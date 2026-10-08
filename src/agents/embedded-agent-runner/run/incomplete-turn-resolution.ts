import { hasOnlyAssistantReasoningContent } from "@openclaw/ai/internal/shared";
import { isProviderRefusalAssistantError } from "@openclaw/llm-core/diagnostics";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import {
  hasAcceptedSessionSpawn,
  hasCompletionMessageSessionSpawn,
} from "../../accepted-session-spawn.js";
import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import type { AuthProfileFailureReason } from "../../auth-profiles.js";
import { collectTextContentBlocks } from "../../content-blocks.js";
import { formatUserFacingAssistantErrorText } from "../../embedded-agent-helpers.js";
import { renderAgentHarnessPreflightUserMessage } from "../../embedded-agent-helpers/user-facing-text.js";
import type { MessagingToolSend } from "../../embedded-agent-messaging.types.js";
import { renderAssistantRequestFailureCopy } from "../../failover/assistant-request-failure-copy.js";
import { resolveReplyFailoverFacts } from "../../failover/request-error-facts.js";
import { renderAuthProfileFailoverCopy } from "../../failover/user-copy.js";
import { buildProviderAuthRecoveryHint } from "../../provider-auth-recovery-hint.js";
import type { AgentMessage } from "../../runtime/index.js";
import {
  hasCommittedMessagingToolDeliveryEvidence,
  resolveSourceReplyDelivery,
} from "../delivery-evidence.js";
import type { EmbeddedRunLivenessState } from "../types.js";
import {
  hasAsyncActivity,
  hasAttemptTerminalState,
  resolveCurrentAttemptAssistant,
} from "./attempt-terminal-evidence.js";
import {
  classifyAssistantTurn,
  isIncompleteTerminalAssistantTurn,
  joinAssistantTexts,
  type IncompleteTurnAttempt,
} from "./incomplete-turn-classification.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

type SilentToolResultAttempt = Pick<
  EmbeddedRunAttemptResult,
  | "clientToolCalls"
  | "yieldDetected"
  | "didSendDeterministicApprovalPrompt"
  | "lastToolError"
  | "messagesSnapshot"
  | "toolMetas"
>;

type RunLivenessAttempt = Pick<
  EmbeddedRunAttemptResult,
  "currentAttemptAssistant" | "currentAttemptCompletedAssistant" | "replayMetadata" | "terminal"
>;

type TerminalAuthFailureContext = {
  assistantProfileFailureReason?: AuthProfileFailureReason | null;
  provider: string;
  runParams: Pick<Parameters<typeof buildProviderAuthRecoveryHint>[0], "config" | "workspaceDir">;
};

/**
 * Builds the user-visible incomplete-turn warning when a terminal attempt did
 * not produce a safe final assistant response and no committed delivery/progress
 * already completed the task.
 */
export function resolveIncompleteTurnPayloadText(params: {
  payloadCount: number;
  aborted: boolean;
  externalAbort: boolean;
  timedOut: boolean;
  hadPotentialSideEffects?: boolean;
  hasIntentionalTerminalCompletion?: boolean;
  terminalAuthFailure?: TerminalAuthFailureContext;
  attempt: IncompleteTurnAttempt;
}): string | null {
  const assistantState = classifyAssistantTurn(params);
  const assistant = assistantState.assistant;
  const hasTerminalOutput = hasAttemptTerminalState(params.attempt);
  // Tool-use expects a post-tool continuation, so partial visible text completes
  // nothing. A length stop that did produce visible text is a partial answer and
  // is delivered with a truncation notice instead. (#76477)
  const incompleteTerminalAssistant = isIncompleteTerminalAssistantTurn({
    hasAssistantVisibleText: params.payloadCount > 0,
    hasTerminalOutput,
    lastAssistant: assistant,
  });
  // Thinking payloads can count toward payloadCount but carry no user-visible
  // content; bypass the visible-text guard when thinking was the only output
  // so that incomplete-turn stall detection fires below. (#89787, #91953)
  const thinkingOnlyTerminal =
    params.payloadCount !== 0 &&
    !assistantState.visibleText.length &&
    !assistant?.openclawDelivery?.tts?.text?.trim() &&
    !hasTerminalOutput &&
    Boolean(assistant && hasOnlyAssistantReasoningContent(assistant));

  if (
    (params.payloadCount !== 0 && !incompleteTerminalAssistant && !thinkingOnlyTerminal) ||
    (params.aborted && params.externalAbort) ||
    params.timedOut ||
    params.attempt.clientToolCalls ||
    params.attempt.yieldDetected ||
    params.attempt.didSendDeterministicApprovalPrompt ||
    params.attempt.lastToolError ||
    params.hasIntentionalTerminalCompletion ||
    params.attempt.hasToolMediaBlockReply ||
    resolveSourceReplyDelivery(params.attempt) !== "missing" ||
    // A tool-authored final reply awaits host delivery, so its delivery state is still missing.
    params.attempt.messagingToolSourceReplyPayloads?.some(
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

  const stopReason = assistant?.stopReason;
  if (
    !incompleteTerminalAssistant &&
    !assistantState.reasoningOnly &&
    !thinkingOnlyTerminal &&
    !assistantState.emptyResponse &&
    stopReason !== "error"
  ) {
    return null;
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
    preflightFailureText ??
    (failureFacts
      ? (failureFacts.providerRequestError?.userMessage ??
        failureFacts.formatFailureText ??
        renderAssistantRequestFailureCopy({
          reason: failureFacts.reason,
          status: failureFacts.status,
          code: failureFacts.code,
        }))
      : undefined);
  if (params.hadPotentialSideEffects || params.attempt.replayMetadata.hadPotentialSideEffects) {
    return `${promptFailureText ?? "⚠️ Agent couldn't generate a response."} Note: some tool actions may have already been executed — please verify before retrying.`;
  }
  if (preflightFailureText !== undefined) {
    return preflightFailureText;
  }
  if (assistant && isProviderRefusalAssistantError(assistant)) {
    return formatUserFacingAssistantErrorText(assistant);
  }
  const authFailure = params.terminalAuthFailure;
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
  return promptFailureText ?? "⚠️ Agent couldn't generate a response. Please try again.";
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
  acceptedSessionSpawns?: readonly { runId: string; childSessionKey: string }[];
  runtimeContinuationStarted?: boolean;
  yieldMessageWaitRegistered?: boolean;
  messagingToolSentTexts?: readonly string[];
  messagingToolSentMediaUrls?: readonly string[];
  messagingToolSentTargets?: readonly MessagingToolSend[];
  toolMetas?: readonly { asyncStarted?: boolean }[];
}

/** Continuation evidence for a yielded turn — sources that will produce future output. */
export function hasYieldContinuationEvidence(attempt: YieldContinuationAttempt): boolean {
  // Only same-attempt evidence is causal here. Session-wide active descendants may be
  // stale or unrelated and must not suppress the diagnostic for this yielded turn.
  return (
    (attempt.clientToolCalls?.length ?? 0) > 0 ||
    attempt.didSendDeterministicApprovalPrompt === true ||
    hasCommittedMessagingToolDeliveryEvidence(attempt) ||
    hasAcceptedSessionSpawn(attempt.acceptedSessionSpawns) ||
    attempt.runtimeContinuationStarted === true ||
    attempt.yieldMessageWaitRegistered === true ||
    hasAsyncActivity(attempt.toolMetas) ||
    (attempt.successfulCronAdds ?? 0) > 0
  );
}

export const YIELD_DIAGNOSTIC_TEXT =
  "⚠️ Turn yielded without a continuation source. Send a message to resume.";

export const TRUNCATED_REPLY_NOTICE_TEXT =
  "⚠️ Reply truncated at the model's output token limit. The text above is partial — ask to continue it.";

function readMessageTextContent(message: AgentMessage): string | undefined {
  const content = (message as { content?: unknown }).content;
  return normalizeOptionalString(
    typeof content === "string"
      ? content
      : collectTextContentBlocks(content)
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
          .join("\n"),
  );
}

function hasTrailingSilentToolResult(messages: readonly AgentMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message) {
      continue;
    }
    const role = normalizeLowercaseStringOrEmpty(message?.role);
    if (role === "toolresult" || role === "tool_result" || role === "tool") {
      if ((message as { isError?: boolean }).isError === true) {
        return false;
      }
      const text =
        readMessageTextContent(message) ??
        normalizeOptionalString(
          (message as { details?: { aggregated?: unknown } }).details?.aggregated,
        );
      return isSilentReplyText(text, SILENT_REPLY_TOKEN);
    }
    if (role === "assistant" && !readMessageTextContent(message)) {
      continue;
    }
    return false;
  }
  return false;
}

/** Emits the silent-reply token for cron turns whose last successful tool result is silent. */
export function resolveSilentToolResultReplyPayload(params: {
  isCronTrigger: boolean;
  payloadCount: number;
  aborted: boolean;
  timedOut: boolean;
  attempt: SilentToolResultAttempt;
}): { text: typeof SILENT_REPLY_TOKEN } | null {
  if (
    !params.isCronTrigger ||
    params.payloadCount !== 0 ||
    params.aborted ||
    params.timedOut ||
    (params.attempt.toolMetas?.length ?? 0) === 0 ||
    params.attempt.clientToolCalls ||
    params.attempt.yieldDetected ||
    params.attempt.didSendDeterministicApprovalPrompt ||
    params.attempt.lastToolError ||
    (params.attempt.messagesSnapshot?.length ?? 0) === 0
  ) {
    return null;
  }

  return hasTrailingSilentToolResult(params.attempt.messagesSnapshot)
    ? { text: SILENT_REPLY_TOKEN }
    : null;
}

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
  if (terminal.promptErrorSource === "compaction" || terminal.timedOutDuringCompaction) {
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
