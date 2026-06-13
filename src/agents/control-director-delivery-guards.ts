import type {
  SessionControlDirectorGuardAuditEntry,
  SessionControlDirectorLivenessAuditEntry,
  SessionControlDirectorMissionLedgerEntry,
  SessionEntry,
} from "../config/sessions/types.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { requestHeartbeat } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { persistSessionEntry as persistSessionEntryBase } from "./command/attempt-execution.shared.js";
import {
  applyControlDirectorFinalOutputGuard,
  applyControlDirectorLivenessWatchdog,
  isControlDirectorAgentId,
  summarizeControlDirectorMissionFinalText,
  type ControlDirectorContinuationDecision,
  type ControlDirectorFinalOutputGuardAudit,
  type ControlDirectorFinalOutputGuardResult,
  type ControlDirectorGuardablePayload,
  type ControlDirectorLivenessWatchdogAudit,
  type ControlDirectorLivenessWatchdogResult,
  type ControlDirectorMissionSummary,
} from "./control-director-contract.js";

const MAX_CONTROL_DIRECTOR_GUARD_AUDIT_ENTRIES = 20;
const MAX_CONTROL_DIRECTOR_LIVENESS_AUDIT_ENTRIES = 20;
const MAX_CONTROL_DIRECTOR_MISSION_LEDGER_ENTRIES = 20;
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
  guardActions: string[];
  watchdogActions: string[];
};

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
  guardActions: string[];
  watchdogActions: string[];
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
    finalStatus: params.summary.finalStatus,
    verifiedEvidenceSummary: params.summary.verifiedEvidenceSummary,
    nextBuildGap: params.summary.nextBuildGap,
    ...(params.summary.completionGrade !== undefined
      ? { completionGrade: params.summary.completionGrade }
      : {}),
    ...(params.summary.criticality !== undefined
      ? { criticality: params.summary.criticality }
      : {}),
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
    guardActions: string[];
    watchdogActions: string[];
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
    guardActions: params.guardActions,
    watchdogActions: params.watchdogActions,
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

function queueControlDirectorContinuation(params: {
  decision: ControlDirectorContinuationDecision;
  sessionKey?: string | undefined;
  sessionAgentId: string;
  missionId: string;
}): boolean {
  if (!params.decision.shouldQueue || !params.decision.prompt || !params.sessionKey) {
    return false;
  }
  const queued = enqueueSystemEvent(params.decision.prompt, {
    sessionKey: params.sessionKey,
    contextKey: `${params.missionId}:continuation:${params.decision.nextContinuationCount}`,
    trusted: true,
  });
  requestHeartbeat({
    source: "other",
    intent: "immediate",
    reason: "control-director-continuation",
    agentId: params.sessionAgentId,
    sessionKey: params.sessionKey,
  });
  return queued;
}

export async function applyControlDirectorDeliveryGuards<T extends ControlDirectorGuardablePayload>(
  params: ControlDirectorSessionMutationParams & {
    agentId?: string | null | undefined;
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
  },
): Promise<ControlDirectorDeliveryGuardResult<T>> {
  const agentId = params.agentId ?? undefined;
  let sessionEntry = params.sessionEntry;
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
      canQueueContinuation: params.canQueueContinuation,
      needsUserInput: params.needsUserInput,
      approvalPending: params.approvalPending,
      externalAbort: params.externalAbort,
      safeToContinue: params.safeToContinue,
    });
    if (livenessGuardedFinalOutput.audit) {
      sessionEntry =
        (await recordControlDirectorLivenessAudit({
          audit: livenessGuardedFinalOutput.audit,
          runId: params.runId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          sessionEntry,
          sessionStore: params.sessionStore,
          storePath: params.storePath,
        })) ?? sessionEntry;
    }

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
      canQueueContinuation: params.canQueueContinuation,
      needsUserInput: params.needsUserInput,
      approvalPending: params.approvalPending,
      externalAbort: params.externalAbort,
      safeToContinue: params.safeToContinue,
    });
    if (livenessGuardedFinalOutput.audit) {
      sessionEntry =
        (await recordControlDirectorLivenessAudit({
          audit: livenessGuardedFinalOutput.audit,
          runId: params.runId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          sessionEntry,
          sessionStore: params.sessionStore,
          storePath: params.storePath,
        })) ?? sessionEntry;
    }
  }

  const finalPayloads = shouldApplyLivenessBeforeFinalGuard
    ? controlDirectorGuardedFinalOutput.payloads
    : livenessGuardedFinalOutput.payloads;
  const continuationQueued =
    params.queueContinuation === false || !agentId
      ? false
      : queueControlDirectorContinuation({
          decision: livenessGuardedFinalOutput.continuation,
          sessionKey: params.sessionKey,
          sessionAgentId: agentId,
          missionId: missionSeed.missionId,
        });
  const finalPayloadText = collectControlDirectorPayloadText(finalPayloads);
  const guardActions = controlDirectorGuardedFinalOutput.audit
    ? [controlDirectorGuardedFinalOutput.audit.action]
    : [];
  const watchdogActions = livenessGuardedFinalOutput.audit
    ? [`${livenessGuardedFinalOutput.audit.action}${continuationQueued ? ":queued" : ""}`]
    : [];
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
          ? livenessGuardedFinalOutput.continuation.nextContinuationCount
          : missionSeed.continuationCount,
        continuationQueued: livenessGuardedFinalOutput.continuation.shouldQueue,
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
    guardActions,
    watchdogActions,
  };
}
