import {
  MAX_TIMER_TIMEOUT_MS,
  positiveSecondsToSafeMilliseconds,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import type { OAuthCredential } from "openclaw/plugin-sdk/provider-auth";
import { readProviderJsonObjectResponse } from "openclaw/plugin-sdk/provider-http";
import {
  type OAuthCredentials,
  throwIfOAuthLoginAborted,
} from "openclaw/plugin-sdk/provider-oauth-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { asFiniteNumberInRange } from "openclaw/plugin-sdk/string-coerce-runtime";
import { sleep } from "openclaw/plugin-sdk/text-utility-runtime";

const OAUTH_BASE_URL = "https://radius.pi.dev/v1/oauth";
const CLIENT_ID = "pi-gateway";
const REQUEST_TIMEOUT_MS = 30_000;

class RadiusOAuthError extends Error {
  readonly code: string | undefined;

  constructor(code: unknown, status: number) {
    super(`Radius OAuth request failed (HTTP ${status}). Retry sign-in.`);
    this.code =
      typeof code === "string" &&
      ["authorization_pending", "slow_down", "access_denied", "expired_token"].includes(code)
        ? code
        : undefined;
  }
}

async function postOAuthForm(
  endpoint: "device" | "token",
  fields: Record<string, string>,
  signal?: AbortSignal,
  beforeRequest?: () => void,
): Promise<Record<string, unknown>> {
  const { response, release } = await fetchWithSsrFGuard({
    url: `${OAUTH_BASE_URL}/${endpoint}`,
    init: {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ client_id: CLIENT_ID, ...fields }),
    },
    signal,
    beforeRequest,
    timeoutMs: REQUEST_TIMEOUT_MS,
    requireHttps: true,
    policy: { hostnameAllowlist: ["radius.pi.dev"] },
    auditContext: `radius.oauth.${endpoint}`,
  });
  try {
    const payload = await readProviderJsonObjectResponse(response, "Radius OAuth", {
      maxBytes: 64 * 1024,
      // Suppress JSON parser causes, which can contain credential bytes.
      requestHeaders: {},
    });
    if (!response.ok || payload.error !== undefined) {
      throw new RadiusOAuthError(payload.error, response.status);
    }
    return payload;
  } finally {
    await release();
  }
}

function parseToken(payload: Record<string, unknown>, previousRefresh?: string): OAuthCredentials {
  const lifetimeMs = positiveSecondsToSafeMilliseconds(payload.expires_in);
  const expires =
    lifetimeMs === undefined
      ? undefined
      : resolveExpiresAtMsFromDurationMs(lifetimeMs, {
          // Refresh early without making short-lived tokens immediately stale.
          bufferMs: Math.min(60_000, Math.floor(lifetimeMs / 2)),
        });
  const refresh = payload.refresh_token ?? previousRefresh;
  if (
    typeof payload.access_token !== "string" ||
    !payload.access_token.trim() ||
    typeof refresh !== "string" ||
    !refresh.trim() ||
    expires === undefined ||
    (payload.scope !== undefined && typeof payload.scope !== "string")
  ) {
    throw new Error("Radius OAuth returned invalid credentials. Retry sign-in.");
  }
  return { access: payload.access_token, refresh, expires };
}

function parseDevice(payload: Record<string, unknown>) {
  const lifetimeMs = positiveSecondsToSafeMilliseconds(payload.expires_in);
  const expiresAt =
    lifetimeMs === undefined ? undefined : resolveExpiresAtMsFromDurationMs(lifetimeMs);
  const intervalSeconds =
    payload.interval === undefined
      ? 5
      : asFiniteNumberInRange(payload.interval, {
          min: Number.MIN_VALUE,
          max: MAX_TIMER_TIMEOUT_MS / 1000,
        });
  const intervalMs = intervalSeconds === undefined ? undefined : Math.ceil(intervalSeconds * 1000);
  if (
    typeof payload.device_code !== "string" ||
    !payload.device_code.trim() ||
    typeof payload.user_code !== "string" ||
    !payload.user_code.trim() ||
    typeof payload.verification_uri !== "string" ||
    expiresAt === undefined ||
    intervalMs === undefined ||
    intervalMs > MAX_TIMER_TIMEOUT_MS
  ) {
    throw new Error("Radius OAuth returned an invalid device authorization response.");
  }
  let url: URL;
  try {
    url = new URL(payload.verification_uri);
  } catch {
    throw new Error("Radius OAuth returned an invalid verification URL.");
  }
  if (url.origin !== "https://radius.earendil.com" || url.username || url.password) {
    throw new Error("Radius OAuth returned an invalid verification URL.");
  }
  return {
    deviceCode: payload.device_code,
    userCode: payload.user_code,
    verificationUri: url.href,
    expiresAt,
    intervalMs,
  };
}

export async function loginRadiusOAuth(ctx: ProviderAuthContext): Promise<OAuthCredentials> {
  const assertCurrent = () => {
    throwIfOAuthLoginAborted(ctx.signal);
    ctx.assertCurrent?.();
  };
  assertCurrent();
  const payload = await postOAuthForm(
    "device",
    { scope: "gateway offline_access" },
    ctx.signal,
    assertCurrent,
  );
  assertCurrent();
  const device = parseDevice(payload);
  await ctx.prompter.note(
    `Open ${device.verificationUri} and enter code ${device.userCode} to sign in to Radius.`,
    "Radius sign-in",
  );
  assertCurrent();
  if (!ctx.isRemote) {
    try {
      await ctx.openUrl(device.verificationUri);
    } catch {
      // The displayed URL remains usable when this host cannot launch a browser.
    }
    assertCurrent();
  }
  const progress = ctx.prompter.progress("Waiting for Radius approval…");
  let completed = false;
  try {
    let intervalMs = device.intervalMs;
    while (Date.now() < device.expiresAt) {
      await sleep(Math.min(intervalMs, device.expiresAt - Date.now()), ctx.signal);
      assertCurrent();
      if (Date.now() >= device.expiresAt) {
        break;
      }
      try {
        const token = await postOAuthForm(
          "token",
          {
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: device.deviceCode,
          },
          ctx.signal,
          assertCurrent,
        );
        assertCurrent();
        const credentials = parseToken(token);
        completed = true;
        return credentials;
      } catch (error) {
        assertCurrent();
        if (!(error instanceof RadiusOAuthError)) {
          throw error;
        }
        switch (error.code) {
          case "authorization_pending":
            break;
          case "slow_down":
            intervalMs = Math.min(intervalMs + 5_000, MAX_TIMER_TIMEOUT_MS);
            break;
          case "access_denied":
            throw new Error("Radius sign-in was denied. Retry sign-in when ready.", {
              cause: error,
            });
          case "expired_token":
            throw new Error("Radius device code expired. Start sign-in again.", { cause: error });
          default:
            throw error;
        }
      }
    }
    throw new Error("Radius device code expired. Start sign-in again.");
  } finally {
    progress.stop(completed ? "Radius sign-in complete" : "Radius sign-in stopped");
  }
}

export async function refreshRadiusOAuthCredential(
  credential: OAuthCredential,
): Promise<OAuthCredential> {
  if (!credential.refresh.trim()) {
    throw new Error("Radius refresh token is missing. Sign in again.");
  }
  const payload = await postOAuthForm("token", {
    grant_type: "refresh_token",
    refresh_token: credential.refresh,
  });
  return { ...credential, ...parseToken(payload, credential.refresh) };
}
