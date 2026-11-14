import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { runAgentHarnessBeforeAgentFinalizeHook } from "../harness/lifecycle-hook-helpers.js";
import type { PreparedCliRunContext } from "./types.js";

/**
 * Host-internal, not in the plugin SDK type: when a plugin registers before_agent_finalize,
 * the bundled Claude runtime relays its native Stop hook through this callback.
 */
export function buildCliBeforeAgentFinalizeRelay(
  context: PreparedCliRunContext,
  assertCurrent: () => void,
) {
  if (!getGlobalHookRunner()?.hasHooks("before_agent_finalize")) {
    return {};
  }
  const run = context.params;
  return {
    runBeforeAgentFinalize: (stop: {
      stopHookActive: boolean;
      lastAssistantMessage?: string;
      transcriptPath?: string;
      cwd?: string;
    }) => {
      assertCurrent();
      return runAgentHarnessBeforeAgentFinalizeHook({
        event: {
          ...stop,
          runId: run.runId,
          sessionId: run.sessionId,
          ...(run.sessionKey ? { sessionKey: run.sessionKey } : {}),
          provider: run.provider,
          model: context.modelId,
        },
        ctx: {
          ...(run.agentId ? { agentId: run.agentId } : {}),
          sessionId: run.sessionId,
          ...(run.sessionKey ? { sessionKey: run.sessionKey } : {}),
          runId: run.runId,
          ...(run.currentChannelId ? { channelId: run.currentChannelId } : {}),
          workspaceDir: context.workspaceDir,
          modelId: context.modelId,
        },
      });
    },
  };
}
