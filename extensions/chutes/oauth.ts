import { randomBytes } from "node:crypto";
import { withTrustedEnvProxyGuardedFetchMode } from "openclaw/plugin-sdk/fetch-runtime";
import { resolveExpiresAtMsFromDurationSeconds } from "openclaw/plugin-sdk/number-runtime";
import {
  generatePkceVerifierChallenge,
  type OAuthCredential,
} from "openclaw/plugin-sdk/provider-auth";
import {
  parseOAuthCallbackInput,
  waitForLocalOAuthCallback,
} from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowProviderError,
  readProviderJsonResponse,
} from "openclaw/plugin-sdk/provider-http";
import {
  buildOAuthRequestSignal,
  type OAuthCredentials,
  type OAuthPrompt,
} from "openclaw/plugin-sdk/provider-oauth-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const CHUTES_AUTHORIZE_ENDPOINT = "https://api.chutes.ai/idp/authorize";
const CHUTES_TOKEN_ENDPOINT = "https://api.chutes.ai/idp/token";
const CHUTES_USERINFO_ENDPOINT = "https://api.chutes.ai/idp/userinfo";
const CHUTES_OAUTH_REQUEST_TIMEOUT_MS = 30_000;

type ChutesOAuthAppConfig = {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes: string[];
};

type ChutesUserInfo = {
  sub?: string;
  username?: string;
};

type ChutesStoredOAuth = OAuthCredentials & {
  accountId?: string;
  clientId?: string;
};

function parseRedirectUri(redirectUri: string): {
  hostname: string;
  port: number;
  pathname: string;
} {
  const url = new URL(redirectUri);
  if (url.protocol !== "http:") {
    throw new Error(`Chutes OAuth redirect URI must be http:// (got ${redirectUri})`);
  }
  const hostname = url.hostname === "[::1]" ? "::1" : url.hostname || "127.0.0.1";
  if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1") {
    throw new Error(
      `Chutes OAuth redirect hostname must be loopback (got ${hostname}). Use http://127.0.0.1:<port>/...`,
    );
  }
  return {
    hostname,
    port: url.port ? Number.parseInt(url.port, 10) : 80,
    pathname: url.pathname || "/",
  };
}

function parseManualOAuthInput(
  input: string,
  expectedState: string,
): { code: string; state: string } {
  const parsed = parseOAuthCallbackInput(input, {
    invalidInput: "Paste the full redirect URL (must include code + state).",
    missingState: "Missing 'state' parameter. Paste the full redirect URL.",
  });
  if ("error" in parsed) {
    throw new Error(parsed.error);
  }
  if (parsed.state !== expectedState) {
    throw new Error("OAuth state mismatch - possible CSRF attack. Please retry login.");
  }
  return parsed;
}

function resolveChutesExpiresAt(value: unknown, now: number): number | undefined {
  return resolveExpiresAtMsFromDurationSeconds(value, {
    nowMs: now,
    bufferMs: 5 * 60 * 1000,
    minRemainingMs: 30_000,
  });
}

async function requestChutesTokenGrant(params: {
  body: URLSearchParams;
  responseLabel: "Chutes token exchange" | "Chutes token refresh";
  now?: number;
  signal?: AbortSignal;
}): Promise<{ access: string; refresh: string | undefined; expires: number }> {
  const { response, release } = await fetchWithSsrFGuard(
    withTrustedEnvProxyGuardedFetchMode({
      url: CHUTES_TOKEN_ENDPOINT,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.body,
      },
      signal: buildOAuthRequestSignal({
        timeoutMs: CHUTES_OAUTH_REQUEST_TIMEOUT_MS,
        ...(params.signal ? { signal: params.signal } : {}),
      }),
    }),
  );
  try {
    await assertOkOrThrowProviderError(response, `${params.responseLabel} failed`);

    const data = await readProviderJsonResponse<{
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    }>(response, params.responseLabel);
    const access = normalizeOptionalString(data.access_token);
    const expires = resolveChutesExpiresAt(data.expires_in, params.now ?? Date.now());
    if (!access) {
      throw new Error(`${params.responseLabel} returned no access_token`);
    }
    if (expires === undefined) {
      throw new Error(`${params.responseLabel} returned invalid expires_in`);
    }
    return { access, refresh: normalizeOptionalString(data.refresh_token), expires };
  } finally {
    await release();
  }
}

async function fetchChutesUserInfo(params: {
  accessToken: string;
  signal?: AbortSignal;
}): Promise<ChutesUserInfo | null> {
  const { response, release } = await fetchWithSsrFGuard(
    withTrustedEnvProxyGuardedFetchMode({
      url: CHUTES_USERINFO_ENDPOINT,
      init: { headers: { Authorization: `Bearer ${params.accessToken}` } },
      signal: buildOAuthRequestSignal({
        timeoutMs: CHUTES_OAUTH_REQUEST_TIMEOUT_MS,
        ...(params.signal ? { signal: params.signal } : {}),
      }),
    }),
  );
  try {
    if (!response.ok) {
      return null;
    }
    const data = await readProviderJsonResponse<unknown>(response, "Chutes userinfo");
    return data && typeof data === "object" ? (data as ChutesUserInfo) : null;
  } finally {
    await release();
  }
}

async function exchangeChutesCodeForTokens(params: {
  app: ChutesOAuthAppConfig;
  code: string;
  codeVerifier: string;
  signal?: AbortSignal;
}): Promise<ChutesStoredOAuth> {
  const now = Date.now();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: params.app.clientId,
    code: params.code,
    redirect_uri: params.app.redirectUri,
    code_verifier: params.codeVerifier,
  });
  if (params.app.clientSecret) {
    body.set("client_secret", params.app.clientSecret);
  }

  const token = await requestChutesTokenGrant({
    body,
    responseLabel: "Chutes token exchange",
    now,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (!token.refresh) {
    throw new Error("Chutes token exchange returned no refresh_token");
  }

  let info: ChutesUserInfo | null = null;
  try {
    info = await fetchChutesUserInfo({
      accessToken: token.access,
      ...(params.signal ? { signal: params.signal } : {}),
    });
  } catch (error) {
    if (params.signal?.aborted) {
      throw error;
    }
    // Token exchange completes authentication; optional profile enrichment must
    // not discard issued credentials when userinfo is unavailable or times out.
  }
  return {
    access: token.access,
    refresh: token.refresh,
    expires: token.expires,
    email: info?.username,
    accountId: info?.sub,
    clientId: params.app.clientId,
  };
}

/** Refreshes a stored Chutes OAuth credential through the provider token endpoint. */
export async function refreshChutesOAuthCredential(
  credential: OAuthCredential,
): Promise<OAuthCredential> {
  const refreshToken = normalizeOptionalString(credential.refresh);
  if (!refreshToken) {
    throw new Error("Chutes OAuth credential is missing refresh token");
  }

  const clientId = normalizeOptionalString(credential.clientId ?? process.env.CHUTES_CLIENT_ID);
  if (!clientId) {
    throw new Error("Missing CHUTES_CLIENT_ID for Chutes OAuth refresh (set env var or re-auth).");
  }
  const clientSecret = normalizeOptionalString(process.env.CHUTES_CLIENT_SECRET);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
  });
  if (clientSecret) {
    body.set("client_secret", clientSecret);
  }

  const token = await requestChutesTokenGrant({
    body,
    responseLabel: "Chutes token refresh",
  });

  return {
    ...credential,
    access: token.access,
    // RFC 6749 section 6 makes replacement refresh tokens optional.
    refresh: token.refresh ?? refreshToken,
    expires: token.expires,
    clientId,
  };
}

/** Runs Chutes OAuth and returns refreshable stored credentials. */
export async function loginChutes(params: {
  app: ChutesOAuthAppConfig;
  manual?: boolean;
  onAuth: (event: { url: string }) => Promise<void>;
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}): Promise<ChutesStoredOAuth> {
  const { verifier, challenge } = generatePkceVerifierChallenge();
  const state = randomBytes(16).toString("hex");
  const query = new URLSearchParams({
    client_id: params.app.clientId,
    redirect_uri: params.app.redirectUri,
    response_type: "code",
    scope: params.app.scopes.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const url = `${CHUTES_AUTHORIZE_ENDPOINT}?${query}`;
  const promptForCode = async () =>
    parseManualOAuthInput(
      await params.onPrompt({
        message: "Paste the redirect URL",
        placeholder: `${params.app.redirectUri}?code=...&state=...`,
      }),
      state,
    );

  let codeAndState: { code: string; state: string };
  if (params.manual) {
    await params.onAuth({ url });
    params.onProgress?.("Waiting for redirect URL...");
    codeAndState = await promptForCode();
  } else {
    const redirect = parseRedirectUri(params.app.redirectUri);
    const callback = waitForLocalOAuthCallback({
      expectedState: state,
      timeoutMs: 3 * 60 * 1000,
      port: redirect.port,
      callbackPath: redirect.pathname,
      redirectUri: params.app.redirectUri,
      successTitle: "Chutes OAuth complete",
      hostname: redirect.hostname,
      onProgress: params.onProgress,
      ...(params.signal ? { signal: params.signal } : {}),
    }).catch(async (error: unknown) => {
      if (params.signal?.aborted) {
        throw error;
      }
      params.onProgress?.("OAuth callback not detected; paste redirect URL...");
      return await promptForCode();
    });

    await params.onAuth({ url });
    codeAndState = await callback;
  }

  params.onProgress?.("Exchanging code for tokens...");
  return await exchangeChutesCodeForTokens({
    app: params.app,
    code: codeAndState.code,
    codeVerifier: verifier,
    ...(params.signal ? { signal: params.signal } : {}),
  });
}
