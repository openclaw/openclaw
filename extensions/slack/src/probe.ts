// Slack plugin module implements probe behavior.
import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import { createSlackWebClient } from "./client.js";
import { formatSlackError } from "./errors.js";
import { formatSlackBotTokenIdentityWarning } from "./token.js";

export type SlackProbe = BaseProbeResult & {
  status?: number | null;
  elapsedMs?: number | null;
  bot?: { id?: string; name?: string };
  user?: { id?: string; name?: string };
  team?: { id?: string; name?: string };
  warning?: string;
};

export async function probeSlack(
  token: string,
  timeoutMs = 2500,
  opts?: { accountId?: string | null; identity?: "bot" | "user" },
): Promise<SlackProbe> {
  // Enforce the timeout through the WebClient's own (Axios) request timeout so a
  // slow Slack API aborts the underlying HTTP request and releases the socket,
  // instead of a Promise-race timeout that leaves the request dangling. A single
  // attempt (retries: 0) keeps the probe a fast pass/fail and avoids background
  // retry sockets after the timeout fires. Rate-limit retries are rejected
  // immediately so a 429 does not stall diagnostics through the WebClient's
  // queue pause (issue #106565).
  const client = createSlackWebClient(token, {
    timeout: timeoutMs,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
  });
  const start = Date.now();
  try {
    const result = await client.auth.test();
    if (!result.ok) {
      return {
        ok: false,
        status: 200,
        error: result.error ?? "unknown",
        elapsedMs: Date.now() - start,
      };
    }
    if (opts?.identity === "user") {
      if (result.bot_id?.trim()) {
        return {
          ok: false,
          status: 200,
          error:
            "Slack auth.test identified a bot token; user identity requires a user OAuth token",
          elapsedMs: Date.now() - start,
        };
      }
      const userId = result.user_id?.trim();
      if (!userId) {
        return {
          ok: false,
          status: 200,
          error: "Slack auth.test returned no human user_id for user identity",
          elapsedMs: Date.now() - start,
        };
      }
      return {
        ok: true,
        status: 200,
        elapsedMs: Date.now() - start,
        user: { id: userId, name: result.user },
        team: { id: result.team_id, name: result.team },
      };
    }
    const warning = formatSlackBotTokenIdentityWarning({
      auth: result,
      accountId: opts?.accountId,
    });
    const authIdentity = { id: result.user_id, name: result.user };
    return {
      ok: true,
      status: 200,
      elapsedMs: Date.now() - start,
      bot: authIdentity,
      team: { id: result.team_id, name: result.team },
      ...(warning ? { warning } : {}),
    };
  } catch (err) {
    const message = formatSlackError(err);
    const status =
      typeof (err as { statusCode?: number }).statusCode === "number"
        ? (err as { statusCode?: number }).statusCode
        : null;
    return {
      ok: false,
      status,
      error: message,
      elapsedMs: Date.now() - start,
    };
  }
}
