import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { HookRunner } from "../plugins/hooks.js";
import { drainPluginNextTurnInjectionContext } from "../plugins/host-hook-state.js";
import { buildPluginAgentTurnPrepareContext } from "../plugins/host-hooks.js";
import type {
  PluginAgentTurnPrepareResult,
  PluginHookAgentContext,
  PluginNextTurnInjectionRecord,
} from "../plugins/types.js";
import { joinPresentTextSegments } from "../shared/text/join-segments.js";

const log = createSubsystemLogger("agents/plugin-turn-context");

// Draining consumes durable injections. Retain them for retries of the same run.
const PROMPT_BUILD_DRAIN_CACHE_MAX = 256;
const promptBuildDrainCache = new Map<string, PluginNextTurnInjectionRecord[]>();

/** Release at run termination so active retries retain cache headroom. */
export function forgetPromptBuildDrainCacheForRun(runId: string | undefined): void {
  if (runId) {
    promptBuildDrainCache.delete(runId);
  }
}

/** Collect queued context before prepare, heartbeat, and prompt-build hooks. */
export async function resolvePluginTurnContext(params: {
  config: OpenClawConfig;
  prompt: string;
  messages: unknown[];
  hookCtx: PluginHookAgentContext;
  hookRunner?:
    | (Partial<Pick<HookRunner, "runAgentTurnPrepare">> & {
        hasHooks: (hookName: "agent_turn_prepare") => boolean;
      })
    | null;
}): Promise<PluginAgentTurnPrepareResult> {
  const runId = params.hookCtx.runId;
  const cachedInjections = runId ? promptBuildDrainCache.get(runId) : undefined;
  const queuedContext = cachedInjections
    ? {
        queuedInjections: cachedInjections,
        ...buildPluginAgentTurnPrepareContext({ queuedInjections: cachedInjections }),
      }
    : await drainPluginNextTurnInjectionContext({
        cfg: params.config,
        sessionKey: params.hookCtx.sessionKey,
        agentId: params.hookCtx.agentId,
      });
  if (runId && !cachedInjections) {
    promptBuildDrainCache.delete(runId);
    pruneMapToMaxSize(promptBuildDrainCache, PROMPT_BUILD_DRAIN_CACHE_MAX - 1);
    promptBuildDrainCache.set(runId, queuedContext.queuedInjections);
  }
  const turnPrepareResult =
    params.hookRunner?.runAgentTurnPrepare && params.hookRunner.hasHooks("agent_turn_prepare")
      ? await params.hookRunner
          .runAgentTurnPrepare(
            {
              prompt: params.prompt,
              messages: params.messages,
              queuedInjections: queuedContext.queuedInjections,
            },
            params.hookCtx,
          )
          .catch((error: unknown) => {
            log.warn(`agent_turn_prepare hook failed: ${String(error)}`);
            return undefined;
          })
      : undefined;
  return {
    prependContext: joinPresentTextSegments([
      queuedContext.prependContext,
      turnPrepareResult?.prependContext,
    ]),
    appendContext: joinPresentTextSegments([
      queuedContext.appendContext,
      turnPrepareResult?.appendContext,
    ]),
  };
}
