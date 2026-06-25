/**
 * Agent harness prompt and compaction hook helpers.
 *
 * Harness runtimes use this to run plugin hooks around prompt construction and
 * compaction while keeping hook failures non-fatal.
 */
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { drainPluginNextTurnInjectionContext } from "../../plugins/host-hook-state.js";
import type {
  PluginAgentTurnPrepareResult,
  PluginHookBeforeAgentStartResult,
  PluginHookBeforePromptBuildResult,
  PluginNextTurnInjectionRecord,
} from "../../plugins/types.js";
import { joinPresentTextSegments } from "../../shared/text/join-segments.js";
import { wrapPluginSystemContextSection } from "../hook-system-context-boundary.js";
import type { AgentMessage } from "../runtime/index.js";
import { buildAgentHookContext, type AgentHarnessHookContext } from "./hook-context.js";

const log = createSubsystemLogger("agents/harness");

/** Prompt/developer-instruction pair after harness prompt-build hooks run. */
type AgentHarnessPromptBuildResult = {
  prompt: string;
  developerInstructions: string;
  /** Span within prompt containing the original prompt input. */
  promptInputRange?: { start: number; end: number };
};

// Cache drained next-turn injections by runId so retry attempts within the
// same run reuse the first-attempt drain rather than calling drain again
// (which destructively consumes from the session store and would return [] on
// retry, dropping injection context).
const PROMPT_BUILD_DRAIN_CACHE_MAX = 256;
const promptBuildDrainCache = new Map<string, PluginNextTurnInjectionRecord[]>();

function rememberDrainedInjections(
  runId: string,
  injections: PluginNextTurnInjectionRecord[],
): void {
  if (promptBuildDrainCache.has(runId)) {
    promptBuildDrainCache.delete(runId);
  } else if (promptBuildDrainCache.size >= PROMPT_BUILD_DRAIN_CACHE_MAX) {
    const oldest = promptBuildDrainCache.keys().next().value;
    if (oldest !== undefined) {
      promptBuildDrainCache.delete(oldest);
    }
  }
  promptBuildDrainCache.set(runId, injections);
}

/**
 * Releases the per-run drained-injection cache. Call when a run terminates so
 * the cap stays headroom for active runs.
 */
export function forgetHarnessPromptBuildDrainCacheForRun(runId: string | undefined): void {
  if (runId) {
    promptBuildDrainCache.delete(runId);
  }
}

/** Runs before-prompt hooks and returns the adjusted prompt fields. */
export async function resolveAgentHarnessBeforePromptBuildResult(params: {
  prompt: string;
  developerInstructions: string;
  messages: unknown[];
  ctx: AgentHarnessHookContext;
  beforeAgentStartResult?: PluginHookBeforeAgentStartResult;
}): Promise<AgentHarnessPromptBuildResult> {
  const hookRunner = getGlobalHookRunner();
  const hasPrecomputedBeforeAgentStartResult = "beforeAgentStartResult" in params;
  // heartbeat_prompt_contribution fires only on heartbeat turns. Harness runtimes
  // (e.g. the Codex app-server) build the prompt through this helper rather than
  // the embedded runner's resolvePromptBuildHookResult, so the hook must run from
  // here too — otherwise it never fires on those runtimes.
  const isHeartbeatTurn = params.ctx.trigger === "heartbeat";
  const hasHeartbeatContribution =
    isHeartbeatTurn && Boolean(hookRunner?.hasHooks("heartbeat_prompt_contribution"));
  // agent_turn_prepare was also missing from the harness path (#96233 added
  // heartbeat_prompt_contribution; this adds the remaining two contributions
  // the embedded path runs — agent_turn_prepare and queued injections).
  const hasAgentTurnPrepare =
    Boolean(hookRunner?.runAgentTurnPrepare) && Boolean(hookRunner?.hasHooks("agent_turn_prepare"));
  const hasQueuedInjections = Boolean(params.ctx.config && params.ctx.sessionKey);
  if (
    !hasPrecomputedBeforeAgentStartResult &&
    !hasHeartbeatContribution &&
    !hasAgentTurnPrepare &&
    !hasQueuedInjections &&
    !hookRunner?.hasHooks("before_prompt_build") &&
    !hookRunner?.hasHooks("before_agent_start")
  ) {
    return {
      prompt: params.prompt,
      developerInstructions: params.developerInstructions,
      promptInputRange: { start: 0, end: params.prompt.length },
    };
  }
  const hookCtx = buildAgentHookContext(params.ctx);
  const promptEvent = {
    prompt: params.prompt,
    messages: params.messages,
  };

  // Drain queued next-turn injections once per run (cached for retries)
  // so plugins that enqueue context for the next turn surface it on harness
  // runtimes, matching the embedded runner's lifecycle.
  const runId = params.ctx.runId;
  const cachedInjections = runId ? promptBuildDrainCache.get(runId) : undefined;
  const hasConfigAndSession = Boolean(params.ctx.config && params.ctx.sessionKey);
  const queuedContext = cachedInjections
    ? {
        queuedInjections: cachedInjections,
        ...buildPluginAgentTurnPrepareContext({ queuedInjections: cachedInjections }),
      }
    : hasConfigAndSession
      ? await drainPluginNextTurnInjectionContext({
          cfg: params.ctx.config!,
          sessionKey: params.ctx.sessionKey,
        })
      : { queuedInjections: [] as PluginNextTurnInjectionRecord[] };
  if (runId && !cachedInjections && queuedContext.queuedInjections.length > 0) {
    rememberDrainedInjections(runId, queuedContext.queuedInjections);
  }

  // Match the embedded runner's lifecycle order: queued injections first,
  // then agent_turn_prepare, then heartbeat contributions, then prompt-build
  // hooks so hook side effects stay deterministic.
  const turnPrepareResult: PluginAgentTurnPrepareResult | undefined =
    hasAgentTurnPrepare && hookRunner
      ? await hookRunner
          .runAgentTurnPrepare?.(
            {
              prompt: params.prompt,
              messages: params.messages,
              queuedInjections: queuedContext.queuedInjections,
            },
            hookCtx,
          )
          .catch((error: unknown) => {
            log.warn(`agent_turn_prepare hook failed: ${String(error)}`);
            return undefined;
          })
      : undefined;

  const heartbeatResult =
    hasHeartbeatContribution && hookRunner
      ? await hookRunner
          .runHeartbeatPromptContribution(
            {
              sessionKey: params.ctx.sessionKey,
              agentId: params.ctx.agentId,
              heartbeatName: "heartbeat",
            },
            hookCtx,
          )
          .catch((error: unknown) => {
            log.warn(`heartbeat_prompt_contribution hook failed: ${String(error)}`);
            return undefined;
          })
      : undefined;

  // Support the newer before_prompt_build hook plus the deprecated
  // before_agent_start hook during the prompt-build migration window.
  const promptBuildResult = hookRunner?.hasHooks("before_prompt_build")
    ? await hookRunner.runBeforePromptBuild(promptEvent, hookCtx).catch((error: unknown) => {
        log.warn(`before_prompt_build hook failed: ${String(error)}`);
        return undefined;
      })
    : undefined;
  // The runner resolves before_agent_start during model selection. Reuse that
  // result so legacy one-shot hooks do not run twice for the same turn.
  const beforeAgentStartResult = hasPrecomputedBeforeAgentStartResult
    ? params.beforeAgentStartResult
    : hookRunner?.hasHooks("before_agent_start")
      ? await hookRunner.runBeforeAgentStart(promptEvent, hookCtx).catch((error: unknown) => {
          log.warn(
            `deprecated before_agent_start hook failed during prompt build: ${String(error)}`,
          );
          return undefined;
        })
      : undefined;

  const systemPrompt = resolvePromptBuildSystemPrompt({
    developerInstructions: params.developerInstructions,
    promptBuildResult,
    beforeAgentStartResult,
  });
  // Queued-injection context and agent_turn_prepare results are prepended
  // before prompt-build and heartbeat contributions so plugins that touch
  // system instructions do not shift the prompt layout unexpectedly.
  const promptPrefix = joinPresentTextSegments([
    queuedContext.prependContext,
    turnPrepareResult?.prependContext,
    heartbeatResult?.prependContext,
    promptBuildResult?.prependContext,
    beforeAgentStartResult?.prependContext,
  ]);
  const promptSuffix = joinPresentTextSegments([
    queuedContext.appendContext,
    turnPrepareResult?.appendContext,
    heartbeatResult?.appendContext,
    promptBuildResult?.appendContext,
    beforeAgentStartResult?.appendContext,
  ]);
  const prompt =
    joinPresentTextSegments([promptPrefix, params.prompt, promptSuffix]) ?? params.prompt;
  const promptInputStart =
    params.prompt.length === 0
      ? (promptPrefix?.length ?? 0)
      : promptPrefix
        ? promptPrefix.length + 2
        : 0;
  return {
    prompt,
    developerInstructions:
      joinPresentTextSegments([
        wrapPluginSystemContextSection(queuedContext.prependSystemContext),
        wrapPluginSystemContextSection(turnPrepareResult?.prependSystemContext),
        wrapPluginSystemContextSection(promptBuildResult?.prependSystemContext),
        wrapPluginSystemContextSection(beforeAgentStartResult?.prependSystemContext),
        systemPrompt,
        wrapPluginSystemContextSection(queuedContext.appendSystemContext),
        wrapPluginSystemContextSection(turnPrepareResult?.appendSystemContext),
        wrapPluginSystemContextSection(promptBuildResult?.appendSystemContext),
        wrapPluginSystemContextSection(beforeAgentStartResult?.appendSystemContext),
      ]) ?? systemPrompt,
    promptInputRange: {
      start: promptInputStart,
      end: promptInputStart + params.prompt.length,
    },
  };
}

function resolvePromptBuildSystemPrompt(params: {
  developerInstructions: string;
  promptBuildResult?: PluginHookBeforePromptBuildResult;
  beforeAgentStartResult?: PluginHookBeforeAgentStartResult;
}): string {
  if (typeof params.promptBuildResult?.systemPrompt === "string") {
    return params.promptBuildResult.systemPrompt;
  }
  if (typeof params.beforeAgentStartResult?.systemPrompt === "string") {
    return params.beforeAgentStartResult.systemPrompt;
  }
  return params.developerInstructions;
}

/** Runs best-effort before-compaction hooks for a harness session. */
export async function runAgentHarnessBeforeCompactionHook(params: {
  sessionFile: string;
  messages?: AgentMessage[];
  ctx: AgentHarnessHookContext;
}): Promise<void> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_compaction")) {
    return;
  }
  try {
    await hookRunner.runBeforeCompaction(
      {
        messageCount: params.messages?.length ?? -1,
        ...(params.messages ? { messages: params.messages } : {}),
        sessionFile: params.sessionFile,
      },
      buildAgentHookContext(params.ctx),
    );
  } catch (error) {
    log.warn(`before_compaction hook failed: ${String(error)}`);
  }
}

/** Runs best-effort after-compaction hooks for a harness session. */
export async function runAgentHarnessAfterCompactionHook(params: {
  sessionFile: string;
  messages?: AgentMessage[];
  ctx: AgentHarnessHookContext;
  compactedCount: number;
}): Promise<void> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("after_compaction")) {
    return;
  }
  try {
    await hookRunner.runAfterCompaction(
      {
        messageCount: params.messages?.length ?? -1,
        compactedCount: params.compactedCount,
        sessionFile: params.sessionFile,
      },
      buildAgentHookContext(params.ctx),
    );
  } catch (error) {
    log.warn(`after_compaction hook failed: ${String(error)}`);
  }
}
