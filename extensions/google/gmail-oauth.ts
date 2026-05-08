import { resolveOAuthClientConfig } from "./oauth.credentials.js";
import { fetchWithTimeout } from "./oauth.http.js";
import { AUTH_URL, DEFAULT_FETCH_TIMEOUT_MS, REDIRECT_URI, TOKEN_URL } from "./oauth.shared.js";

export const GMAIL_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
] as const;

export type GmailOAuthCredentials = {
  access: string;
  refresh: string;
  expires: number;
  email?: string;
  scope?: string;
  tokenType?: string;
};

export function buildGmailAuthUrl(params: {
  challenge: string;
  state: string;
  redirectUri?: string;
}): string {
  const { clientId } = resolveOAuthClientConfig();
  const redirectUri = params.redirectUri?.trim() || REDIRECT_URI;
  const query = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: GMAIL_OAUTH_SCOPES.join(" "),
    code_challenge: params.challenge,
    code_challenge_method: "S256",
    state: params.state,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  });
  return `${AUTH_URL}?${query.toString()}`;
}

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
};

async function exchangeToken(body: URLSearchParams): Promise<TokenResponse> {
  const { clientId, clientSecret } = resolveOAuthClientConfig();
  body.set("client_id", clientId);
  if (clientSecret) {
    body.set("client_secret", clientSecret);
  }
  const response = await fetchWithTimeout(
    TOKEN_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Accept: "application/json",
      },
      body,
    },
    DEFAULT_FETCH_TIMEOUT_MS,
  );

  if (!response.ok) {
    throw new Error(`Gmail OAuth token exchange failed: ${await response.text()}`);
  }

  return (await response.json()) as TokenResponse;
}

export async function exchangeGmailCodeForTokens(params: {
  code: string;
  verifier: string;
  redirectUri?: string;
}): Promise<GmailOAuthCredentials> {
  const token = await exchangeToken(
    new URLSearchParams({
      code: params.code,
      grant_type: "authorization_code",
      redirect_uri: params.redirectUri?.trim() || REDIRECT_URI,
      code_verifier: params.verifier,
    }),
  );

  if (!token.refresh_token) {
    throw new Error("No Gmail refresh token received. Please try again.");
  }

  return {
    access: token.access_token,
    refresh: token.refresh_token,
    expires: Date.now() + token.expires_in * 1000 - 5 * 60 * 1000,
    scope: token.scope,
    tokenType: token.token_type,
  };
}

export async function refreshGmailAccessToken(params: {
  refreshToken: string;
}): Promise<GmailOAuthCredentials> {
  const token = await exchangeToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: params.refreshToken,
    }),
  );

  return {
    access: token.access_token,
    refresh: params.refreshToken,
    expires: Date.now() + token.expires_in * 1000 - 5 * 60 * 1000,
    scope: token.scope,
    tokenType: token.token_type,
  };
}
