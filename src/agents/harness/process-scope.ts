import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";

/** Bind a plugin harness to cancellation authority for only its current process scope. */
export function bindAgentHarnessProcessScope(
  params: EmbeddedRunAttemptParams,
): EmbeddedRunAttemptParams {
  const scopeKey =
    params.sandboxSessionKey?.trim() || params.sessionKey?.trim() || params.sessionId;
  params.hostProcessScope = {
    cancelAndWait: async ({ timeoutMs }) => {
      const { getProcessSupervisor } = await import("../../process/supervisor/index.js");
      await getProcessSupervisor().cancelScopeAndWait(scopeKey, {
        reason: "manual-cancel",
        timeoutMs,
      });
    },
  };
  return params;
}
