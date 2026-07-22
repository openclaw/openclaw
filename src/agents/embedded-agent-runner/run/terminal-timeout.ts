import { hasMessagingToolDeliveryEvidence } from "../delivery-evidence.js";
import type { EmbeddedAgentMeta, EmbeddedAgentRunResult } from "../types.js";
import { resolveRunLivenessState, resolveTurnBudgetTimeoutNotice } from "./incomplete-turn.js";
import { copyAttemptDeliveryState } from "./terminal-resolution.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

export function resolveEmbeddedRunTerminalTimeout(input: {
  timedOutDuringPrompt: boolean;
  hasSuccessfulFinalAssistantAfterPromptTimeout: boolean;
  shouldSurfaceCodexCompletionTimeout: boolean;
  idleTimedOut: boolean;
  attempt: EmbeddedRunAttemptResult;
  hasPartialAssistantTextAfterPromptTimeout: boolean;
  payloads: EmbeddedAgentRunResult["payloads"];
  payloadsWithToolMedia: EmbeddedAgentRunResult["payloads"];
  terminalAborted: boolean;
  terminalTimedOut: boolean;
  terminalOutcome: {
    timeoutPhase?: EmbeddedAgentRunResult["meta"]["timeoutPhase"];
    providerStarted?: boolean;
  };
  resolveReplayInvalid: (incompleteTurnText?: string | null) => boolean;
  setTerminalLifecycleMeta: NonNullable<EmbeddedRunAttemptResult["setTerminalLifecycleMeta"]>;
  startedAtMs: number;
  agentMeta: EmbeddedAgentMeta;
  finalAssistantVisibleText?: string;
  finalAssistantRawText?: string;
  attemptToolSummary: EmbeddedAgentRunResult["meta"]["toolSummary"];
  failureSignal: EmbeddedAgentRunResult["meta"]["failureSignal"];
}): EmbeddedAgentRunResult | undefined {
  if (
    !input.timedOutDuringPrompt ||
    input.hasSuccessfulFinalAssistantAfterPromptTimeout ||
    (!input.shouldSurfaceCodexCompletionTimeout && hasMessagingToolDeliveryEvidence(input.attempt))
  ) {
    return undefined;
  }
  const defaultTimeoutText = input.idleTimedOut
    ? "The model did not produce a response before the model idle timeout. " +
      "Please try again, or increase `models.providers.<id>.timeoutSeconds` for slow local or self-hosted providers. " +
      "If `agents.defaults.timeoutSeconds` or a run-specific timeout is lower, raise that ceiling too; provider timeouts cannot extend the whole agent run."
    : "Request timed out before a response was generated. " +
      "Please try again, or increase `agents.defaults.timeoutSeconds` in your config.";
  const timeoutText = input.attempt.promptTimeoutOutcome?.message?.trim() || defaultTimeoutText;
  const replayInvalid =
    input.attempt.promptTimeoutOutcome?.replayInvalid ?? input.resolveReplayInvalid(null);
  const livenessState =
    input.attempt.promptTimeoutOutcome?.livenessState ??
    resolveRunLivenessState({
      payloadCount: input.hasPartialAssistantTextAfterPromptTimeout
        ? 0
        : (input.payloads?.length ?? 0),
      aborted: input.terminalAborted,
      timedOut: input.terminalTimedOut,
      attempt: input.attempt,
      incompleteTurnText: null,
    });
  const timeoutPhase =
    input.attempt.promptTimeoutOutcome?.timeoutPhase ?? input.terminalOutcome.timeoutPhase;
  const providerStarted =
    input.attempt.promptTimeoutOutcome?.providerStarted ?? input.terminalOutcome.providerStarted;
  const timeoutAttribution = {
    ...(timeoutPhase ? { timeoutPhase } : {}),
    ...(typeof providerStarted === "boolean" ? { providerStarted } : {}),
  };
  input.setTerminalLifecycleMeta({ replayInvalid, livenessState, ...timeoutAttribution });
  return {
    payloads: [
      ...(input.hasPartialAssistantTextAfterPromptTimeout ? [] : input.payloadsWithToolMedia || []),
      { text: timeoutText, isError: true },
    ],
    meta: {
      durationMs: Date.now() - input.startedAtMs,
      agentMeta: input.agentMeta,
      aborted: input.terminalAborted,
      systemPromptReport: input.attempt.systemPromptReport,
      finalPromptText: input.attempt.finalPromptText,
      finalAssistantVisibleText: input.finalAssistantVisibleText,
      finalAssistantRawText: input.finalAssistantRawText,
      replayInvalid,
      livenessState,
      ...timeoutAttribution,
      ...(input.shouldSurfaceCodexCompletionTimeout
        ? {
            error: {
              kind: "incomplete_turn" as const,
              message: timeoutText,
              fallbackSafe: false,
            },
          }
        : {}),
      toolSummary: input.attemptToolSummary,
      ...(input.failureSignal ? { failureSignal: input.failureSignal } : {}),
      agentHarnessResultClassification: input.attempt.agentHarnessResultClassification,
    },
    ...copyAttemptDeliveryState(input.attempt),
  };
}

/**
 * Surfaces a user-visible notice when a turn times out DURING TOOL EXECUTION
 * (`timedOutDuringToolExecution`) and would otherwise fall through to the
 * general terminal path with no payloads — returning silently and leaving the
 * channel dead (indistinguishable from a hung process). The prompt-timeout path
 * (`resolveEmbeddedRunTerminalTimeout`, above) only covers
 * `timedOutDuringPrompt === true`; this is the companion for the tool-execution
 * sub-case. Returns `undefined` (fall through to the general terminal path) for
 * any non-tool-execution timeout and for every suppression case that
 * `resolveTurnBudgetTimeoutNotice` gates out (compaction/silent/messaging
 * delivery/deterministic approval/pending client tool calls/yield/source-reply),
 * so those terminal states are preserved untouched.
 */
export function resolveEmbeddedRunToolExecutionTimeout(input: {
  timedOutDuringToolExecution: boolean;
  terminalTimedOut: boolean;
  idleTimedOut: boolean;
  timedOutDuringCompaction: boolean;
  payloads: EmbeddedAgentRunResult["payloads"];
  allowEmptyAssistantReplyAsSilent: boolean;
  attempt: EmbeddedRunAttemptResult;
  terminalAborted: boolean;
  resolveReplayInvalid: (incompleteTurnText?: string | null) => boolean;
  setTerminalLifecycleMeta: NonNullable<EmbeddedRunAttemptResult["setTerminalLifecycleMeta"]>;
  startedAtMs: number;
  agentMeta: EmbeddedAgentMeta;
  finalAssistantVisibleText?: string;
  finalAssistantRawText?: string;
  attemptToolSummary: EmbeddedAgentRunResult["meta"]["toolSummary"];
  failureSignal: EmbeddedAgentRunResult["meta"]["failureSignal"];
}): EmbeddedAgentRunResult | undefined {
  if (!input.timedOutDuringToolExecution) {
    return undefined;
  }
  const notice = resolveTurnBudgetTimeoutNotice({
    timedOut: input.terminalTimedOut,
    idleTimedOut: input.idleTimedOut,
    timedOutDuringCompaction: input.timedOutDuringCompaction,
    payloadCount: input.payloads?.length ?? 0,
    allowSilentReply: input.allowEmptyAssistantReplyAsSilent,
    hasMessagingDelivery: hasMessagingToolDeliveryEvidence(input.attempt),
    hasDeterministicApprovalPrompt: input.attempt.didSendDeterministicApprovalPrompt === true,
    hasClientToolCalls: (input.attempt.clientToolCalls?.length ?? 0) > 0,
    yieldDetected: input.attempt.yieldDetected === true,
    hasSourceReplyDelivery: input.attempt.didDeliverSourceReplyViaMessageTool === true,
  });
  if (!notice) {
    return undefined;
  }
  const replayInvalid = input.resolveReplayInvalid(notice);
  const livenessState = resolveRunLivenessState({
    payloadCount: 0,
    aborted: input.terminalAborted,
    timedOut: input.terminalTimedOut,
    attempt: input.attempt,
    incompleteTurnText: notice,
  });
  // A tool-execution timeout carries no promptTimeoutOutcome (that is a
  // prompt-phase artifact); attribute it to the provider phase with the provider
  // already started, mirroring the prompt-timeout path's hard defaults.
  const timeoutPhase = input.attempt.promptTimeoutOutcome?.timeoutPhase ?? "provider";
  const providerStarted = input.attempt.promptTimeoutOutcome?.providerStarted ?? true;
  const timeoutAttribution = { timeoutPhase, providerStarted };
  input.setTerminalLifecycleMeta({ replayInvalid, livenessState, ...timeoutAttribution });
  return {
    payloads: [{ text: notice, isError: true }],
    meta: {
      durationMs: Date.now() - input.startedAtMs,
      agentMeta: input.agentMeta,
      aborted: input.terminalAborted,
      systemPromptReport: input.attempt.systemPromptReport,
      finalPromptText: input.attempt.finalPromptText,
      finalAssistantVisibleText: input.finalAssistantVisibleText,
      finalAssistantRawText: input.finalAssistantRawText,
      replayInvalid,
      livenessState,
      ...timeoutAttribution,
      toolSummary: input.attemptToolSummary,
      ...(input.failureSignal ? { failureSignal: input.failureSignal } : {}),
      agentHarnessResultClassification: input.attempt.agentHarnessResultClassification,
    },
    ...copyAttemptDeliveryState(input.attempt),
  };
}
