import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  type InternalSessionEntry as SessionEntry,
  resolveSessionWorkStartError,
} from "../../config/sessions.js";
import { buildRestartRecoveryClaimCleanupPatch } from "../../config/sessions/restart-recovery-state.js";
import {
  listSessionEntriesByStatus,
  loadExactSessionEntry,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { readSessionMessagesAsync } from "../../gateway/session-transcript-readers.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { findDeliveryIntentOwners } from "../../infra/outbound/delivery-queue-storage.js";
import {
  getOwedHarnessCompletionTask,
  readAdmittedHarnessCompletionInput,
} from "../../tasks/agent-harness-completion-recovery.js";
import { resolveExecDefaults } from "../exec-defaults.js";
import type { MainSessionRecoveryAdmission } from "./main-session-recovery-admission.js";
import type { MainSessionRecoveryCapacity } from "./main-session-recovery-capacity.js";
import { createCurrentProcessOwnerLookup } from "./main-session-recovery-live-owners.js";
import {
  getMainSessionRecoveryRetryCount,
  isMainRestartRecoveryAggregateTerminalOnly,
  isMainRestartRecoveryCandidate,
} from "./main-session-recovery-state.js";
import {
  commitMainSessionRecovery,
  type MainSessionRecoveryStoreTarget,
} from "./main-session-recovery-store.js";
import {
  hasRestartRecoveryMessageActionAuthority,
  requiresRestartRecoveryMessageActionAuthority,
  resumeMainSession,
} from "./main-session-restart-dispatch.js";
import {
  markSessionCompletedAfterRecoveryCheckpoint,
  reconcileInvalidHarnessCompletion,
} from "./main-session-restart-recovery-checkpoint.js";
import { tombstoneMainRestartRecoveryWithNotice } from "./main-session-restart-recovery-failure.js";
import { readMainSessionRecoveryCheckpoint } from "./main-session-restart-recovery-replay-safety.js";
import {
  hasReplaySafeCodeModeCheckpointInCurrentTurn,
  resolveMainSessionResumePolicy,
} from "./main-session-restart-recovery-resume-policy.js";
import {
  type ExhaustedRestartRecoveryTarget,
  type ExpectedRestartRecoveryTarget,
  mainSessionRecoveryLog,
  MAX_RECOVERY_RETRIES,
  resolveRestartRecoveryTerminalClientRunId,
} from "./main-session-restart-recovery-shared.js";
import { resolveRestartRecoveryDispatchTarget } from "./main-session-restart-recovery-target.js";

async function pendingFinalRecoveryAction(
  pending: NonNullable<SessionEntry["pendingFinalDelivery"]>,
  stateDir?: string,
): Promise<"complete" | "defer" | "fail" | "notice" | "retry"> {
  const deliveries = pending.deliveries;
  if (!deliveries?.length) {
    return "fail";
  }
  if (deliveries.every(({ state }) => state === "delivered" || state === "suppressed")) {
    return "complete";
  }
  const owners = await findDeliveryIntentOwners(
    deliveries.map(({ id }) => id),
    stateDir,
  );
  if (owners.some((owner) => owner?.status === "pending" || owner?.settlementPending)) {
    return "defer";
  }
  if (
    pending.kind === "replayable" &&
    deliveries.every(({ state }) => state === "prepared") &&
    owners.every((owner) => owner === null)
  ) {
    return "retry";
  }
  // Residual ambiguity (unknown custody, settled owners, unreplayable mixes):
  // complete the session and record durable notice debt instead of failing it.
  // A fire-and-forget failure notice is lost during the very outage that made
  // the outcome ambiguous; the debt survives until the next same-route turn.
  // Records without notice identity cannot carry debt, so they keep the
  // visible fail path instead of completing silently.
  return pending.context && pending.intentId ? "notice" : "fail";
}

async function completePendingFinalRecoveryWithNotice(
  entry: SessionEntry,
  target: MainSessionRecoveryStoreTarget,
): Promise<boolean> {
  const endedAt = Date.now();
  let completed = false;
  await updateSessionEntry(
    target,
    (current) => {
      if (
        current.sessionId !== entry.sessionId ||
        current.pendingFinalDelivery?.intentId !== entry.pendingFinalDelivery?.intentId
      ) {
        return null;
      }
      const pending = current.pendingFinalDelivery;
      completed = true;
      return {
        ...buildRestartRecoveryClaimCleanupPatch({
          entry: current,
          recordTerminalSource: true,
        }),
        abortedLastRun: false,
        endedAt,
        lifecycleRunId: undefined,
        lastRunId: resolveRestartRecoveryTerminalClientRunId(current),
        pendingFinalDelivery: undefined,
        ...(pending?.context &&
        pending.intentId &&
        current.pendingDeliveryNotice?.intentId !== pending.intentId &&
        (!current.pendingDeliveryNotice ||
          current.pendingDeliveryNotice.createdAt <= pending.createdAt)
          ? {
              pendingDeliveryNotice: {
                createdAt: pending.createdAt,
                context: pending.context,
                intentId: pending.intentId,
                state: "owed" as const,
              },
            }
          : {}),
        restartRecoveryRuns: undefined,
        runtimeMs:
          typeof current.startedAt === "number"
            ? Math.max(0, endedAt - current.startedAt)
            : undefined,
        status: "done" as const,
        updatedAt: endedAt,
      };
    },
    { skipMaintenance: true, takeCacheOwnership: true },
  );
  return completed;
}

export function loadExpectedRestartRecoveryTarget(params: {
  expected: ExpectedRestartRecoveryTarget;
  storePath: string;
}): SessionEntry | undefined {
  const exact = loadExactSessionEntry({
    ...params.expected,
    storePath: params.storePath,
    readConsistency: "latest",
  });
  const entry = exact?.sessionKey === params.expected.sessionKey ? exact.entry : undefined;
  return entry?.sessionId === params.expected.sessionId &&
    entry.status === "running" &&
    entry.abortedLastRun === true &&
    (params.expected.claim
      ? normalizeOptionalString(entry.restartRecoveryDeliveryRunId) ===
          params.expected.claim.runId &&
        normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId) ===
          params.expected.claim.sourceRunId
      : isMainRestartRecoveryCandidate(entry, params.expected.sessionKey))
    ? entry
    : undefined;
}

export async function recoverStore(params: {
  storeAgentId?: string;
  cfg?: OpenClawConfig;
  observationOnly?: boolean;
  onExhaustedTarget?: (target: ExhaustedRestartRecoveryTarget) => void;
  storePath: string;
  stateDir?: string;
  handledSessionKeys: Set<string>;
  expectedTarget?: ExpectedRestartRecoveryTarget;
  recoveryAdmission?: MainSessionRecoveryAdmission;
  activeSessionIds?: Iterable<string>;
  activeSessionKeys?: Iterable<string>;
  lifecycleGeneration?: string;
  recoveryCapacity?: MainSessionRecoveryCapacity;
  shouldContinue?: () => boolean;
  gatewayRuntime: GatewayRecoveryRuntime;
}): Promise<{ started: number; settled: number; failed: number; skipped: number }> {
  const result = { started: 0, settled: 0, failed: 0, skipped: 0 };
  const shouldContinue = () => params.shouldContinue?.() !== false;
  const stopped = () => {
    if (shouldContinue()) {
      return false;
    }
    result.skipped++;
    return true;
  };
  const hasCurrentProcessOwner = createCurrentProcessOwnerLookup(params);
  let entries: Array<{ sessionKey: string; entry: SessionEntry }>;
  try {
    if (params.expectedTarget) {
      const entry = loadExpectedRestartRecoveryTarget({
        expected: params.expectedTarget,
        storePath: params.storePath,
      });
      entries = entry ? [{ sessionKey: params.expectedTarget.sessionKey, entry }] : [];
    } else {
      entries = listSessionEntriesByStatus(
        { agentId: params.storeAgentId, storePath: params.storePath },
        ["running"],
      );
    }
  } catch (err) {
    mainSessionRecoveryLog.warn(`failed to load session store ${params.storePath}: ${String(err)}`);
    result.failed++;
    return result;
  }

  for (const { sessionKey, entry: loadedEntry } of entries.toSorted((a, b) =>
    a.sessionKey.localeCompare(b.sessionKey),
  )) {
    if (stopped()) {
      return result;
    }
    let entry = loadedEntry;
    const hasRecoveryStateToObserve =
      entry?.abortedLastRun === true ||
      (entry !== undefined && isMainRestartRecoveryAggregateTerminalOnly(entry));
    if (!entry || entry.status !== "running" || !hasRecoveryStateToObserve) {
      continue;
    }
    if (!isMainRestartRecoveryCandidate(entry, sessionKey)) {
      result.skipped++;
      continue;
    }
    if (resolveSessionWorkStartError(sessionKey, entry)) {
      result.skipped++;
      continue;
    }
    const dispatchTarget = resolveRestartRecoveryDispatchTarget({
      agentId: params.expectedTarget?.agentId,
      storeAgentId: params.storeAgentId,
      cfg: params.cfg,
      sessionKey,
      storePath: params.storePath,
    });
    if (!dispatchTarget) {
      result.skipped++;
      continue;
    }
    const agentId = dispatchTarget.agentId;
    const target = { agentId, sessionKey, storePath: params.storePath };
    const dispatchSessionKey =
      params.expectedTarget?.canonicalSessionKey ?? dispatchTarget.sessionKey;
    if (hasCurrentProcessOwner(entry, sessionKey)) {
      result.skipped++;
      continue;
    }
    const resumeDedupeKey = JSON.stringify([agentId, dispatchSessionKey]);
    if (params.handledSessionKeys.has(resumeDedupeKey)) {
      result.skipped++;
      continue;
    }

    if (stopped()) {
      return result;
    }
    const observed = await commitMainSessionRecovery({
      command: {
        kind: "observe",
        cycleId: randomUUID(),
        lifecycleGeneration: params.lifecycleGeneration ?? getAgentEventLifecycleGeneration(),
        sessionKey,
      },
      requireWriteSuccess: true,
      shouldContinue: params.shouldContinue,
      target,
    });
    if (!observed.entry || observed.transition.kind !== "observed") {
      result.skipped++;
      continue;
    }
    if (stopped()) {
      return result;
    }
    entry = observed.entry;
    const recoveryView = observed.transition.view;
    if (
      recoveryView.status === "inactive" ||
      recoveryView.status === "blocked" ||
      recoveryView.status === "tombstoned"
    ) {
      result.skipped++;
      continue;
    }
    if (
      recoveryView.status === "exhausted" ||
      (!params.observationOnly &&
        requiresRestartRecoveryMessageActionAuthority(entry) &&
        !hasRestartRecoveryMessageActionAuthority(entry))
    ) {
      if (stopped()) {
        return result;
      }
      const tombstone = await tombstoneMainRestartRecoveryWithNotice({
        ...target,
        cfg: params.cfg,
        entry,
        gatewayRuntime: params.gatewayRuntime,
        observation: recoveryView.observation,
        reason:
          recoveryView.status === "exhausted"
            ? recoveryView.reason
            : "message-tool-only recovery authority is unavailable",
      });
      if (tombstone === "notice_failed") {
        result.failed++;
      } else {
        result.skipped++;
      }
      continue;
    }
    if (params.observationOnly) {
      result.skipped++;
      continue;
    }
    const recordResumeResult = (resumeResult: Awaited<ReturnType<typeof resumeMainSession>>) => {
      if (resumeResult === "started") {
        params.handledSessionKeys.add(resumeDedupeKey);
        result.started++;
      } else if (resumeResult === "settled") {
        params.handledSessionKeys.add(resumeDedupeKey);
        result.settled++;
      } else if (resumeResult === "skipped") {
        result.skipped++;
      } else {
        result.failed++;
        const current = loadExpectedRestartRecoveryTarget({
          expected: { agentId, sessionId: entry.sessionId, sessionKey },
          storePath: params.storePath,
        });
        if (
          getMainSessionRecoveryRetryCount(current?.mainRestartRecovery) === MAX_RECOVERY_RETRIES &&
          !current?.mainRestartRecovery?.reservation
        ) {
          params.onExhaustedTarget?.({
            ...target,
            canonicalSessionKey: dispatchSessionKey,
            sessionId: entry.sessionId,
          });
        }
      }
    };

    const expectedRecoverySourceRunId = normalizeOptionalString(
      entry.restartRecoveryDeliverySourceRunId,
    );
    const resumeCurrent = async (
      options: Pick<
        Parameters<typeof resumeMainSession>[0],
        "forceCodeModeTools" | "forceRestartSafeTools" | "pendingFinalDeliveryText"
      > = {},
    ) => {
      if (stopped()) {
        return false;
      }
      recordResumeResult(
        await resumeMainSession({
          ...target,
          canonicalSessionKey: dispatchSessionKey,
          cfg: params.cfg,
          entry,
          observation: recoveryView.observation,
          recoveryAttempt: recoveryView.nextAttempt,
          recoveryAdmission: params.recoveryAdmission,
          gatewayRuntime: params.gatewayRuntime,
          ...options,
          lifecycleGeneration: params.lifecycleGeneration,
          recoveryCapacity: params.recoveryCapacity,
          shouldContinue: params.shouldContinue,
        }),
      );
      return true;
    };

    const pendingAction = entry.pendingFinalDelivery
      ? await pendingFinalRecoveryAction(entry.pendingFinalDelivery, params.stateDir)
      : undefined;
    if (stopped()) {
      return result;
    }
    if (pendingAction === "defer") {
      // The exact durable queue owner is still responsible for settlement.
      // Dispatching a second recovery turn would duplicate that delivery.
      result.skipped++;
      continue;
    }
    if (pendingAction === "complete") {
      const completion = await markSessionCompletedAfterRecoveryCheckpoint({
        ...target,
        entry,
        messages: [],
        pendingFinalDeliveryIntentId: entry.pendingFinalDelivery?.intentId,
        reason: "delivered-terminal-receipt",
      });
      if (completion.outcome === "completed") {
        params.handledSessionKeys.add(resumeDedupeKey);
        result.settled++;
      } else {
        result.skipped++;
      }
      continue;
    }
    if (pendingAction === "notice") {
      const completed = await completePendingFinalRecoveryWithNotice(entry, target);
      result[completed ? "settled" : "skipped"]++;
      continue;
    }
    const harnessCompletion = entry.restartRecoveryHarnessCompletion;
    let recoverableHarnessCompletion: boolean;
    try {
      recoverableHarnessCompletion = Boolean(
        harnessCompletion &&
        harnessCompletion.requesterSessionKey === sessionKey &&
        harnessCompletion.requesterAgentId === agentId &&
        harnessCompletion.sourceRunId === entry.restartRecoveryDeliverySourceRunId &&
        Boolean(entry.restartRecoveryDeliveryRunId) &&
        entry.restartRecoverySourceIngress === "internal" &&
        Boolean(getOwedHarnessCompletionTask(harnessCompletion, entry)) &&
        readAdmittedHarnessCompletionInput({
          claim: harnessCompletion,
          entry,
          storePath: params.storePath,
          operationalRunId: entry.restartRecoveryDeliveryRunId,
        }),
      );
    } catch (error) {
      mainSessionRecoveryLog.warn(
        `harness completion input unavailable for ${sessionKey}: ${String(error)}`,
      );
      result.failed++;
      continue;
    }
    if (
      harnessCompletion &&
      getOwedHarnessCompletionTask(harnessCompletion, entry) &&
      !recoverableHarnessCompletion
    ) {
      // A missing or stale input projection is not evidence that an admitted task
      // stopped being owed. Retain custody for a later read; do not retire it.
      mainSessionRecoveryLog.warn(
        `harness completion input unresolved for ${sessionKey}; retaining its claim`,
      );
      result.failed++;
      continue;
    }
    if (harnessCompletion && !recoverableHarnessCompletion) {
      if (stopped()) {
        return result;
      }
      const reconciliation = await reconcileInvalidHarnessCompletion({
        ...target,
        entry,
      });
      if (reconciliation.outcome === "reconciled") {
        params.handledSessionKeys.add(resumeDedupeKey);
        result.skipped++;
      } else if (
        reconciliation.entry?.status === "running" &&
        reconciliation.entry.abortedLastRun === true
      ) {
        result.failed++;
      } else {
        result.skipped++;
      }
      continue;
    }

    const execPolicy = resolveExecDefaults({
      cfg: params.cfg,
      agentId,
      sessionKey: dispatchSessionKey,
      sessionEntry: entry,
    });
    const fullAccess =
      execPolicy.mode === "full" &&
      execPolicy.security === "full" &&
      execPolicy.ask === "off" &&
      entry.restartRecoveryDeliveryMediaUrls === undefined &&
      entry.restartRecoveryDisableMessageTool !== true &&
      entry.restartRecoverySuppressTextDelivery !== true;
    let replaySafeCheckpoint: boolean;
    let source: Awaited<ReturnType<typeof readMainSessionRecoveryCheckpoint>>["source"];
    let messages: unknown[];
    try {
      const transcriptScope = {
        ...target,
        sessionEntry: entry,
        sessionId: entry.sessionId,
      };
      messages = await readSessionMessagesAsync(transcriptScope, {
        mode: "recent",
        maxMessages: 20,
        maxBytes: 256 * 1024,
      });
      const checkpoint = await readMainSessionRecoveryCheckpoint(transcriptScope);
      source = checkpoint.source;
      replaySafeCheckpoint = fullAccess && !entry.pendingFinalDelivery && checkpoint.replaySafe;
    } catch (err) {
      if (stopped()) {
        return result;
      }
      mainSessionRecoveryLog.warn(`failed to read transcript for ${sessionKey}: ${String(err)}`);
      result.failed++;
      continue;
    }

    if (stopped()) {
      return result;
    }
    if (
      !recoverableHarnessCompletion &&
      (source === "inter_session" ||
        ((source === undefined ||
          source === "internal_system" ||
          source === "harness_completion") &&
          entry.restartRecoverySourceIngress === "internal"))
    ) {
      const tombstone = await tombstoneMainRestartRecoveryWithNotice({
        ...target,
        cfg: params.cfg,
        entry,
        gatewayRuntime: params.gatewayRuntime,
        observation: recoveryView.observation,
        reason: "delegated recovery sender authority is unavailable",
      });
      result[tombstone === "notice_failed" ? "failed" : "skipped"]++;
      continue;
    }

    if (pendingAction === "fail") {
      if (
        !(await resumeCurrent({
          ...(entry.pendingFinalDelivery?.kind === "replayable"
            ? { pendingFinalDeliveryText: entry.pendingFinalDelivery.text }
            : {}),
          forceRestartSafeTools: true,
        }))
      ) {
        return result;
      }
      continue;
    }

    if (
      entry.pendingFinalDelivery?.kind === "replayable" &&
      entry.restartRecoveryForceSafeTools === true
    ) {
      if (
        !(await resumeCurrent({
          pendingFinalDeliveryText: entry.pendingFinalDelivery.text,
          forceRestartSafeTools: true,
        }))
      ) {
        return result;
      }
      continue;
    }

    if (entry.pendingFinalDelivery?.kind === "replayable") {
      if (
        !(await resumeCurrent({
          pendingFinalDeliveryText: entry.pendingFinalDelivery.text,
          forceRestartSafeTools: hasReplaySafeCodeModeCheckpointInCurrentTurn(messages),
        }))
      ) {
        return result;
      }
      continue;
    }

    const retainedSafeTools =
      replaySafeCheckpoint || (entry.restartRecoveryForceSafeTools === true && !fullAccess);
    const resumePolicy = resolveMainSessionResumePolicy(
      messages,
      retainedSafeTools,
      expectedRecoverySourceRunId,
      entry.restartRecoveryBeforeAgentReplyState,
      entry.restartRecoveryDeliveryReceiptState,
      entry.restartRecoveryDeliveryToolCallId,
      fullAccess && !retainedSafeTools,
    );
    if (resumePolicy.action === "complete") {
      if (stopped()) {
        return result;
      }
      const completion = await markSessionCompletedAfterRecoveryCheckpoint({
        ...target,
        entry,
        messages,
        reason: resumePolicy.reason,
        sourceTurnId: expectedRecoverySourceRunId,
        ...(resumePolicy.reason === "handled-silent"
          ? {}
          : {
              toolCallId: resumePolicy.toolCallId,
            }),
      });
      if (completion.outcome === "completed") {
        params.handledSessionKeys.add(resumeDedupeKey);
        result.settled++;
      } else if (completion.outcome === "changed") {
        result.skipped++;
      } else {
        if (!(await resumeCurrent({ forceRestartSafeTools: true }))) {
          return result;
        }
      }
      continue;
    }

    if (
      !(await resumeCurrent({
        forceRestartSafeTools: retainedSafeTools || resumePolicy.forceRestartSafeTools,
        forceCodeModeTools: resumePolicy.forceCodeModeTools === true,
      }))
    ) {
      return result;
    }
  }

  return result;
}
