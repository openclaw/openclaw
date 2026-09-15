import {
  MAX_TIMER_TIMEOUT_MS,
  positiveSecondsToSafeMilliseconds,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import type { ProviderAuthContext, ProviderAuthResult } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildOauthProviderAuthResult,
  type OAuthCredential,
} from "openclaw/plugin-sdk/provider-auth";
import { readProviderJsonObjectResponse } from "openclaw/plugin-sdk/provider-http";
import { throwIfOAuthLoginAborted } from "openclaw/plugin-sdk/provider-oauth-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { sleep } from "openclaw/plugin-sdk/text-utility-runtime";
import { applyKimiProviderConnectionConfig, KIMI_MODEL_REF } from "./onboard.js";

const OAUTH_ORIGIN = "https://auth.kimi.com";
const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const REQUEST_TIMEOUT_MS = 30_000;

class KimiOAuthError extends Error {
  readonly code: string | undefined;

  constructor(code: unknown, status: number) {
    super(`Kimi sign-in request failed (HTTP ${status}). Start sign-in again.`);
    this.code =
      typeof code === "string" &&
      ["authorization_pending", "slow_down", "access_denied", "expired_token"].includes(code)
        ? code
        : undefined;
  }
}

async function request(
  endpoint: "device_authorization" | "token",
  fields: Record<string, string>,
  options: { signal?: AbortSignal; assertCurrent?: () => void; timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const { response, release } = await fetchWithSsrFGuard({
    url: `${OAUTH_ORIGIN}/api/oauth/${endpoint}`,
    init: {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CLIENT_ID, ...fields }),
    },
    signal: options.signal,
    beforeRequest: options.assertCurrent,
    timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    requireHttps: true,
    policy: { hostnameAllowlist: ["auth.kimi.com"] },
    auditContext: `kimi.oauth.${endpoint}`,
  });
  try {
    const payload = await readProviderJsonObjectResponse(response, "Kimi sign-in", {
      // OAuth parser errors must not include token response bytes.
      requestHeaders: {},
    });
    if (!response.ok || payload.error !== undefined) {
      throw new KimiOAuthError(payload.error, response.status);
    }
    return payload;
  } finally {
    await release();
  }
}

function expiresAt(seconds: unknown): number | undefined {
  const duration = positiveSecondsToSafeMilliseconds(seconds);
  return duration === undefined ? undefined : resolveExpiresAtMsFromDurationMs(duration);
}

function parseCredentials(payload: Record<string, unknown>) {
  const expires = expiresAt(payload.expires_in);
  if (
    typeof payload.access_token !== "string" ||
    !payload.access_token.trim() ||
    typeof payload.refresh_token !== "string" ||
    !payload.refresh_token.trim() ||
    typeof payload.token_type !== "string" ||
    payload.token_type.toLowerCase() !== "bearer" ||
    expires === undefined
  ) {
    throw new Error("Kimi returned invalid sign-in credentials. Start sign-in again.");
  }
  return { access: payload.access_token, refresh: payload.refresh_token, expires };
}

function parseDevice(payload: Record<string, unknown>) {
  const expires = expiresAt(payload.expires_in);
  const interval = positiveSecondsToSafeMilliseconds(payload.interval ?? 5);
  if (
    typeof payload.device_code !== "string" ||
    !payload.device_code.trim() ||
    typeof payload.user_code !== "string" ||
    !payload.user_code.trim() ||
    typeof payload.verification_uri_complete !== "string" ||
    expires === undefined ||
    interval === undefined ||
    interval > MAX_TIMER_TIMEOUT_MS
  ) {
    throw new Error("Kimi returned an invalid device code. Start sign-in again.");
  }
  let url: URL;
  try {
    url = new URL(payload.verification_uri_complete);
  } catch {
    throw new Error("Kimi returned an invalid sign-in page.");
  }
  if (url.origin !== "https://www.kimi.com" || url.username || url.password) {
    throw new Error("Kimi returned an invalid sign-in page.");
  }
  return {
    deviceCode: payload.device_code,
    userCode: payload.user_code,
    url: url.href,
    expires,
    interval,
  };
}

export async function loginKimiDeviceCode(ctx: ProviderAuthContext): Promise<ProviderAuthResult> {
  const assertCurrent = () => {
    throwIfOAuthLoginAborted(ctx.signal);
    ctx.assertCurrent?.();
  };
  const progress = ctx.prompter.progress("Starting Kimi sign-in…");
  let completed = false;
  try {
    assertCurrent();
    const device = parseDevice(
      await request("device_authorization", {}, { signal: ctx.signal, assertCurrent }),
    );
    assertCurrent();
    await ctx.openUrl(device.url);
    assertCurrent();
    if (ctx.prompter.deviceCode) {
      await ctx.prompter.deviceCode({
        title: "Kimi sign-in",
        code: device.userCode,
        expiresInMinutes: Math.ceil((device.expires - Date.now()) / 60_000),
        message: "Enter this one-time code to sign in to Kimi Code.",
      });
    } else {
      await ctx.prompter.note(`Open <${device.url}>\nCode: ${device.userCode}`, "Kimi sign-in");
    }
    progress.update("Waiting for Kimi approval…");
    let interval = device.interval;
    while (Date.now() < device.expires) {
      await sleep(Math.min(interval, device.expires - Date.now()), ctx.signal);
      assertCurrent();
      const remaining = device.expires - Date.now();
      if (remaining <= 0) {
        break;
      }
      let payload: Record<string, unknown>;
      try {
        payload = await request(
          "token",
          {
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: device.deviceCode,
          },
          { signal: ctx.signal, assertCurrent, timeoutMs: Math.min(REQUEST_TIMEOUT_MS, remaining) },
        );
      } catch (error) {
        assertCurrent();
        if (!(error instanceof KimiOAuthError)) {
          throw error;
        }
        if (error.code === "authorization_pending") {
          continue;
        }
        if (error.code === "slow_down") {
          interval = Math.min(interval + 5000, MAX_TIMER_TIMEOUT_MS);
          continue;
        }
        if (error.code === "access_denied") {
          throw new Error("Kimi sign-in was denied. Start sign-in again when ready.", {
            cause: error,
          });
        }
        if (error.code === "expired_token") {
          break;
        }
        throw error;
      }
      assertCurrent();
      if (Date.now() >= device.expires) {
        break;
      }
      const credential = parseCredentials(payload);
      const result = buildOauthProviderAuthResult({
        providerId: "kimi",
        defaultModel: KIMI_MODEL_REF,
        ...credential,
        configPatch: applyKimiProviderConnectionConfig(ctx.config),
      });
      assertCurrent();
      completed = true;
      return result;
    }
    throw new Error("Kimi device code expired. Start sign-in again.");
  } finally {
    progress.stop(completed ? "Kimi sign-in complete" : "Kimi sign-in stopped");
  }
}

export async function refreshKimiOAuth(credential: OAuthCredential): Promise<OAuthCredential> {
  if (!credential.refresh.trim()) {
    throw new Error("Kimi refresh token is missing. Start sign-in again.");
  }
  const payload = await request("token", {
    grant_type: "refresh_token",
    refresh_token: credential.refresh,
  });
  return { ...credential, ...parseCredentials(payload) };
}
