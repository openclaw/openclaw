import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { withTimeout } from "openclaw/plugin-sdk/text-runtime";
import { createSlackWebClient } from "./client.js";
import {
  formatMissingSlackReadbackScopes,
  resolveMissingSlackReadbackScopes,
  SLACK_READBACK_REQUIRED_SCOPES,
  type SlackScopesResult,
} from "./scopes.js";

export type SlackProbe = BaseProbeResult & {
  status?: number | null;
  elapsedMs?: number | null;
  bot?: { id?: string; name?: string };
  team?: { id?: string; name?: string };
  scopes?: string[];
  readbackRequiredScopes?: string[];
  readbackMissingScopes?: string[];
  readbackState?: "ok" | "missing_scopes";
  readbackError?: string | null;
};

type SlackScopeProbe = (token: string, timeoutMs: number) => Promise<SlackScopesResult>;

async function resolveReadbackScopeProbe(
  token: string,
  timeoutMs: number,
  fetchScopes: SlackScopeProbe,
): Promise<Partial<SlackProbe>> {
  const result = await fetchScopes(token, timeoutMs);
  if (!result.ok) {
    return {
      readbackRequiredScopes: [...SLACK_READBACK_REQUIRED_SCOPES],
      readbackState: "missing_scopes",
      readbackError: result.error ?? "Slack scope lookup failed",
    };
  }
  const missing = resolveMissingSlackReadbackScopes(result.scopes);
  return {
    scopes: result.scopes ?? [],
    readbackRequiredScopes: [...SLACK_READBACK_REQUIRED_SCOPES],
    readbackMissingScopes: missing,
    readbackState: missing.length > 0 ? "missing_scopes" : "ok",
    readbackError: formatMissingSlackReadbackScopes(missing),
  };
}

export async function probeSlack(
  token: string,
  timeoutMs = 2500,
  opts?: { includeScopes?: boolean; fetchScopes?: SlackScopeProbe },
): Promise<SlackProbe> {
  const client = createSlackWebClient(token);
  const start = Date.now();
  try {
    const result = await withTimeout(client.auth.test(), timeoutMs);
    if (!result.ok) {
      return {
        ok: false,
        status: 200,
        error: result.error ?? "unknown",
        elapsedMs: Date.now() - start,
      };
    }
    const readbackScopeProbe = opts?.includeScopes
      ? await resolveReadbackScopeProbe(
          token,
          timeoutMs,
          opts.fetchScopes ?? (await import("./scopes.js")).fetchSlackScopes,
        )
      : {};
    return {
      ok: true,
      status: 200,
      elapsedMs: Date.now() - start,
      bot: { id: result.user_id, name: result.user },
      team: { id: result.team_id, name: result.team },
      ...readbackScopeProbe,
    };
  } catch (err) {
    const message = formatErrorMessage(err);
    const status =
      typeof (err as { status?: number }).status === "number"
        ? (err as { status?: number }).status
        : null;
    return {
      ok: false,
      status,
      error: message,
      elapsedMs: Date.now() - start,
    };
  }
}
