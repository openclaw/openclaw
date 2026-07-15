// Slack plugin module implements probe behavior.
import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import { createSlackWebClient } from "./client.js";
import { formatSlackError } from "./errors.js";
import { formatSlackBotTokenIdentityWarning } from "./token.js";

export type SlackProbe = BaseProbeResult & {
  status?: number | null;
  elapsedMs?: number | null;
  bot?: { id?: string; name?: string };
  team?: { id?: string; name?: string };
  warning?: string;
};

export async function probeSlack(
  token: string,
  timeoutMs = 2500,
  opts?: { accountId?: string | null },
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
    const warning = formatSlackBotTokenIdentityWarning({
      auth: result,
      accountId: opts?.accountId,
    });
    return {
      ok: true,
      status: 200,
      elapsedMs: Date.now() - start,
      bot: { id: result.user_id, name: result.user },
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
