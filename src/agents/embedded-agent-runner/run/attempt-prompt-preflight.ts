import { CompactionReplayRefreshRequiredError } from "@openclaw/ai/transports";
import type { AssembleResult } from "../../../context-engine/types.js";
import type { AgentRunAttemptFailureSource } from "../../agent-run-terminal-outcome.js";
import { sanitizeCompactionReplayMessages } from "../../compaction-replay.js";
import { decideContextPressure } from "../../context-pressure.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../defaults.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { FixedRequestTokenPressure } from "../../sessions/context-token-pressure.js";
import type { SessionManager } from "../../sessions/index.js";
import { log } from "../logger.js";
import type { ToolResultPromptProjectionState } from "../session-prompt-state.js";
import {
  resolveLiveToolResultMaxChars,
  truncateOversizedToolResultsInSessionManager,
} from "../tool-result-truncation.js";
import { normalizeMessagesForLlmBoundary } from "./attempt-llm-boundary.js";
import type { MidTurnPrecheckRequest } from "./midturn-precheck.js";
import {
  PREEMPTIVE_OVERFLOW_ERROR_TEXT,
  buildPrePromptContextBudgetStatus,
  contextPressureSignal,
  shouldPreemptivelyCompactBeforePrompt,
} from "./preemptive-compaction.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

type AttemptPromptPreflightParams = Pick<
  EmbeddedRunAttemptParams,
  "config" | "modelId" | "provider" | "sessionFile" | "sessionId" | "sessionKey"
> &
  Partial<Pick<EmbeddedRunAttemptParams, "runId">>;

type AttemptPromptPreflightState = {
  contextBudgetStatus: EmbeddedRunAttemptResult["contextBudgetStatus"];
  preflightRecovery: EmbeddedRunAttemptResult["preflightRecovery"];
  promptError: unknown;
  promptErrorSource: AgentRunAttemptFailureSource | null;
  skipPromptSubmission: boolean;
};

type PreflightRecoveryBudgetSnapshot = Pick<
  MidTurnPrecheckRequest,
  "estimatedPromptTokens" | "promptBudgetBeforeReserve" | "overflowTokens"
>;

// Carries the measured prompt budget into the outer recovery loop. The synthetic
// precheck error is only a routing signal, so compaction engines need these
// fields to compact against the prompt OpenClaw actually rendered.
function buildPreflightRecoveryBudgetSnapshot(snapshot: PreflightRecoveryBudgetSnapshot) {
  return {
    estimatedPromptTokens: snapshot.estimatedPromptTokens,
    promptBudgetBeforeReserve: snapshot.promptBudgetBeforeReserve,
    overflowTokens: snapshot.overflowTokens,
  };
}

export async function handleEmbeddedAttemptMidTurnPrecheck(input: {
  attempt: AttemptPromptPreflightParams & Pick<EmbeddedRunAttemptParams, "contextTokenBudget">;
  request: MidTurnPrecheckRequest;
  sessionAgentId: string;
  sessionManager: SessionManager;
  toolResultPromptProjectionState: ToolResultPromptProjectionState;
  prePromptMessageCount: number;
  replaceSessionMessages: (messages: AgentMessage[]) => void;
}): Promise<{
  preflightRecovery: NonNullable<EmbeddedRunAttemptResult["preflightRecovery"]>;
  promptError?: Error;
}> {
  const { attempt, request } = input;
  const preflightRecovery = {
    route: request.route,
    pressure: request.pressure,
    source: "mid-turn" as const,
    ...buildPreflightRecoveryBudgetSnapshot(request),
  };
  const logMidTurnPrecheck = (route: string, extra?: string) => {
    log.warn(
      `[context-overflow-midturn-precheck] sessionKey=${attempt.sessionKey ?? attempt.sessionId} ` +
        `provider=${attempt.provider}/${attempt.modelId} pressure=${request.pressure} route=${route} ` +
        `estimatedPromptTokens=${request.estimatedPromptTokens} ` +
        `promptBudgetBeforeReserve=${request.promptBudgetBeforeReserve} ` +
        `overflowTokens=${request.overflowTokens} ` +
        `toolResultReducibleChars=${request.toolResultReducibleChars} ` +
        `effectiveReserveTokens=${request.effectiveReserveTokens} ` +
        `prePromptMessageCount=${input.prePromptMessageCount} ` +
        (extra ? `${extra} ` : "") +
        `sessionFile=${attempt.sessionFile}`,
    );
  };

  if (request.route === "truncate_tool_results_only") {
    const contextTokenBudget = attempt.contextTokenBudget ?? DEFAULT_CONTEXT_TOKENS;
    const toolResultMaxChars = resolveLiveToolResultMaxChars({
      contextWindowTokens: contextTokenBudget,
    });
    const truncationResult = await truncateOversizedToolResultsInSessionManager({
      sessionManager: input.sessionManager,
      projectionState: input.toolResultPromptProjectionState,
      contextWindowTokens: contextTokenBudget,
      maxCharsOverride: toolResultMaxChars,
      preserveSentToolResults: true,
      sessionFile: attempt.sessionFile,
      sessionId: attempt.sessionId,
      sessionKey: attempt.sessionKey,
      agentId: input.sessionAgentId,
    });
    if (truncationResult.truncated) {
      input.replaceSessionMessages(
        sanitizeCompactionReplayMessages(input.sessionManager.buildSessionContext().messages),
      );
      const { truncatedCount } = truncationResult;
      logMidTurnPrecheck(request.route, `handled=true truncatedCount=${truncatedCount}`);
      return { preflightRecovery: { ...preflightRecovery, handled: true, truncatedCount } };
    }

    preflightRecovery.route = "compact_only";
    logMidTurnPrecheck(
      preflightRecovery.route,
      `truncateFallbackReason=${truncationResult.reason ?? "unknown"}`,
    );
  } else {
    logMidTurnPrecheck(request.route);
  }
  return {
    preflightRecovery,
    promptError: contextPressureSignal(request.pressure),
  };
}

export async function prepareEmbeddedAttemptPromptPreflight(input: {
  appendOnlyRuntimeContext?: boolean;
  attempt: AttemptPromptPreflightParams &
    Pick<EmbeddedRunAttemptParams, "model" | "runtimePlan" | "authProfileId">;
  compactionReplayEnabled: boolean;
  providerCompactionAtRequestBoundary?: boolean;
  contextEnginePromptAuthority: NonNullable<AssembleResult["promptAuthority"]>;
  contextTokenBudget: number;
  hookMessagesForCurrentPrompt: AgentMessage[];
  includeBoundaryTimestamp: boolean;
  promptForPrecheck: string;
  pendingInputTokens?: number;
  fixedTokenPressure?: FixedRequestTokenPressure;
  reserveTokens: number;
  sessionMessageCount: number;
  state: AttemptPromptPreflightState;
  systemPrompt: string;
  timezone?: string;
  toolResultMaxChars: number;
  toolSchemaTokens?: number;
  unwindowedContextEngineMessagesForPrecheck?: AgentMessage[];
}): Promise<AttemptPromptPreflightState> {
  const { attempt } = input;
  const boundaryOptions = {
    appendOnlyRuntimeContext: input.appendOnlyRuntimeContext,
    ...(input.timezone ? { timezone: input.timezone } : {}),
    ...(input.includeBoundaryTimestamp ? {} : { includeTimestamp: false }),
  };
  const unwindowedMessages =
    input.contextEnginePromptAuthority === "preassembly_may_overflow"
      ? input.unwindowedContextEngineMessagesForPrecheck
      : undefined;
  const unwindowedLlmBoundaryMessagesForPrecheck = unwindowedMessages
    ? normalizeMessagesForLlmBoundary(unwindowedMessages, boundaryOptions)
    : undefined;
  if (input.state.skipPromptSubmission) {
    return { ...input.state };
  }
  if ((input.pendingInputTokens ?? 0) >= input.contextTokenBudget) {
    if (input.providerCompactionAtRequestBoundary) {
      log.warn(
        "Request-boundary compaction unavailable; falling back to client compaction: pending input exceeds the context budget",
      );
    }
    return {
      ...input.state,
      preflightRecovery: { route: "compact_only", pressure: "overflow" },
      promptError: new Error(PREEMPTIVE_OVERFLOW_ERROR_TEXT),
      promptErrorSource: "precheck",
      skipPromptSubmission: true,
    };
  }
  let preemptiveCompaction: ReturnType<typeof shouldPreemptivelyCompactBeforePrompt>;
  try {
    preemptiveCompaction = shouldPreemptivelyCompactBeforePrompt({
      messages: input.hookMessagesForCurrentPrompt,
      unwindowedMessages: unwindowedLlmBoundaryMessagesForPrecheck,
      systemPrompt: input.systemPrompt,
      fixedTokenPressure: input.fixedTokenPressure,
      prompt: input.promptForPrecheck,
      contextTokenBudget: input.contextTokenBudget,
      reserveTokens: input.reserveTokens,
      toolResultMaxChars: input.toolResultMaxChars,
      ...(typeof input.toolSchemaTokens === "number"
        ? { toolSchemaTokens: input.toolSchemaTokens }
        : {}),
      replay: {
        model: attempt.model,
        sessionId: attempt.sessionId,
        enabled: input.compactionReplayEnabled,
      },
    });
  } catch (error) {
    if (!(error instanceof CompactionReplayRefreshRequiredError)) {
      throw error;
    }
    return {
      ...input.state,
      promptError: error,
      promptErrorSource: "precheck",
      skipPromptSubmission: true,
    };
  }
  const precheckSummary = {
    result: preemptiveCompaction,
    provider: attempt.provider,
    modelId: attempt.modelId,
    messageCount: input.sessionMessageCount,
    contextTokenBudget: input.contextTokenBudget,
    reserveTokens: input.reserveTokens,
    ...(attempt.sessionId ? { sessionId: attempt.sessionId } : {}),
    ...(unwindowedMessages ? { unwindowedMessageCount: unwindowedMessages.length } : {}),
  };
  const contextBudgetStatus = buildPrePromptContextBudgetStatus(precheckSummary);
  const checkpointPressure = preemptiveCompaction.compactionReplay;
  // Only the actual canonical window can require recovery; the raw-history
  // maximum above remains diagnostic even when it exceeds this window.
  // No tool batch is open before the prompt, so this boundary is always safe.
  const pressure =
    checkpointPressure && !input.providerCompactionAtRequestBoundary
      ? decideContextPressure({
          estimatedPromptTokens: checkpointPressure.estimatedPromptTokens,
          windowTokens: input.contextTokenBudget,
          maintenanceDue: checkpointPressure.route !== "fits",
          boundarySafe: true,
          runId: attempt.runId,
        })
      : undefined;
  if (checkpointPressure && checkpointPressure.route !== "fits" && pressure) {
    return {
      ...input.state,
      contextBudgetStatus,
      preflightRecovery: {
        route: checkpointPressure.route,
        pressure,
        ...buildPreflightRecoveryBudgetSnapshot(checkpointPressure),
      },
      promptError: contextPressureSignal(pressure),
      promptErrorSource: "precheck",
      skipPromptSubmission: true,
    };
  }
  if (preemptiveCompaction.route !== "fits") {
    // This pressure estimate is diagnostic only; it never compacts or discards history.
    // Real compaction runs through explicit preflight or provider-overflow recovery.
    log.info(
      `[context-pressure-diagnostic] admitted provider attempt for ` +
        `${attempt.provider}/${attempt.modelId} route=${preemptiveCompaction.route} ` +
        `estimatedPromptTokens=${preemptiveCompaction.estimatedPromptTokens} ` +
        `promptBudgetBeforeReserve=${preemptiveCompaction.promptBudgetBeforeReserve}`,
    );
  }
  return { ...input.state, contextBudgetStatus };
}
