import { hasOnlyAssistantReasoningContent } from "@openclaw/ai/internal/shared";
import { isProviderRefusalAssistantError } from "@openclaw/llm-core/diagnostics";
import { getReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import {
  hasAcceptedSessionSpawn,
  hasCompletionMessageSessionSpawn,
  type AcceptedSessionSpawn,
} from "../../accepted-session-spawn.js";
import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import type { AuthProfileFailureReason } from "../../auth-profiles.js";
import { formatUserFacingAssistantErrorText } from "../../embedded-agent-helpers/error-text.js";
import { renderAgentHarnessPreflightUserMessage } from "../../embedded-agent-helpers/user-facing-text.js";
import type { MessagingToolSend } from "../../embedded-agent-messaging.types.js";
import { isToolAuthoredSourceReplyForAssistant } from "../../embedded-agent-tool-authored-source-reply.js";
import { renderAssistantRequestFailureCopy } from "../../failover/assistant-request-failure-copy.js";
import { resolveReplyFailoverFacts } from "../../failover/request-error-facts.js";
import { renderAuthProfileFailoverCopy } from "../../failover/user-copy.js";
import { buildProviderAuthRecoveryHint } from "../../provider-auth-recovery-hint.js";
import {
  MISSING_REPLY_NOTICE_TEXT,
  MISSING_REPLY_SIDE_EFFECT_NOTICE_TEXT,
} from "../../reply-completion.js";
import {
  hasCommittedMessagingToolDeliveryEvidence,
  resolveSourceReplyDelivery,
} from "../delivery-evidence.js";
import type { EmbeddedAgentRunResult, EmbeddedRunLivenessState } from "../types.js";
import {
  hasAsyncActivity,
  hasAttemptTerminalState,
  resolveCurrentAttemptAssistant,
} from "./attempt-terminal-evidence.js";
import {
  classifyAssistantTurn,
  countSettledTurnDeliveryPayloads,
  isIncompleteTerminalAssistantTurn,
  joinAssistantTexts,
  type IncompleteTurnAttempt,
} from "./incomplete-turn-classification.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

type RunLivenessAttempt = Pick<
  EmbeddedRunAttemptResult,
  "currentAttemptAssistant" | "currentAttemptCompletedAssistant" | "replayMetadata" | "terminal"
>;

type TerminalFailureContext = {
  assistantProfileFailureReason?: AuthProfileFailureReason | null;
  provider: string;
  runParams: Pick<Parameters<typeof buildProviderAuthRecoveryHint>[0], "config" | "workspaceDir">;
  prepared: { payloadsForVisibleCompletion: EmbeddedAgentRunResult["payloads"] };
};

/**
 * Builds the user-visible incomplete-turn warning when a terminal attempt did
 * not produce a safe final assistant response and no committed delivery/progress
 * already completed the task.
 */
export function resolveIncompleteTurnPayloadText(params: {
  payloadCount: number;
  rawPayloadCount?: number;
  aborted: boolean;
  externalAbort: boolean;
  timedOut: boolean;
  hadPotentialSideEffects?: boolean;
  hasIntentionalTerminalCompletion?: boolean;
  terminalFailure?: TerminalFailureContext;
  attempt: IncompleteTurnAttempt;
}): string | null {
  // A generated warning reports a failed tool; it is not the answer that consumes
  // the failure. Keep its prepared detail when the terminal owner records failure.
  const payloads = params.terminalFailure?.prepared.payloadsForVisibleCompletion;
  const toolFailurePayload =
    params.attempt.terminal.kind === "ok" && params.attempt.lastToolError
      ? payloads?.find((payload) => getReplyPayloadMetadata(payload)?.toolErrorWarning)
      : undefined;
  const payloadCount = toolFailurePayload
    ? countSettledTurnDeliveryPayloads({ payloads, attempt: params.attempt })
    : params.payloadCount;
  const assistantState = classifyAssistantTurn({ ...params, payloadCount });
  const textToolCallAttempt = params.attempt.textToolCallAttempt === true;
  const assistant = assistantState.assistant;
  const completionAttempt = {
    ...params.attempt,
    messagingToolSourceReplyPayloads: params.attempt.messagingToolSourceReplyPayloads?.filter(
      (payload) =>
        !payload.toolAuthored || isToolAuthoredSourceReplyForAssistant(payload, assistant),
    ),
  };
  const hasTerminalOutput = hasAttemptTerminalState(completionAttempt);
  // Tool-use expects a post-tool continuation, so partial visible text completes
  // nothing. A length stop that did produce visible text is a partial answer and
  // is delivered with a truncation notice instead. (#76477)
  const incompleteTerminalAssistant = isIncompleteTerminalAssistantTurn({
    hasAssistantVisibleText: payloadCount > 0,
    hasTerminalOutput,
    lastAssistant: assistant,
  });
  // Thinking payloads can count toward payloadCount but carry no user-visible
  // content; bypass the visible-text guard when thinking was the only output
  // so that incomplete-turn stall detection fires below. (#89787, #91953)
  const thinkingOnlyTerminal =
    payloadCount !== 0 &&
    params.attempt.keptAnswer === undefined &&
    !assistantState.visibleText.length &&
    !assistant?.openclawDelivery?.tts?.text?.trim() &&
    !hasTerminalOutput &&
    Boolean(assistant && hasOnlyAssistantReasoningContent(assistant));
  const presentationHiddenAssistantReply =
    (params.rawPayloadCount ?? params.payloadCount) > payloadCount;

  if (
    (payloadCount !== 0 &&
      !incompleteTerminalAssistant &&
      !thinkingOnlyTerminal &&
      !textToolCallAttempt) ||
    (params.aborted && params.externalAbort) ||
    params.timedOut ||
    params.attempt.clientToolCalls ||
    params.attempt.yieldDetected ||
    params.attempt.didSendDeterministicApprovalPrompt ||
    (toolFailurePayload && hasTerminalOutput) ||
    (params.attempt.lastToolError && !toolFailurePayload) ||
    params.hasIntentionalTerminalCompletion ||
    params.attempt.hasToolMediaBlockReply ||
    resolveSourceReplyDelivery(completionAttempt) !== "missing" ||
    // Authored replies await host delivery, but only this input can complete here.
    completionAttempt.messagingToolSourceReplyPayloads?.some(
      (payload) => payload.toolAuthored === true,
    ) ||
    hasCompletionMessageSessionSpawn(params.attempt.acceptedSessionSpawns)
  ) {
    return null;
  }

  // Failed or incomplete model steps still need a warning when their lifecycle
  // snapshot contains unfinished work; only a normal stop can leave that work pending.
  if (
    hasAsyncActivity(params.attempt.toolMetas) ||
    (!params.aborted &&
      assistant?.stopReason === "stop" &&
      (params.attempt.itemLifecycle.activeCount > 0 ||
        params.attempt.itemLifecycle.completedCount < params.attempt.itemLifecycle.startedCount))
  ) {
    return null;
  }

  const textToolCallFailureText = textToolCallAttempt
    ? "⚠️ The model wrote a tool call as text instead of calling the tool. No tool ran for that call."
    : undefined;

  const stopReason = assistant?.stopReason;
  if (
    !textToolCallAttempt &&
    !incompleteTerminalAssistant &&
    !assistantState.reasoningOnly &&
    !thinkingOnlyTerminal &&
    !presentationHiddenAssistantReply &&
    !assistantState.emptyResponse &&
    stopReason !== "error"
  ) {
    return null;
  }

  if (toolFailurePayload?.text) {
    return toolFailurePayload.text;
  }

  const { promptError } = projectAgentRunAttemptTerminal(params.attempt.terminal);
  if (
    !promptError &&
    assistant?.stopReason === "error" &&
    assistant.errorCode === "incomplete_tool_call"
  ) {
    return formatUserFacingAssistantErrorText(assistant);
  }
  const preflightFailureText = renderAgentHarnessPreflightUserMessage(promptError);
  const failureFacts =
    promptError && preflightFailureText === undefined
      ? resolveReplyFailoverFacts(promptError, formatErrorMessage(promptError))
      : undefined;
  // A non-replayable harness failure may have no assistant message to carry its error.
  // Share classified copy with thrown failures; never display raw prompt diagnostics.
  const promptFailureText =
    textToolCallFailureText ??
    preflightFailureText ??
    (failureFacts
      ? (failureFacts.providerRequestError?.userMessage ??
        failureFacts.requestFailureText ??
        renderAssistantRequestFailureCopy({
          reason: failureFacts.reason,
          status: failureFacts.status,
          code: failureFacts.code,
        }))
      : undefined);
  if (params.hadPotentialSideEffects || params.attempt.replayMetadata.hadPotentialSideEffects) {
    return promptFailureText
      ? `${promptFailureText} Note: some tool actions may have already been executed — please verify before retrying.`
      : MISSING_REPLY_SIDE_EFFECT_NOTICE_TEXT;
  }
  if (textToolCallFailureText) {
    return `${textToolCallFailureText} Please try again or use a model with native tool calling.`;
  }
  if (preflightFailureText !== undefined) {
    return preflightFailureText;
  }
  if (assistant && isProviderRefusalAssistantError(assistant)) {
    return formatUserFacingAssistantErrorText(assistant);
  }
  const authFailure = params.terminalFailure;
  const reason = authFailure?.assistantProfileFailureReason;
  if (authFailure && (reason === "auth" || reason === "auth_permanent")) {
    return renderAuthProfileFailoverCopy({
      reason,
      provider: authFailure.provider,
      allInCooldown: false,
      recoveryHint: buildProviderAuthRecoveryHint({
        provider: authFailure.provider,
        config: authFailure.runParams.config,
        workspaceDir: authFailure.runParams.workspaceDir,
        env: process.env,
      }),
    });
  }
  return (
    promptFailureText ??
    (stopReason === "length"
      ? "⚠️ The model reached its output token limit before generating an answer. Please try again."
      : MISSING_REPLY_NOTICE_TEXT)
  );
}

/**
 * Allows one retry when the provider returned no assistant turn at all and the
 * attempt has no side effects, active lifecycle items, delivery, or terminal
 * assistant/tool state.
 */
export function shouldRetryMissingAssistantTurn(params: {
  payloadCount: number;
  aborted: boolean;
  promptError?: unknown;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
}): boolean {
  return !(
    params.payloadCount !== 0 ||
    params.aborted ||
    params.promptError ||
    params.timedOut ||
    params.attempt.clientToolCalls ||
    resolveCurrentAttemptAssistant(params.attempt) ||
    params.attempt.yieldDetected ||
    params.attempt.didSendDeterministicApprovalPrompt ||
    params.attempt.lastToolError ||
    joinAssistantTexts(params.attempt.assistantTexts).length > 0 ||
    hasCommittedMessagingToolDeliveryEvidence(params.attempt) ||
    hasAcceptedSessionSpawn(params.attempt.acceptedSessionSpawns) ||
    hasAsyncActivity(params.attempt.toolMetas) ||
    (params.attempt.itemLifecycle?.startedCount ?? 0) > 0 ||
    (params.attempt.itemLifecycle?.activeCount ?? 0) > 0 ||
    params.attempt.replayMetadata.hadPotentialSideEffects
  );
}

/** Fields needed to determine whether a yielded turn already delivered or can continue. */
interface YieldContinuationAttempt {
  clientToolCalls?: readonly unknown[];
  didSendDeterministicApprovalPrompt?: boolean;
  successfulCronAdds?: number;
  acceptedSessionSpawns?: readonly AcceptedSessionSpawn[];
  runtimeContinuationStarted?: boolean;
  yieldMessageWaitRegistered?: boolean;
  messagingToolSentTexts?: readonly string[];
  messagingToolSentMediaUrls?: readonly string[];
  messagingToolSentTargets?: readonly MessagingToolSend[];
  toolMetas?: readonly { asyncStarted?: boolean }[];
}

/** Same-attempt work that can resume execution or deliver its completion. */
export function hasRunContinuationEvidence(attempt: YieldContinuationAttempt): boolean {
  // Only same-attempt evidence is causal here. Session-wide active descendants may be
  // stale or unrelated and must not suppress the diagnostic for this yielded turn.
  return (
    (attempt.clientToolCalls?.length ?? 0) > 0 ||
    attempt.didSendDeterministicApprovalPrompt === true ||
    hasCompletionMessageSessionSpawn(attempt.acceptedSessionSpawns) ||
    attempt.runtimeContinuationStarted === true ||
    attempt.yieldMessageWaitRegistered === true ||
    hasAsyncActivity(attempt.toolMetas)
  );
}

/** A deliberate yield can also leave accepted work or already-sent output. */
export function hasYieldContinuationEvidence(attempt: YieldContinuationAttempt): boolean {
  return (
    hasAcceptedSessionSpawn(attempt.acceptedSessionSpawns) ||
    hasCommittedMessagingToolDeliveryEvidence(attempt) ||
    (attempt.successfulCronAdds ?? 0) > 0 ||
    hasRunContinuationEvidence(attempt)
  );
}

export const YIELD_DIAGNOSTIC_TEXT =
  "⚠️ Turn yielded without a continuation source. Send a message to resume.";

export const TRUNCATED_REPLY_NOTICE_TEXT =
  "⚠️ Reply truncated at the model's output token limit. The text above is partial — ask to continue it.";

export const CUT_OFF_SUMMARY_NOTICE_TEXT =
  "⚠️ The model was cut off at its output token limit, so the summary above was written afterwards without tools. Some work may be unfinished — check before relying on it.";

/**
 * Marks replay invalid whenever the recorded attempt might not be safe to
 * replay or the current run ended in a compaction/incomplete-turn state that
 * needs a fresh prompt boundary.
 */
export function resolveReplayInvalidFlag(params: {
  attempt: RunLivenessAttempt;
  incompleteTurnText?: string | null;
}): boolean {
  const terminal = projectAgentRunAttemptTerminal(params.attempt.terminal);
  const replaySafeProviderRefusal =
    params.attempt.replayMetadata.replaySafe &&
    isProviderRefusalAssistantError(resolveCurrentAttemptAssistant(params.attempt));
  return (
    !params.attempt.replayMetadata.replaySafe ||
    terminal.promptErrorSource === "compaction" ||
    terminal.timedOutDuringCompaction ||
    (Boolean(params.incompleteTurnText) && !replaySafeProviderRefusal)
  );
}

/** Classifies the persisted run state used by session recovery and resume logic. */
export function resolveRunLivenessState(params: {
  payloadCount: number;
  aborted: boolean;
  timedOut: boolean;
  attempt: RunLivenessAttempt;
  incompleteTurnText?: string | null;
}): EmbeddedRunLivenessState {
  if (params.incompleteTurnText) {
    return "abandoned";
  }
  const terminal = projectAgentRunAttemptTerminal(params.attempt.terminal);
  if (
    !terminal.timedOutDuringToolExecution &&
    (terminal.promptErrorSource === "compaction" || terminal.timedOutDuringCompaction)
  ) {
    return "paused";
  }
  if ((params.aborted || params.timedOut) && params.payloadCount === 0) {
    return "blocked";
  }
  if (resolveCurrentAttemptAssistant(params.attempt)?.stopReason === "error") {
    return "blocked";
  }
  return "working";
}
