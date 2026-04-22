import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { EmbeddedPiExecutionContract } from "../../../config/types.agent-defaults.js";
import { normalizeLowercaseStringOrEmpty } from "../../../shared/string-coerce.js";
import { isStrictAgenticSupportedProviderModel } from "../../execution-contract.js";
import { isLikelyMutatingToolName } from "../../tool-mutation.js";
import { assessLastAssistantMessage } from "../thinking.js";
import type { EmbeddedRunLivenessState } from "../types.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

type ReplayMetadataAttempt = Pick<
  EmbeddedRunAttemptResult,
  "toolMetas" | "didSendViaMessagingTool" | "successfulCronAdds"
>;

type IncompleteTurnAttempt = Pick<
  EmbeddedRunAttemptResult,
  | "assistantTexts"
  | "clientToolCall"
  | "currentAttemptAssistant"
  | "yieldDetected"
  | "didSendDeterministicApprovalPrompt"
  | "lastToolError"
  | "lastAssistant"
  | "replayMetadata"
  | "promptErrorSource"
  | "timedOutDuringCompaction"
>;

type PlanningOnlyAttempt = Pick<
  EmbeddedRunAttemptResult,
  | "assistantTexts"
  | "clientToolCall"
  | "yieldDetected"
  | "didSendDeterministicApprovalPrompt"
  | "didSendViaMessagingTool"
  | "lastToolError"
  | "lastAssistant"
  | "itemLifecycle"
  | "replayMetadata"
  | "toolMetas"
>;

type RunLivenessAttempt = Pick<
  EmbeddedRunAttemptResult,
  "lastAssistant" | "promptErrorSource" | "replayMetadata" | "timedOutDuringCompaction"
>;

export function isIncompleteTerminalAssistantTurn(params: {
  hasAssistantVisibleText: boolean;
  lastAssistant?: { stopReason?: string } | null;
}): boolean {
  return !params.hasAssistantVisibleText && params.lastAssistant?.stopReason === "toolUse";
}

const PLANNING_ONLY_PROMISE_RE =
  /\b(?:i(?:'ll| will)|let me|i(?:'m| am)\s+going to|first[, ]+i(?:'ll| will)|next[, ]+i(?:'ll| will)|i can do that)\b/i;
const PLANNING_ONLY_COMPLETION_RE =
  /\b(?:done|finished|implemented|updated|fixed|changed|ran|verified|found|here(?:'s| is) what|blocked by|the blocker is)\b/i;
const PLANNING_ONLY_HEADING_RE = /^(?:plan|steps?|next steps?)\s*:/i;
const PLANNING_ONLY_BULLET_RE = /^(?:[-*•]\s+|\d+[.)]\s+)/u;
const PLANNING_ONLY_MAX_VISIBLE_TEXT = 700;
const PLANNING_ONLY_ACTION_VERB_RE =
  /\b(?:inspect|investigate|check|look(?:\s+into|\s+at)?|read|search|find|debug|fix|patch|update|change|edit|write|implement|run|test|verify|review|analy(?:s|z)e|summari(?:s|z)e|explain|answer|show|share|report|prepare|capture|take|refactor|restart|deploy|ship)\b/i;
const SINGLE_ACTION_EXPLICIT_CONTINUATION_RE =
  /\b(?:going to|first[, ]+i(?:'ll| will)|next[, ]+i(?:'ll| will)|then[, ]+i(?:'ll| will)|i can do that next|let me (?!know\b)\w+(?:\s+\w+){0,3}\s+(?:next|then|first)\b)/i;
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
const DEFAULT_PLANNING_ONLY_RETRY_LIMIT = 1;
const STRICT_AGENTIC_PLANNING_ONLY_RETRY_LIMIT = 3;
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
const ACTIONABLE_PROMPT_DIRECTIVE_RE =
  /^\s*(?:please\s+)?(?:check|look(?:\s+into|\s+at)?|read|write|edit|update|fix|investigate|debug|run|search|find|implement|add|remove|refactor|explain|summari(?:s|z)e|analy(?:s|z)e|review|tell|show|make|restart|deploy|prepare)\b/i;
const ACTIONABLE_PROMPT_REQUEST_RE =
  /\b(?:can|could|would|will)\s+you\b|\b(?:please|pls)\b|\b(?:help|explain|summari(?:s|z)e|analy(?:s|z)e|review|investigate|debug|fix|check|look(?:\s+into|\s+at)?|read|write|edit|update|run|search|find|implement|add|remove|refactor|show|tell me|walk me through)\b/i;

// Live-test iteration 1 Bug 1: outside plan mode but same family of
// nudges (agent narrated a plan instead of acting). Tagged so the
// future "hide PLAN_* in webchat" filter can be a single regex.
export const PLANNING_ONLY_RETRY_INSTRUCTION =
  "[PLANNING_RETRY]: The previous assistant turn only described the plan. Do not restate the plan. Act now: take the first concrete tool action you can. If a real blocker prevents action, reply with the exact blocker in one sentence.";
export const PLANNING_ONLY_RETRY_INSTRUCTION_FIRM =
  "[PLANNING_RETRY]: CRITICAL: You have described the plan multiple times without acting. You MUST call a tool in this turn. No more planning or narration. If a real blocker prevents action, state the exact blocker in one sentence. Otherwise, call the first tool NOW.";
export const PLANNING_ONLY_RETRY_INSTRUCTION_FINAL =
  "[PLANNING_RETRY]: Final reminder: this is the third planning-only turn. Please call a tool now to make progress. If a real blocker prevents action, state the exact blocker in one sentence so the user can unblock you.";
export const REASONING_ONLY_RETRY_INSTRUCTION =
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue from that partial turn and produce the visible answer now. Do not restate the reasoning or restart from scratch.";
export const EMPTY_RESPONSE_RETRY_INSTRUCTION =
  "The previous attempt did not produce a user-visible answer. Continue from the current state and produce the visible answer now. Do not restart from scratch.";
export const ACK_EXECUTION_FAST_PATH_INSTRUCTION =
  "The latest user message is a short approval to proceed. Do not recap or restate the plan. Start with the first concrete tool action immediately. Keep any user-facing follow-up brief and natural.";
export const AUTO_CONTINUE_FAST_PATH_INSTRUCTION =
  "The system is auto-continuing. Do not recap or restate the plan. Start with the first concrete tool action immediately. Keep any user-facing follow-up brief and natural.";
export const STRICT_AGENTIC_BLOCKED_TEXT =
  "Agent stopped after repeated plan-only turns without taking a concrete action. No concrete tool action or external side effect advanced the task.";

// PR-8 follow-up: when the session is in plan mode, the agent must
// either submit a plan via exit_plan_mode, investigate read-only, or
// genuinely act. A chat-only acknowledgement ("opening a fresh plan
// cycle" / "submitting now") followed by no tool call is a
// behavior-selection drift Eva self-diagnosed across multiple test
// rounds: conversational reflex winning over plan-mode workflow.
const PLAN_MODE_ACK_ONLY_MAX_VISIBLE_TEXT = 1500;

// Read-only / planning-supportive tools whose presence proves the
// agent is genuinely investigating and is allowed to defer
// exit_plan_mode another turn. update_plan and enter_plan_mode are
// listed but treated specially below — they do NOT satisfy the
// "submit a plan" requirement.
//
// The `lcm_*` family is the read-only investigative surface from the
// `@martian-engineering/lossless-claw` context-engine plugin (LCM =
// Lossless Claw Memory). When the user has installed lossless-claw
// (`openclaw plugins install @martian-engineering/lossless-claw`, see
// `docs/concepts/context-engine.md`), these tools let the agent
// search/recall/expand persistent context-engine memory at planning
// time — surfacing prior conversations, decisions, and code
// references not in the current turn's context. Keeping the LCM
// family in this set ensures those calls correctly count as planning
// investigation when the plugin is enabled; when not installed, the
// agent never calls them so the entries are harmless.
//
// Catalog (verified against the plugin's published tool surface):
//   • lcm_grep         — search compacted history (read-only)
//   • lcm_describe     — recall details from compacted history (read-only)
//   • lcm_expand_query — drill into summaries via sub-agent expansion (read-only)
//   • lcm_expand       — internal sub-agent expansion tool (read-only)
//
// Maintainer-confirmed: agents must be able to use the full LCM family
// (initial revert added only `lcm_grep`; `lcm_describe`/`lcm_expand*`
// were missed and triggered premature retry pressure on those calls).
const PLAN_MODE_INVESTIGATIVE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read",
  "lcm_grep",
  "lcm_describe",
  "lcm_expand_query",
  "lcm_expand",
  "grep",
  "glob",
  "ls",
  "find",
  "web_search",
  "web_fetch",
  "update_plan",
  "enter_plan_mode",
]);

// Live-test iteration 1 Bug 1: every plan-mode synthetic message
// gets a `[PLAN_*]:` first-line tag so (a) channel renderers can
// identify them as system-generated, (b) future PRs can hide them
// from user-visible chat when in webchat plan mode, and (c) debug
// log greps can correlate them with `[plan-mode/synthetic_injection]`
// events. Pattern matches `[PLAN_DECISION]:`, `[QUESTION_ANSWER]:`,
// `[PLAN_COMPLETE]:` already in use by sessions-patch.ts.
export const PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION =
  "[PLAN_ACK_ONLY]: Plan mode is active and you're still in the PLANNING phase (no user " +
  "approval yet). Your previous response stopped without calling " +
  "exit_plan_mode OR a read-only investigative tool. Brief progress " +
  "updates are fine, but they must NOT end the turn — keep calling tools " +
  "after them. The next response MUST either: (a) continue planning " +
  "investigation with a read-only tool (read, lcm_grep, lcm_describe, " +
  "lcm_expand_query, grep, glob, ls, find, web_search, web_fetch, " +
  "update_plan), or (b) call exit_plan_mode(title=..., plan=[...]) " +
  "with the proposed plan. A status line followed by another tool call " +
  "is the right pattern; a status line alone is treated as yielding " +
  "without acting.";

export const PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION_FIRM =
  "[PLAN_ACK_ONLY]: CRITICAL: plan mode is active and you have acknowledged twice without calling " +
  "exit_plan_mode. You MUST call exit_plan_mode(plan=[...]) in this turn. No more " +
  "chat-only acknowledgements. If a real blocker prevents producing a plan, state " +
  "the exact blocker in one sentence so the user can unblock you.";

export const DEFAULT_PLAN_MODE_ACK_ONLY_RETRY_LIMIT = 2;

// PR-8 follow-up Round 2: after an approved plan, if the agent yields
// the turn without taking any main-lane action, auto-retry with a steer
// that says "continue executing, don't orchestrate/wait." Eva's post-
// mortem: after approval she went into orchestration/wait mode for
// subagent results instead of continuing execution, which broke the
// explicit "do not pause between steps" rule from the approval
// injection.
export const PLAN_APPROVED_YIELD_RETRY_INSTRUCTION =
  "[PLAN_YIELD]: Your plan was just approved and mutating tools were unlocked. You yielded the turn " +
  "without taking any main-lane action — but the approval flow explicitly told you to " +
  "continue through every step without pausing. Continue executing the plan now. Only " +
  "yield if you actually need a subagent's result for the next step you are about to " +
  "take, AND state in one sentence which step is blocked on which result.";

export const PLAN_APPROVED_YIELD_RETRY_INSTRUCTION_FIRM =
  "[PLAN_YIELD]: CRITICAL: you yielded again immediately after plan approval. Continue main-lane " +
  "execution of the approved plan. If a subagent result is genuinely required for the " +
  "next step, perform that step's prerequisite reads inline instead of orchestrating. " +
  "Do not yield unless a real blocker requires the user to intervene.";

export const DEFAULT_PLAN_APPROVED_YIELD_RETRY_LIMIT = 2;

export type PlanningOnlyPlanDetails = {
  explanation: string;
  steps: string[];
};

export function buildAttemptReplayMetadata(
  params: ReplayMetadataAttempt,
): EmbeddedRunAttemptResult["replayMetadata"] {
  const hadMutatingTools = params.toolMetas.some((t) => isLikelyMutatingToolName(t.toolName));
  const hadPotentialSideEffects =
    hadMutatingTools || params.didSendViaMessagingTool || (params.successfulCronAdds ?? 0) > 0;
  return {
    hadPotentialSideEffects,
    replaySafe: !hadPotentialSideEffects,
  };
}

export function resolveIncompleteTurnPayloadText(params: {
  payloadCount: number;
  aborted: boolean;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
}): string | null {
  if (
    params.payloadCount !== 0 ||
    params.aborted ||
    params.timedOut ||
    params.attempt.clientToolCall ||
    params.attempt.yieldDetected ||
    params.attempt.didSendDeterministicApprovalPrompt ||
    params.attempt.lastToolError
  ) {
    return null;
  }

  const stopReason = params.attempt.lastAssistant?.stopReason;
  const incompleteTerminalAssistant = isIncompleteTerminalAssistantTurn({
    hasAssistantVisibleText: params.payloadCount > 0,
    lastAssistant: params.attempt.lastAssistant,
  });
  const reasoningOnlyAssistant = isReasoningOnlyAssistantTurn(
    params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant,
  );
  const emptyResponseAssistant = isEmptyResponseAssistantTurn({
    payloadCount: params.payloadCount,
    attempt: params.attempt,
  });
  if (
    !incompleteTerminalAssistant &&
    !reasoningOnlyAssistant &&
    !emptyResponseAssistant &&
    stopReason !== "error"
  ) {
    return null;
  }

  return params.attempt.replayMetadata.hadPotentialSideEffects
    ? "⚠️ Agent couldn't generate a response. Note: some tool actions may have already been executed — please verify before retrying."
    : "⚠️ Agent couldn't generate a response. Please try again.";
}

export function resolveReplayInvalidFlag(params: {
  attempt: RunLivenessAttempt;
  incompleteTurnText?: string | null;
}): boolean {
  return (
    !params.attempt.replayMetadata.replaySafe ||
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

export function isReasoningOnlyAssistantTurn(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  return assessLastAssistantMessage(message as AgentMessage) === "incomplete-text";
}

function isEmptyResponseAssistantTurn(params: {
  payloadCount: number;
  attempt: Pick<
    IncompleteTurnAttempt,
    "assistantTexts" | "currentAttemptAssistant" | "lastAssistant"
  >;
}): boolean {
  if (params.payloadCount !== 0) {
    return false;
  }
  if (params.attempt.assistantTexts.join("\n\n").trim().length > 0) {
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

export function resolveReasoningOnlyRetryInstruction(params: {
  provider?: string;
  modelId?: string;
  aborted: boolean;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
  /** When true, planning-only is the desired state — skip retry pressure. */
  planModeActive?: boolean;
}): string | null {
  if (
    params.aborted ||
    params.timedOut ||
    params.attempt.clientToolCall ||
    params.attempt.yieldDetected ||
    params.attempt.didSendDeterministicApprovalPrompt ||
    params.attempt.lastToolError ||
    params.attempt.replayMetadata.hadPotentialSideEffects
  ) {
    return null;
  }

  if (
    !shouldApplyPlanningOnlyRetryGuard({
      provider: params.provider,
      modelId: params.modelId,
      planModeActive: params.planModeActive,
    })
  ) {
    return null;
  }

  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant;
  if (params.attempt.assistantTexts.join("\n\n").trim().length > 0) {
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
  payloadCount: number;
  aborted: boolean;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
  /** When true, planning-only is the desired state — skip retry pressure. */
  planModeActive?: boolean;
}): string | null {
  if (
    params.aborted ||
    params.timedOut ||
    params.attempt.clientToolCall ||
    params.attempt.yieldDetected ||
    params.attempt.didSendDeterministicApprovalPrompt ||
    params.attempt.lastToolError ||
    params.attempt.replayMetadata.hadPotentialSideEffects
  ) {
    return null;
  }

  if (
    !shouldApplyPlanningOnlyRetryGuard({
      provider: params.provider,
      modelId: params.modelId,
      planModeActive: params.planModeActive,
    })
  ) {
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

  return EMPTY_RESPONSE_RETRY_INSTRUCTION;
}

function shouldApplyPlanningOnlyRetryGuard(params: {
  provider?: string;
  modelId?: string;
  /**
   * When plan mode is active, planning-only IS the correct state — the agent
   * is supposed to produce a plan and call exit_plan_mode for review. Do not
   * apply the act-now retry pressure in that case.
   */
  planModeActive?: boolean;
}): boolean {
  if (params.planModeActive) {
    return false;
  }
  return isStrictAgenticSupportedProviderModel({
    provider: params.provider,
    modelId: params.modelId,
  });
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

function isLikelyActionableUserPrompt(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (isLikelyExecutionAckPrompt(trimmed) || trimmed.includes("?")) {
    return true;
  }
  return ACTIONABLE_PROMPT_DIRECTIVE_RE.test(trimmed) || ACTIONABLE_PROMPT_REQUEST_RE.test(trimmed);
}

export function resolveAckExecutionFastPathInstruction(params: {
  provider?: string;
  modelId?: string;
  prompt: string;
  /** Plan mode disables ack fast-path: a "do it" reply is the approval signal, not a planning skip. */
  planModeActive?: boolean;
}): string | null {
  if (
    !shouldApplyPlanningOnlyRetryGuard({
      provider: params.provider,
      modelId: params.modelId,
      planModeActive: params.planModeActive,
    }) ||
    !isLikelyExecutionAckPrompt(params.prompt)
  ) {
    return null;
  }
  return ACK_EXECUTION_FAST_PATH_INSTRUCTION;
}

function extractPlanningOnlySteps(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const bulletLines = lines
    .map((line) => line.replace(/^[-*•]\s+|^\d+[.)]\s+/u, "").trim())
    .filter(Boolean);
  if (bulletLines.length >= 2) {
    return bulletLines.slice(0, 4);
  }
  return text
    .split(/(?<=[.!?])\s+/u)
    .map((step) => step.trim())
    .filter(Boolean)
    .slice(0, 4);
}

function hasStructuredPlanningOnlyFormat(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return false;
  }
  const bulletLineCount = lines.filter((line) => PLANNING_ONLY_BULLET_RE.test(line)).length;
  const hasPlanningCueLine = lines.some((line) => PLANNING_ONLY_PROMISE_RE.test(line));
  const hasPlanningHeading = PLANNING_ONLY_HEADING_RE.test(lines[0] ?? "");
  return (hasPlanningHeading && hasPlanningCueLine) || (bulletLineCount >= 2 && hasPlanningCueLine);
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

function countPlanOnlyToolMetas(toolMetas: PlanningOnlyAttempt["toolMetas"]): number {
  return toolMetas.filter((entry) => entry.toolName === "update_plan").length;
}

function countNonPlanToolCalls(toolMetas: PlanningOnlyAttempt["toolMetas"]): number {
  return toolMetas.filter((entry) => entry.toolName !== "update_plan").length;
}

function hasNonPlanToolActivity(toolMetas: PlanningOnlyAttempt["toolMetas"]): boolean {
  return toolMetas.some((entry) => entry.toolName !== "update_plan");
}

function hasSingleRetrySafeNonPlanTool(toolMetas: PlanningOnlyAttempt["toolMetas"]): boolean {
  const nonPlanToolNames = toolMetas
    .map((entry) => normalizeLowercaseStringOrEmpty(entry.toolName))
    .filter((toolName) => toolName && toolName !== "update_plan");
  return (
    nonPlanToolNames.length === 1 &&
    SINGLE_ACTION_RETRY_SAFE_TOOL_NAMES.has(nonPlanToolNames[0] ?? "")
  );
}

/**
 * Treat a turn with exactly one non-plan tool call plus visible "I'll do X
 * next" prose as effectively planning-only from the user's perspective. This
 * closes the one-action-then-narrative loophole without changing the 2+ tool
 * call path, which still counts as real multi-step progress.
 */
function isSingleActionThenNarrativePattern(params: {
  toolMetas: PlanningOnlyAttempt["toolMetas"];
  assistantTexts: readonly string[];
}): boolean {
  const nonPlanCount = countNonPlanToolCalls(params.toolMetas);
  if (nonPlanCount !== 1) {
    return false;
  }
  const text = params.assistantTexts.join("\n\n").trim();
  if (!text || text.length > PLANNING_ONLY_MAX_VISIBLE_TEXT) {
    return false;
  }
  if (SINGLE_ACTION_RESULT_STYLE_RE.test(text)) {
    return false;
  }
  return (
    SINGLE_ACTION_EXPLICIT_CONTINUATION_RE.test(text) ||
    SINGLE_ACTION_MULTI_STEP_PROMISE_RE.test(text)
  );
}

export function resolvePlanningOnlyRetryLimit(
  executionContract?: EmbeddedPiExecutionContract,
): number {
  return executionContract === "strict-agentic"
    ? STRICT_AGENTIC_PLANNING_ONLY_RETRY_LIMIT
    : DEFAULT_PLANNING_ONLY_RETRY_LIMIT;
}

/**
 * Returns an escalating retry instruction based on the current attempt number.
 * Attempt 0 = first retry (standard), 1 = firm, 2+ = final warning.
 */
export function resolveEscalatingPlanningRetryInstruction(attemptIndex: number): string {
  if (attemptIndex <= 0) {
    return PLANNING_ONLY_RETRY_INSTRUCTION;
  }
  if (attemptIndex === 1) {
    return PLANNING_ONLY_RETRY_INSTRUCTION_FIRM;
  }
  return PLANNING_ONLY_RETRY_INSTRUCTION_FINAL;
}

export function resolvePlanningOnlyRetryInstruction(params: {
  provider?: string;
  modelId?: string;
  prompt?: string;
  aborted: boolean;
  timedOut: boolean;
  attempt: PlanningOnlyAttempt;
  /**
   * When plan mode is active, planning IS the desired state — return null
   * to skip the act-now retry pressure. The agent should produce a thorough
   * plan and call exit_plan_mode for approval.
   */
  planModeActive?: boolean;
}): string | null {
  const planOnlyToolMetaCount = countPlanOnlyToolMetas(params.attempt.toolMetas);
  const singleActionNarrative = isSingleActionThenNarrativePattern({
    toolMetas: params.attempt.toolMetas,
    assistantTexts: params.attempt.assistantTexts,
  });
  const allowSingleActionRetryBypass =
    singleActionNarrative && hasSingleRetrySafeNonPlanTool(params.attempt.toolMetas);
  if (
    !shouldApplyPlanningOnlyRetryGuard({
      provider: params.provider,
      modelId: params.modelId,
      planModeActive: params.planModeActive,
    }) ||
    (typeof params.prompt === "string" && !isLikelyActionableUserPrompt(params.prompt)) ||
    params.aborted ||
    params.timedOut ||
    params.attempt.clientToolCall ||
    params.attempt.yieldDetected ||
    params.attempt.didSendDeterministicApprovalPrompt ||
    params.attempt.didSendViaMessagingTool ||
    params.attempt.lastToolError ||
    (hasNonPlanToolActivity(params.attempt.toolMetas) && !allowSingleActionRetryBypass) ||
    (params.attempt.itemLifecycle.startedCount > planOnlyToolMetaCount &&
      !allowSingleActionRetryBypass) ||
    params.attempt.replayMetadata.hadPotentialSideEffects
  ) {
    return null;
  }

  const stopReason = params.attempt.lastAssistant?.stopReason;
  if (stopReason && stopReason !== "stop") {
    return null;
  }

  const text = params.attempt.assistantTexts.join("\n\n").trim();
  if (!text || text.length > PLANNING_ONLY_MAX_VISIBLE_TEXT || text.includes("```")) {
    return null;
  }
  const hasStructuredPlanningFormat = hasStructuredPlanningOnlyFormat(text);
  if (!PLANNING_ONLY_PROMISE_RE.test(text) && !hasStructuredPlanningFormat) {
    return null;
  }
  if (
    !hasStructuredPlanningFormat &&
    !singleActionNarrative &&
    !PLANNING_ONLY_ACTION_VERB_RE.test(text)
  ) {
    return null;
  }
  if (PLANNING_ONLY_COMPLETION_RE.test(text)) {
    return null;
  }
  return PLANNING_ONLY_RETRY_INSTRUCTION;
}

/**
 * PR-8 follow-up: detect "session in plan mode + agent's response had
 * no exit_plan_mode tool call + no investigative tool call + clean
 * stop" — the action-selection drift Eva self-diagnosed across
 * multiple test rounds. Returns a corrective steer for the next
 * attempt, escalating tone on the second retry.
 *
 * The existing planning-only retry mechanism short-circuits in plan
 * mode (incomplete-turn.ts:568) because "planning IS the desired
 * state" there. This detector is the sister mechanism specifically
 * for the plan-mode case: planning IS desired, but the agent must
 * eventually submit the plan via exit_plan_mode.
 *
 * Sister to resolvePlanningOnlyRetryInstruction. Same injection slot
 * (planningOnlyRetryInstruction in run.ts), one slot multiple
 * producers — the established pattern.
 */
type PlanModeAckOnlyAttempt = Pick<
  PlanningOnlyAttempt,
  | "assistantTexts"
  | "clientToolCall"
  | "yieldDetected"
  | "didSendDeterministicApprovalPrompt"
  | "didSendViaMessagingTool"
  | "lastToolError"
  | "lastAssistant"
  | "toolMetas"
  | "replayMetadata"
>;

/**
 * Grace window (ms) after approval during which the ack-only detector
 * remains active. Same rationale as POST_APPROVAL_YIELD_GRACE_MS but
 * narrower — ack-only is a text-without-tool failure, which is most
 * common in the first few minutes post-approval while the agent is
 * still orienting to the unlocked mutation tools. 5 minutes covers the
 * natural response latency without keeping the retry armed
 * indefinitely.
 */
export const POST_APPROVAL_ACK_ONLY_GRACE_MS = 5 * 60_000;

export function resolvePlanModeAckOnlyRetryInstruction(params: {
  planModeActive?: boolean;
  /**
   * Epoch-ms timestamp from `SessionEntry.recentlyApprovedAt`.
   * Post-approval the session is in normal mode but the ack-only
   * failure pattern (agent says "I'll now execute..." without
   * calling a tool) is still a real stall. Extends the detector's
   * fire window by POST_APPROVAL_ACK_ONLY_GRACE_MS when planMode is
   * no longer active but approval was recent.
   */
  recentlyApprovedAt?: number;
  /** Now (ms) — injectable for tests. Defaults to Date.now(). */
  nowMs?: number;
  aborted: boolean;
  timedOut: boolean;
  attempt: PlanModeAckOnlyAttempt;
  /** 0 = first retry (standard tone), >=1 = firm */
  retryAttemptIndex: number;
}): string | null {
  const now = params.nowMs ?? Date.now();
  const withinPostApprovalGrace =
    typeof params.recentlyApprovedAt === "number" &&
    now - params.recentlyApprovedAt < POST_APPROVAL_ACK_ONLY_GRACE_MS;
  if (!params.planModeActive && !withinPostApprovalGrace) {
    return null;
  }
  if (params.aborted || params.timedOut) {
    return null;
  }
  if (params.attempt.clientToolCall) {
    return null;
  }
  if (params.attempt.yieldDetected) {
    return null;
  }
  if (params.attempt.didSendDeterministicApprovalPrompt) {
    return null;
  }
  if (params.attempt.didSendViaMessagingTool) {
    return null;
  }
  if (params.attempt.lastToolError) {
    return null;
  }
  if (params.attempt.replayMetadata.hadPotentialSideEffects) {
    return null;
  }

  const stopReason = params.attempt.lastAssistant?.stopReason;
  if (stopReason && stopReason !== "stop") {
    return null;
  }

  const tools = params.attempt.toolMetas;
  if (tools.some((t) => t.toolName === "exit_plan_mode")) {
    return null;
  }

  // Genuine investigation phase — let the agent keep working.
  // update_plan and enter_plan_mode do NOT count as investigation.
  const calledInvestigativeTool = tools.some(
    (t) =>
      PLAN_MODE_INVESTIGATIVE_TOOL_NAMES.has(t.toolName) &&
      t.toolName !== "update_plan" &&
      t.toolName !== "enter_plan_mode",
  );
  if (calledInvestigativeTool) {
    return null;
  }

  // Any non-plan tool means the agent is acting (likely shouldn't be
  // in plan mode at all — let it through, mutation gate will block
  // bad actions, no need to add re-prompt pressure).
  const calledNonPlanTool = tools.some((t) => !PLAN_MODE_INVESTIGATIVE_TOOL_NAMES.has(t.toolName));
  if (calledNonPlanTool) {
    return null;
  }

  const text = params.attempt.assistantTexts.join("\n\n").trim();
  if (text.length === 0) {
    // Empty-response handler owns this — its own retry mechanism
    // covers it without our help. Bail to avoid double-fire.
    return null;
  }
  if (text.length > PLAN_MODE_ACK_ONLY_MAX_VISIBLE_TEXT) {
    // Already-substantive text; agent likely wrote the plan inline as
    // markdown rather than calling exit_plan_mode. Different failure
    // mode — out of scope for this detector. The system prompt's
    // ACTION CONTRACT block is the right surface for that case.
    return null;
  }

  return params.retryAttemptIndex >= 1
    ? PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION_FIRM
    : PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION;
}

/**
 * PR-8 follow-up Round 2: detect "agent yielded the turn immediately
 * after plan approval without taking any main-lane action." Fires only
 * on clean yields (no blocker text, no real work done). Reuses the
 * standard → firm escalation pattern.
 *
 * Gating conditions (all must hold):
 * - plan mode active AND session approval == "approved" or "edited"
 * - the agent yielded this turn
 * - no side effects happened this turn (write/edit/exec/send etc.)
 * - no real tool work happened beyond yield/update_plan
 * - clean stop (no abort/timeout/error/tool-error)
 *
 * Bypass: if the agent did a non-yield, non-update_plan tool call this
 * turn (e.g., `read`, `exec` dry-run), we treat that as genuine progress
 * and do NOT re-prompt.
 */
type PlanApprovedYieldAttempt = Pick<
  EmbeddedRunAttemptResult,
  | "yieldDetected"
  | "clientToolCall"
  | "didSendDeterministicApprovalPrompt"
  | "didSendViaMessagingTool"
  | "lastToolError"
  | "lastAssistant"
  | "toolMetas"
  | "replayMetadata"
>;

/**
 * PR-11 review fix (Codex P2 #3105311664 — escalation cluster):
 * grace window after approval during which the yield-retry detector
 * remains active. 2 minutes covers the agent's natural response latency
 * + tool-call overhead without keeping the retry loop armed
 * indefinitely. Past this window the agent is "fully executing" and
 * any yield is treated as normal task completion rather than a
 * spurious post-approval stall.
 */
export const POST_APPROVAL_YIELD_GRACE_MS = 2 * 60_000;

export function resolveYieldDuringApprovedPlanInstruction(params: {
  planModeActive?: boolean;
  /** Latest session-entry approval state: "approved" / "edited" trigger this detector. */
  planApproval?: string;
  /**
   * PR-11 review fix (Codex P2 #3105311664 — escalation cluster):
   * epoch-ms timestamp from `SessionEntry.recentlyApprovedAt`. When
   * `sessions.patch { planApproval: { action: "approve"/"edit" } }`
   * fires, planMode gets deleted (mode → "normal") which clears both
   * `planModeActive` and `planApproval` state that the old predicates
   * relied on. `recentlyApprovedAt` survives that deletion (stored at
   * SessionEntry ROOT), so the detector can still fire within the
   * grace window post-approval.
   */
  recentlyApprovedAt?: number;
  /** Now (ms) — injectable for tests. Defaults to Date.now(). */
  nowMs?: number;
  aborted: boolean;
  timedOut: boolean;
  attempt: PlanApprovedYieldAttempt;
  /** 0 = first retry (standard tone), >=1 = firm */
  retryAttemptIndex: number;
}): string | null {
  // Two entry paths gate this detector:
  //   A) Legacy: planModeActive + planApproval ∈ {approved, edited}.
  //      Only fires BEFORE sessions.patch processes the transition
  //      (narrow window — typically doesn't fire in production).
  //   B) Post-transition: recentlyApprovedAt within grace window. This
  //      is the production path — sessions.patch clears planMode on
  //      approve/edit so we can't depend on the old predicates.
  const now = params.nowMs ?? Date.now();
  const withinGraceWindow =
    params.recentlyApprovedAt !== undefined &&
    now - params.recentlyApprovedAt < POST_APPROVAL_YIELD_GRACE_MS;
  const legacyPathActive =
    params.planModeActive &&
    (params.planApproval === "approved" || params.planApproval === "edited");
  if (!withinGraceWindow && !legacyPathActive) {
    return null;
  }
  if (params.aborted || params.timedOut) {
    return null;
  }
  if (!params.attempt.yieldDetected) {
    return null;
  }
  if (params.attempt.clientToolCall) {
    return null;
  }
  if (params.attempt.didSendDeterministicApprovalPrompt) {
    return null;
  }
  if (params.attempt.didSendViaMessagingTool) {
    return null;
  }
  if (params.attempt.lastToolError) {
    return null;
  }
  if (params.attempt.replayMetadata.hadPotentialSideEffects) {
    return null;
  }

  const stopReason = params.attempt.lastAssistant?.stopReason;
  if (stopReason && stopReason !== "stop") {
    return null;
  }

  // Yield-only or yield + update_plan only counts as "no progress."
  // Any OTHER tool call this turn is treated as genuine main-lane work
  // (reads / investigations / dry-runs are fine; we don't loop).
  const didOtherWork = params.attempt.toolMetas.some(
    (t) => t.toolName !== "sessions_yield" && t.toolName !== "update_plan",
  );
  if (didOtherWork) {
    return null;
  }

  return params.retryAttemptIndex >= 1
    ? PLAN_APPROVED_YIELD_RETRY_INSTRUCTION_FIRM
    : PLAN_APPROVED_YIELD_RETRY_INSTRUCTION;
}
