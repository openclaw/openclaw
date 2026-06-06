import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import {
  isSilentReplyPayloadText,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
} from "../../../auto-reply/tokens.js";
import type { EmbeddedAgentExecutionContract } from "../../../config/types.agent-defaults.js";
import { hasAcceptedSessionSpawn } from "../../accepted-session-spawn.js";
import { collectTextContentBlocks } from "../../content-blocks.js";
import type { AgentMessage } from "../../runtime/index.js";
import { isLikelyMutatingToolName } from "../../tool-mutation.js";
import {
  hasCommittedMessagingToolDeliveryEvidence,
  hasMessagingToolDeliveryEvidence,
  hasMessagingToolSideEffectEvidence,
} from "../delivery-evidence.js";
import { isZeroUsageEmptyStopAssistantTurn } from "../empty-assistant-turn.js";
import { assessLastAssistantMessage } from "../thinking.js";
import type { EmbeddedRunLivenessState } from "../types.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

type ReplayMetadataAttempt = Pick<
  EmbeddedRunAttemptResult,
  | "toolMetas"
  | "didSendViaMessagingTool"
  | "messagingToolSentTexts"
  | "messagingToolSentMediaUrls"
  | "successfulCronAdds"
> &
  Partial<
    Pick<
      EmbeddedRunAttemptResult,
      "messagingToolSentTargets" | "messagingToolSourceReplyPayloads" | "acceptedSessionSpawns"
    >
  >;

type IncompleteTurnAttempt = Pick<
  EmbeddedRunAttemptResult,
  | "assistantTexts"
  | "clientToolCalls"
  | "currentAttemptAssistant"
  | "yieldDetected"
  | "didSendDeterministicApprovalPrompt"
  | "didSendViaMessagingTool"
  | "messagingToolSentTexts"
  | "messagingToolSentMediaUrls"
  | "messagingToolSentTargets"
  | "messagingToolSourceReplyPayloads"
  | "lastToolError"
  | "lastAssistant"
  | "itemLifecycle"
  | "replayMetadata"
  | "promptErrorSource"
  | "timedOutDuringCompaction"
  | "toolMetas"
> &
  Partial<Pick<EmbeddedRunAttemptResult, "acceptedSessionSpawns">>;

type PlanningOnlyAttempt = Pick<
  EmbeddedRunAttemptResult,
  | "assistantTexts"
  | "clientToolCalls"
  | "yieldDetected"
  | "didSendDeterministicApprovalPrompt"
  | "didSendViaMessagingTool"
  | "lastToolError"
  | "lastAssistant"
  | "itemLifecycle"
  | "replayMetadata"
  | "messagingToolSentTexts"
  | "messagingToolSentMediaUrls"
  | "messagingToolSentTargets"
  | "messagingToolSourceReplyPayloads"
  | "toolMetas"
>;

function hasPositiveOutputTokenUsage(message: AgentMessage | null): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const usage = (message as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") {
    return false;
  }
  const output = asFiniteNumber((usage as { output?: unknown }).output);
  return output !== undefined && output > 0;
}

type SilentToolResultAttempt = Pick<
  EmbeddedRunAttemptResult,
  | "clientToolCalls"
  | "yieldDetected"
  | "didSendDeterministicApprovalPrompt"
  | "lastToolError"
  | "messagesSnapshot"
  | "toolMetas"
>;

type TerminalToolResultReplyPayload = {
  text: string;
  isError?: boolean;
};

type RunLivenessAttempt = Pick<
  EmbeddedRunAttemptResult,
  "lastAssistant" | "promptErrorSource" | "replayMetadata" | "timedOutDuringCompaction"
>;

const REPLAY_UNSAFE_FALLBACK_METADATA: EmbeddedRunAttemptResult["replayMetadata"] = {
  hadPotentialSideEffects: true,
  replaySafe: false,
};

export function isIncompleteTerminalAssistantTurn(params: {
  hasAssistantVisibleText: boolean;
  lastAssistant?: { stopReason?: string } | null;
}): boolean {
  // A tool-use stop reason means the model issued a tool call and expected
  // to continue after tool results. If the session ended before the
  // post-tool assistant message arrived, the turn is incomplete regardless
  // of whether pre-tool text exists — that text is preliminary analysis,
  // not the final answer. (#76477)
  return params.lastAssistant?.stopReason === "toolUse";
}

const PLANNING_ONLY_PROMISE_RE =
  /\b(?:i(?:'ll| will)|let me|lemme|i(?:'m| am)\s+(?:going to|gonna|about to)|first[, ]+i(?:'ll| will)|next[, ]+i(?:'ll| will)|i can (?:do that|check|look|inspect|investigate|verify|review|search|run|test|handle|take|start|launch|send|monitor))\b/i;
const PLANNING_ONLY_PROGRESS_CLAIM_RE =
  /^(?:i(?:'m| am)\s+)?(?:checking|running|working(?:\s+on\s+it)?|on\s+it|taking\s+a\s+look|inspecting|reading|searching|looking(?:\s+into|\s+at)?|debugging|testing|verifying|investigating|reviewing|fetching|probing|starting|launching|sending(?:\s+(?:it|this|that|the\s+\w+))?\s+off|kicking\s+(?:it|this|that|the\s+\w+\s+)?off|monitoring\s+(?:it|this|that|now|for\b))\b/i;
const PLANNING_ONLY_COMPLETION_RE =
  /\b(?:done|finished|implemented|updated|fixed|changed|ran|verified|found|here(?:'s| is) what|blocked by|the blocker is|requires?|unavailable|not available|can't|cannot)\b/i;
const PLANNING_ONLY_HEADING_RE = /^(?:plan|steps?|next steps?)\s*:/i;
const PLANNING_ONLY_BULLET_RE = /^(?:[-*•]\s+|\d+[.)]\s+)/u;
const PLANNING_ONLY_MAX_VISIBLE_TEXT = 700;
const PLANNING_ONLY_ACTION_VERB_RE =
  /\b(?:inspect(?:ing)?|investigat(?:e|ing)|check(?:ing)?|look(?:ing)?(?:\s+into|\s+at)?|read(?:ing)?|search(?:ing)?|find(?:ing)?|debug(?:ging)?|fix(?:ing)?|patch(?:ing)?|updat(?:e|ing)|chang(?:e|ing)|edit(?:ing)?|writ(?:e|ing)|implement(?:ing)?|runn?ing|run|test(?:ing)?|verify|verifying|review(?:ing)?|analy(?:s|z)(?:e|ing)|summari(?:s|z)(?:e|ing)|explain(?:ing)?|answer(?:ing)?|show(?:ing)?|shar(?:e|ing)|report(?:ing)?|prepar(?:e|ing)|captur(?:e|ing)|tak(?:e|ing)|handl(?:e|ing)|sort(?:ing|ed)?|follow(?:ing)?\s+up|get(?:ting)?\s+back|start(?:ing)?|launch(?:ing)?|send(?:ing)?|monitor(?:ing)?|refactor(?:ing)?|restart(?:ing)?|deploy(?:ing)?|ship(?:ping)?)\b/i;
const ACTIONABLE_TASK_NOUN_RE =
  /\b(?:endpoint|results?|proof|restart|model|default|question|image|pull request|pr|cron|scheduler|jobs?|status|logs?|build|tests?|deploy|bug|error|fix|patch|config|settings?|reply|delivery|runtime|gateway|container|docker|discord)\b/i;
const PLANNING_ONLY_SHORT_PLACEHOLDER_RE =
  /\bi(?:'ll| will)\s+(?:do|handle|take care of|work on)\s+(?:it|that|this)\b/i;
const PLANNING_ONLY_WAIT_PLACEHOLDER_RE =
  /^(?:stand by|one sec(?:ond)?|give me (?:a )?(?:moment|minute|sec(?:ond)?)|hang on|hold on|bear with me|just a moment|please wait)(?:\s+(?:while|and)\b.{0,100})?[.!…]*$/i;
const PLANNING_ONLY_ACK_PLACEHOLDER_RE =
  /^(?:sure(?: thing)?|got it|understood|absolutely|will do|roger(?: that)?|copy(?: that)?|sounds good|okay|ok)(?:[.!…]*)$/i;
const SINGLE_ACTION_EXPLICIT_CONTINUATION_RE =
  /\b(?:going to|gonna|about to|first[, ]+i(?:'ll| will)|next[, ]+i(?:'ll| will)|then[, ]+i(?:'ll| will)|i can do that next|let me (?!know\b)\w+(?:\s+\w+){0,3}\s+(?:next|then|first)\b|lemme \w+(?:\s+\w+){0,3}\s+(?:next|then|first)\b)/i;
const SINGLE_ACTION_MULTI_STEP_PROMISE_RE =
  /\bi(?:'ll| will)\b(?=[^.!?]{0,160}\b(?:next|then|after(?:wards)?|once)\b)/i;
const SINGLE_ACTION_RESULT_STYLE_RE =
  /\b(?:i(?:'ll| will)\s+(?:summarize|explain|share|show|report|describe|clarify|answer|recap)(?:\s+\w+){0,4}\s*:|(?:here(?:'s| is)|summary|result|answer|findings?|root cause)\s*:)/i;
const SINGLE_ACTION_RETRY_SAFE_TOOL_NAMES = new Set([
  "read",
  "search",
  "find",
  "grep",
  "glob",
  "ls",
]);
// Ollama native `/api/chat` can finish with only thinking/internal blocks when
// constrained; keep a direct non-visible retry gate for those local-model turns.
const OLLAMA_INCOMPLETE_TURN_PROVIDER_ID_PATTERN = /^ollama(?:-|$)/;
// Model APIs eligible for the non-visible turn retry guard.  OpenAI Responses
// family can produce reasoning-only turns where usage.output > 0 but no visible
// text is emitted; without the guard these pass through as successful. (#85364)
const RETRY_GUARD_MODEL_APIS = new Set([
  "openai-completions",
  "anthropic-messages",
  "bedrock-converse-stream",
  "openai-responses",
  "openai-chatgpt-responses",
  "azure-openai-responses",
  "openclaw-openai-responses-transport",
  "openclaw-azure-openai-responses-transport",
]);
const DEFAULT_PLANNING_ONLY_RETRY_LIMIT = 1;
const STRICT_AGENTIC_PLANNING_ONLY_RETRY_LIMIT = 2;
// Allow one immediate continuation plus one follow-up continuation before
// surfacing the existing incomplete-turn error path.
export const DEFAULT_REASONING_ONLY_RETRY_LIMIT = 2;
export const DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT = 1;
const ACK_EXECUTION_NORMALIZED_SET = new Set([
  "ok",
  "okay",
  "ok do it",
  "okay do it",
  "do it",
  "go ahead",
  "please do",
  "sounds good",
  "sounds good do it",
  "ship it",
  "fix it",
  "make it so",
  "yes do it",
  "yep do it",
  "تمام",
  "حسنا",
  "حسنًا",
  "امض قدما",
  "نفذها",
  "mach es",
  "leg los",
  "los geht s",
  "weiter",
  "やって",
  "進めて",
  "そのまま進めて",
  "allez y",
  "vas y",
  "fais le",
  "continue",
  "hazlo",
  "adelante",
  "sigue",
  "faz isso",
  "vai em frente",
  "pode fazer",
  "해줘",
  "진행해",
  "계속해",
]);
const EXPLICIT_PLANNING_REQUEST_RE =
  /\b(?:what(?:'s| is) (?:(?:the|your|our|my) )?(?:plan|approach)|give me (?:a )?(?:plan|approach|outline)|outline (?:the )?(?:plan|approach|steps)|(?:only|just) (?:plan|outline)|how would you\b|propose (?:a )?(?:plan|approach))\b/i;
const NON_ACTIONABLE_CONTEXT_UPDATE_RE =
  /^\s*(?:i|we)\b(?!.{0,120}\b(?:need|want|would like)\s+you\b).{0,180}\b(?:haven't|have not|am not|ain't|haven’t)\b.{0,120}\b(?:yet|though|fyi|heads up)\b/i;
const NON_ACTIONABLE_PROMPT_NORMALIZED_SET = new Set([
  "cool",
  "great",
  "haha",
  "lol",
  "nice",
  "nice work",
  "ok",
  "okay",
  "perfect",
  "thanks",
  "thank you",
  "ty",
  "yep",
  "yes",
]);

export const PLANNING_ONLY_RETRY_INSTRUCTION =
  "The previous assistant turn only described the plan. Do not restate the plan. Act now: take the first concrete tool action you can. If a real blocker prevents action, reply with the exact blocker in one sentence.";
export const REASONING_ONLY_RETRY_INSTRUCTION =
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue from that partial turn and produce the visible answer now. Do not restate the reasoning or restart from scratch.";
export const EMPTY_RESPONSE_RETRY_INSTRUCTION =
  "The previous attempt did not produce a user-visible answer. Continue from the current state and produce the visible answer now. Do not restart from scratch.";
export const ACK_EXECUTION_FAST_PATH_INSTRUCTION =
  "The latest user message is a short approval to proceed. Do not recap or restate the plan. Start with the first concrete tool action immediately. Keep any user-facing follow-up brief and natural.";
export const PLANNING_ONLY_BLOCKED_TEXT =
  "Agent stopped after repeated plan-only turns without taking a concrete action. No concrete tool action or external side effect advanced the task.";
export const STRICT_AGENTIC_BLOCKED_TEXT = PLANNING_ONLY_BLOCKED_TEXT;

export type PlanningOnlyPlanDetails = {
  explanation: string;
  steps: string[];
};

export function buildAttemptReplayMetadata(
  params: ReplayMetadataAttempt,
): EmbeddedRunAttemptResult["replayMetadata"] {
  const hadMutatingTools = params.toolMetas.some(
    (t) => t.mutatingAction ?? isLikelyMutatingToolName(t.toolName),
  );
  const hadAsyncStartedTool = params.toolMetas.some((t) => t.asyncStarted === true);
  const hadPotentialSideEffects =
    hadMutatingTools ||
    hadAsyncStartedTool ||
    hasMessagingToolSideEffectEvidence(params) ||
    hasAcceptedSessionSpawn(params.acceptedSessionSpawns) ||
    (params.successfulCronAdds ?? 0) > 0;
  return {
    hadPotentialSideEffects,
    replaySafe: !hadPotentialSideEffects,
  };
}

export function resolveAttemptReplayMetadata(attempt: {
  replayMetadata?: EmbeddedRunAttemptResult["replayMetadata"] | null;
}): EmbeddedRunAttemptResult["replayMetadata"] {
  return attempt.replayMetadata ?? REPLAY_UNSAFE_FALLBACK_METADATA;
}

export function resolveIncompleteTurnPayloadText(params: {
  payloadCount: number;
  aborted: boolean;
  externalAbort: boolean;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
}): string | null {
  // Tool-use terminal guard: when the last assistant message ended with a
  // tool-call stop reason, the model expected to continue after tool results.
  // Pre-tool text alone (payloadCount > 0) must not suppress the incomplete-
  // turn check in that case — the final post-tool response was never
  // produced. (#76477)
  const toolUseTerminal = params.attempt.lastAssistant?.stopReason === "toolUse";
  const emptyResponseAssistant = isEmptyResponseAssistantTurn({
    payloadCount: params.payloadCount,
    attempt: params.attempt,
  });
  const reasoningOnlyAssistant = isReasoningOnlyAssistantTurn(
    params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant,
  );
  const nonVisiblePostToolAssistant =
    emptyResponseAssistant || (reasoningOnlyAssistant && hasCompletedToolActivity(params.attempt));

  if (
    (params.payloadCount !== 0 && !toolUseTerminal && !nonVisiblePostToolAssistant) ||
    (params.aborted && params.externalAbort) ||
    params.timedOut ||
    params.attempt.clientToolCalls ||
    params.attempt.yieldDetected ||
    params.attempt.didSendDeterministicApprovalPrompt ||
    hasReplayBlockingToolError(params.attempt)
  ) {
    return null;
  }

  if (hasOnlySilentAssistantReply(params.attempt.assistantTexts)) {
    return null;
  }

  if (hasCommittedMessagingToolDeliveryEvidence(params.attempt)) {
    return null;
  }

  if (hasAcceptedSessionSpawn(params.attempt.acceptedSessionSpawns)) {
    return null;
  }

  const stopReason = params.attempt.lastAssistant?.stopReason;
  const incompleteTerminalAssistant = isIncompleteTerminalAssistantTurn({
    hasAssistantVisibleText: params.payloadCount > 0,
    lastAssistant: params.attempt.lastAssistant,
  });
  if (
    !incompleteTerminalAssistant &&
    !reasoningOnlyAssistant &&
    !emptyResponseAssistant &&
    stopReason !== "error"
  ) {
    return null;
  }

  return resolveAttemptReplayMetadata(params.attempt).hadPotentialSideEffects
    ? "⚠️ Agent couldn't generate a response. Note: some tool actions may have already been executed — please verify before retrying."
    : "⚠️ Agent couldn't generate a response. Please try again.";
}

export function shouldRetryMissingAssistantTurn(params: {
  payloadCount: number;
  aborted: boolean;
  promptError?: unknown;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
}): boolean {
  if (
    params.payloadCount !== 0 ||
    params.aborted ||
    Boolean(params.promptError) ||
    params.timedOut ||
    params.attempt.clientToolCalls ||
    params.attempt.currentAttemptAssistant ||
    params.attempt.lastAssistant ||
    params.attempt.yieldDetected ||
    params.attempt.didSendDeterministicApprovalPrompt ||
    params.attempt.lastToolError
  ) {
    return false;
  }

  if (hasOnlySilentAssistantReply(params.attempt.assistantTexts)) {
    return false;
  }

  if (joinAssistantTexts(params.attempt.assistantTexts).length > 0) {
    return false;
  }

  if (hasCommittedMessagingToolDeliveryEvidence(params.attempt)) {
    return false;
  }

  if (hasAcceptedSessionSpawn(params.attempt.acceptedSessionSpawns)) {
    return false;
  }

  if (hasAsyncStartedToolActivity(params.attempt.toolMetas)) {
    return false;
  }

  if (
    (params.attempt.itemLifecycle?.startedCount ?? 0) > 0 ||
    (params.attempt.itemLifecycle?.activeCount ?? 0) > 0
  ) {
    return false;
  }

  return !resolveAttemptReplayMetadata(params.attempt).hadPotentialSideEffects;
}

function joinAssistantTexts(assistantTexts?: readonly string[]): string {
  return (assistantTexts ?? []).join("\n\n").trim();
}

function hasOnlySilentAssistantReply(assistantTexts?: readonly string[]): boolean {
  const nonEmptyTexts = (assistantTexts ?? []).filter((text) => text.trim().length > 0);
  return (
    nonEmptyTexts.length > 0 &&
    nonEmptyTexts.every((text) => isSilentReplyPayloadText(text, SILENT_REPLY_TOKEN))
  );
}

function hasAsyncStartedToolActivity(toolMetas?: readonly { asyncStarted?: boolean }[]): boolean {
  return (toolMetas ?? []).some((entry) => entry.asyncStarted === true);
}

function isToolResultRole(role: string): boolean {
  return role === "toolresult" || role === "tool_result" || role === "tool";
}

function readMessageTextContent(message: AgentMessage): string | undefined {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed || undefined;
  }
  const text = collectTextContentBlocks(content)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .join("\n");
  return text || undefined;
}

function readToolResultAggregatedText(message: AgentMessage): string | undefined {
  const aggregated = (message as { details?: { aggregated?: unknown } }).details?.aggregated;
  if (typeof aggregated !== "string") {
    return undefined;
  }
  const trimmed = aggregated.trim();
  return trimmed || undefined;
}

function resolveTrailingToolResultText(messages: readonly AgentMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message) {
      continue;
    }
    const role = normalizeLowercaseStringOrEmpty(message?.role);
    if (isToolResultRole(role)) {
      if ((message as { isError?: boolean }).isError === true) {
        return null;
      }
      const text = readMessageTextContent(message) ?? readToolResultAggregatedText(message);
      return text ?? null;
    }
    if (role === "assistant" && !readMessageTextContent(message)) {
      continue;
    }
    return null;
  }
  return null;
}

function resolveSingleToolName(toolMetas?: readonly { toolName?: string }[]): string | undefined {
  const names = new Set(
    (toolMetas ?? [])
      .map((entry) => entry.toolName?.trim())
      .filter((name): name is string => Boolean(name)),
  );
  return names.size === 1 ? names.values().next().value : undefined;
}

export function resolveTerminalToolResultReplyPayload(params: {
  isCronTrigger: boolean;
  payloadCount: number;
  aborted: boolean;
  timedOut: boolean;
  attempt: SilentToolResultAttempt;
}): TerminalToolResultReplyPayload | null {
  if (
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

  const trailingToolResultText = resolveTrailingToolResultText(params.attempt.messagesSnapshot);
  if (isSilentReplyText(trailingToolResultText ?? undefined, SILENT_REPLY_TOKEN)) {
    return params.isCronTrigger ? { text: SILENT_REPLY_TOKEN } : null;
  }

  if (trailingToolResultText === null) {
    return null;
  }
  const toolName = resolveSingleToolName(params.attempt.toolMetas);
  const subject = toolName ? `${toolName} completed` : "Tool work completed";
  return {
    text:
      `${subject}, but the model did not provide a final answer. ` +
      "No user-facing result text was provided.",
  };
}

export const resolveSilentToolResultReplyPayload = resolveTerminalToolResultReplyPayload;

export function resolveReplayInvalidFlag(params: {
  attempt: RunLivenessAttempt;
  incompleteTurnText?: string | null;
}): boolean {
  return (
    !resolveAttemptReplayMetadata(params.attempt).replaySafe ||
    params.attempt.promptErrorSource === "compaction" ||
    params.attempt.timedOutDuringCompaction ||
    Boolean(params.incompleteTurnText)
  );
}

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
  if (
    params.attempt.promptErrorSource === "compaction" ||
    params.attempt.timedOutDuringCompaction
  ) {
    return "paused";
  }
  if ((params.aborted || params.timedOut) && params.payloadCount === 0) {
    return "blocked";
  }
  if (params.attempt.lastAssistant?.stopReason === "error") {
    return "blocked";
  }
  return "working";
}

function isReasoningOnlyAssistantTurn(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  return assessLastAssistantMessage(message as AgentMessage) === "incomplete-text";
}

function isEmptyResponseAssistantTurn(params: {
  payloadCount: number;
  attempt: Pick<
    IncompleteTurnAttempt,
    "assistantTexts" | "currentAttemptAssistant" | "lastAssistant" | "itemLifecycle" | "toolMetas"
  >;
}): boolean {
  if (params.payloadCount !== 0 && !hasCompletedToolActivity(params.attempt)) {
    return false;
  }
  if (
    joinAssistantTexts(params.attempt.assistantTexts).length > 0 &&
    !hasCompletedToolActivity(params.attempt)
  ) {
    return false;
  }
  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant;
  if (!assistant) {
    return true;
  }
  if (assistant.stopReason === "error") {
    return false;
  }
  if (
    isIncompleteTerminalAssistantTurn({
      hasAssistantVisibleText: false,
      lastAssistant: assistant,
    }) ||
    isReasoningOnlyAssistantTurn(assistant)
  ) {
    return false;
  }
  return true;
}

function hasCompletedToolActivity(
  attempt: Pick<IncompleteTurnAttempt, "itemLifecycle" | "toolMetas">,
): boolean {
  return (attempt.itemLifecycle?.completedCount ?? 0) > 0 && attempt.toolMetas.length > 0;
}

function isNonVisibleAssistantTurnEligibleForSilentReply(params: {
  payloadCount: number;
  attempt: Pick<
    IncompleteTurnAttempt,
    "assistantTexts" | "currentAttemptAssistant" | "lastAssistant" | "itemLifecycle" | "toolMetas"
  >;
}): boolean {
  if (isEmptyResponseAssistantTurn(params)) {
    return true;
  }
  if (params.payloadCount !== 0) {
    return false;
  }
  if (joinAssistantTexts(params.attempt.assistantTexts).length > 0) {
    return false;
  }
  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant;
  if (!assistant || assistant.stopReason === "error") {
    return false;
  }
  if (
    isIncompleteTerminalAssistantTurn({
      hasAssistantVisibleText: false,
      lastAssistant: assistant,
    })
  ) {
    return false;
  }
  return isReasoningOnlyAssistantTurn(assistant);
}

function shouldSkipPlanningOnlyRetry(params: {
  aborted: boolean;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
}): boolean {
  return Boolean(
    params.aborted ||
    params.timedOut ||
    params.attempt.clientToolCalls ||
    params.attempt.yieldDetected ||
    params.attempt.didSendDeterministicApprovalPrompt ||
    hasReplayBlockingToolError(params.attempt) ||
    hasAcceptedSessionSpawn(params.attempt.acceptedSessionSpawns) ||
    resolveAttemptReplayMetadata(params.attempt).hadPotentialSideEffects,
  );
}

function hasReplayBlockingToolError(
  attempt: Pick<IncompleteTurnAttempt, "lastToolError">,
): boolean {
  const error = attempt.lastToolError;
  if (!error) {
    return false;
  }
  return error.mutatingAction ?? isLikelyMutatingToolName(error.toolName);
}

export function shouldTreatEmptyAssistantReplyAsSilent(params: {
  allowEmptyAssistantReplyAsSilent?: boolean;
  payloadCount: number;
  aborted: boolean;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
}): boolean {
  if (!params.allowEmptyAssistantReplyAsSilent || shouldSkipPlanningOnlyRetry(params)) {
    return false;
  }
  if (hasCommittedMessagingToolDeliveryEvidence(params.attempt)) {
    return false;
  }
  return isNonVisibleAssistantTurnEligibleForSilentReply({
    payloadCount: params.payloadCount,
    attempt: params.attempt,
  });
}

export function resolveReasoningOnlyRetryInstruction(params: {
  provider?: string;
  modelId?: string;
  modelApi?: string;
  executionContract?: string;
  aborted: boolean;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
}): string | null {
  if (shouldSkipPlanningOnlyRetry(params)) {
    return null;
  }

  if (
    !shouldApplyNonVisibleTurnRetryGuard({
      provider: params.provider,
      modelId: params.modelId,
      modelApi: params.modelApi,
      executionContract: params.executionContract,
    })
  ) {
    return null;
  }

  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant;
  if (
    joinAssistantTexts(params.attempt.assistantTexts).length > 0 &&
    !hasCompletedToolActivity(params.attempt)
  ) {
    return null;
  }
  if (assistant?.stopReason === "error") {
    return null;
  }
  if (!isReasoningOnlyAssistantTurn(assistant)) {
    return null;
  }

  return REASONING_ONLY_RETRY_INSTRUCTION;
}

export function resolveEmptyResponseRetryInstruction(params: {
  provider?: string;
  modelId?: string;
  modelApi?: string;
  executionContract?: string;
  payloadCount: number;
  aborted: boolean;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
}): string | null {
  if (shouldSkipPlanningOnlyRetry(params)) {
    return null;
  }

  if (
    !isEmptyResponseAssistantTurn({
      payloadCount: params.payloadCount,
      attempt: params.attempt,
    })
  ) {
    return null;
  }

  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant ?? null;
  if (
    assistant?.stopReason === "stop" &&
    OLLAMA_INCOMPLETE_TURN_PROVIDER_ID_PATTERN.test(
      normalizeLowercaseStringOrEmpty(params.provider ?? ""),
    ) &&
    !hasPositiveOutputTokenUsage(assistant)
  ) {
    return null;
  }

  if (
    shouldApplyNonVisibleTurnRetryGuard({
      provider: params.provider,
      modelId: params.modelId,
      modelApi: params.modelApi,
      executionContract: params.executionContract,
    }) ||
    // Keep the generic zero-usage stop retry for providers that expose a
    // provider-neutral "nothing was generated" signal, even outside the
    // provider allowlist above.
    isZeroUsageEmptyStopAssistantTurn(assistant)
  ) {
    return EMPTY_RESPONSE_RETRY_INSTRUCTION;
  }

  return null;
}

function shouldApplyPlanningOnlyRetryGuard(params: {
  provider?: string;
  modelId?: string;
  executionContract?: string;
}): boolean {
  void params;
  return true;
}

function shouldApplyNonVisibleTurnRetryGuard(params: {
  provider?: string;
  modelId?: string;
  modelApi?: string;
  executionContract?: string;
}): boolean {
  if (shouldApplyPlanningOnlyRetryGuard(params)) {
    return true;
  }
  if (RETRY_GUARD_MODEL_APIS.has(normalizeLowercaseStringOrEmpty(params.modelApi ?? ""))) {
    return true;
  }
  // Non-visible final turns are narrower than planning-only turns: there is no
  // user text to classify, just a replay-safe empty/thinking-only result.
  return OLLAMA_INCOMPLETE_TURN_PROVIDER_ID_PATTERN.test(
    normalizeLowercaseStringOrEmpty(params.provider ?? ""),
  );
}

function normalizeAckPrompt(text: string): string {
  const normalized = text
    .normalize("NFKC")
    .trim()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalizeLowercaseStringOrEmpty(normalized);
}

export function isLikelyExecutionAckPrompt(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 80 || trimmed.includes("\n") || trimmed.includes("?")) {
    return false;
  }
  return ACK_EXECUTION_NORMALIZED_SET.has(normalizeAckPrompt(trimmed));
}

function isLikelyNonActionableUserPrompt(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes("?") || trimmed.includes("\n")) {
    return false;
  }
  if (
    trimmed.length <= 80 &&
    NON_ACTIONABLE_PROMPT_NORMALIZED_SET.has(normalizeAckPrompt(trimmed))
  ) {
    return true;
  }
  return NON_ACTIONABLE_CONTEXT_UPDATE_RE.test(trimmed);
}

function isExplicitPlanningOnlyUserPrompt(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && EXPLICIT_PLANNING_REQUEST_RE.test(trimmed);
}

function isLikelyActionableUserPrompt(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (isLikelyNonActionableUserPrompt(trimmed) || isExplicitPlanningOnlyUserPrompt(trimmed)) {
    return false;
  }
  return (
    trimmed.includes("?") ||
    PLANNING_ONLY_ACTION_VERB_RE.test(trimmed) ||
    ACTIONABLE_TASK_NOUN_RE.test(trimmed)
  );
}

export function resolveAckExecutionFastPathInstruction(params: {
  provider?: string;
  modelId?: string;
  prompt: string;
}): string | null {
  if (!isLikelyExecutionAckPrompt(params.prompt)) {
    return null;
  }
  return ACK_EXECUTION_FAST_PATH_INSTRUCTION;
}

function extractPlanningOnlySteps(text: string): string[] {
  const lines = normalizeStringEntries(text.split(/\r?\n/));
  const bulletLines = normalizeStringEntries(
    lines.map((line) => line.replace(/^[-*•]\s+|^\d+[.)]\s+/u, "")),
  );
  if (bulletLines.length >= 2) {
    return bulletLines.slice(0, 4);
  }
  return normalizeStringEntries(text.split(/(?<=[.!?])\s+/u)).slice(0, 4);
}

function hasStructuredPlanningOnlyFormat(text: string): boolean {
  const lines = normalizeStringEntries(text.split(/\r?\n/));
  if (lines.length === 0) {
    return false;
  }
  const bulletLineCount = lines.filter((line) => PLANNING_ONLY_BULLET_RE.test(line)).length;
  const hasPlanningCueLine = lines.some(
    (line) => PLANNING_ONLY_PROMISE_RE.test(line) || PLANNING_ONLY_PROGRESS_CLAIM_RE.test(line),
  );
  const hasPlanningHeading = PLANNING_ONLY_HEADING_RE.test(lines[0] ?? "");
  return (hasPlanningHeading && hasPlanningCueLine) || (bulletLineCount >= 2 && hasPlanningCueLine);
}

function normalizePlanningOnlyClassifierText(text: string): string {
  return text.replace(/[\u2018\u2019\u02bc]/gu, "'");
}

export function extractPlanningOnlyPlanDetails(text: string): PlanningOnlyPlanDetails | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  const steps = extractPlanningOnlySteps(trimmed);
  return {
    explanation: trimmed,
    steps,
  };
}

function normalizePlanningToolMetas(
  toolMetas?: PlanningOnlyAttempt["toolMetas"],
): PlanningOnlyAttempt["toolMetas"] {
  return toolMetas ?? [];
}

function countPlanOnlyToolMetas(toolMetas?: PlanningOnlyAttempt["toolMetas"]): number {
  return normalizePlanningToolMetas(toolMetas).filter((entry) => entry.toolName === "update_plan")
    .length;
}

function countNonPlanToolCalls(toolMetas?: PlanningOnlyAttempt["toolMetas"]): number {
  return normalizePlanningToolMetas(toolMetas).filter((entry) => entry.toolName !== "update_plan")
    .length;
}

function hasNonPlanToolActivity(toolMetas?: PlanningOnlyAttempt["toolMetas"]): boolean {
  return normalizePlanningToolMetas(toolMetas).some((entry) => entry.toolName !== "update_plan");
}

function hasSingleRetrySafeNonPlanTool(toolMetas?: PlanningOnlyAttempt["toolMetas"]): boolean {
  const nonPlanTools = normalizePlanningToolMetas(toolMetas).filter(
    (entry) => normalizeLowercaseStringOrEmpty(entry.toolName) !== "update_plan",
  );
  const nonPlanToolNames = nonPlanTools
    .map((entry) => normalizeLowercaseStringOrEmpty(entry.toolName))
    .filter(Boolean);
  return (
    nonPlanTools.length === 1 &&
    (SINGLE_ACTION_RETRY_SAFE_TOOL_NAMES.has(nonPlanToolNames[0] ?? "") ||
      isPlanningRetrySafeToolMeta(nonPlanTools[0] as PlanningOnlyAttempt["toolMetas"][number]))
  );
}

function isPlanningRetrySafeToolMeta(toolMeta: PlanningOnlyAttempt["toolMetas"][number]): boolean {
  return (
    toolMeta.mutatingAction === false ||
    SINGLE_ACTION_RETRY_SAFE_TOOL_NAMES.has(normalizeLowercaseStringOrEmpty(toolMeta.toolName))
  );
}

function hasCompletedRetrySafeNonPlanToolActivity(
  attempt: Pick<PlanningOnlyAttempt, "itemLifecycle" | "toolMetas">,
): boolean {
  const nonPlanTools = normalizePlanningToolMetas(attempt.toolMetas).filter(
    (entry) => entry.toolName !== "update_plan",
  );
  if (nonPlanTools.length < 2 || (attempt.itemLifecycle?.activeCount ?? 0) > 0) {
    return false;
  }
  const completedCount = attempt.itemLifecycle?.completedCount ?? 0;
  if (completedCount < nonPlanTools.length) {
    return false;
  }
  return nonPlanTools.every(isPlanningRetrySafeToolMeta);
}

/**
 * Treat a turn with exactly one non-plan tool call plus visible "I'll do X
 * next" prose as effectively planning-only from the user's perspective. This
 * closes the one-action-then-narrative loophole without changing the 2+ tool
 * call path, which still counts as real multi-step progress.
 */
function isSingleActionThenNarrativePattern(params: {
  toolMetas?: PlanningOnlyAttempt["toolMetas"];
  assistantTexts?: readonly string[];
}): boolean {
  const nonPlanCount = countNonPlanToolCalls(params.toolMetas);
  if (nonPlanCount !== 1) {
    return false;
  }
  const text = (params.assistantTexts ?? []).join("\n\n").trim();
  if (!text || text.length > PLANNING_ONLY_MAX_VISIBLE_TEXT) {
    return false;
  }
  const classifierText = normalizePlanningOnlyClassifierText(text);
  if (SINGLE_ACTION_RESULT_STYLE_RE.test(classifierText)) {
    return false;
  }
  return (
    SINGLE_ACTION_EXPLICIT_CONTINUATION_RE.test(classifierText) ||
    SINGLE_ACTION_MULTI_STEP_PROMISE_RE.test(classifierText)
  );
}

export function isPlanningOnlyAssistantText(
  assistantTexts?: readonly string[],
  options: { singleActionNarrative?: boolean } = {},
): boolean {
  const text = (assistantTexts ?? []).join("\n\n").trim();
  if (!text || text.length > PLANNING_ONLY_MAX_VISIBLE_TEXT || text.includes("```")) {
    return false;
  }
  const classifierText = normalizePlanningOnlyClassifierText(text);
  const hasStructuredPlanningFormat = hasStructuredPlanningOnlyFormat(classifierText);
  const hasProgressClaim = PLANNING_ONLY_PROGRESS_CLAIM_RE.test(classifierText);
  const hasShortPlaceholder = PLANNING_ONLY_SHORT_PLACEHOLDER_RE.test(classifierText);
  const hasWaitPlaceholder = PLANNING_ONLY_WAIT_PLACEHOLDER_RE.test(classifierText);
  const hasAckPlaceholder = PLANNING_ONLY_ACK_PLACEHOLDER_RE.test(classifierText);
  const hasPlanningCue =
    PLANNING_ONLY_PROMISE_RE.test(classifierText) ||
    hasProgressClaim ||
    hasWaitPlaceholder ||
    hasAckPlaceholder;
  if (!hasPlanningCue && !hasStructuredPlanningFormat) {
    return false;
  }
  if (
    !hasStructuredPlanningFormat &&
    !options.singleActionNarrative &&
    !hasProgressClaim &&
    !hasShortPlaceholder &&
    !hasWaitPlaceholder &&
    !hasAckPlaceholder &&
    !PLANNING_ONLY_ACTION_VERB_RE.test(classifierText)
  ) {
    return false;
  }
  return !PLANNING_ONLY_COMPLETION_RE.test(classifierText);
}

function resolvePlanningOnlyTurnClassification(params: {
  prompt?: string;
  aborted: boolean;
  timedOut: boolean;
  attempt: PlanningOnlyAttempt;
}): { singleActionNarrative: boolean; allowSingleActionRetryBypass: boolean } | null {
  const singleActionNarrative = isSingleActionThenNarrativePattern({
    toolMetas: params.attempt.toolMetas,
    assistantTexts: params.attempt.assistantTexts,
  });
  if (
    (typeof params.prompt === "string" && !isLikelyActionableUserPrompt(params.prompt)) ||
    params.aborted ||
    params.timedOut ||
    params.attempt.clientToolCalls ||
    params.attempt.yieldDetected ||
    params.attempt.didSendDeterministicApprovalPrompt ||
    hasMessagingToolDeliveryEvidence(params.attempt)
  ) {
    return null;
  }

  const stopReason = params.attempt.lastAssistant?.stopReason;
  if (stopReason && stopReason !== "stop") {
    return null;
  }

  const text = (params.attempt.assistantTexts ?? []).join("\n\n").trim();
  if (!text || text.length > PLANNING_ONLY_MAX_VISIBLE_TEXT || text.includes("```")) {
    return null;
  }
  const classifierText = normalizePlanningOnlyClassifierText(text);
  const hasStructuredPlanningFormat = hasStructuredPlanningOnlyFormat(classifierText);
  const hasProgressClaim = PLANNING_ONLY_PROGRESS_CLAIM_RE.test(classifierText);
  const hasShortPlaceholder = PLANNING_ONLY_SHORT_PLACEHOLDER_RE.test(classifierText);
  const hasWaitPlaceholder = PLANNING_ONLY_WAIT_PLACEHOLDER_RE.test(classifierText);
  const hasAckPlaceholder = PLANNING_ONLY_ACK_PLACEHOLDER_RE.test(classifierText);
  if (
    !isPlanningOnlyAssistantText(params.attempt.assistantTexts, {
      singleActionNarrative,
    })
  ) {
    return null;
  }
  if (
    !hasStructuredPlanningFormat &&
    !singleActionNarrative &&
    !hasProgressClaim &&
    !hasShortPlaceholder &&
    !hasWaitPlaceholder &&
    !hasAckPlaceholder &&
    !PLANNING_ONLY_ACTION_VERB_RE.test(classifierText)
  ) {
    return null;
  }
  if (PLANNING_ONLY_COMPLETION_RE.test(classifierText)) {
    return null;
  }

  return {
    singleActionNarrative,
    allowSingleActionRetryBypass:
      singleActionNarrative && hasSingleRetrySafeNonPlanTool(params.attempt.toolMetas),
  };
}

export function resolvePlanningOnlyRetryLimit(
  executionContract?: EmbeddedAgentExecutionContract,
): number {
  return executionContract === "strict-agentic"
    ? STRICT_AGENTIC_PLANNING_ONLY_RETRY_LIMIT
    : DEFAULT_PLANNING_ONLY_RETRY_LIMIT;
}

export function resolvePlanningOnlyRetryInstruction(params: {
  provider?: string;
  modelId?: string;
  executionContract?: string;
  prompt?: string;
  aborted: boolean;
  timedOut: boolean;
  attempt: PlanningOnlyAttempt;
}): string | null {
  const planOnlyToolMetaCount = countPlanOnlyToolMetas(params.attempt.toolMetas);
  const planningOnly = resolvePlanningOnlyTurnClassification(params);
  if (!planningOnly) {
    return null;
  }
  const allowRetrySafeToolActivity = hasCompletedRetrySafeNonPlanToolActivity(params.attempt);
  if (
    !shouldApplyPlanningOnlyRetryGuard({
      provider: params.provider,
      modelId: params.modelId,
      executionContract: params.executionContract,
    }) ||
    hasReplayBlockingToolError(params.attempt) ||
    (hasNonPlanToolActivity(params.attempt.toolMetas) &&
      !planningOnly.allowSingleActionRetryBypass &&
      !allowRetrySafeToolActivity) ||
    ((params.attempt.itemLifecycle?.startedCount ?? 0) > planOnlyToolMetaCount &&
      !planningOnly.allowSingleActionRetryBypass &&
      !allowRetrySafeToolActivity) ||
    resolveAttemptReplayMetadata(params.attempt).hadPotentialSideEffects
  ) {
    return null;
  }

  return PLANNING_ONLY_RETRY_INSTRUCTION;
}

export function resolvePlanningOnlyBlockedPayloadText(params: {
  provider?: string;
  modelId?: string;
  prompt?: string;
  aborted: boolean;
  timedOut: boolean;
  attempt: PlanningOnlyAttempt;
}): string | null {
  const planOnlyToolMetaCount = countPlanOnlyToolMetas(params.attempt.toolMetas);
  const planningOnly = resolvePlanningOnlyTurnClassification(params);
  if (!planningOnly) {
    return null;
  }
  const allowRetrySafeToolActivity = hasCompletedRetrySafeNonPlanToolActivity(params.attempt);
  const retryBlockedByToolActivity =
    hasReplayBlockingToolError(params.attempt) ||
    (hasNonPlanToolActivity(params.attempt.toolMetas) &&
      !planningOnly.allowSingleActionRetryBypass &&
      !allowRetrySafeToolActivity) ||
    ((params.attempt.itemLifecycle?.startedCount ?? 0) > planOnlyToolMetaCount &&
      !planningOnly.allowSingleActionRetryBypass &&
      !allowRetrySafeToolActivity);
  if (
    retryBlockedByToolActivity ||
    resolveAttemptReplayMetadata(params.attempt).hadPotentialSideEffects
  ) {
    return PLANNING_ONLY_BLOCKED_TEXT;
  }
  return null;
}

export function resolvePlanningOnlyTerminalPayloadText(params: {
  provider?: string;
  modelId?: string;
  prompt?: string;
  aborted: boolean;
  timedOut: boolean;
  attempt: PlanningOnlyAttempt;
}): string | null {
  return resolvePlanningOnlyTurnClassification(params) ? PLANNING_ONLY_BLOCKED_TEXT : null;
}
