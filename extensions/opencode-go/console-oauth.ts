/**
 * OpenCode Console browser sign-in (device authorization) for the `opencode-go` provider.
 * OpenClaw signs in as its own Console client, `openclaw`, so it never shares or impersonates
 * the OpenCode Console CLI's sign-in. Console refresh tokens are single-use: reusing one revokes
 * the whole sign-in, so each credential owns exactly one refresh chain. This plugin and the
 * `opencode` plugin each sign in separately for that reason, and keep their own copy of this file
 * because plugins cannot share private code.
 */
import {
  MAX_TIMER_TIMEOUT_MS,
  positiveSecondsToSafeMilliseconds,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import type { OAuthCredential } from "openclaw/plugin-sdk/provider-auth";
import { readProviderJsonObjectResponse } from "openclaw/plugin-sdk/provider-http";
import {
  createOAuthRefreshError,
  createOAuthRefreshResponseError,
  type OAuthCredentials,
  throwIfOAuthLoginAborted,
} from "openclaw/plugin-sdk/provider-oauth-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { asFiniteNumberInRange } from "openclaw/plugin-sdk/string-coerce-runtime";
import { sleep } from "openclaw/plugin-sdk/text-utility-runtime";

const CONSOLE_ORIGIN = "https://opencode.ai";
const CONSOLE_URL = `${CONSOLE_ORIGIN}/console`;
const CLIENT_ID = "openclaw";
const REQUEST_TIMEOUT_MS = 30_000;

class OpencodeConsoleOAuthError extends Error {
  readonly code: string | undefined;

  constructor(code: unknown, status: number) {
    super(`OpenCode Console sign-in request failed (HTTP ${status}). Retry sign-in.`);
    this.code =
      typeof code === "string" &&
      ["authorization_pending", "slow_down", "access_denied", "expired_token"].includes(code)
        ? code
        : undefined;
  }
}

async function postConsoleJson(
  endpoint: "code" | "token",
  fields: Record<string, string | boolean>,
  signal?: AbortSignal,
  beforeRequest?: () => void,
): Promise<Record<string, unknown>> {
  const { response, release } = await fetchWithSsrFGuard({
    url: `${CONSOLE_URL}/auth/device/${endpoint}`,
    init: {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID, ...fields }),
    },
    signal,
    beforeRequest,
    timeoutMs: REQUEST_TIMEOUT_MS,
    requireHttps: true,
    policy: { hostnameAllowlist: ["opencode.ai"] },
    auditContext: `opencode-go.console-oauth.${endpoint}`,
  });
  try {
    const payload = await readProviderJsonObjectResponse(response, "OpenCode Console sign-in", {
      maxBytes: 64 * 1024,
      // Suppress JSON parser causes, which can contain credential bytes.
      requestHeaders: {},
    });
    if (!response.ok || payload.error !== undefined) {
      if (fields.grant_type === "refresh_token") {
        throw createOAuthRefreshResponseError(
          "OpenCode Console sign-in refresh",
          response.status,
          payload,
        );
      }
      throw new OpencodeConsoleOAuthError(payload.error, response.status);
    }
    return payload;
  } finally {
    await release();
  }
}

/** Console rotates the refresh token on every refresh; the previous one is never reusable. */
function parseToken(payload: Record<string, unknown>): OAuthCredentials {
  const lifetimeMs = positiveSecondsToSafeMilliseconds(payload.expires_in);
  const expires =
    lifetimeMs === undefined
      ? undefined
      : resolveExpiresAtMsFromDurationMs(lifetimeMs, {
          bufferMs: Math.min(5 * 60_000, Math.floor(lifetimeMs / 2)),
        });
  if (
    typeof payload.access_token !== "string" ||
    !payload.access_token.trim() ||
    typeof payload.refresh_token !== "string" ||
    !payload.refresh_token.trim() ||
    expires === undefined
  ) {
    throw new Error("OpenCode Console returned invalid credentials. Retry sign-in.");
  }
  return { access: payload.access_token, refresh: payload.refresh_token, expires };
}

export async function loginOpencodeConsole(ctx: ProviderAuthContext): Promise<OAuthCredentials> {
  const assertCurrent = () => {
    throwIfOAuthLoginAborted(ctx.signal);
    ctx.assertCurrent?.();
  };
  assertCurrent();
  const payload = await postConsoleJson(
    "code",
    { supports_org_scope: true },
    ctx.signal,
    assertCurrent,
  );
  assertCurrent();
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
  const pollMs = intervalSeconds === undefined ? undefined : Math.ceil(intervalSeconds * 1000);
  const link =
    typeof payload.verification_uri_complete === "string"
      ? payload.verification_uri_complete
      : payload.verification_uri;
  if (
    typeof payload.device_code !== "string" ||
    !payload.device_code.trim() ||
    typeof payload.user_code !== "string" ||
    !payload.user_code.trim() ||
    typeof link !== "string" ||
    expiresAt === undefined ||
    pollMs === undefined ||
    pollMs > MAX_TIMER_TIMEOUT_MS
  ) {
    throw new Error("OpenCode Console returned an invalid device authorization response.");
  }
  // Console answers with a path on its own origin; approving anywhere else would sign in for another site.
  const url = URL.parse(link, `${CONSOLE_URL}/`);
  if (!url || url.origin !== CONSOLE_ORIGIN || url.username || url.password) {
    throw new Error("OpenCode Console returned an invalid verification URL.");
  }
  const { device_code: deviceCode, user_code: userCode } = payload;
  if (ctx.prompter.deviceCode) {
    await ctx.openUrl(url.href);
    await ctx.prompter.deviceCode({
      title: "OpenCode Console sign-in",
      code: userCode,
      expiresInMinutes: Math.ceil((expiresAt - Date.now()) / 60_000),
      message: "Confirm this code, then pick the workspace OpenClaw should use.",
    });
  } else {
    await ctx.prompter.note(
      `Open ${url.href}, confirm code ${userCode}, and pick a workspace.`,
      "OpenCode Console sign-in",
    );
  }
  assertCurrent();
  if (!ctx.isRemote && !ctx.prompter.deviceCode) {
    try {
      await ctx.openUrl(url.href);
    } catch {
      // The displayed URL remains usable when this host cannot launch a browser.
    }
    assertCurrent();
  }
  const progress = ctx.prompter.progress("Waiting for OpenCode Console approval…");
  let completed = false;
  try {
    let intervalMs = pollMs;
    while (Date.now() < expiresAt) {
      await sleep(Math.min(intervalMs, expiresAt - Date.now()), ctx.signal);
      assertCurrent();
      if (Date.now() >= expiresAt) {
        break;
      }
      try {
        const token = await postConsoleJson(
          "token",
          { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode },
          ctx.signal,
          assertCurrent,
        );
        assertCurrent();
        const credentials = parseToken(token);
        completed = true;
        return credentials;
      } catch (error) {
        assertCurrent();
        if (!(error instanceof OpencodeConsoleOAuthError)) {
          throw error;
        }
        switch (error.code) {
          case "authorization_pending":
            break;
          case "slow_down":
            intervalMs = Math.min(intervalMs + 5_000, MAX_TIMER_TIMEOUT_MS);
            break;
          case "access_denied":
            throw new Error("OpenCode Console sign-in was denied. Retry sign-in when ready.", {
              cause: error,
            });
          case "expired_token":
            throw new Error("OpenCode Console sign-in code expired. Start sign-in again.", {
              cause: error,
            });
          default:
            throw error;
        }
      }
    }
    throw new Error("OpenCode Console sign-in code expired. Start sign-in again.");
  } finally {
    progress.stop(
      completed ? "OpenCode Console sign-in complete" : "OpenCode Console sign-in stopped",
    );
  }
}

export async function refreshOpencodeConsoleCredential(
  credential: OAuthCredential,
): Promise<OAuthCredential> {
  if (!credential.refresh.trim()) {
    throw new Error("OpenCode Console refresh token is missing. Sign in again.");
  }
  const payload = await postConsoleJson("token", {
    grant_type: "refresh_token",
    refresh_token: credential.refresh,
  });
  try {
    return { ...credential, ...parseToken(payload) };
  } catch (cause) {
    throw createOAuthRefreshError(
      "OpenCode Console refresh returned invalid credentials. Sign in again.",
      { version: 1, phase: "after-token-response", outcome: "unknown" },
      { cause },
    );
  }
}
