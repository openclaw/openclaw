import { formatErrorMessage } from "../../../infra/errors.js";
import {
  retireSessionMcpRuntime,
  retireSessionMcpRuntimeForSessionKey,
} from "../../agent-bundle-mcp-tools.js";
import { runAgentCleanupStep } from "../../run-cleanup-timeout.js";

type EmbeddedRunCleanupLogger = {
  warn(message: string): void;
};

export async function cleanupEmbeddedRunBundleMcpRuntime(params: {
  enabled: boolean;
  runId: string;
  sessionId: string;
  sessionKey?: string;
  log: EmbeddedRunCleanupLogger;
}): Promise<void> {
  if (!params.enabled) {
    return;
  }
  await runAgentCleanupStep({
    runId: params.runId,
    sessionId: params.sessionId,
    step: "bundle-mcp-retire",
    log: params.log,
    cleanup: async () => {
      const onError = (errorLocal: unknown, sessionId: string) => {
        params.log.warn(
          `bundle-mcp cleanup failed after run for ${sessionId}: ${formatErrorMessage(errorLocal)}`,
        );
      };
      const retiredBySessionKey = params.sessionKey
        ? await retireSessionMcpRuntimeForSessionKey({
            sessionKey: params.sessionKey,
            reason: "embedded-run-end",
            // MCP App views hold bounded leases so their bridge can remain usable
            // after a one-shot gateway run returns.
            preserveActiveLeases: true,
            onError,
          })
        : false;
      if (!retiredBySessionKey) {
        await retireSessionMcpRuntime({
          sessionId: params.sessionId,
          reason: "embedded-run-end",
          preserveActiveLeases: true,
          onError,
        });
      }
    },
  });
}
