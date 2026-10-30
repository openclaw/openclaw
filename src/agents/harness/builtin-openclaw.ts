import { readGoalContinuationContext } from "../../auto-reply/reply/goal-continuation-return.js";
import type { EmbeddedRunAttemptInternalParams } from "../embedded-agent-runner/run/internal-params.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import { runHostPreparedIsolatedCompletion } from "../host-prepared-isolated-completion.js";
import { BUILTIN_AGENT_HARNESS_METADATA } from "./builtin-openclaw-metadata.js";
import { projectSettledTurnFinalizationAttemptResult } from "./settled-turn-finalization-result.js";
import { harnessSupportsTurnScopedToolRestrictions } from "./types.js";
import type {
  AgentHarness,
  AgentHarnessAttemptParamsV2,
  AgentHarnessSettledTurnFinalizationAttemptParams,
  AgentHarnessV2,
} from "./types.js";

const builtInOpenClawHarnesses = new WeakSet<object>();

function buildRestrictedFinalizationAttempt(
  attempt: AgentHarnessSettledTurnFinalizationAttemptParams<AgentHarnessAttemptParamsV2>,
): EmbeddedRunAttemptInternalParams {
  const internalAttempt =
    attempt as AgentHarnessSettledTurnFinalizationAttemptParams<AgentHarnessAttemptParamsV2> &
      Pick<EmbeddedRunAttemptParams, "admittedRunContext" | "replyOperation">;
  return {
    admittedRunContext: internalAttempt.admittedRunContext,
    // Finalization is another backend attempt of the same admitted turn, so its
    // native registration borrows that turn instead of needing a second admission.
    replyOperation: internalAttempt.replyOperation,
    sessionId: attempt.sessionId,
    sessionKey: attempt.sessionKey,
    sessionTarget: attempt.sessionTarget,
    lifecycleGeneration: attempt.lifecycleGeneration,
    promptCacheKey: attempt.promptCacheKey,
    sandboxSessionKey: attempt.sandboxSessionKey,
    agentId: attempt.agentId,
    workspaceDir: attempt.workspaceDir,
    cwd: attempt.cwd,
    agentDir: attempt.agentDir,
    config: attempt.config,
    prompt: attempt.prompt,
    timeoutMs: attempt.timeoutMs,
    runTimeoutOverrideMs: attempt.runTimeoutOverrideMs,
    runId: attempt.runId,
    abortSignal: attempt.abortSignal,
    onExecutionStarted: attempt.onExecutionStarted,
    onExecutionPhase: attempt.onExecutionPhase,
    onLaneWait: attempt.onLaneWait,
    onRunProgress: attempt.onRunProgress,
    // The caller owns terminal publication across the failed and finalizing attempts.
    onAgentEvent: attempt.onAgentEvent,
    deferTerminalLifecycle: attempt.deferTerminalLifecycle,
    onAttemptTimeoutArmed: attempt.onAttemptTimeoutArmed,
    onAttemptDeadlineChanged: attempt.onAttemptDeadlineChanged,
    onAttemptTimeout: attempt.onAttemptTimeout,
    onAttemptAbort: attempt.onAttemptAbort,
    preparedModelRuntime: attempt.preparedModelRuntime,
    sessionFile: attempt.sessionFile,
    // Host-owned transcript custody: detached runs keep the receipt-bearing manager.
    sessionManager: attempt.sessionManager,
    sessionPersistence: attempt.sessionPersistence,
    prepareAssistantTranscriptMessage: attempt.prepareAssistantTranscriptMessage,
    privateCompletion: attempt.privateCompletion,
    contextTokenBudget: attempt.contextTokenBudget,
    contextWindowInfo: attempt.contextWindowInfo,
    resolvedApiKey: attempt.resolvedApiKey,
    authProfileId: attempt.authProfileId,
    authProfileIdSource: attempt.authProfileIdSource,
    provider: attempt.provider,
    modelId: attempt.modelId,
    requestedModelId: attempt.requestedModelId,
    agentHarnessId: attempt.agentHarnessId,
    runtimePlan: attempt.runtimePlan,
    model: attempt.model,
    authStorage: attempt.authStorage,
    authProfileStore: attempt.authProfileStore,
    toolAuthProfileStore: attempt.toolAuthProfileStore,
    modelRegistry: attempt.modelRegistry,
    thinkLevel: attempt.thinkLevel,
    fastMode: attempt.fastMode,
    fastModeAuto: attempt.fastModeAuto,
    operation: "settled-tool-finalization",
    disableTools: true,
    disableTrajectory: true,
    skipPreparedUserTurnMessage: true,
    suppressNextUserMessagePersistence: true,
    initialReplayState: { replayInvalid: false, hadPotentialSideEffects: false },
  };
}

export function createOpenClawAgentHarness(): AgentHarnessV2 {
  const harness: AgentHarnessV2 = {
    ...BUILTIN_AGENT_HARNESS_METADATA,
    supportsTurnScopedToolRestrictions: true,
    runAttempt: async (params) => {
      const currentInboundContext = readGoalContinuationContext({
        runId: params.runId,
        sessionKey: params.sessionKey,
        currentInboundContext: params.currentInboundContext,
      });
      const attempt = {
        ...(params as EmbeddedRunAttemptParams),
        ...(currentInboundContext ? { currentInboundContext } : {}),
        supportsTurnScopedToolRestrictions: harnessSupportsTurnScopedToolRestrictions(harness),
      };
      // Isolated completions never need the full runner. Capture invocation state before loading it.
      const { runEmbeddedAttempt } = await import("../embedded-agent-runner/run/attempt.js");
      return runEmbeddedAttempt(attempt);
    },
    runIsolatedCompletionV2: runHostPreparedIsolatedCompletion,
    finalizeSettledTurn: async ({ attempt, settledAttempt }) => {
      const context = settledAttempt.settledTurnFinalizationContext;
      const messages =
        context?.source === "openclaw-transcript"
          ? context.messages
          : context === undefined
            ? settledAttempt.messagesSnapshot
            : undefined;
      if (!messages) {
        throw new Error("OpenClaw finalization requires the settled attempt transcript view");
      }
      // Preserve only transcript/model transport state. The operation-specific
      // runner path suppresses every ambient prompt and capability contributor.
      const restrictedAttempt = {
        ...buildRestrictedFinalizationAttempt(attempt),
        settledTurnFinalizationMessages: Object.freeze([...messages]),
      };
      const { runEmbeddedAttempt } = await import("../embedded-agent-runner/run/attempt.js");
      const result = await runEmbeddedAttempt(restrictedAttempt);
      return projectSettledTurnFinalizationAttemptResult(result);
    },
  };
  builtInOpenClawHarnesses.add(harness);
  return harness;
}

/** Distinguishes the internal runtime from an untrusted harness that copies its public id. */
export function isBuiltInOpenClawAgentHarness(harness: AgentHarness): boolean {
  return builtInOpenClawHarnesses.has(harness);
}
