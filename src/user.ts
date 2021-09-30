import fetch from "node-fetch";
import { webcrypto as crypto } from "node:crypto";
import { TextEncoder } from "node:util";
import open from "open";
import url from "node:url";
import http from "node:http";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import TOML from "@iarna/toml";
import assert from "node:assert";

/**
 * An implementation of rfc6749#section-4.1 and rfc7636.
 */

interface PKCECodes {
  codeChallenge: string;
  codeVerifier: string;
}

interface State {
  accessToken?: AccessToken; // persist
  authorizationCode?: string;
  codeChallenge?: string;
  codeVerifier?: string;
  hasAuthCodeBeenExchangedForAccessToken?: boolean;
  refreshToken?: RefreshToken; // persist
  stateQueryParam?: string;
  scopes?: Scope[];
}

interface RefreshToken {
  value: string;
}

interface AccessToken {
  value: string;
  expiry: string;
}

type Scope =
  | "account:read"
  | "user:read"
  | "workers:write"
  | "workers_kv:write"
  | "workers_routes:write"
  | "workers_scripts:write"
  | "workers_tail:read"
  | "zone:read"
  | "offline_access"; // this should be included by default

const Scopes: Scope[] = [
  "account:read",
  "user:read",
  "workers:write",
  "workers_kv:write",
  "workers_routes:write",
  "workers_scripts:write",
  "workers_tail:read",
  "zone:read",
];

const ScopeDescriptions = [
  "See your account info such as account details, analytics, and memberships.",
  "See your user info such as name, email address, and account memberships.",
  "See and change Cloudflare Workers data such as zones, KV storage, namespaces, scripts, and routes.",
  "See and change Cloudflare Workers KV Storage data such as keys and namespaces.",
  "See and change Cloudflare Workers data such as filters and routes.",
  "See and change Cloudflare Workers scripts, durable objects, subdomains, triggers, and tail data.",
  "See Cloudflare Workers tail and script data.",
  "Grants read level access to account zone.",
];

const CLIENT_ID = "54d11594-84e4-41aa-b438-e81b8fa78ee7";
const AUTH_URL = "https://dash.cloudflare.com/oauth2/auth";
const TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
const CALLBACK_URL = "http://localhost:8976/oauth/callback";
const REVOKE_URL = "https://dash.cloudflare.com/oauth2/revoke";

const LocalState: State = {};

{
  // get refreshtoken/accesstoken from fs if exists
  try {
    const toml = TOML.parse(
      readFileSync(path.join(os.homedir(), ".wrangler/config/default.toml"), {
        encoding: "utf-8",
      })
    );
    const { oauth_token, refresh_token, expiration_time } = toml as {
      oauth_token: string;
      refresh_token: string;
      expiration_time: string;
    };
    if (oauth_token) {
      LocalState.accessToken = { value: oauth_token, expiry: expiration_time };
    }
    if (refresh_token) {
      LocalState.refreshToken = { value: refresh_token };
    }
  } catch (err) {
    // no config yet, let's chill
    console.error(err);
  }
}

interface AccessContext {
  token?: AccessToken;
  scopes?: Scope[];
  refreshToken?: RefreshToken;
}

/**
 * A list of OAuth2AuthCodePKCE errors.
 */
// To "namespace" all errors.
class ErrorOAuth2 {
  toString(): string {
    return "ErrorOAuth2";
  }
}

// For really unknown errors.
class ErrorUnknown extends ErrorOAuth2 {
  toString(): string {
    return "ErrorUnknown";
  }
}

// Some generic, internal errors that can happen.
class ErrorNoAuthCode extends ErrorOAuth2 {
  toString(): string {
    return "ErrorNoAuthCode";
  }
}
class ErrorInvalidReturnedStateParam extends ErrorOAuth2 {
  toString(): string {
    return "ErrorInvalidReturnedStateParam";
  }
}
class ErrorInvalidJson extends ErrorOAuth2 {
  toString(): string {
    return "ErrorInvalidJson";
  }
}

// Errors that occur across many endpoints
class ErrorInvalidScope extends ErrorOAuth2 {
  toString(): string {
    return "ErrorInvalidScope";
  }
}
class ErrorInvalidRequest extends ErrorOAuth2 {
  toString(): string {
    return "ErrorInvalidRequest";
  }
}
class ErrorInvalidToken extends ErrorOAuth2 {
  toString(): string {
    return "ErrorInvalidToken";
  }
}

/**
 * Possible authorization grant errors given by the redirection from the
 * authorization server.
 */
class ErrorAuthenticationGrant extends ErrorOAuth2 {
  toString(): string {
    return "ErrorAuthenticationGrant";
  }
}
class ErrorUnauthorizedClient extends ErrorAuthenticationGrant {
  toString(): string {
    return "ErrorUnauthorizedClient";
  }
}
class ErrorAccessDenied extends ErrorAuthenticationGrant {
  toString(): string {
    return "ErrorAccessDenied";
  }
}
class ErrorUnsupportedResponseType extends ErrorAuthenticationGrant {
  toString(): string {
    return "ErrorUnsupportedResponseType";
  }
}
class ErrorServerError extends ErrorAuthenticationGrant {
  toString(): string {
    return "ErrorServerError";
  }
}
class ErrorTemporarilyUnavailable extends ErrorAuthenticationGrant {
  toString(): string {
    return "ErrorTemporarilyUnavailable";
  }
}

/**
 * A list of possible access token response errors.
 */
class ErrorAccessTokenResponse extends ErrorOAuth2 {
  toString(): string {
    return "ErrorAccessTokenResponse";
  }
}
class ErrorInvalidClient extends ErrorAccessTokenResponse {
  toString(): string {
    return "ErrorInvalidClient";
  }
}
class ErrorInvalidGrant extends ErrorAccessTokenResponse {
  toString(): string {
    return "ErrorInvalidGrant";
  }
}
class ErrorUnsupportedGrantType extends ErrorAccessTokenResponse {
  toString(): string {
    return "ErrorUnsupportedGrantType";
  }
}

const RawErrorToErrorClassMap: { [_: string]: any } = {
  invalid_request: ErrorInvalidRequest,
  invalid_grant: ErrorInvalidGrant,
  unauthorized_client: ErrorUnauthorizedClient,
  access_denied: ErrorAccessDenied,
  unsupported_response_type: ErrorUnsupportedResponseType,
  invalid_scope: ErrorInvalidScope,
  server_error: ErrorServerError,
  temporarily_unavailable: ErrorTemporarilyUnavailable,
  invalid_client: ErrorInvalidClient,
  unsupported_grant_type: ErrorUnsupportedGrantType,
  invalid_json: ErrorInvalidJson,
  invalid_token: ErrorInvalidToken,
};

/**
 * Translate the raw error strings returned from the server into error classes.
 */
function toErrorClass(rawError: string): ErrorOAuth2 {
  return new (RawErrorToErrorClassMap[rawError] || ErrorUnknown)();
}

/**
 * The maximum length for a code verifier for the best security we can offer.
 * Please note the NOTE section of RFC 7636 § 4.1 - the length must be >= 43,
 * but <= 128, **after** base64 url encoding. This means 32 code verifier bytes
 * encoded will be 43 bytes, or 96 bytes encoded will be 128 bytes. So 96 bytes
 * is the highest valid value that can be used.
 */
const RECOMMENDED_CODE_VERIFIER_LENGTH = 96;

/**
 * A sensible length for the state's length, for anti-csrf.
 */
const RECOMMENDED_STATE_LENGTH = 32;

/**
 * Character set to generate code verifier defined in rfc7636.
 */
const PKCE_CHARSET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

/**
 * OAuth 2.0 client that ONLY supports authorization code flow, with PKCE.
 */

/**
 * If there is an error, it will be passed back as a rejected Promise.
 * If there is no code, the user should be redirected via
 * [fetchAuthorizationCode].
 */
function isReturningFromAuthServer(query: { [key: string]: string }): boolean {
  if (query.error) {
    throw toErrorClass(query.error);
  }

  const code = query.code;
  if (!code) {
    return false;
  }

  const state = LocalState;

  const stateQueryParam = query.state;
  if (stateQueryParam !== state.stateQueryParam) {
    console.warn(
      "state query string parameter doesn't match the one sent! Possible malicious activity somewhere."
    );
    throw new ErrorInvalidReturnedStateParam();
  }

  state.authorizationCode = code;
  state.hasAuthCodeBeenExchangedForAccessToken = false;
  return true;
}

export async function getAuthURL(): Promise<string> {
  const { codeChallenge, codeVerifier } = await generatePKCECodes();
  const stateQueryParam = generateRandomState(RECOMMENDED_STATE_LENGTH);

  Object.assign(LocalState, {
    codeChallenge,
    codeVerifier,
    stateQueryParam,
  });

  return (
    AUTH_URL +
    `?response_type=code&` +
    `client_id=${encodeURIComponent(CLIENT_ID)}&` +
    `redirect_uri=${encodeURIComponent(CALLBACK_URL)}&` +
    `scope=${encodeURIComponent(Scopes.concat("offline_access").join(" "))}&` +
    `state=${stateQueryParam}&` +
    `code_challenge=${encodeURIComponent(codeChallenge)}&` +
    `code_challenge_method=S256`
  );
}

/**
 * Refresh an access token from the remote service.
 */
async function exchangeRefreshTokenForAccessToken(): Promise<AccessContext> {
  const { refreshToken } = LocalState;

  if (!refreshToken) {
    console.warn("No refresh token is present.");
  }

  const url = TOKEN_URL;
  const body =
    `grant_type=refresh_token&` +
    `refresh_token=${refreshToken?.value}&` +
    `client_id=${CLIENT_ID}`;

  const response = await fetch(url, {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
  if (response.status >= 400) {
    throw await response.json();
  } else {
    try {
      const json = await response.json();
      const { access_token, expires_in, refresh_token, scope } = json as {
        access_token: string;
        expires_in: number;
        refresh_token: string;
        scope: string;
      };
      let scopes: Scope[] = [];

      const accessToken: AccessToken = {
        value: access_token,
        expiry: new Date(Date.now() + expires_in * 1000).toISOString(),
      };
      LocalState.accessToken = accessToken;

      if (refresh_token) {
        const refreshToken: RefreshToken = {
          value: refresh_token,
        };
        LocalState.refreshToken = refreshToken;
      }

      if (scope) {
        // Multiple scopes are passed and delimited by spaces,
        // despite using the singular name "scope".
        scopes = scope.split(" ") as Scope[];
        LocalState.scopes = scopes;
      }

      const accessContext: AccessContext = {
        token: accessToken,
        scopes,
        refreshToken: LocalState.refreshToken,
      };
      return accessContext;
    } catch (err: any) {
      const error = err?.error || "There was a network error.";
      switch (error) {
        case "invalid_grant":
          console.log(
            "Expired! Auth code or refresh token needs to be renewed."
          );
          // alert("Redirecting to auth server to obtain a new auth grant code.");
          // TODO: return refreshAuthCodeOrRefreshToken();
          break;
        default:
          break;
      }
      throw toErrorClass(error);
    }
  }
}

/**
 * Fetch an access token from the remote service.
 */
async function exchangeAuthCodeForAccessToken(): Promise<AccessContext> {
  const { authorizationCode, codeVerifier = "" } = LocalState;

  if (!codeVerifier) {
    console.warn("No code verifier is being sent.");
  } else if (!authorizationCode) {
    console.warn("No authorization grant code is being passed.");
  }

  const url = TOKEN_URL;
  const body =
    `grant_type=authorization_code&` +
    `code=${encodeURIComponent(authorizationCode || "")}&` +
    `redirect_uri=${encodeURIComponent(CALLBACK_URL)}&` +
    `client_id=${encodeURIComponent(CLIENT_ID)}&` +
    `code_verifier=${codeVerifier}`;

  const response = await fetch(url, {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
  if (!response.ok) {
    const { error } = (await response.json()) as { error: string };
    // .catch((_) => ({ error: "invalid_json" }));
    if (error === "invalid_grant") {
      console.log("Expired! Auth code or refresh token needs to be renewed.");
      // alert("Redirecting to auth server to obtain a new auth grant code.");
      // TODO: return refreshAuthCodeOrRefreshToken();
    }
    throw toErrorClass(error);
  }
  const json = await response.json();
  const { access_token, expires_in, refresh_token, scope } = json as {
    access_token: string;
    expires_in: number;
    refresh_token: string;
    scope: string;
  };
  let scopes: Scope[] = [];
  LocalState.hasAuthCodeBeenExchangedForAccessToken = true;

  const expiryDate = new Date(Date.now() + expires_in * 1000);
  const accessToken: AccessToken = {
    value: access_token,
    expiry: expiryDate.toISOString(),
  };
  LocalState.accessToken = accessToken;

  if (refresh_token) {
    const refreshToken: RefreshToken = {
      value: refresh_token,
    };
    LocalState.refreshToken = refreshToken;
  }

  if (scope) {
    // Multiple scopes are passed and delimited by spaces,
    // despite using the singular name "scope".
    scopes = scope.split(" ") as Scope[];
    LocalState.scopes = scopes;
  }

  const accessContext: AccessContext = {
    token: accessToken,
    scopes,
    refreshToken: LocalState.refreshToken,
  };
  return accessContext;
}

/**
 * Implements *base64url-encode* (RFC 4648 § 5) without padding, which is NOT
 * the same as regular base64 encoding.
 */
function base64urlEncode(value: string): string {
  let base64 = btoa(value);
  base64 = base64.replace(/\+/g, "-");
  base64 = base64.replace(/\//g, "_");
  base64 = base64.replace(/=/g, "");
  return base64;
}

/**
 * Generates a code_verifier and code_challenge, as specified in rfc7636.
 */

async function generatePKCECodes(): Promise<PKCECodes> {
  const output = new Uint32Array(RECOMMENDED_CODE_VERIFIER_LENGTH);
  // @ts-expect-error crypto's types aren't there yet
  crypto.getRandomValues(output);
  const codeVerifier = base64urlEncode(
    Array.from(output)
      .map((num: number) => PKCE_CHARSET[num % PKCE_CHARSET.length])
      .join("")
  );
  // @ts-expect-error crypto's types aren't there yet
  const buffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier)
  );
  const hash = new Uint8Array(buffer);
  let binary = "";
  const hashLength = hash.byteLength;
  for (let i = 0; i < hashLength; i++) {
    binary += String.fromCharCode(hash[i]);
  }
  const codeChallenge = base64urlEncode(binary);
  return { codeChallenge, codeVerifier };
}

/**
 * Generates random state to be passed for anti-csrf.
 */
function generateRandomState(lengthOfState: number): string {
  const output = new Uint32Array(lengthOfState);
  // @ts-expect-error crypto's types aren't there yet
  crypto.getRandomValues(output);
  return Array.from(output)
    .map((num: number) => PKCE_CHARSET[num % PKCE_CHARSET.length])
    .join("");
}

async function writeToConfigFile(tokenData: AccessContext) {
  await writeFile(
    path.join(os.homedir(), ".wrangler/config/default.toml"),
    `oauth_token = "${tokenData.token?.value || ""}"
refresh_token = "${tokenData.refreshToken?.value}"
expiration_time = "${tokenData.token?.expiry}"\n`,
    { encoding: "utf-8" }
  );
}

const server = http.createServer(async (req, res) => {
  assert(req.url, "This request doesn't have a URL"); // This should never happen
  const { pathname, query } = url.parse(req.url, true);
  switch (pathname) {
    case "/oauth/callback": {
      let hasAuthCode = false;
      try {
        hasAuthCode = isReturningFromAuthServer(query);
      } catch (err) {
        console.log({ err });
        // render an error page instead
      }
      if (!hasAuthCode) {
        // render an error page here
        console.log("no auth code, render error page");
      } else {
        if (query.code === LocalState.authorizationCode) {
          const tokenData = await exchangeAuthCodeForAccessToken();
          console.log(tokenData);
          await writeToConfigFile(tokenData);
          // write to file
        } else {
          console.log("not matching?");
          // ???
        }
      }
    }
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain");
  res.end(`Hello ${req.url}`);
});

// server.listen(8976);

export async function login(): Promise<void> {
  open(await getAuthURL());
}

/**
 * Checks to see if the access token has expired.
 */
export function isAccessTokenExpired(): boolean {
  const { accessToken } = LocalState;
  return Boolean(accessToken && new Date() >= new Date(accessToken.expiry));
}

export async function refresh(): Promise<void> {
  // // refresh
  try {
    const refreshed = await exchangeRefreshTokenForAccessToken();
    console.log({ refreshed });
    await writeToConfigFile(refreshed);
  } catch (err) {
    console.log(err);
    throw err;
  }
}

export async function logout(): Promise<void> {
  const { refreshToken } = LocalState;
  const body =
    `client_id=${encodeURIComponent(CLIENT_ID)}&` +
    `token_type_hint=refresh_token&` +
    `token=${encodeURIComponent(refreshToken?.value || "")}`;

  const response = await fetch(REVOKE_URL, {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
  await response.text(); // blank text? would be nice if it was something meaningful
}

// async function run() {
//   // // login
//   // // logout
//   // await logout();
// }

// run();
