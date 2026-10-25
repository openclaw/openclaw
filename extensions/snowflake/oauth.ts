import { createHash } from "node:crypto";
import type { ProviderAuthContext, ProviderAuthResult } from "openclaw/plugin-sdk/plugin-entry";
import {
  generatePkceVerifierChallenge,
  type OAuthCredential,
} from "openclaw/plugin-sdk/provider-auth";
import {
  generateOAuthState,
  startProviderOAuthLoopbackCallbackServer,
} from "openclaw/plugin-sdk/provider-auth-runtime";
import { readProviderJsonObjectResponse } from "openclaw/plugin-sdk/provider-http";
import {
  resolveOAuthTokenExpiresAt,
  throwIfOAuthLoginAborted,
} from "openclaw/plugin-sdk/provider-oauth-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { CORTEX_PATH, snowflakeUrl } from "./endpoint.js";

const CLIENT_ID = "LOCAL_APPLICATION";
const REDIRECT_URI = "http://127.0.0.1:8765/snowflake/callback";

async function requestToken(
  issuer: string,
  fields: Record<string, string>,
  signal?: AbortSignal,
  beforeRequest?: () => void,
): Promise<Record<string, unknown>> {
  const { response, release } = await fetchWithSsrFGuard({
    url: `${issuer}/oauth/token-request`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: CLIENT_ID, ...fields }),
    },
    signal,
    beforeRequest,
    timeoutMs: 30_000,
    maxRedirects: 0,
    requireHttps: true,
    policy: { hostnameAllowlist: [new URL(issuer).hostname] },
    auditContext: "snowflake.oauth.token",
  });
  try {
    if (!response.ok) {
      throw new Error(
        `Snowflake OAuth token request failed (HTTP ${response.status}). Sign in again; if it persists, ask your administrator to check local-application OAuth and network policies.`,
      );
    }
    const payload = await readProviderJsonObjectResponse(response, "Snowflake OAuth", {
      maxBytes: 64 * 1024,
      // Parser errors must not include access or refresh token bytes.
      requestHeaders: {},
    });
    if (payload.error !== undefined) {
      throw new Error("Snowflake OAuth rejected the token request. Sign in again.");
    }
    return payload;
  } finally {
    await release();
  }
}

function parseToken(payload: Record<string, unknown>, previousRefresh?: string) {
  const expires = resolveOAuthTokenExpiresAt(payload.expires_in);
  const refresh = payload.refresh_token ?? previousRefresh;
  if (typeof refresh !== "string" || !refresh.trim()) {
    throw new Error(
      "Snowflake did not issue a refresh token. Ask your administrator whether local-application OAuth permits refresh tokens, then sign in again.",
    );
  }
  if (
    typeof payload.access_token !== "string" ||
    !payload.access_token.trim() ||
    typeof payload.token_type !== "string" ||
    payload.token_type.toLowerCase() !== "bearer" ||
    expires === undefined
  ) {
    throw new Error("Snowflake OAuth returned invalid credentials. Sign in again.");
  }
  return { access: payload.access_token, refresh, expires };
}

export async function loginSnowflake(ctx: ProviderAuthContext): Promise<ProviderAuthResult> {
  const assertCurrent = () => {
    throwIfOAuthLoginAborted(ctx.signal);
    ctx.assertCurrent?.();
  };
  assertCurrent();
  if (ctx.isRemote || ctx.oauth.authorize) {
    throw new Error(
      "Snowflake local-application OAuth requires OpenClaw and the browser on the same computer. Run models auth login locally; hosted OAuth needs a separately configured integration.",
    );
  }
  const provider = ctx.config.models?.providers?.snowflake;
  const issuer = snowflakeUrl(provider?.baseUrl, CORTEX_PATH).origin;
  if (provider?.apiKey) {
    throw new Error(
      "Remove models.providers.snowflake.apiKey before OAuth sign-in so the saved OAuth profile supplies inference credentials.",
    );
  }
  const { verifier, challenge } = generatePkceVerifierChallenge();
  const state = generateOAuthState();
  const authorize = new URL(`${issuer}/oauth/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "refresh_token",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  await ctx.prompter.note(
    "Sign in with your Snowflake user. Its default role must permit Cortex REST inference. The account must have SNOWFLAKE$LOCAL_APPLICATION enabled and allow refresh tokens.",
    "Snowflake Cortex",
  );
  assertCurrent();
  const callback = await startProviderOAuthLoopbackCallbackServer({
    redirectUrl: REDIRECT_URI,
    expectedState: state,
    bindOnlyHostname: "127.0.0.1",
    timeoutMs: 5 * 60_000,
    signal: ctx.signal,
  });
  // Attach rejection handling before browser launch, which can itself be canceled.
  const result = callback.waitForCallback();
  void result.catch(() => undefined);
  try {
    assertCurrent();
    await ctx.openUrl(authorize.href);
    assertCurrent();
    const authorization = await result;
    assertCurrent();
    if (authorization.type === "oauth_error") {
      throw new Error(
        "Snowflake sign-in was denied. Retry sign-in or ask your administrator to check local-application OAuth and role policies.",
      );
    }
    const payload = await requestToken(
      issuer,
      {
        grant_type: "authorization_code",
        code: authorization.code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      },
      ctx.signal,
      assertCurrent,
    );
    assertCurrent();
    const tokens = parseToken(payload);
    if (typeof payload.username !== "string" || !payload.username.trim()) {
      throw new Error("Snowflake OAuth returned no user identity. Sign in again.");
    }
    const accountId = createHash("sha256")
      .update(JSON.stringify([issuer, payload.username]))
      .digest("hex");
    return {
      profiles: [
        {
          profileId: `snowflake:${accountId}`,
          credential: { type: "oauth", provider: "snowflake", ...tokens, issuer, accountId },
        },
      ],
      ...(!ctx.credentialOnly && provider?.models[0]
        ? { defaultModel: `snowflake/${provider.models[0].id}` }
        : {}),
    };
  } finally {
    await callback.close();
  }
}

export async function refreshSnowflake(credential: OAuthCredential): Promise<OAuthCredential> {
  const issuer = snowflakeUrl(credential.issuer, "").origin;
  const payload = await requestToken(issuer, {
    grant_type: "refresh_token",
    refresh_token: credential.refresh,
  });
  return { ...credential, ...parseToken(payload, credential.refresh) };
}
