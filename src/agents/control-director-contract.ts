import { createHash } from "node:crypto";
import { judgeTaskCompletion } from "../tasks/task-completion-judge.js";

export const CONTROL_DIRECTOR_AGENT_IDS = ["main", "control-director"] as const;

export const CONTROL_DIRECTOR_PRIMARY_PROVIDER = "ollama";
export const CONTROL_DIRECTOR_PRIMARY_ALIAS = "openclaw-control-qwen36-27b";
export const CONTROL_DIRECTOR_PRIMARY_MODEL_ID = "openclaw-control-qwen36-27b:latest";
export const CONTROL_DIRECTOR_PRIMARY_MODEL = `${CONTROL_DIRECTOR_PRIMARY_PROVIDER}/${CONTROL_DIRECTOR_PRIMARY_MODEL_ID}`;
export const CONTROL_DIRECTOR_UNDERLYING_OLLAMA_TAG = "qwen3.6:27b-q8_0";
export const CONTROL_DIRECTOR_PRIMARY_DISPLAY_LABEL = "OpenClaw Control Qwen3.6 27B Q8_0";
export const CONTROL_DIRECTOR_FIRST_FALLBACK_MODEL = "ollama/openclaw-control-qwen25-32b:latest";
export const CONTROL_DIRECTOR_EFFECTIVE_CONTEXT_TOKENS = 64_000;

export type ControlDirectorFinalStatus = "complete" | "blocked" | "needs_user_input" | "continuing";
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
  | "repaired_missing_required_fields"
  | "blocked_missing_judge_approval"
  | "blocked_invalid_judge_approval";

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

export type ControlDirectorJudgeCompletionApproval = {
  judgeStatus: "pending" | "approved" | "rejected" | "invalid";
  judgeVerdict?: string;
  judgeRunId?: string;
  missionId: string;
  approvedClaimHash?: string;
  evidenceSummary?: string;
  scope?: string;
  approvedAt?: number;
  missingAcceptanceCriteria?: string[];
};

export type ControlDirectorJudgeCompletionGateResult<T extends ControlDirectorGuardablePayload> = {
  payloads: T[];
  changed: boolean;
  expectedClaimHash?: string;
  approval?: ControlDirectorJudgeCompletionApproval;
  audit?: ControlDirectorFinalOutputGuardAudit;
};

export type ControlDirectorTruthClaimType =
  | "completion"
  | "verification"
  | "remote_proof"
  | "dashboard"
  | "implementation"
  | "external_fact";

export type ControlDirectorClaimEvidenceType =
  | "judge_approval"
  | "command"
  | "github_run"
  | "ui_smoke"
  | "repo_change"
  | "source_citation";

export type ControlDirectorClaimEvidence = {
  type: ControlDirectorClaimEvidenceType;
  id: string;
  source: string;
  summary: string;
  status: "passed" | "failed" | "unknown";
  exitCode?: number;
  sha?: string;
};

export type ControlDirectorTruthClaimAudit = {
  claim: string;
  claimHash: string;
  claimType: ControlDirectorTruthClaimType;
  requiredEvidenceType: ControlDirectorClaimEvidenceType;
  evidenceId?: string;
  evidenceSource?: string;
  matchStatus: "matched" | "missing";
  missingCondition?: string;
  rewriteAction?: "blocked_unsupported_truth_claim";
};

export type ControlDirectorTruthAudit = {
  status: "passed" | "blocked" | "not_required";
  claims: ControlDirectorTruthClaimAudit[];
  missing: string[];
  payloadsChecked: number;
  payloadsRewritten: number;
};

export type ControlDirectorTruthGateResult<T extends ControlDirectorGuardablePayload> = {
  payloads: T[];
  changed: boolean;
  audit?: ControlDirectorTruthAudit;
};

export type ControlDirectorLivenessClassification = "empty" | "reasoning-only" | "planning-only";

export type ControlDirectorLivenessWatchdogAction =
  | "synthesized_blocked_no_visible_output"
  | "synthesized_blocked_incomplete_classification"
  | "queued_safe_continuation"
  | "blocked_continuation_queue_failed"
  | "blocked_continuation_limit"
  | "blocked_unsafe_continuation";

export type ControlDirectorLivenessWatchdogAudit = {
  action: ControlDirectorLivenessWatchdogAction;
  reason: string;
  classification?: ControlDirectorLivenessClassification;
  nextStatus: "blocked" | "continuing";
  continuationCount: number;
  continuationQueued: boolean;
  continuationQueueId?: string;
  continuationQueueError?: string;
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
  | "continuing"
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

const STATUS_PATTERN_GLOBAL =
  /\bstatus\s*:\s*(complete|blocked|needs[_ -]user[_ -]input|continuing)\b/gi;
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
    "A `Status: complete` claim also requires Judge approval for this exact mission, final answer, and evidence. If Judge approval is missing, invalid, stale, or scope-mismatched, report `Status: blocked` instead.",
    "Any factual, verification, remote-proof, dashboard-tested, implemented/fixed, or success claim must be backed by matching runtime evidence. If evidence is unavailable, say it is unknown/unverified or report `Status: blocked`.",
    "If work is incomplete, do not call it complete. State the exact blocker or the next build gap and the smallest action that would close it.",
    "When the user asks for Completion Grade, Criticality, verified state, or next build gap, include those fields in every response until the user changes that reporting requirement.",
    "When reporting Completion Grade or Criticality, use numeric `/10` values unless the user explicitly asks for another scale.",
    "If the user gives an exact response format, follow that format exactly. Do not ask what task the format applies to when the current prompt itself defines a smoke, verification, or implementation task.",
    "Thinking policy: default to non-thinking for routine turns, but use thinking only as needed for implementation, evaluation, debugging, verification, rollback, model, runtime, service, or production-risk work.",
    "End task reports with an explicit status line using one of: `Status: complete`, `Status: blocked`, or `Status: needs_user_input`. Runtime recovery/progress handoffs may use `Status: continuing` only when a durable recovery turn has been queued.",
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
      normalized === "needs_user_input" ||
      normalized === "continuing"
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
  if (
    evaluation.status === "blocked" ||
    evaluation.status === "needs_user_input" ||
    evaluation.status === "continuing"
  ) {
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

function summarizeControlDirectorPromptRequest(
  text: string | undefined | null,
): string | undefined {
  const normalized = (text ?? "").replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 239)}…`;
}

function hashControlDirectorPromptRequest(text: string | undefined | null): string | undefined {
  const normalized = (text ?? "").replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return createHash("sha256").update(normalized).digest("hex");
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
  requestBody?: string | undefined;
}): string {
  const requestSummary = summarizeControlDirectorPromptRequest(params.requestBody);
  const requestHash = hashControlDirectorPromptRequest(params.requestBody);
  return [
    "Control Director recovery supervisor request.",
    params.missionId ? `Mission id: ${params.missionId}` : undefined,
    requestHash ? `Original request hash: ${requestHash}` : undefined,
    requestSummary ? `Original request summary: ${requestSummary}` : undefined,
    `Continuation attempt: ${params.nextContinuationCount}/${CONTROL_DIRECTOR_MAX_SAFE_CONTINUATIONS}`,
    `Reason: ${params.reason}`,
    "This is a liveness recovery turn. Bypass continuation-skip behavior and load the needed bootstrap/context before acting.",
    "Continue from the current state. Do not repeat completed or mutating actions unless the action is idempotent and needed for verification.",
    "Diagnose why the prior turn produced no user-visible terminal output, then continue or delegate safely.",
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
  requestBody?: string | undefined;
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
      requestBody: params.requestBody,
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
  if (params.decision.shouldQueue) {
    return [
      "Control Director liveness watchdog prevented a silent or non-terminal final response.",
      "",
      `Verified state: ${visibilityText} Classification: ${classificationText}. Recovery queued: ${queuedText}.`,
      "Next build gap: Run the queued recovery continuation and verify concrete evidence before any complete claim.",
      "Completion Grade: 7/10",
      "Criticality: 10/10",
      "Status: continuing",
    ].join("\n");
  }
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
  requestBody?: string | undefined;
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
    requestBody: params.requestBody,
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
      nextStatus: decision.shouldQueue ? "continuing" : "blocked",
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
        : finalStatus === "continuing"
          ? "continuing"
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

function normalizeControlDirectorClaimPart(value: string | undefined | null): string {
  return (value ?? "").replace(/\s+/gu, " ").trim();
}

function stableControlDirectorStringList(values: readonly string[] | undefined): string[] {
  return [
    ...new Set((values ?? []).map(normalizeControlDirectorClaimPart).filter(Boolean)),
  ].toSorted();
}

function hashControlDirectorTruthClaim(claim: string): string {
  return createHash("sha256").update(normalizeControlDirectorClaimPart(claim)).digest("hex");
}

function isControlDirectorUncertainOrBlockedClaim(line: string): boolean {
  return (
    /^original response summary\s*:/iu.test(line) ||
    /\b(blocked|unsupported|missing|not delivered|not verified|unverified|cannot verify|can't verify|unknown|requires?|need(?:s|ed)?|obtain|pending)\b/iu.test(
      line,
    )
  );
}

function buildControlDirectorTruthClaim(params: {
  line: string;
  claimType: ControlDirectorTruthClaimType;
  requiredEvidenceType: ControlDirectorClaimEvidenceType;
}): Omit<
  ControlDirectorTruthClaimAudit,
  "evidenceId" | "evidenceSource" | "matchStatus" | "missingCondition" | "rewriteAction"
> {
  return {
    claim: params.line,
    claimHash: hashControlDirectorTruthClaim(params.line),
    claimType: params.claimType,
    requiredEvidenceType: params.requiredEvidenceType,
  };
}

function extractControlDirectorTruthClaims(
  text: string,
): Array<
  Omit<
    ControlDirectorTruthClaimAudit,
    "evidenceId" | "evidenceSource" | "matchStatus" | "missingCondition" | "rewriteAction"
  >
> {
  const claims: Array<
    Omit<
      ControlDirectorTruthClaimAudit,
      "evidenceId" | "evidenceSource" | "matchStatus" | "missingCondition" | "rewriteAction"
    >
  > = [];
  const seen = new Set<string>();
  for (const rawLine of text.split(/\n+/u)) {
    const line = rawLine.replace(/\s+/gu, " ").trim();
    if (!line || isControlDirectorUncertainOrBlockedClaim(line)) {
      continue;
    }
    const add = (
      claimType: ControlDirectorTruthClaimType,
      requiredEvidenceType: ControlDirectorClaimEvidenceType,
    ) => {
      const key = `${claimType}:${line}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      claims.push(buildControlDirectorTruthClaim({ line, claimType, requiredEvidenceType }));
    };
    const remoteProofClaim =
      /\b(remote|github actions?|ci|workflow|linux proof)\b.*\b(passed|succeeded|success|green|verified)\b/iu.test(
        line,
      );
    const dashboardClaim =
      /\b(dashboard|control ui|webchat|ui smoke)\b.*\b(updated|tested|verified|passed|succeeded)\b/iu.test(
        line,
      );
    if (/\bstatus\s*:\s*complete\b/iu.test(line) || /\b(done|finished|completed)\b/iu.test(line)) {
      add("completion", "judge_approval");
    }
    if (remoteProofClaim) {
      add("remote_proof", "github_run");
    }
    if (dashboardClaim) {
      add("dashboard", "ui_smoke");
    }
    const verificationClaim =
      !remoteProofClaim &&
      !dashboardClaim &&
      (/\b(tests?|checks?|smoke|validation|proof|command|readiness|pnpm)\b.*\b(passed|succeeded|verified|tested|green)\b/iu.test(
        line,
      ) ||
        /\b(verified|tested)\b.*\b(tests?|checks?|smoke|validation|proof|command|readiness|pnpm)\b/iu.test(
          line,
        ));
    if (verificationClaim) {
      add("verification", "command");
    }
    if (/\b(implemented|fixed|changed|updated)\b/iu.test(line)) {
      add("implementation", "repo_change");
    }
    if (
      /\b(latest|as of|today|yesterday|tomorrow|current public|currently public)\b/iu.test(line) &&
      !/\b(source|citation|cited|https?:\/\/)\b/iu.test(line)
    ) {
      add("external_fact", "source_citation");
    }
  }
  return claims;
}

function findControlDirectorEvidenceForClaim(params: {
  claim: Pick<ControlDirectorTruthClaimAudit, "claim" | "requiredEvidenceType">;
  evidence: readonly ControlDirectorClaimEvidence[];
  implementationSha?: string | undefined;
}): ControlDirectorClaimEvidence | undefined {
  const claimText = params.claim.claim.toLowerCase();
  return params.evidence.find((candidate) => {
    if (candidate.type !== params.claim.requiredEvidenceType || candidate.status !== "passed") {
      return false;
    }
    if (candidate.type === "command" && candidate.exitCode !== 0) {
      return false;
    }
    if (candidate.type === "command") {
      const haystack = `${candidate.source} ${candidate.summary}`.toLowerCase();
      const requiredCommandTerms = [
        ["test", /\b(test|vitest|pnpm test)\b/u],
        ["check", /\b(check|lint|type|tsgo|pnpm check)\b/u],
        ["smoke", /\b(smoke)\b/u],
        ["readiness", /\b(readiness|control-director:readiness)\b/u],
        ["pnpm", /\bpnpm\b/u],
      ] as const;
      for (const [term, pattern] of requiredCommandTerms) {
        if (claimText.includes(term) && !pattern.test(haystack)) {
          return false;
        }
      }
    }
    if (
      candidate.type === "github_run" &&
      params.implementationSha &&
      candidate.sha !== params.implementationSha
    ) {
      return false;
    }
    return true;
  });
}

function missingControlDirectorTruthCondition(params: {
  requiredEvidenceType: ControlDirectorClaimEvidenceType;
  implementationSha?: string | undefined;
}): string {
  if (params.requiredEvidenceType === "command") {
    return "command evidence with exit code 0";
  }
  if (params.requiredEvidenceType === "github_run") {
    return params.implementationSha
      ? `successful GitHub run evidence for implementation SHA ${params.implementationSha}`
      : "successful GitHub run evidence for the implementation SHA";
  }
  if (params.requiredEvidenceType === "ui_smoke") {
    return "successful dashboard/UI smoke evidence";
  }
  if (params.requiredEvidenceType === "repo_change") {
    return "repo diff or commit evidence touching the claimed surface";
  }
  if (params.requiredEvidenceType === "source_citation") {
    return "source evidence or explicit unknown/unverified wording for external facts";
  }
  return "matching Judge approval evidence";
}

function buildControlDirectorTruthBlockedText(params: {
  blockedClaims: readonly ControlDirectorTruthClaimAudit[];
}): string {
  const first = params.blockedClaims[0];
  return [
    "Control Director truth gate blocked unsupported claims.",
    "",
    "Verified state: unsupported Control Director truth claim was blocked before delivery.",
    `Unsupported claim: ${first?.claim ?? "unknown"}`,
    `Missing evidence: ${first?.missingCondition ?? "matching runtime evidence"}`,
    "Next build gap: collect matching evidence or revise the answer to state uncertainty.",
    "Completion Grade: 9.9/10",
    "Criticality: 10/10",
    "Status: blocked",
  ].join("\n");
}

export function applyControlDirectorTruthGate<T extends ControlDirectorGuardablePayload>(params: {
  agentId?: string | undefined | null;
  payloads: readonly T[] | undefined;
  evidence?: readonly ControlDirectorClaimEvidence[] | undefined;
  implementationSha?: string | undefined;
}): ControlDirectorTruthGateResult<T> {
  const payloads = [...(params.payloads ?? [])];
  if (!isControlDirectorAgentId(params.agentId) || payloads.length === 0) {
    return { payloads, changed: false };
  }

  const evidence = params.evidence ?? [];
  const claims: ControlDirectorTruthClaimAudit[] = [];
  let payloadsRewritten = 0;
  const guardedPayloads = payloads.map((payload) => {
    const text = typeof payload.text === "string" ? payload.text : "";
    const payloadClaims = extractControlDirectorTruthClaims(text).map((claim) => {
      const matched = findControlDirectorEvidenceForClaim({
        claim,
        evidence,
        implementationSha: params.implementationSha,
      });
      if (matched) {
        return Object.assign({}, claim, {
          evidenceId: matched.id,
          evidenceSource: matched.source,
          matchStatus: "matched" as const,
        });
      }
      return Object.assign({}, claim, {
        matchStatus: "missing" as const,
        missingCondition: missingControlDirectorTruthCondition({
          requiredEvidenceType: claim.requiredEvidenceType,
          implementationSha: params.implementationSha,
        }),
        rewriteAction: "blocked_unsupported_truth_claim" as const,
      });
    });
    claims.push(...payloadClaims);
    const blockedClaims = payloadClaims.filter((claim) => claim.matchStatus === "missing");
    if (blockedClaims.length === 0) {
      return payload;
    }
    payloadsRewritten += 1;
    return {
      ...payload,
      text: buildControlDirectorTruthBlockedText({ blockedClaims }),
    };
  });

  if (claims.length === 0) {
    return {
      payloads: guardedPayloads,
      changed: false,
      audit: {
        status: "not_required",
        claims: [],
        missing: [],
        payloadsChecked: payloads.length,
        payloadsRewritten: 0,
      },
    };
  }
  const missing = claims
    .filter((claim) => claim.matchStatus === "missing")
    .map((claim) => claim.missingCondition ?? "matching runtime evidence");
  return {
    payloads: guardedPayloads,
    changed: payloadsRewritten > 0,
    audit: {
      status: missing.length > 0 ? "blocked" : "passed",
      claims,
      missing,
      payloadsChecked: payloads.length,
      payloadsRewritten,
    },
  };
}

export function buildControlDirectorJudgeClaimHash(params: {
  missionId: string;
  requestBody: string;
  finalText: string;
  evidenceSummary: string;
  artifactIds?: readonly string[] | undefined;
  commandEvidence?: readonly string[] | undefined;
}): string {
  const stablePayload = {
    artifactIds: stableControlDirectorStringList(params.artifactIds),
    commandEvidence: stableControlDirectorStringList(params.commandEvidence),
    evidenceSummary: normalizeControlDirectorClaimPart(params.evidenceSummary),
    finalText: normalizeControlDirectorClaimPart(params.finalText),
    missionId: normalizeControlDirectorClaimPart(params.missionId),
    requestBody: normalizeControlDirectorClaimPart(params.requestBody),
  };
  return createHash("sha256").update(JSON.stringify(stablePayload)).digest("hex");
}

export function evaluateControlDirectorJudgeCompletionApproval(params: {
  missionId: string;
  requestBody: string;
  finalText: string;
  evidenceSummary: string;
  approval?: ControlDirectorJudgeCompletionApproval | null | undefined;
}): {
  approved: boolean;
  expectedClaimHash: string;
  missing: string[];
  reason: string;
} {
  const expectedClaimHash = buildControlDirectorJudgeClaimHash({
    missionId: params.missionId,
    requestBody: params.requestBody,
    finalText: params.finalText,
    evidenceSummary: params.evidenceSummary,
  });
  const approval = params.approval;
  const missing: string[] = [];
  if (!approval) {
    missing.push("Judge approval metadata");
  } else {
    if (approval.judgeStatus !== "approved") {
      missing.push(`Judge status approved (actual: ${approval.judgeStatus})`);
    }
    if (approval.judgeVerdict !== "APPROVE") {
      missing.push(`Judge verdict APPROVE (actual: ${approval.judgeVerdict ?? "missing"})`);
    }
    if (!approval.judgeRunId?.trim()) {
      missing.push("Judge run id");
    }
    if (approval.missionId !== params.missionId) {
      missing.push("matching mission id");
    }
    if (approval.approvedClaimHash !== expectedClaimHash) {
      missing.push("matching approved claim hash");
    }
    if (!approval.evidenceSummary?.trim()) {
      missing.push("Judge evidence summary");
    }
    if (!approval.scope?.trim()) {
      missing.push("Judge approval scope");
    }
    if (!approval.approvedAt || !Number.isFinite(approval.approvedAt)) {
      missing.push("Judge approval timestamp");
    }
    if ((approval.missingAcceptanceCriteria ?? []).length > 0) {
      missing.push(
        `zero missing acceptance criteria (${approval.missingAcceptanceCriteria?.join(", ")})`,
      );
    }
    const localJudge = judgeTaskCompletion({
      userRequest: params.requestBody,
      finalText: params.finalText,
      expectedDeliverable: approval.scope,
      status: "succeeded",
    });
    if (!localJudge.approved) {
      missing.push(`deterministic local Judge approval (${localJudge.verdict.verdict})`);
    }
  }
  return {
    approved: missing.length === 0,
    expectedClaimHash,
    missing,
    reason:
      missing.length > 0
        ? `Missing or invalid Judge approval: ${formatControlDirectorMissing(missing)}.`
        : "Judge approved this exact mission completion claim.",
  };
}

function buildControlDirectorJudgeBlockedCompletionText(params: {
  originalText: string;
  evaluation: ReturnType<typeof evaluateControlDirectorJudgeCompletionApproval>;
}): string {
  return [
    "Control Director Judge completion gate blocked an unapproved completion claim.",
    "",
    "Verified state: completion was not delivered because Judge approval is missing or invalid.",
    `Original response summary: ${summarizeControlDirectorOriginalText(params.originalText)}`,
    `Next build gap: obtain Judge APPROVE verdict for this exact mission and evidence. Missing: ${formatControlDirectorMissing(params.evaluation.missing)}.`,
    "Completion Grade: 9/10",
    "Criticality: 10/10",
    "Status: blocked",
  ].join("\n");
}

export function applyControlDirectorJudgeCompletionGate<
  T extends ControlDirectorGuardablePayload,
>(params: {
  agentId?: string | undefined | null;
  payloads: readonly T[] | undefined;
  missionId: string;
  requestBody: string;
  approval?: ControlDirectorJudgeCompletionApproval | null | undefined;
}): ControlDirectorJudgeCompletionGateResult<T> {
  const payloads = [...(params.payloads ?? [])];
  if (!isControlDirectorAgentId(params.agentId) || payloads.length === 0) {
    return { payloads, changed: false, approval: params.approval ?? undefined };
  }

  let payloadsRewritten = 0;
  let expectedClaimHash: string | undefined;
  let firstAudit:
    | Omit<ControlDirectorFinalOutputGuardAudit, "payloadsChecked" | "payloadsRewritten">
    | undefined;
  const guardedPayloads = payloads.map((payload) => {
    const text = typeof payload.text === "string" ? payload.text : "";
    if (parseControlDirectorFinalStatus(text) !== "complete") {
      return payload;
    }
    const summary = summarizeControlDirectorMissionFinalText(text);
    const evaluation = evaluateControlDirectorJudgeCompletionApproval({
      missionId: params.missionId,
      requestBody: params.requestBody,
      finalText: text,
      evidenceSummary: summary.verifiedEvidenceSummary,
      approval: params.approval,
    });
    expectedClaimHash ??= evaluation.expectedClaimHash;
    if (evaluation.approved) {
      return payload;
    }
    payloadsRewritten += 1;
    firstAudit ??= {
      action: params.approval ? "blocked_invalid_judge_approval" : "blocked_missing_judge_approval",
      originalStatus: "complete",
      nextStatus: "blocked",
      missing: evaluation.missing,
    };
    return {
      ...payload,
      text: buildControlDirectorJudgeBlockedCompletionText({
        originalText: text,
        evaluation,
      }),
    };
  });

  return {
    payloads: guardedPayloads,
    changed: payloadsRewritten > 0,
    ...(expectedClaimHash ? { expectedClaimHash } : {}),
    approval: params.approval ?? undefined,
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
