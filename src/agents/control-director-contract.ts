export const CONTROL_DIRECTOR_AGENT_IDS = ["main", "control-director"] as const;

export const CONTROL_DIRECTOR_PRIMARY_PROVIDER = "ollama";
export const CONTROL_DIRECTOR_PRIMARY_ALIAS = "openclaw-control-qwen36-27b";
export const CONTROL_DIRECTOR_PRIMARY_MODEL_ID = "openclaw-control-qwen36-27b:latest";
export const CONTROL_DIRECTOR_PRIMARY_MODEL = `${CONTROL_DIRECTOR_PRIMARY_PROVIDER}/${CONTROL_DIRECTOR_PRIMARY_MODEL_ID}`;
export const CONTROL_DIRECTOR_UNDERLYING_OLLAMA_TAG = "qwen3.6:27b-q8_0";
export const CONTROL_DIRECTOR_PRIMARY_DISPLAY_LABEL = "OpenClaw Control Qwen3.6 27B Q8_0";
export const CONTROL_DIRECTOR_FIRST_FALLBACK_MODEL = "ollama/openclaw-control-qwen25-32b:latest";
export const CONTROL_DIRECTOR_EFFECTIVE_CONTEXT_TOKENS = 64_000;

export type ControlDirectorFinalStatus = "complete" | "blocked" | "needs_user_input";
export type ControlDirectorThinkingEscalationLevel = "off" | "medium" | "high";

export type ControlDirectorThinkingEscalation = {
  level: ControlDirectorThinkingEscalationLevel;
  reason: string;
  trigger?: string;
  escalated: boolean;
};

export type ControlDirectorResponseRequirements = {
  completionState?: boolean;
  verifiedEvidence?: boolean;
  completionGrade?: boolean;
  criticality?: boolean;
  nextBuildGap?: boolean;
};

export type ControlDirectorResponseEvaluation = {
  passed: boolean;
  status: ControlDirectorFinalStatus | null;
  missing: string[];
};

export type ControlDirectorGuardablePayload = {
  text?: unknown;
};

export type ControlDirectorFinalOutputGuardAction =
  | "rewrote_unsupported_complete"
  | "repaired_missing_required_fields";

export type ControlDirectorFinalOutputGuardAudit = {
  action: ControlDirectorFinalOutputGuardAction;
  originalStatus: ControlDirectorFinalStatus | null;
  nextStatus: ControlDirectorFinalStatus;
  missing: string[];
  payloadsChecked: number;
  payloadsRewritten: number;
};

export type ControlDirectorFinalOutputGuardResult<T extends ControlDirectorGuardablePayload> = {
  payloads: T[];
  changed: boolean;
  audit?: ControlDirectorFinalOutputGuardAudit;
};

export type ControlDirectorLivenessClassification = "empty" | "reasoning-only" | "planning-only";

export type ControlDirectorLivenessWatchdogAction =
  | "synthesized_blocked_no_visible_output"
  | "synthesized_blocked_incomplete_classification"
  | "queued_safe_continuation"
  | "blocked_continuation_limit"
  | "blocked_unsafe_continuation";

export type ControlDirectorLivenessWatchdogAudit = {
  action: ControlDirectorLivenessWatchdogAction;
  reason: string;
  classification?: ControlDirectorLivenessClassification;
  nextStatus: "blocked";
  continuationCount: number;
  continuationQueued: boolean;
  payloadsChecked: number;
  payloadsSynthesized: number;
};

export type ControlDirectorContinuationDecisionStatus = "not_needed" | "queue" | "blocked";

export type ControlDirectorContinuationDecision = {
  status: ControlDirectorContinuationDecisionStatus;
  reason: string;
  shouldQueue: boolean;
  continuationCount: number;
  nextContinuationCount: number;
  prompt?: string;
};

export type ControlDirectorLivenessWatchdogResult<T extends ControlDirectorGuardablePayload> = {
  payloads: T[];
  changed: boolean;
  audit?: ControlDirectorLivenessWatchdogAudit;
  continuation: ControlDirectorContinuationDecision;
};

export type ControlDirectorMissionLedgerStatus =
  | "running"
  | "complete"
  | "blocked"
  | "needs_user_input"
  | "continuation_queued";

export type ControlDirectorMissionSummary = {
  finalStatus: ControlDirectorFinalStatus | null;
  status: ControlDirectorMissionLedgerStatus;
  verifiedEvidenceSummary: string;
  nextBuildGap: string;
  completionGrade?: number;
  criticality?: number;
};

export type ControlDirectorReadinessFact = {
  id: string;
  label: string;
  passed: boolean;
  critical: boolean;
  detail?: string;
};

export type ControlDirectorReadinessScorecard = {
  completionGrade: number;
  criticality: number;
  productionReady: boolean;
  facts: ControlDirectorReadinessFact[];
  failedCritical: string[];
  nextBuildGap: string;
};

const STATUS_PATTERN = /\bstatus\s*:\s*(complete|blocked|needs[_ -]user[_ -]input)\b/i;
const STATUS_PATTERN_GLOBAL = /\bstatus\s*:\s*(complete|blocked|needs[_ -]user[_ -]input)\b/gi;
const FINISHED_PATTERN = /\b(finished|complete|completed|done)\b/i;
const BLOCKED_PATTERN = /\bblocked\b/i;
const NEEDS_INPUT_PATTERN = /\b(needs? user input|needs? input|needs? clarification)\b/i;
const EVIDENCE_PATTERN =
  /\b(verified|validation|evidence|proof|commands? run|tests? passed|smoke(?:-test)? evidence)\b/i;
const COMPLETION_GRADE_PATTERN = /\bcompletion grade\s*:\s*(?:10|[0-9](?:\.\d+)?)\s*\/\s*10\b/i;
const CRITICALITY_PATTERN = /\bcriticality\s*:\s*(?:10|[0-9](?:\.\d+)?)\s*\/\s*10\b/i;
const NEXT_BUILD_GAP_PATTERN = /\bnext (?:most impactful )?build gap\b/i;
const CONTROL_DIRECTOR_GUARD_ORIGINAL_SUMMARY_MAX = 420;
export const CONTROL_DIRECTOR_MAX_SAFE_CONTINUATIONS = 2;

const CONTROL_DIRECTOR_FINAL_OUTPUT_REQUIREMENTS: ControlDirectorResponseRequirements = {
  completionState: true,
  verifiedEvidence: true,
  completionGrade: true,
  criticality: true,
  nextBuildGap: true,
};

type ControlDirectorThinkingTrigger = {
  level: Exclude<ControlDirectorThinkingEscalationLevel, "off">;
  reason: string;
  pattern: RegExp;
};

const CONTROL_DIRECTOR_THINKING_TRIGGERS: ControlDirectorThinkingTrigger[] = [
  {
    level: "high",
    reason: "high-risk failure, rollback, runtime, or production-control task",
    pattern:
      /\b(?:failed?|failing|failure|error|regression|broken|crash|panic|timeout|blocked|stuck|conflicting evidence|contradict(?:ion|ory)|rollback|revert|hotfix|incident|production|prod|service|runtime|ollama|launchctl|launchd|restart|smoke[- ]?test|model\s+(?:routing|alias|selection|fallback|chain|promotion|switch|change)|qwen|context\s+window)\b/i,
  },
  {
    level: "medium",
    reason: "multi-step implementation, evaluation, validation, or build-gap task",
    pattern:
      /\b(?:implement|implementation|fix|debug|diagnose|test|verify|validation|validate|evaluate|evaluation|assess|audit|inspect|build\s+gap|completion\s+grade|criticality|plan|milestone|root\s+cause|triage|production[- ]grade|full\s+functionality|do\s+not\s+stop|continue\s+to\s+work|until\s+(?:complete|completed|done))\b/i,
  },
];

export function isControlDirectorAgentId(agentId: string | undefined | null): boolean {
  if (!agentId) {
    return false;
  }
  const normalized = agentId.trim().toLowerCase();
  return CONTROL_DIRECTOR_AGENT_IDS.some((candidate) => candidate === normalized);
}

function normalizeControlDirectorModelCandidate(value: string | undefined | null): string {
  const raw = value?.trim().toLowerCase() ?? "";
  if (!raw) {
    return "";
  }
  const modelPart = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
  const stablePart = modelPart.split("@")[0]?.split(/\s+/)[0] ?? "";
  return stablePart.replace(/:latest$/i, "");
}

function resolveControlDirectorModelProviderCandidate(params: {
  provider?: string | undefined | null;
  model?: string | undefined | null;
}): string {
  const provider = params.provider?.trim().toLowerCase();
  if (provider) {
    return provider;
  }
  const model = params.model?.trim().toLowerCase() ?? "";
  const slashIndex = model.indexOf("/");
  return slashIndex > 0 ? model.slice(0, slashIndex) : "";
}

export function isControlDirectorPrimaryModelRef(value: string | undefined | null): boolean {
  const normalized = normalizeControlDirectorModelCandidate(value);
  return (
    normalized === CONTROL_DIRECTOR_PRIMARY_ALIAS ||
    normalized === CONTROL_DIRECTOR_UNDERLYING_OLLAMA_TAG
  );
}

export type ControlDirectorCanonicalModelRef = {
  provider: typeof CONTROL_DIRECTOR_PRIMARY_PROVIDER;
  model: typeof CONTROL_DIRECTOR_PRIMARY_MODEL_ID;
  qualified: typeof CONTROL_DIRECTOR_PRIMARY_MODEL;
  displayLabel: typeof CONTROL_DIRECTOR_PRIMARY_DISPLAY_LABEL;
};

export function resolveControlDirectorCanonicalModelRef(params: {
  agentId?: string | undefined | null;
  provider?: string | undefined | null;
  model?: string | undefined | null;
}): ControlDirectorCanonicalModelRef | null {
  if (
    !isControlDirectorAgentId(params.agentId) ||
    !isControlDirectorPrimaryModelRef(params.model)
  ) {
    return null;
  }
  return {
    provider: CONTROL_DIRECTOR_PRIMARY_PROVIDER,
    model: CONTROL_DIRECTOR_PRIMARY_MODEL_ID,
    qualified: CONTROL_DIRECTOR_PRIMARY_MODEL,
    displayLabel: CONTROL_DIRECTOR_PRIMARY_DISPLAY_LABEL,
  };
}

export function isStaleControlDirectorPrimaryModelProvider(params: {
  agentId?: string | undefined | null;
  provider?: string | undefined | null;
  model?: string | undefined | null;
}): boolean {
  const candidateProvider = resolveControlDirectorModelProviderCandidate(params);
  return (
    isControlDirectorAgentId(params.agentId) &&
    isControlDirectorPrimaryModelRef(params.model) &&
    Boolean(candidateProvider) &&
    candidateProvider !== CONTROL_DIRECTOR_PRIMARY_PROVIDER
  );
}

export function buildControlDirectorSystemPromptSection(
  agentId: string | undefined | null,
): string[] {
  if (!isControlDirectorAgentId(agentId)) {
    return [];
  }
  return [
    "## Control Director Operating Contract",
    "You are the Control Director for this OpenClaw deployment. Treat the latest user request as the active mission.",
    "Do not stop at advice or a proposed next step when you can safely continue executing the user's requested work.",
    "Continue until the requested task is complete, a real blocker is proven, or user input is genuinely required.",
    "Before saying a task is finished, verify the requested outcome with concrete evidence such as source inspection, config proof, runtime status, tests, smoke output, or command results when feasible.",
    "A completion claim must include the concrete evidence used to verify it; if that evidence is missing, report `Status: blocked` or `Status: needs_user_input` instead of `Status: complete`.",
    "If work is incomplete, do not call it complete. State the exact blocker or the next build gap and the smallest action that would close it.",
    "When the user asks for Completion Grade, Criticality, verified state, or next build gap, include those fields in every response until the user changes that reporting requirement.",
    "When reporting Completion Grade or Criticality, use numeric `/10` values unless the user explicitly asks for another scale.",
    "If the user gives an exact response format, follow that format exactly. Do not ask what task the format applies to when the current prompt itself defines a smoke, verification, or implementation task.",
    "Thinking policy: default to non-thinking for routine turns, but use thinking only as needed for implementation, evaluation, debugging, verification, rollback, model, runtime, service, or production-risk work.",
    "End task reports with an explicit status line using one of: `Status: complete`, `Status: blocked`, or `Status: needs_user_input`.",
    "",
  ];
}

export function resolveControlDirectorThinkingEscalation(params: {
  agentId: string | undefined | null;
  text?: string | undefined | null;
}): ControlDirectorThinkingEscalation | undefined {
  if (!isControlDirectorAgentId(params.agentId)) {
    return undefined;
  }
  const text = params.text?.trim() ?? "";
  if (!text) {
    return {
      level: "off",
      reason: "empty or low-risk Control Director turn",
      escalated: false,
    };
  }
  for (const trigger of CONTROL_DIRECTOR_THINKING_TRIGGERS) {
    const match = trigger.pattern.exec(text);
    if (match) {
      return {
        level: trigger.level,
        reason: trigger.reason,
        trigger: match[0],
        escalated: true,
      };
    }
  }
  return {
    level: "off",
    reason: "low-risk Control Director turn",
    escalated: false,
  };
}

export function parseControlDirectorFinalStatus(text: string): ControlDirectorFinalStatus | null {
  const explicit = parseExplicitControlDirectorFinalStatus(text);
  if (explicit) {
    return explicit;
  }
  if (BLOCKED_PATTERN.test(text)) {
    return "blocked";
  }
  if (NEEDS_INPUT_PATTERN.test(text)) {
    return "needs_user_input";
  }
  if (FINISHED_PATTERN.test(text)) {
    return "complete";
  }
  return null;
}

function parseExplicitControlDirectorFinalStatus(text: string): ControlDirectorFinalStatus | null {
  let explicit: ControlDirectorFinalStatus | null = null;
  for (const match of text.matchAll(STATUS_PATTERN_GLOBAL)) {
    const normalized = match[1]?.toLowerCase().replace(/[ -]/g, "_");
    if (
      normalized === "complete" ||
      normalized === "blocked" ||
      normalized === "needs_user_input"
    ) {
      explicit = normalized;
    }
  }
  return explicit;
}

export function evaluateControlDirectorResponse(params: {
  text: string;
  requirements?: ControlDirectorResponseRequirements;
}): ControlDirectorResponseEvaluation {
  const requirements = params.requirements ?? {};
  const status = parseControlDirectorFinalStatus(params.text);
  const explicitStatus = parseExplicitControlDirectorFinalStatus(params.text);
  const missing: string[] = [];
  const completeStatusRequiresEvidence = status === "complete";
  if (requirements.completionState !== false && !explicitStatus) {
    missing.push("explicit completion status");
  }
  if (
    (requirements.verifiedEvidence || completeStatusRequiresEvidence) &&
    !EVIDENCE_PATTERN.test(params.text)
  ) {
    missing.push(
      completeStatusRequiresEvidence
        ? "verified evidence for complete status"
        : "verified evidence",
    );
  }
  if (requirements.completionGrade && !COMPLETION_GRADE_PATTERN.test(params.text)) {
    missing.push("Completion Grade /10");
  }
  if (requirements.criticality && !CRITICALITY_PATTERN.test(params.text)) {
    missing.push("Criticality /10");
  }
  if (requirements.nextBuildGap && !NEXT_BUILD_GAP_PATTERN.test(params.text)) {
    missing.push("next build gap");
  }
  return {
    passed: missing.length === 0,
    status,
    missing,
  };
}

function includesControlDirectorEvidenceMissing(missing: readonly string[]): boolean {
  return missing.some((entry) => entry.toLowerCase().includes("verified evidence"));
}

function summarizeControlDirectorOriginalText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "empty final response";
  }
  if (normalized.length <= CONTROL_DIRECTOR_GUARD_ORIGINAL_SUMMARY_MAX) {
    return normalized;
  }
  return `${normalized.slice(0, CONTROL_DIRECTOR_GUARD_ORIGINAL_SUMMARY_MAX - 1)}…`;
}

function resolveGuardedControlDirectorStatus(
  evaluation: ControlDirectorResponseEvaluation,
): ControlDirectorFinalStatus {
  if (
    evaluation.status === "complete" &&
    !includesControlDirectorEvidenceMissing(evaluation.missing)
  ) {
    return "complete";
  }
  if (evaluation.status === "blocked" || evaluation.status === "needs_user_input") {
    return evaluation.status;
  }
  return "blocked";
}

function formatControlDirectorMissing(missing: readonly string[]): string {
  return missing.length > 0 ? missing.join(", ") : "none";
}

function extractControlDirectorLineValue(text: string, pattern: RegExp): string | undefined {
  for (const line of text.split(/\r?\n/u)) {
    const match = pattern.exec(line);
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }
  return undefined;
}

function extractControlDirectorNumber(text: string, pattern: RegExp): number | undefined {
  const raw = pattern.exec(text)?.[1];
  if (!raw) {
    return undefined;
  }
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function collectControlDirectorVisiblePayloadText(
  payloads: readonly ControlDirectorGuardablePayload[] | undefined,
): string {
  return (payloads ?? [])
    .map((payload) => (typeof payload.text === "string" ? payload.text.trim() : ""))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function normalizeControlDirectorLivenessClassification(
  classification: string | undefined | null,
): ControlDirectorLivenessClassification | undefined {
  return classification === "empty" ||
    classification === "reasoning-only" ||
    classification === "planning-only"
    ? classification
    : undefined;
}

function buildControlDirectorContinuationPrompt(params: {
  missionId?: string;
  reason: string;
  nextContinuationCount: number;
}): string {
  return [
    "Control Director safe continuation request.",
    params.missionId ? `Mission id: ${params.missionId}` : undefined,
    `Continuation attempt: ${params.nextContinuationCount}/${CONTROL_DIRECTOR_MAX_SAFE_CONTINUATIONS}`,
    `Reason: ${params.reason}`,
    "Continue from the current state. Do not repeat completed or mutating actions unless the action is idempotent and needed for verification.",
    "Verify evidence before claiming complete. If evidence is missing, report the exact blocker or next build gap.",
    "Include Verified state, Next build gap, Completion Grade: x/10, Criticality: x/10, and explicit Status: complete|blocked|needs_user_input.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function decideControlDirectorContinuation(params: {
  agentId?: string | undefined | null;
  incomplete: boolean;
  finalStatus?: ControlDirectorFinalStatus | null | undefined;
  classification?: string | null | undefined;
  continuationCount?: number | undefined;
  missionId?: string | undefined;
  canQueueContinuation?: boolean | undefined;
  needsUserInput?: boolean | undefined;
  approvalPending?: boolean | undefined;
  externalAbort?: boolean | undefined;
  safeToContinue?: boolean | undefined;
}): ControlDirectorContinuationDecision {
  const continuationCount = Math.max(0, Math.trunc(params.continuationCount ?? 0));
  const nextContinuationCount = continuationCount + 1;
  if (!isControlDirectorAgentId(params.agentId)) {
    return {
      status: "not_needed",
      reason: "agent is not the Control Director",
      shouldQueue: false,
      continuationCount,
      nextContinuationCount,
    };
  }
  if (!params.incomplete) {
    return {
      status: "not_needed",
      reason: "run has a visible terminal response",
      shouldQueue: false,
      continuationCount,
      nextContinuationCount,
    };
  }
  if (params.finalStatus === "needs_user_input" || params.needsUserInput === true) {
    return {
      status: "blocked",
      reason: "user input is required before safe continuation",
      shouldQueue: false,
      continuationCount,
      nextContinuationCount,
    };
  }
  if (params.approvalPending === true) {
    return {
      status: "blocked",
      reason: "an approval or user action is pending",
      shouldQueue: false,
      continuationCount,
      nextContinuationCount,
    };
  }
  if (params.externalAbort === true) {
    return {
      status: "blocked",
      reason: "run was externally aborted or cancelled",
      shouldQueue: false,
      continuationCount,
      nextContinuationCount,
    };
  }
  if (params.safeToContinue === false) {
    return {
      status: "blocked",
      reason: "continuation was not classified safe to replay",
      shouldQueue: false,
      continuationCount,
      nextContinuationCount,
    };
  }
  if (continuationCount >= CONTROL_DIRECTOR_MAX_SAFE_CONTINUATIONS) {
    return {
      status: "blocked",
      reason: "safe continuation limit reached",
      shouldQueue: false,
      continuationCount,
      nextContinuationCount,
    };
  }
  const classification = normalizeControlDirectorLivenessClassification(params.classification);
  const reason = classification
    ? `Control Director run ended with ${classification} classification`
    : "Control Director run ended without a user-visible terminal response";
  if (params.canQueueContinuation !== true) {
    return {
      status: "blocked",
      reason: `${reason}; session follow-up queue is unavailable`,
      shouldQueue: false,
      continuationCount,
      nextContinuationCount,
    };
  }
  return {
    status: "queue",
    reason,
    shouldQueue: true,
    continuationCount,
    nextContinuationCount,
    prompt: buildControlDirectorContinuationPrompt({
      missionId: params.missionId,
      reason,
      nextContinuationCount,
    }),
  };
}

function resolveControlDirectorLivenessAction(params: {
  classification?: ControlDirectorLivenessClassification;
  noVisiblePayload: boolean;
  decision: ControlDirectorContinuationDecision;
}): ControlDirectorLivenessWatchdogAction {
  if (params.decision.shouldQueue) {
    return "queued_safe_continuation";
  }
  if (params.decision.reason.includes("limit")) {
    return "blocked_continuation_limit";
  }
  if (params.decision.reason.includes("not classified safe")) {
    return "blocked_unsafe_continuation";
  }
  return params.classification
    ? "synthesized_blocked_incomplete_classification"
    : params.noVisiblePayload
      ? "synthesized_blocked_no_visible_output"
      : "synthesized_blocked_incomplete_classification";
}

function buildControlDirectorLivenessBlockedText(params: {
  classification?: ControlDirectorLivenessClassification;
  decision: ControlDirectorContinuationDecision;
  noVisiblePayload: boolean;
}): string {
  const classificationText = params.classification ?? "none";
  const queuedText = params.decision.shouldQueue ? "yes" : "no";
  const visibilityText = params.noVisiblePayload
    ? "No user-visible payload was available for delivery."
    : "The harness classified the final turn as non-terminal.";
  const nextGap = params.decision.shouldQueue
    ? "Run the queued safe continuation and verify concrete evidence before any complete claim."
    : `Resolve the liveness blocker before claiming completion. Reason: ${params.decision.reason}.`;
  return [
    "Control Director liveness watchdog prevented a silent or non-terminal final response.",
    "",
    `Verified state: ${visibilityText} Classification: ${classificationText}. Safe continuation queued: ${queuedText}.`,
    `Next build gap: ${nextGap}`,
    "Completion Grade: 7/10",
    "Criticality: 10/10",
    "Status: blocked",
  ].join("\n");
}

export function applyControlDirectorLivenessWatchdog<
  T extends ControlDirectorGuardablePayload,
>(params: {
  agentId?: string | undefined | null;
  payloads: readonly T[] | undefined;
  finalAssistantVisibleText?: string | undefined;
  classification?: string | null | undefined;
  continuationCount?: number | undefined;
  missionId?: string | undefined;
  canQueueContinuation?: boolean | undefined;
  needsUserInput?: boolean | undefined;
  approvalPending?: boolean | undefined;
  externalAbort?: boolean | undefined;
  safeToContinue?: boolean | undefined;
}): ControlDirectorLivenessWatchdogResult<T> {
  const payloads = [...(params.payloads ?? [])];
  const emptyDecision = decideControlDirectorContinuation({
    agentId: params.agentId,
    incomplete: false,
    continuationCount: params.continuationCount,
  });
  if (!isControlDirectorAgentId(params.agentId)) {
    return { payloads, changed: false, continuation: emptyDecision };
  }

  const classification = normalizeControlDirectorLivenessClassification(params.classification);
  const payloadText = collectControlDirectorVisiblePayloadText(payloads);
  const fallbackVisibleText = params.finalAssistantVisibleText?.trim() ?? "";
  const noVisiblePayload = !payloadText;
  const incompleteClassification = Boolean(classification);
  if (!noVisiblePayload && !incompleteClassification) {
    return { payloads, changed: false, continuation: emptyDecision };
  }

  const finalStatus = parseControlDirectorFinalStatus(payloadText || fallbackVisibleText);
  const decision = decideControlDirectorContinuation({
    agentId: params.agentId,
    incomplete: true,
    finalStatus,
    classification,
    continuationCount: params.continuationCount,
    missionId: params.missionId,
    canQueueContinuation: params.canQueueContinuation,
    needsUserInput: params.needsUserInput,
    approvalPending: params.approvalPending,
    externalAbort: params.externalAbort,
    safeToContinue: params.safeToContinue,
  });
  const text = buildControlDirectorLivenessBlockedText({
    classification,
    decision,
    noVisiblePayload,
  });
  const nextPayloads =
    payloads.length > 0
      ? payloads.map((payload, index) => (index === 0 ? { ...payload, text } : payload))
      : ([{ text } as T] satisfies T[]);
  return {
    payloads: nextPayloads,
    changed: true,
    continuation: decision,
    audit: {
      action: resolveControlDirectorLivenessAction({
        classification,
        noVisiblePayload,
        decision,
      }),
      reason: decision.reason,
      ...(classification ? { classification } : {}),
      nextStatus: "blocked",
      continuationCount: decision.continuationCount,
      continuationQueued: decision.shouldQueue,
      payloadsChecked: payloads.length,
      payloadsSynthesized: 1,
    },
  };
}

export function summarizeControlDirectorMissionFinalText(
  text: string,
): ControlDirectorMissionSummary {
  const finalStatus = parseControlDirectorFinalStatus(text);
  const status: ControlDirectorMissionLedgerStatus =
    finalStatus === "complete"
      ? "complete"
      : finalStatus === "needs_user_input"
        ? "needs_user_input"
        : "blocked";
  return {
    finalStatus,
    status,
    verifiedEvidenceSummary:
      extractControlDirectorLineValue(text, /^\s*verified (?:state|evidence)\s*:\s*(.+)$/iu) ??
      "No verified evidence summary found in final response.",
    nextBuildGap:
      extractControlDirectorLineValue(
        text,
        /^\s*next (?:most impactful )?build gap\s*:\s*(.+)$/iu,
      ) ?? "No next build gap found in final response.",
    completionGrade: extractControlDirectorNumber(
      text,
      /\bcompletion grade\s*:\s*(10|[0-9](?:\.\d+)?)\s*\/\s*10\b/iu,
    ),
    criticality: extractControlDirectorNumber(
      text,
      /\bcriticality\s*:\s*(10|[0-9](?:\.\d+)?)\s*\/\s*10\b/iu,
    ),
  };
}

function buildControlDirectorBlockedCompletionText(params: {
  originalText: string;
  evaluation: ControlDirectorResponseEvaluation;
}): string {
  return [
    "Control Director completion guard blocked an unsupported completion claim.",
    "",
    "Verified state: The final response was not delivered as complete because required verification evidence was missing.",
    `Original response summary: ${summarizeControlDirectorOriginalText(params.originalText)}`,
    `Next build gap: Provide concrete verification evidence before claiming complete. Missing: ${formatControlDirectorMissing(params.evaluation.missing)}.`,
    "Completion Grade: 8/10",
    "Criticality: 10/10",
    "Status: blocked",
  ].join("\n");
}

function buildControlDirectorRepairedReportText(params: {
  originalText: string;
  evaluation: ControlDirectorResponseEvaluation;
  nextStatus: ControlDirectorFinalStatus;
}): string {
  const completionGrade = params.nextStatus === "complete" ? "9/10" : "8/10";
  const nextBuildGap =
    params.nextStatus === "complete"
      ? `No additional runtime guard gap detected; repaired missing report fields before delivery. Missing: ${formatControlDirectorMissing(params.evaluation.missing)}.`
      : `Close missing Control Director report fields before final handoff. Missing: ${formatControlDirectorMissing(params.evaluation.missing)}.`;
  return [
    params.originalText.trimEnd(),
    "",
    "---",
    "Verified state: Runtime guard repaired missing Control Director report fields before delivery.",
    `Next build gap: ${nextBuildGap}`,
    `Completion Grade: ${completionGrade}`,
    "Criticality: 10/10",
    `Status: ${params.nextStatus}`,
  ].join("\n");
}

function guardControlDirectorFinalText(text: string): {
  text: string;
  changed: boolean;
  action?: ControlDirectorFinalOutputGuardAction;
  originalStatus: ControlDirectorFinalStatus | null;
  nextStatus: ControlDirectorFinalStatus;
  missing: string[];
} {
  const evaluation = evaluateControlDirectorResponse({
    text,
    requirements: CONTROL_DIRECTOR_FINAL_OUTPUT_REQUIREMENTS,
  });
  const nextStatus = resolveGuardedControlDirectorStatus(evaluation);
  if (evaluation.passed) {
    return {
      text,
      changed: false,
      originalStatus: evaluation.status,
      nextStatus,
      missing: [],
    };
  }
  const falseCompleteClaim =
    evaluation.status === "complete" && includesControlDirectorEvidenceMissing(evaluation.missing);
  if (falseCompleteClaim) {
    return {
      text: buildControlDirectorBlockedCompletionText({ originalText: text, evaluation }),
      changed: true,
      action: "rewrote_unsupported_complete",
      originalStatus: evaluation.status,
      nextStatus: "blocked",
      missing: evaluation.missing,
    };
  }
  return {
    text: buildControlDirectorRepairedReportText({
      originalText: text,
      evaluation,
      nextStatus,
    }),
    changed: true,
    action: "repaired_missing_required_fields",
    originalStatus: evaluation.status,
    nextStatus,
    missing: evaluation.missing,
  };
}

export function applyControlDirectorFinalOutputGuard<
  T extends ControlDirectorGuardablePayload,
>(params: {
  agentId?: string | undefined | null;
  payloads: readonly T[] | undefined;
}): ControlDirectorFinalOutputGuardResult<T> {
  const payloads = [...(params.payloads ?? [])];
  if (!isControlDirectorAgentId(params.agentId) || payloads.length === 0) {
    return { payloads, changed: false };
  }

  let payloadsRewritten = 0;
  let firstAudit:
    | Omit<ControlDirectorFinalOutputGuardAudit, "payloadsChecked" | "payloadsRewritten">
    | undefined;
  const guardedPayloads = payloads.map((payload) => {
    const text = typeof payload.text === "string" ? payload.text : "";
    if (!text.trim()) {
      return payload;
    }
    const guarded = guardControlDirectorFinalText(text);
    if (!guarded.changed) {
      return payload;
    }
    payloadsRewritten += 1;
    firstAudit ??= {
      action: guarded.action ?? "repaired_missing_required_fields",
      originalStatus: guarded.originalStatus,
      nextStatus: guarded.nextStatus,
      missing: guarded.missing,
    };
    return {
      ...payload,
      text: guarded.text,
    };
  });

  return {
    payloads: guardedPayloads,
    changed: payloadsRewritten > 0,
    audit:
      payloadsRewritten > 0 && firstAudit
        ? {
            ...firstAudit,
            payloadsChecked: payloads.length,
            payloadsRewritten,
          }
        : undefined,
  };
}

export function scoreControlDirectorReadiness(
  facts: ControlDirectorReadinessFact[],
): ControlDirectorReadinessScorecard {
  const critical = facts.filter((fact) => fact.critical);
  const failedCritical = critical.filter((fact) => !fact.passed).map((fact) => fact.label);
  const passedCritical = critical.length - failedCritical.length;
  const passed = facts.filter((fact) => fact.passed).length;
  const criticalRatio = critical.length > 0 ? passedCritical / critical.length : 1;
  const overallRatio = facts.length > 0 ? passed / facts.length : 0;
  const completionGrade = Math.round((criticalRatio * 0.75 + overallRatio * 0.25) * 100) / 10;
  const nextFailed =
    facts.find((fact) => !fact.passed && fact.critical) ?? facts.find((fact) => !fact.passed);
  return {
    completionGrade,
    criticality: 10,
    productionReady: completionGrade >= 9.5 && failedCritical.length === 0,
    facts,
    failedCritical,
    nextBuildGap: nextFailed
      ? `${nextFailed.label}${nextFailed.detail ? `: ${nextFailed.detail}` : ""}`
      : "No critical Control Director build gap detected by this scorecard.",
  };
}

export const CONTROL_DIRECTOR_DETERMINISTIC_EVALS = [
  {
    id: "verified-complete-report",
    requirement: {
      completionState: true,
      verifiedEvidence: true,
      completionGrade: true,
      criticality: true,
      nextBuildGap: true,
    },
  },
  {
    id: "blocked-not-complete",
    requirement: {
      completionState: true,
      verifiedEvidence: false,
      completionGrade: true,
      criticality: true,
      nextBuildGap: true,
    },
  },
] as const;
