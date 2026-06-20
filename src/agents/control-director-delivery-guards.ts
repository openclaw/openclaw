import type {
  SessionControlDirectorGuardAuditEntry,
  SessionControlDirectorJudgeCompletionApproval,
  SessionControlDirectorJudgeCompletionGate,
  SessionControlDirectorLivenessAuditEntry,
  SessionControlDirectorMissionLedgerEntry,
  SessionControlDirectorTruthAuditEntry,
  SessionEntry,
} from "../config/sessions/types.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import { requestHeartbeat } from "../infra/heartbeat-wake.js";
import { enqueueSessionDelivery } from "../infra/session-delivery-queue.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { persistSessionEntry as persistSessionEntryBase } from "./command/attempt-execution.shared.js";
import {
  applyControlDirectorFinalOutputGuard,
  applyControlDirectorJudgeCompletionGate,
  applyControlDirectorLivenessWatchdog,
  applyControlDirectorTruthGate,
  isControlDirectorAgentId,
  isControlDirectorPrimaryModelRef,
  summarizeControlDirectorMissionFinalText,
  type ControlDirectorClaimEvidence,
  type ControlDirectorContinuationDecision,
  type ControlDirectorFinalOutputGuardAudit,
  type ControlDirectorFinalOutputGuardResult,
  type ControlDirectorGuardablePayload,
  type ControlDirectorJudgeCompletionApproval,
  type ControlDirectorJudgeCompletionGateResult,
  type ControlDirectorLivenessWatchdogAudit,
  type ControlDirectorLivenessWatchdogResult,
  type ControlDirectorMissionSummary,
  type ControlDirectorTruthAudit,
} from "./control-director-contract.js";
import { loadControlDirectorTruthEvidence } from "./control-director-truth-evidence.js";

const MAX_CONTROL_DIRECTOR_GUARD_AUDIT_ENTRIES = 20;
const MAX_CONTROL_DIRECTOR_LIVENESS_AUDIT_ENTRIES = 20;
const MAX_CONTROL_DIRECTOR_MISSION_LEDGER_ENTRIES = 20;
const MAX_CONTROL_DIRECTOR_TRUTH_AUDIT_ENTRIES = 20;
const CONTROL_DIRECTOR_REQUEST_SUMMARY_MAX = 240;

type ControlDirectorSessionMutationParams = {
  runId?: string | undefined;
  sessionId: string;
  sessionKey?: string | undefined;
  sessionEntry?: SessionEntry | undefined;
  sessionStore?: Record<string, SessionEntry> | undefined;
  storePath?: string | undefined;
};

export type ControlDirectorDeliveryGuardResult<T extends ControlDirectorGuardablePayload> = {
  payloads: T[];
  sessionEntry?: SessionEntry;
  finalPayloadText: string;
  continuation: ControlDirectorContinuationDecision;
  continuationQueued: boolean;
  continuationQueueId?: string;
  continuationQueueError?: string;
  guardActions: string[];
  watchdogActions: string[];
  judgeCompletionGate?: SessionControlDirectorJudgeCompletionGate;
  truthAudit?: SessionControlDirectorTruthAuditEntry;
};

function buildNoopControlDirectorContinuation(): ControlDirectorContinuationDecision {
  return {
    status: "not_needed",
    reason: "delivery is outside Control Director scope",
    shouldQueue: false,
    continuationCount: 0,
    nextContinuationCount: 1,
  };
}

function looksLikeControlDirectorReport(text: string | undefined): boolean {
  if (!text?.trim()) {
    return false;
  }
  return (
    /\bVerified state\s*:/iu.test(text) &&
    /\bNext build gap\s*:/iu.test(text) &&
    /\bCompletion Grade\s*:/iu.test(text) &&
    /\bCriticality\s*:/iu.test(text) &&
    /\bStatus\s*:/iu.test(text)
  );
}

function isControlDirectorDeliveryScope(params: {
  agentId?: string | undefined;
  model?: string | null | undefined;
  explicit?: boolean | undefined;
  hasRuntimeEvidence?: boolean | undefined;
  hasJudgeApproval?: boolean | undefined;
  finalText?: string | undefined;
}): boolean {
  if (params.explicit !== undefined) {
    return params.explicit;
  }
  const normalizedAgentId = params.agentId?.trim().toLowerCase();
  if (normalizedAgentId === "control-director") {
    return true;
  }
  if (normalizedAgentId !== "main") {
    return false;
  }
  return (
    isControlDirectorPrimaryModelRef(params.model) ||
    params.hasRuntimeEvidence === true ||
    params.hasJudgeApproval === true ||
    looksLikeControlDirectorReport(params.finalText)
  );
}

function buildSessionControlDirectorGuardAuditEntry(params: {
  audit: ControlDirectorFinalOutputGuardAudit;
  runId?: string | undefined;
}): SessionControlDirectorGuardAuditEntry {
  return {
    ...(params.runId ? { runId: params.runId } : {}),
    ts: Date.now(),
    action: params.audit.action,
    originalStatus: params.audit.originalStatus,
    nextStatus: params.audit.nextStatus,
    missing: params.audit.missing,
    payloadsChecked: params.audit.payloadsChecked,
    payloadsRewritten: params.audit.payloadsRewritten,
  };
}

function buildSessionControlDirectorLivenessAuditEntry(params: {
  audit: ControlDirectorLivenessWatchdogAudit;
  runId?: string | undefined;
}): SessionControlDirectorLivenessAuditEntry {
  return {
    ...(params.runId ? { runId: params.runId } : {}),
    ts: Date.now(),
    action: params.audit.action,
    reason: params.audit.reason,
    ...(params.audit.classification ? { classification: params.audit.classification } : {}),
    nextStatus: params.audit.nextStatus,
    continuationCount: params.audit.continuationCount,
    continuationQueued: params.audit.continuationQueued,
    ...(params.audit.continuationQueueId
      ? { continuationQueueId: params.audit.continuationQueueId }
      : {}),
    ...(params.audit.continuationQueueError
      ? { continuationQueueError: params.audit.continuationQueueError }
      : {}),
    payloadsChecked: params.audit.payloadsChecked,
    payloadsSynthesized: params.audit.payloadsSynthesized,
  };
}

async function persistControlDirectorSessionEntry(params: {
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  storePath: string;
  entry: SessionEntry;
}): Promise<void> {
  await persistSessionEntryBase(params);
}

async function recordControlDirectorGuardAudit(
  params: ControlDirectorSessionMutationParams & { audit: ControlDirectorFinalOutputGuardAudit },
): Promise<SessionEntry | undefined> {
  const auditEntry = buildSessionControlDirectorGuardAuditEntry({
    audit: params.audit,
    runId: params.runId,
  });
  if (params.runId) {
    emitAgentEvent({
      runId: params.runId,
      sessionKey: params.sessionKey ?? params.sessionId,
      stream: "control_director_guard",
      data: auditEntry,
    });
  }
  if (params.sessionStore && params.sessionKey && params.storePath) {
    const entry = params.sessionStore[params.sessionKey] ?? params.sessionEntry;
    if (entry) {
      const nextAudit = [...(entry.controlDirectorGuardAudit ?? []), auditEntry].slice(
        -MAX_CONTROL_DIRECTOR_GUARD_AUDIT_ENTRIES,
      );
      const next: SessionEntry = {
        ...entry,
        controlDirectorGuardAudit: nextAudit,
        updatedAt: auditEntry.ts,
      };
      await persistControlDirectorSessionEntry({
        sessionStore: params.sessionStore,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
        entry: next,
      });
      return next;
    }
  }
  return params.sessionEntry;
}

async function recordControlDirectorLivenessAudit(
  params: ControlDirectorSessionMutationParams & { audit: ControlDirectorLivenessWatchdogAudit },
): Promise<SessionEntry | undefined> {
  const auditEntry = buildSessionControlDirectorLivenessAuditEntry({
    audit: params.audit,
    runId: params.runId,
  });
  if (params.runId) {
    emitAgentEvent({
      runId: params.runId,
      sessionKey: params.sessionKey ?? params.sessionId,
      stream: "control_director_liveness",
      data: auditEntry,
    });
  }
  if (params.sessionStore && params.sessionKey && params.storePath) {
    const entry = params.sessionStore[params.sessionKey] ?? params.sessionEntry;
    if (entry) {
      const nextAudit = [...(entry.controlDirectorLivenessAudit ?? []), auditEntry].slice(
        -MAX_CONTROL_DIRECTOR_LIVENESS_AUDIT_ENTRIES,
      );
      const next: SessionEntry = {
        ...entry,
        controlDirectorLivenessAudit: nextAudit,
        updatedAt: auditEntry.ts,
      };
      await persistControlDirectorSessionEntry({
        sessionStore: params.sessionStore,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
        entry: next,
      });
      return next;
    }
  }
  return params.sessionEntry;
}

function summarizeControlDirectorRequest(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (normalized.length <= CONTROL_DIRECTOR_REQUEST_SUMMARY_MAX) {
    return normalized;
  }
  return `${normalized.slice(0, CONTROL_DIRECTOR_REQUEST_SUMMARY_MAX - 1)}…`;
}

function collectControlDirectorPayloadText(
  payloads: readonly ControlDirectorGuardablePayload[],
): string {
  return payloads
    .map((payload) => (typeof payload.text === "string" ? payload.text.trim() : ""))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function isControlDirectorNoVisibleOutputClassification(
  classification: string | null | undefined,
): boolean {
  return (
    classification === "empty" ||
    classification === "reasoning-only" ||
    classification === "planning-only"
  );
}

function resolveControlDirectorMissionSeed(params: {
  sessionEntry?: SessionEntry | undefined;
  runId: string;
}): {
  missionId: string;
  continuationCount: number;
  existing?: SessionControlDirectorMissionLedgerEntry;
} {
  const latestQueued = (params.sessionEntry?.controlDirectorMissionLedger ?? [])
    .toReversed()
    .find((entry) => entry.status === "continuation_queued");
  const missionId = latestQueued?.missionId ?? `control-director:${params.runId}`;
  return {
    missionId,
    continuationCount: latestQueued?.continuationCount ?? 0,
    ...(latestQueued ? { existing: latestQueued } : {}),
  };
}

function buildSessionControlDirectorMissionLedgerEntry(params: {
  missionId: string;
  runId?: string | undefined;
  requestSummary: string;
  summary: ControlDirectorMissionSummary;
  continuationCount: number;
  continuationQueued: boolean;
  judgeCompletionApproval?: SessionControlDirectorJudgeCompletionApproval | undefined;
  judgeCompletionGate?: SessionControlDirectorJudgeCompletionGate | undefined;
  truthAudit?: SessionControlDirectorTruthAuditEntry | undefined;
  guardActions: string[];
  watchdogActions: string[];
  continuationQueueId?: string | undefined;
  continuationQueueError?: string | undefined;
  existing?: SessionControlDirectorMissionLedgerEntry | undefined;
  ts?: number;
}): SessionControlDirectorMissionLedgerEntry {
  const ts = params.ts ?? Date.now();
  const status = params.continuationQueued ? "continuation_queued" : params.summary.status;
  return {
    missionId: params.missionId,
    ...(params.runId ? { runId: params.runId } : {}),
    requestSummary: params.requestSummary,
    status,
    startedAt: params.existing?.startedAt ?? ts,
    updatedAt: ts,
    continuationCount: params.continuationCount,
    continuationQueued: params.continuationQueued,
    ...(params.continuationQueueId ? { continuationQueueId: params.continuationQueueId } : {}),
    ...(params.continuationQueueError
      ? { continuationQueueError: params.continuationQueueError }
      : {}),
    finalStatus: params.summary.finalStatus,
    verifiedEvidenceSummary: params.summary.verifiedEvidenceSummary,
    nextBuildGap: params.summary.nextBuildGap,
    ...(params.summary.completionGrade !== undefined
      ? { completionGrade: params.summary.completionGrade }
      : {}),
    ...(params.summary.criticality !== undefined
      ? { criticality: params.summary.criticality }
      : {}),
    ...(params.judgeCompletionApproval
      ? { judgeCompletionApproval: params.judgeCompletionApproval }
      : {}),
    ...(params.judgeCompletionGate ? { judgeCompletionGate: params.judgeCompletionGate } : {}),
    ...(params.truthAudit ? { truthAudit: params.truthAudit } : {}),
    ...(params.guardActions.length > 0 ? { guardActions: params.guardActions } : {}),
    ...(params.watchdogActions.length > 0 ? { watchdogActions: params.watchdogActions } : {}),
  };
}

async function recordControlDirectorMissionLedger(
  params: ControlDirectorSessionMutationParams & {
    missionId: string;
    requestSummary: string;
    summary: ControlDirectorMissionSummary;
    continuationCount: number;
    continuationQueued: boolean;
    judgeCompletionApproval?: SessionControlDirectorJudgeCompletionApproval | undefined;
    judgeCompletionGate?: SessionControlDirectorJudgeCompletionGate | undefined;
    truthAudit?: SessionControlDirectorTruthAuditEntry | undefined;
    guardActions: string[];
    watchdogActions: string[];
    continuationQueueId?: string | undefined;
    continuationQueueError?: string | undefined;
  },
): Promise<SessionEntry | undefined> {
  if (!params.sessionStore || !params.sessionKey || !params.storePath) {
    return params.sessionEntry;
  }
  const entry = params.sessionStore[params.sessionKey] ?? params.sessionEntry;
  if (!entry) {
    return params.sessionEntry;
  }
  const existing = entry.controlDirectorMissionLedger?.find(
    (candidate) => candidate.missionId === params.missionId,
  );
  const ledgerEntry = buildSessionControlDirectorMissionLedgerEntry({
    missionId: params.missionId,
    runId: params.runId,
    requestSummary: params.requestSummary,
    summary: params.summary,
    continuationCount: params.continuationCount,
    continuationQueued: params.continuationQueued,
    judgeCompletionApproval: params.judgeCompletionApproval,
    judgeCompletionGate: params.judgeCompletionGate,
    truthAudit: params.truthAudit,
    guardActions: params.guardActions,
    watchdogActions: params.watchdogActions,
    continuationQueueId: params.continuationQueueId,
    continuationQueueError: params.continuationQueueError,
    existing,
  });
  const nextLedger = [
    ...(entry.controlDirectorMissionLedger ?? []).filter(
      (candidate) => candidate.missionId !== ledgerEntry.missionId,
    ),
    ledgerEntry,
  ].slice(-MAX_CONTROL_DIRECTOR_MISSION_LEDGER_ENTRIES);
  const next: SessionEntry = {
    ...entry,
    controlDirectorMissionLedger: nextLedger,
    ...(params.judgeCompletionApproval
      ? { controlDirectorJudgeCompletionApproval: params.judgeCompletionApproval }
      : {}),
    updatedAt: ledgerEntry.updatedAt,
  };
  await persistControlDirectorSessionEntry({
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    entry: next,
  });
  if (params.runId) {
    emitAgentEvent({
      runId: params.runId,
      sessionKey: params.sessionKey ?? params.sessionId,
      stream: "control_director_mission",
      data: ledgerEntry,
    });
  }
  return next;
}

function toSessionJudgeCompletionApproval(
  approval: ControlDirectorJudgeCompletionApproval | undefined | null,
): SessionControlDirectorJudgeCompletionApproval | undefined {
  if (!approval) {
    return undefined;
  }
  return {
    judgeStatus: approval.judgeStatus,
    ...(approval.judgeVerdict ? { judgeVerdict: approval.judgeVerdict } : {}),
    ...(approval.judgeRunId ? { judgeRunId: approval.judgeRunId } : {}),
    missionId: approval.missionId,
    ...(approval.approvedClaimHash ? { approvedClaimHash: approval.approvedClaimHash } : {}),
    ...(approval.evidenceSummary ? { evidenceSummary: approval.evidenceSummary } : {}),
    ...(approval.scope ? { scope: approval.scope } : {}),
    ...(approval.approvedAt ? { approvedAt: approval.approvedAt } : {}),
    ...(approval.missingAcceptanceCriteria?.length
      ? { missingAcceptanceCriteria: approval.missingAcceptanceCriteria }
      : {}),
  };
}

function toSessionControlDirectorTruthAuditEntry(params: {
  audit: ControlDirectorTruthAudit;
  runId?: string | undefined;
  ts?: number;
}): SessionControlDirectorTruthAuditEntry {
  return {
    ...(params.runId ? { runId: params.runId } : {}),
    ts: params.ts ?? Date.now(),
    status: params.audit.status,
    claims: params.audit.claims.map((claim) => ({
      claim: claim.claim,
      claimHash: claim.claimHash,
      claimType: claim.claimType,
      requiredEvidenceType: claim.requiredEvidenceType,
      ...(claim.evidenceId ? { evidenceId: claim.evidenceId } : {}),
      ...(claim.evidenceSource ? { evidenceSource: claim.evidenceSource } : {}),
      matchStatus: claim.matchStatus,
      ...(claim.missingCondition ? { missingCondition: claim.missingCondition } : {}),
      ...(claim.rewriteAction ? { rewriteAction: claim.rewriteAction } : {}),
    })),
    missing: params.audit.missing,
    payloadsChecked: params.audit.payloadsChecked,
    payloadsRewritten: params.audit.payloadsRewritten,
  };
}

async function recordControlDirectorTruthAudit(
  params: ControlDirectorSessionMutationParams & { audit: ControlDirectorTruthAudit },
): Promise<{
  sessionEntry?: SessionEntry | undefined;
  auditEntry: SessionControlDirectorTruthAuditEntry;
}> {
  const auditEntry = toSessionControlDirectorTruthAuditEntry({
    audit: params.audit,
    runId: params.runId,
  });
  if (params.runId) {
    emitAgentEvent({
      runId: params.runId,
      sessionKey: params.sessionKey ?? params.sessionId,
      stream: "control_director_truth",
      data: auditEntry,
    });
  }
  if (params.sessionStore && params.sessionKey && params.storePath) {
    const entry = params.sessionStore[params.sessionKey] ?? params.sessionEntry;
    if (entry) {
      const nextAudit = [...(entry.controlDirectorTruthAudit ?? []), auditEntry].slice(
        -MAX_CONTROL_DIRECTOR_TRUTH_AUDIT_ENTRIES,
      );
      const next: SessionEntry = {
        ...entry,
        controlDirectorTruthAudit: nextAudit,
        updatedAt: auditEntry.ts,
      };
      await persistControlDirectorSessionEntry({
        sessionStore: params.sessionStore,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
        entry: next,
      });
      return { sessionEntry: next, auditEntry };
    }
  }
  return { sessionEntry: params.sessionEntry, auditEntry };
}

function resolveControlDirectorJudgeCompletionApproval(params: {
  explicit?: ControlDirectorJudgeCompletionApproval | undefined;
  sessionEntry?: SessionEntry | undefined;
  missionSeed?: { existing?: SessionControlDirectorMissionLedgerEntry | undefined } | undefined;
  missionId: string;
}): ControlDirectorJudgeCompletionApproval | undefined {
  const candidates = [
    params.explicit,
    params.sessionEntry?.controlDirectorJudgeCompletionApproval,
    params.missionSeed?.existing?.judgeCompletionApproval,
  ];
  return candidates.find((candidate): candidate is ControlDirectorJudgeCompletionApproval =>
    Boolean(candidate && candidate.missionId === params.missionId),
  );
}

function summarizeJudgeCompletionGate(params: {
  gate: ControlDirectorJudgeCompletionGateResult<ControlDirectorGuardablePayload>;
  originalComplete: boolean;
}): SessionControlDirectorJudgeCompletionGate {
  if (!params.originalComplete) {
    return {
      status: "not_required",
      reason: "Final Control Director status was not complete.",
    };
  }
  if (!params.gate.audit) {
    return {
      status: "approved",
      reason: "Judge approved this exact mission completion claim.",
      ...(params.gate.expectedClaimHash
        ? { expectedClaimHash: params.gate.expectedClaimHash }
        : {}),
      ...(params.gate.approval?.judgeRunId ? { judgeRunId: params.gate.approval.judgeRunId } : {}),
    };
  }
  return {
    status: "blocked",
    reason: "Judge approval is missing or invalid for this exact mission completion claim.",
    ...(params.gate.expectedClaimHash ? { expectedClaimHash: params.gate.expectedClaimHash } : {}),
    ...(params.gate.approval?.judgeRunId ? { judgeRunId: params.gate.approval.judgeRunId } : {}),
    missing: params.gate.audit.missing,
  };
}

type ControlDirectorContinuationQueueResult = {
  queued: boolean;
  queueId?: string;
  error?: string;
};

function buildControlDirectorContinuationQueueFailureText(params: {
  reason: string;
  queueError: string;
}): string {
  return [
    "Control Director recovery supervisor could not start a safe continuation.",
    "",
    "Verified state: liveness recovery was required, but the recovery queue did not accept the continuation.",
    `Missing evidence: durable recovery queue accepted and woke the continuation. Queue error: ${params.queueError}`,
    `Next build gap: repair the recovery queue path, then retry the Control Director mission. Original liveness reason: ${params.reason}.`,
    "Completion Grade: 7/10",
    "Criticality: 10/10",
    "Status: blocked",
  ].join("\n");
}

function replaceFirstControlDirectorPayloadText<T extends ControlDirectorGuardablePayload>(
  payloads: readonly T[],
  text: string,
): T[] {
  if (payloads.length === 0) {
    return [{ text } as T];
  }
  return payloads.map((payload, index) => (index === 0 ? { ...payload, text } : payload));
}

async function queueControlDirectorContinuation(params: {
  decision: ControlDirectorContinuationDecision;
  sessionKey?: string | undefined;
  sessionAgentId: string;
  missionId: string;
}): Promise<ControlDirectorContinuationQueueResult> {
  if (!params.decision.shouldQueue || !params.decision.prompt || !params.sessionKey) {
    return {
      queued: false,
      error: !params.sessionKey
        ? "session key unavailable"
        : !params.decision.prompt
          ? "continuation prompt unavailable"
          : "continuation decision did not request queueing",
    };
  }
  const idempotencyKey = `${params.missionId}:control-director-recovery:${params.decision.nextContinuationCount}`;
  let queueId: string;
  try {
    queueId = await enqueueSessionDelivery({
      kind: "systemEvent",
      sessionKey: params.sessionKey,
      text: params.decision.prompt,
      idempotencyKey,
      maxRetries: 5,
    });
  } catch (err) {
    return {
      queued: false,
      error: `durable session delivery enqueue failed: ${formatErrorMessage(err)}`,
    };
  }
  const queued = enqueueSystemEvent(params.decision.prompt, {
    sessionKey: params.sessionKey,
    contextKey: `${params.missionId}:continuation:${params.decision.nextContinuationCount}`,
  });
  if (!queued) {
    return {
      queued: false,
      queueId,
      error: `durable queue entry ${queueId} was written, but the in-memory recovery event queue rejected the immediate continuation`,
    };
  }
  requestHeartbeat({
    source: "other",
    intent: "immediate",
    reason: "control-director-continuation",
    agentId: params.sessionAgentId,
    sessionKey: params.sessionKey,
  });
  return { queued: true, queueId };
}

export async function applyControlDirectorDeliveryGuards<T extends ControlDirectorGuardablePayload>(
  params: ControlDirectorSessionMutationParams & {
    agentId?: string | null | undefined;
    provider?: string | null | undefined;
    model?: string | null | undefined;
    controlDirectorScope?: boolean | undefined;
    payloads: readonly T[] | undefined;
    requestBody: string;
    finalAssistantVisibleText?: string | undefined;
    classification?: string | null | undefined;
    canQueueContinuation?: boolean | undefined;
    needsUserInput?: boolean | undefined;
    approvalPending?: boolean | undefined;
    externalAbort?: boolean | undefined;
    safeToContinue?: boolean | undefined;
    queueContinuation?: boolean | undefined;
    judgeCompletionApproval?: ControlDirectorJudgeCompletionApproval | undefined;
    truthEvidence?: readonly ControlDirectorClaimEvidence[] | undefined;
    implementationSha?: string | undefined;
  },
): Promise<ControlDirectorDeliveryGuardResult<T>> {
  const agentId = params.agentId ?? undefined;
  const activeControlDirectorScope = isControlDirectorDeliveryScope({
    agentId,
    model: params.model,
    explicit: params.controlDirectorScope,
    hasRuntimeEvidence: Boolean(params.truthEvidence?.length),
    hasJudgeApproval: Boolean(params.judgeCompletionApproval),
    finalText:
      params.finalAssistantVisibleText ?? collectControlDirectorPayloadText(params.payloads ?? []),
  });
  let sessionEntry = params.sessionEntry;
  if (!activeControlDirectorScope) {
    const payloads = [...(params.payloads ?? [])];
    return {
      payloads,
      sessionEntry,
      finalPayloadText: collectControlDirectorPayloadText(payloads),
      continuation: buildNoopControlDirectorContinuation(),
      continuationQueued: false,
      guardActions: [],
      watchdogActions: [],
    };
  }
  const runId = params.runId ?? params.sessionId;
  const missionSeed = resolveControlDirectorMissionSeed({ sessionEntry, runId });
  const shouldApplyLivenessBeforeFinalGuard = isControlDirectorNoVisibleOutputClassification(
    params.classification,
  );

  let controlDirectorGuardedFinalOutput: ControlDirectorFinalOutputGuardResult<T>;
  let livenessGuardedFinalOutput: ControlDirectorLivenessWatchdogResult<T>;

  if (shouldApplyLivenessBeforeFinalGuard) {
    livenessGuardedFinalOutput = applyControlDirectorLivenessWatchdog({
      agentId,
      payloads: params.payloads,
      finalAssistantVisibleText: params.finalAssistantVisibleText,
      classification: params.classification,
      continuationCount: missionSeed.continuationCount,
      missionId: missionSeed.missionId,
      requestBody: params.requestBody,
      canQueueContinuation: params.canQueueContinuation,
      needsUserInput: params.needsUserInput,
      approvalPending: params.approvalPending,
      externalAbort: params.externalAbort,
      safeToContinue: params.safeToContinue,
    });
    controlDirectorGuardedFinalOutput = applyControlDirectorFinalOutputGuard({
      agentId,
      payloads: livenessGuardedFinalOutput.payloads,
    });
    if (controlDirectorGuardedFinalOutput.audit) {
      sessionEntry =
        (await recordControlDirectorGuardAudit({
          audit: controlDirectorGuardedFinalOutput.audit,
          runId: params.runId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          sessionEntry,
          sessionStore: params.sessionStore,
          storePath: params.storePath,
        })) ?? sessionEntry;
    }
  } else {
    controlDirectorGuardedFinalOutput = applyControlDirectorFinalOutputGuard({
      agentId,
      payloads: params.payloads,
    });
    if (controlDirectorGuardedFinalOutput.audit) {
      sessionEntry =
        (await recordControlDirectorGuardAudit({
          audit: controlDirectorGuardedFinalOutput.audit,
          runId: params.runId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          sessionEntry,
          sessionStore: params.sessionStore,
          storePath: params.storePath,
        })) ?? sessionEntry;
    }

    livenessGuardedFinalOutput = applyControlDirectorLivenessWatchdog({
      agentId,
      payloads: controlDirectorGuardedFinalOutput.payloads,
      finalAssistantVisibleText: params.finalAssistantVisibleText,
      classification: params.classification,
      continuationCount: missionSeed.continuationCount,
      missionId: missionSeed.missionId,
      requestBody: params.requestBody,
      canQueueContinuation: params.canQueueContinuation,
      needsUserInput: params.needsUserInput,
      approvalPending: params.approvalPending,
      externalAbort: params.externalAbort,
      safeToContinue: params.safeToContinue,
    });
  }

  let finalPayloads = shouldApplyLivenessBeforeFinalGuard
    ? controlDirectorGuardedFinalOutput.payloads
    : livenessGuardedFinalOutput.payloads;
  const judgeApproval = resolveControlDirectorJudgeCompletionApproval({
    explicit: params.judgeCompletionApproval,
    sessionEntry,
    missionSeed,
    missionId: missionSeed.missionId,
  });
  const finalPayloadTextBeforeJudge = collectControlDirectorPayloadText(finalPayloads);
  const originalCompleteBeforeJudge =
    summarizeControlDirectorMissionFinalText(finalPayloadTextBeforeJudge).finalStatus ===
    "complete";
  const judgeCompletionGate = applyControlDirectorJudgeCompletionGate({
    agentId,
    payloads: finalPayloads,
    missionId: missionSeed.missionId,
    requestBody: params.requestBody,
    approval: judgeApproval,
  });
  finalPayloads = judgeCompletionGate.payloads;
  if (judgeCompletionGate.audit) {
    sessionEntry =
      (await recordControlDirectorGuardAudit({
        audit: judgeCompletionGate.audit,
        runId: params.runId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sessionEntry,
        sessionStore: params.sessionStore,
        storePath: params.storePath,
      })) ?? sessionEntry;
  }
  const implementationSha =
    params.implementationSha ?? process.env.GITHUB_SHA ?? process.env.GITHUB_COMMIT_SHA;
  const truthEvidence: ControlDirectorClaimEvidence[] = loadControlDirectorTruthEvidence({
    sessionEntry,
    runId,
    implementationSha,
    extraEvidence: params.truthEvidence,
  });
  if (judgeCompletionGate.approval && !judgeCompletionGate.audit) {
    truthEvidence.push({
      type: "judge_approval",
      id: judgeCompletionGate.approval.judgeRunId ?? "judge-approval",
      source: "control-director-judge-completion-gate",
      summary: judgeCompletionGate.approval.evidenceSummary ?? "Judge approved completion claim.",
      status: "passed",
    });
  }
  const truthGate = applyControlDirectorTruthGate({
    agentId,
    payloads: finalPayloads,
    evidence: truthEvidence,
    implementationSha,
  });
  finalPayloads = truthGate.payloads;
  let sessionTruthAudit: SessionControlDirectorTruthAuditEntry | undefined;
  if (truthGate.audit) {
    const recorded = await recordControlDirectorTruthAudit({
      audit: truthGate.audit,
      runId: params.runId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionEntry,
      sessionStore: params.sessionStore,
      storePath: params.storePath,
    });
    sessionEntry = recorded.sessionEntry ?? sessionEntry;
    sessionTruthAudit = recorded.auditEntry;
  }
  let continuationQueueResult: ControlDirectorContinuationQueueResult = { queued: false };
  if (livenessGuardedFinalOutput.continuation.shouldQueue) {
    continuationQueueResult =
      params.queueContinuation === false || !agentId
        ? {
            queued: false,
            error:
              params.queueContinuation === false
                ? "continuation queue disabled"
                : "agent id missing",
          }
        : await queueControlDirectorContinuation({
            decision: livenessGuardedFinalOutput.continuation,
            sessionKey: params.sessionKey,
            sessionAgentId: agentId,
            missionId: missionSeed.missionId,
          });
  }
  const continuationQueued = continuationQueueResult.queued;
  if (
    livenessGuardedFinalOutput.continuation.shouldQueue &&
    !continuationQueued &&
    continuationQueueResult.error
  ) {
    finalPayloads = replaceFirstControlDirectorPayloadText(
      finalPayloads,
      buildControlDirectorContinuationQueueFailureText({
        reason: livenessGuardedFinalOutput.continuation.reason,
        queueError: continuationQueueResult.error,
      }),
    );
  }
  if (livenessGuardedFinalOutput.audit) {
    const livenessAudit: ControlDirectorLivenessWatchdogAudit = {
      ...livenessGuardedFinalOutput.audit,
      ...(livenessGuardedFinalOutput.continuation.shouldQueue && !continuationQueued
        ? {
            action: "blocked_continuation_queue_failed",
            nextStatus: "blocked",
          }
        : {}),
      continuationQueued,
      ...(continuationQueueResult.queueId
        ? { continuationQueueId: continuationQueueResult.queueId }
        : {}),
      ...(continuationQueueResult.error
        ? { continuationQueueError: continuationQueueResult.error }
        : {}),
    };
    sessionEntry =
      (await recordControlDirectorLivenessAudit({
        audit: livenessAudit,
        runId: params.runId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sessionEntry,
        sessionStore: params.sessionStore,
        storePath: params.storePath,
      })) ?? sessionEntry;
  }
  const finalPayloadText = collectControlDirectorPayloadText(finalPayloads);
  const guardActions = [
    ...(controlDirectorGuardedFinalOutput.audit
      ? [controlDirectorGuardedFinalOutput.audit.action]
      : []),
    ...(judgeCompletionGate.audit ? [judgeCompletionGate.audit.action] : []),
  ];
  const watchdogActions = livenessGuardedFinalOutput.audit
    ? [
        `${
          livenessGuardedFinalOutput.continuation.shouldQueue && !continuationQueued
            ? "blocked_continuation_queue_failed"
            : livenessGuardedFinalOutput.audit.action
        }${continuationQueued ? ":queued" : ""}`,
      ]
    : [];
  const judgeGateSummary =
    isControlDirectorAgentId(agentId) && finalPayloadText
      ? summarizeJudgeCompletionGate({
          gate: judgeCompletionGate,
          originalComplete: originalCompleteBeforeJudge,
        })
      : undefined;
  if (isControlDirectorAgentId(agentId) && finalPayloadText) {
    sessionEntry =
      (await recordControlDirectorMissionLedger({
        missionId: missionSeed.missionId,
        runId: params.runId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sessionEntry,
        sessionStore: params.sessionStore,
        storePath: params.storePath,
        requestSummary: summarizeControlDirectorRequest(params.requestBody),
        summary: summarizeControlDirectorMissionFinalText(finalPayloadText),
        continuationCount: livenessGuardedFinalOutput.continuation.shouldQueue
          ? continuationQueued
            ? livenessGuardedFinalOutput.continuation.nextContinuationCount
            : missionSeed.continuationCount
          : missionSeed.continuationCount,
        continuationQueued,
        continuationQueueId: continuationQueueResult.queueId,
        continuationQueueError: continuationQueueResult.error,
        judgeCompletionApproval: toSessionJudgeCompletionApproval(judgeCompletionGate.approval),
        judgeCompletionGate: judgeGateSummary,
        truthAudit: sessionTruthAudit,
        guardActions,
        watchdogActions,
      })) ?? sessionEntry;
  }

  return {
    payloads: finalPayloads,
    sessionEntry,
    finalPayloadText,
    continuation: livenessGuardedFinalOutput.continuation,
    continuationQueued,
    ...(continuationQueueResult.queueId
      ? { continuationQueueId: continuationQueueResult.queueId }
      : {}),
    ...(continuationQueueResult.error
      ? { continuationQueueError: continuationQueueResult.error }
      : {}),
    guardActions,
    watchdogActions,
    ...(judgeGateSummary ? { judgeCompletionGate: judgeGateSummary } : {}),
    ...(sessionTruthAudit ? { truthAudit: sessionTruthAudit } : {}),
  };
}
