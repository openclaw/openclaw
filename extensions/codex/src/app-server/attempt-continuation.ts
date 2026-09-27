import type { EmbeddedRunAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";

/** Resolve the SDK compatibility name without replacing the capability-bound input object. */
export function readCodexContinuationMessages(params: EmbeddedRunAttemptParamsV2) {
  return params.continuationMessages ?? params.pluginRuntimeRefreshMessages;
}
