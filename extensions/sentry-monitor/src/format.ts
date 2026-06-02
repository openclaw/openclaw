// Pure formatting/guard helpers for the Sentry monitor. Kept free of Sentry and
// host imports so they stay unit-testable in isolation.

import type { PluginHookModelCallEndedEvent } from "openclaw/plugin-sdk/types";

// safe wraps a synchronous handler body so a bug in our reporting code can't
// take down the host gateway. The whole point of this plugin is to surface
// errors, not introduce new ones.
export function safe(
  logger: { error: (m: string) => void },
  pluginId: string,
  hook: string,
  fn: () => void,
): void {
  try {
    fn();
  } catch (err) {
    logger.error(`${pluginId}: handler for ${hook} threw — ${stringifyErr(err)}`);
  }
}

export function describeModelCallError(event: PluginHookModelCallEndedEvent): string {
  const parts = [
    event.errorCategory,
    event.failureKind ? `failure_kind=${event.failureKind}` : undefined,
  ].filter(Boolean);
  return parts.length > 0
    ? `model_call_ended: ${parts.join(", ")}`
    : "model_call_ended outcome=error";
}

export function runContext(
  runId?: string,
  sessionId?: string,
  callId?: string,
): Record<string, string | undefined> | undefined {
  if (!runId && !sessionId && !callId) {
    return undefined;
  }
  return { run_id: runId, session_id: sessionId, call_id: callId };
}

// Sentry tag values must be string-coercible and non-empty; drop undefined,
// null, and empty keys so each capture reads cleanly.
export function pruneTags(tags: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) {
    if (v !== undefined && v !== null && v !== "") {
      out[k] = v;
    }
  }
  return out;
}

export function stringifyErr(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
