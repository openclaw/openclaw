/**
 * Agent harness prompt and compaction hook helpers.
 *
 * Harness runtimes use this to run plugin hooks around prompt construction and
 * compaction while keeping hook failures non-fatal.
 */
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type {
  PluginHookBeforeAgentStartResult,
  PluginHookBeforePromptBuildResult,
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
<<<<<<< HEAD
  /** Span within prompt containing the original prompt input. */
  promptInputRange?: { start: number; end: number };
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
};

/** Runs before-prompt hooks and returns the adjusted prompt fields. */
export async function resolveAgentHarnessBeforePromptBuildResult(params: {
  prompt: string;
  developerInstructions: string;
  messages: unknown[];
  ctx: AgentHarnessHookContext;
<<<<<<< HEAD
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
  if (
    !hasPrecomputedBeforeAgentStartResult &&
    !hasHeartbeatContribution &&
    !hookRunner?.hasHooks("before_prompt_build") &&
    !hookRunner?.hasHooks("before_agent_start")
  ) {
    return {
      prompt: params.prompt,
      developerInstructions: params.developerInstructions,
      promptInputRange: { start: 0, end: params.prompt.length },
=======
}): Promise<AgentHarnessPromptBuildResult> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_prompt_build") && !hookRunner?.hasHooks("before_agent_start")) {
    return {
      prompt: params.prompt,
      developerInstructions: params.developerInstructions,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    };
  }
  const hookCtx = buildAgentHookContext(params.ctx);
  const promptEvent = {
    prompt: params.prompt,
    messages: params.messages,
  };

<<<<<<< HEAD
  // Match the embedded runner's lifecycle order: heartbeat contributions are
  // collected before prompt-build hooks so hook side effects stay deterministic.
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
=======
  // Support the newer before_prompt_build hook plus the deprecated
  // before_agent_start hook during the prompt-build migration window.
  const promptBuildResult = hookRunner.hasHooks("before_prompt_build")
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    ? await hookRunner.runBeforePromptBuild(promptEvent, hookCtx).catch((error: unknown) => {
        log.warn(`before_prompt_build hook failed: ${String(error)}`);
        return undefined;
      })
    : undefined;
<<<<<<< HEAD
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
=======
  const beforeAgentStartResult = hookRunner.hasHooks("before_agent_start")
    ? await hookRunner.runBeforeAgentStart(promptEvent, hookCtx).catch((error: unknown) => {
        log.warn(`deprecated before_agent_start hook failed during prompt build: ${String(error)}`);
        return undefined;
      })
    : undefined;
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

  const systemPrompt = resolvePromptBuildSystemPrompt({
    developerInstructions: params.developerInstructions,
    promptBuildResult,
    beforeAgentStartResult,
  });
<<<<<<< HEAD
  const promptPrefix = joinPresentTextSegments([
    heartbeatResult?.prependContext,
    promptBuildResult?.prependContext,
    beforeAgentStartResult?.prependContext,
  ]);
  const promptSuffix = joinPresentTextSegments([
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
=======
  return {
    prompt:
      joinPresentTextSegments([
        promptBuildResult?.prependContext,
        beforeAgentStartResult?.prependContext,
        params.prompt,
      ]) ?? params.prompt,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    developerInstructions:
      joinPresentTextSegments([
        wrapPluginSystemContextSection(promptBuildResult?.prependSystemContext),
        wrapPluginSystemContextSection(beforeAgentStartResult?.prependSystemContext),
        systemPrompt,
        wrapPluginSystemContextSection(promptBuildResult?.appendSystemContext),
        wrapPluginSystemContextSection(beforeAgentStartResult?.appendSystemContext),
      ]) ?? systemPrompt,
<<<<<<< HEAD
    promptInputRange: {
      start: promptInputStart,
      end: promptInputStart + params.prompt.length,
    },
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
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
<<<<<<< HEAD
  messages?: AgentMessage[];
=======
  messages: AgentMessage[];
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  ctx: AgentHarnessHookContext;
}): Promise<void> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_compaction")) {
    return;
  }
  try {
    await hookRunner.runBeforeCompaction(
      {
<<<<<<< HEAD
        messageCount: params.messages?.length ?? -1,
        ...(params.messages ? { messages: params.messages } : {}),
=======
        messageCount: params.messages.length,
        messages: params.messages,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
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
<<<<<<< HEAD
  messages?: AgentMessage[];
=======
  messages: AgentMessage[];
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
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
<<<<<<< HEAD
        messageCount: params.messages?.length ?? -1,
=======
        messageCount: params.messages.length,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
        compactedCount: params.compactedCount,
        sessionFile: params.sessionFile,
      },
      buildAgentHookContext(params.ctx),
    );
  } catch (error) {
    log.warn(`after_compaction hook failed: ${String(error)}`);
  }
}
