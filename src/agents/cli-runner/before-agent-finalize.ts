import { AsyncLocalStorage } from "node:async_hooks";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { PluginHookBeforeAgentFinalizeEvent } from "../../plugins/hook-types.js";
import { runAgentHarnessBeforeAgentFinalizeHook } from "../harness/lifecycle-hook-helpers.js";
import type { PreparedCliRunContext } from "./types.js";

type NativeStop = Pick<
  PluginHookBeforeAgentFinalizeEvent,
  "stopHookActive" | "lastAssistantMessage" | "transcriptPath" | "cwd"
>;

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
    // Warm transports retain their first turn's async context, so bind to this turn's plugin scope.
    runBeforeAgentFinalize: AsyncLocalStorage.bind((stop: NativeStop) => {
      assertCurrent();
      return runAgentHarnessBeforeAgentFinalizeHook({
        event: {
          ...stop,
          runId: run.runId,
          sessionId: run.sessionId,
          sessionKey: run.sessionKey,
          provider: run.provider,
          model: context.modelId,
        },
        ctx: {
          agentId: run.agentId,
          sessionId: run.sessionId,
          sessionKey: run.sessionKey,
          runId: run.runId,
          channelId: run.currentChannelId,
          workspaceDir: context.workspaceDir,
          modelId: context.modelId,
        },
      });
    }),
  };
}
