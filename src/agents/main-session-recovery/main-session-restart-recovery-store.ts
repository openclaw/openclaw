import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import {
  hasMainSessionRecoveryClaim,
  isMainRestartRecoveryCandidate,
} from "../../config/sessions/restart-recovery-state.js";
import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import { readSessionEntrySummariesInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import {
  prepareSessionSourceScope,
  releaseSessionSourceAuthorities,
  type PreparedSessionSourceAuthority,
} from "../../config/sessions/session-source-authority.js";
import { resolveSessionWorkStartBlock } from "../../config/sessions/session-work-start.js";
import { isTerminalSessionStatus } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { canPrepareAgentSessionWorktree } from "../../gateway/agent-turn/agent-handler-helpers.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { readSessionMessagesAsync } from "../../gateway/session-transcript-readers.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { findDeliveryIntentOwners } from "../../infra/outbound/delivery-queue-storage.js";
import {
  getOwedHarnessCompletionTask,
  createHarnessCompletionSourceAssertion,
  readAdmittedHarnessCompletionInput,
} from "../agent-harness-completion-recovery.js";
import { resolveExecDefaultsAsync } from "../exec-defaults.js";
import type { MainSessionRecoveryAdmission } from "./main-session-recovery-admission.js";
import { buildMainSessionRecoverySettlementPatch } from "./main-session-recovery-clear.js";
import { createCurrentProcessOwnerLookup } from "./main-session-recovery-live-owners.js";
import {
  getMainSessionRecoveryRetryCount,
  isMainRestartRecoveryTerminalOnly,
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
  readMainSessionRecoveryCheckpoint,
  reconcileInvalidHarnessCompletion,
} from "./main-session-restart-recovery-checkpoint.js";
import {
  skippedMainSessionRecoveryDecision,
  type MainSessionRecoveryDecision,
  type MainSessionRecoverySkipReason,
} from "./main-session-restart-recovery-diagnostics.js";
import { loadExpectedRestartRecoveryTarget } from "./main-session-restart-recovery-exact-target.js";
import { tombstoneMainRestartRecoveryWithNotice } from "./main-session-restart-recovery-failure.js";
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
  const completedOutcome = isTerminalSessionStatus(entry.status) && entry.status !== "interrupted";
  const endedAt = completedOutcome ? (entry.endedAt ?? Date.now()) : Date.now();
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
        ...buildMainSessionRecoverySettlementPatch({
          entry: current,
          recordTerminalSource: true,
        }),
        endedAt,
        lifecycleRunId: undefined,
        lastRunId: completedOutcome
          ? current.lastRunId
          : resolveRestartRecoveryTerminalClientRunId(current),
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
        runtimeMs:
          typeof current.startedAt === "number"
            ? Math.max(0, endedAt - current.startedAt)
            : undefined,
        status: completedOutcome ? current.status : ("done" as const),
        updatedAt: endedAt,
      };
    },
    { skipMaintenance: true, takeCacheOwnership: true },
  );
  return completed;
}

export async function recoverStore(params: {
  storeAgentId?: string;
  cfg?: OpenClawConfig;
  observationOnly?: boolean;
  onExhaustedTarget?: (target: ExhaustedRestartRecoveryTarget) => void;
  onSkipped?: (reason: MainSessionRecoverySkipReason) => void;
  onPreparationPending?: (target: ExhaustedRestartRecoveryTarget) => void;
  passId?: string;
  storePath: string;
  stateDir?: string;
  handledSessionKeys: Set<string>;
  expectedTarget?: ExpectedRestartRecoveryTarget;
  recoveryAdmission?: MainSessionRecoveryAdmission;
  activeSessionIds?: Iterable<string>;
  activeSessionKeys?: Iterable<string>;
  lifecycleGeneration?: string;
  shouldContinue?: () => boolean;
  gatewayRuntime: GatewayRecoveryRuntime;
}): Promise<{ started: number; settled: number; failed: number; skipped: number }> {
  const result = { started: 0, settled: 0, failed: 0, skipped: 0 };
  const passId = params.passId ?? randomUUID();
  const lifecycleGeneration = params.lifecycleGeneration ?? getAgentEventLifecycleGeneration();
  const hasCurrentProcessOwner = createCurrentProcessOwnerLookup(params);
  let entries: Array<{ sessionKey: string; entry: SessionEntry }>;
  try {
    if (params.expectedTarget) {
      const entry = await loadExpectedRestartRecoveryTarget({
        expected: params.expectedTarget,
        storePath: params.storePath,
      });
      entries = entry ? [{ sessionKey: params.expectedTarget.sessionKey, entry }] : [];
    } else {
      entries = await readSessionEntrySummariesInWorker({
        agentId: params.storeAgentId,
        storePath: params.storePath,
      });
    }
  } catch (err) {
    mainSessionRecoveryLog.warn(`failed to load session store ${params.storePath}: ${String(err)}`);
    result.failed++;
    return result;
  }

  for (const { sessionKey, entry: loadedEntry } of entries.toSorted((a, b) =>
    a.sessionKey.localeCompare(b.sessionKey),
  )) {
    let entry = loadedEntry;
    let completionSource: PreparedSessionSourceAuthority | undefined;
    const recoveryErrors: unknown[] = [];
    const isRecoveryCandidate =
      !loadedEntry.mainRestartRecovery?.tombstone &&
      hasMainSessionRecoveryClaim(loadedEntry) &&
      (loadedEntry.abortedLastRun === true ||
        isMainRestartRecoveryTerminalOnly(loadedEntry) ||
        (isTerminalSessionStatus(loadedEntry.status) && loadedEntry.status !== "interrupted"));
    let decision: MainSessionRecoveryDecision = {
      decision: "deferred",
      reason: "preparation_failed",
      nextOwner: "main-session-recovery",
    };
    const skip = (reason: MainSessionRecoverySkipReason) => {
      result.skipped++;
      params.onSkipped?.(reason);
      decision = skippedMainSessionRecoveryDecision(reason);
    };
    const stopped = () => {
      if (params.shouldContinue?.() !== false) {
        return false;
      }
      skip("stopped");
      return true;
    };
    try {
      if (stopped()) {
        return result;
      }
      if (!isRecoveryCandidate) {
        continue;
      }
      if (!isMainRestartRecoveryCandidate(entry, sessionKey)) {
        skip("not_main_session");
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
        skip("dispatch_target_unavailable");
        continue;
      }
      const agentId = dispatchTarget.agentId;
      const target = { agentId, sessionKey, storePath: params.storePath };
      const workStartBlock = resolveSessionWorkStartBlock(
        sessionKey,
        entry,
        canPrepareAgentSessionWorktree(sessionKey, entry)
          ? { allowPendingWorkspace: true }
          : undefined,
      );
      if (workStartBlock) {
        skip(
          workStartBlock.reason === "archived"
            ? "archived"
            : workStartBlock.retryable
              ? "work_start_pending"
              : "work_start_blocked",
        );
        decision.reason = workStartBlock.reason;
        if (workStartBlock.retryable) {
          params.onPreparationPending?.({ ...target, sessionId: entry.sessionId });
        }
        continue;
      }

      const dispatchSessionKey =
        params.expectedTarget?.canonicalSessionKey ?? dispatchTarget.sessionKey;
      if (hasCurrentProcessOwner(entry, sessionKey)) {
        skip("live_owner");
        continue;
      }
      const resumeDedupeKey = JSON.stringify([agentId, dispatchSessionKey]);
      if (params.handledSessionKeys.has(resumeDedupeKey)) {
        skip("already_handled");
        continue;
      }

      if (stopped()) {
        return result;
      }
      const observed = await commitMainSessionRecovery({
        command: {
          kind: "observe",
          cycleId: randomUUID(),
          lifecycleGeneration,
          sessionKey,
        },
        requireWriteSuccess: true,
        shouldContinue: params.shouldContinue,
        target,
      });
      if (!observed.entry || observed.transition.kind !== "observed") {
        skip("state_changed");
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
        skip(recoveryView.status);
        if (recoveryView.status === "inactive" && isMainRestartRecoveryTerminalOnly(loadedEntry)) {
          decision = { decision: "settled", reason: "terminal-residue", nextOwner: "none" };
        }
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
          skip(
            recoveryView.status === "exhausted"
              ? "exhausted"
              : "message_action_authority_unavailable",
          );
        }
        continue;
      }
      if (params.observationOnly) {
        skip("observation_only");
        continue;
      }
      const expectedRecoverySourceRunId = normalizeOptionalString(
        entry.restartRecoveryDeliverySourceRunId,
      );

      const pendingAction = entry.pendingFinalDelivery
        ? await pendingFinalRecoveryAction(entry.pendingFinalDelivery, params.stateDir)
        : undefined;
      if (stopped()) {
        return result;
      }
      if (pendingAction === "defer") {
        // The exact durable queue owner is still responsible for settlement.
        // Dispatching a second recovery turn would duplicate that delivery.
        skip("pending_delivery");
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
          decision = { decision: "settled", reason: "terminal-evidence", nextOwner: "none" };
          result.settled++;
          params.handledSessionKeys.add(resumeDedupeKey);
        } else {
          skip("state_changed");
        }
        continue;
      }
      if (pendingAction === "notice") {
        const completed = await completePendingFinalRecoveryWithNotice(entry, target);
        if (completed) {
          decision = { decision: "settled", reason: "pending_delivery_notice", nextOwner: "none" };
          result.settled++;
        } else {
          skip("state_changed");
        }
        continue;
      }
      const harnessCompletion = entry.restartRecoveryHarnessCompletion;
      let recoverableHarnessCompletion: boolean;
      try {
        const hasCurrentCompletionInput = async () => {
          if (!harnessCompletion) {
            return false;
          }
          const assertion = createHarnessCompletionSourceAssertion({
            claim: harnessCompletion,
            storePath: params.storePath,
          });
          completionSource = await prepareSessionSourceScope(assertion);
          if (completionSource) {
            completionSource.assertCurrent();
            return true;
          }
          return readAdmittedHarnessCompletionInput({
            claim: harnessCompletion,
            entry,
            storePath: params.storePath,
            operationalRunId: entry.restartRecoveryDeliveryRunId,
          });
        };
        recoverableHarnessCompletion = Boolean(
          harnessCompletion &&
          harnessCompletion.requesterSessionKey === sessionKey &&
          harnessCompletion.requesterAgentId === agentId &&
          harnessCompletion.sourceRunId === entry.restartRecoveryDeliverySourceRunId &&
          Boolean(entry.restartRecoveryDeliveryRunId) &&
          entry.restartRecoverySourceIngress === "internal" &&
          Boolean(getOwedHarnessCompletionTask(harnessCompletion, entry)) &&
          (await hasCurrentCompletionInput()),
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
          skip("invalid_harness_completion");
        } else if (
          reconciliation.entry &&
          hasMainSessionRecoveryClaim(reconciliation.entry) &&
          reconciliation.entry.abortedLastRun === true
        ) {
          result.failed++;
        } else {
          skip("state_changed");
        }
        continue;
      }

      const execPolicy = await resolveExecDefaultsAsync({
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
        if (tombstone === "notice_failed") {
          result.failed++;
        } else {
          skip("delegated_authority_unavailable");
        }
        continue;
      }

      const pendingFinal = entry.pendingFinalDelivery;
      let resumeOptions: Pick<
        Parameters<typeof resumeMainSession>[0],
        "forceCodeModeTools" | "forceRestartSafeTools" | "pendingFinalDeliveryText"
      >;
      if (pendingAction === "fail" || pendingFinal?.kind === "replayable") {
        resumeOptions = {
          ...(pendingFinal?.kind === "replayable"
            ? { pendingFinalDeliveryText: pendingFinal.text }
            : {}),
          forceRestartSafeTools:
            pendingAction === "fail" ||
            (isTerminalSessionStatus(entry.status) && entry.status !== "interrupted") ||
            entry.restartRecoveryForceSafeTools === true ||
            hasReplaySafeCodeModeCheckpointInCurrentTurn(messages),
        };
      } else {
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
              : { toolCallId: resumePolicy.toolCallId }),
          });
          if (completion.outcome === "completed") {
            params.handledSessionKeys.add(resumeDedupeKey);
            decision = { decision: "settled", reason: "terminal-evidence", nextOwner: "none" };
            result.settled++;
            continue;
          }
          if (completion.outcome === "changed") {
            skip("state_changed");
            continue;
          }
          resumeOptions = { forceRestartSafeTools: true };
        } else {
          resumeOptions = {
            forceRestartSafeTools: retainedSafeTools || resumePolicy.forceRestartSafeTools,
            forceCodeModeTools: resumePolicy.forceCodeModeTools === true,
          };
        }
      }
      if (stopped()) {
        return result;
      }
      const resumeResult = await resumeMainSession({
        ...target,
        canonicalSessionKey: dispatchSessionKey,
        cfg: params.cfg,
        entry,
        observation: recoveryView.observation,
        assertCompletionCurrent: completionSource?.assertCurrent,
        recoveryAttempt: recoveryView.nextAttempt,
        recoveryAdmission: params.recoveryAdmission,
        gatewayRuntime: params.gatewayRuntime,
        ...resumeOptions,
        lifecycleGeneration: params.lifecycleGeneration,
        shouldContinue: params.shouldContinue,
      });
      decision = {
        decision:
          resumeResult === "failed" || resumeResult === "skipped" ? "deferred" : resumeResult,
        reason: `dispatch_${resumeResult}`,
        nextOwner:
          resumeResult === "started"
            ? "main-lane"
            : resumeResult === "settled"
              ? "none"
              : "main-session-recovery",
      };
      if (resumeResult === "skipped") {
        skip("dispatch_skipped");
      } else {
        result[resumeResult]++;
      }
      if (resumeResult === "started" || resumeResult === "settled") {
        params.handledSessionKeys.add(resumeDedupeKey);
      } else if (resumeResult === "failed") {
        const current = await loadExpectedRestartRecoveryTarget({
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
    } catch (error) {
      recoveryErrors.push(error);
      throw error;
    } finally {
      if (completionSource) {
        await releaseSessionSourceAuthorities([completionSource], recoveryErrors);
      }
      if (isRecoveryCandidate && isMainRestartRecoveryCandidate(loadedEntry, sessionKey)) {
        mainSessionRecoveryLog.info(
          `main-session restart recovery candidate ${JSON.stringify({
            boot: lifecycleGeneration,
            pass: passId,
            agentId: params.storeAgentId?.slice(0, 256),
            storePath: params.storePath.slice(0, 512),
            sessionKey: sessionKey.slice(0, 256),
            sessionId: loadedEntry.sessionId.slice(0, 256),
            sourceRunId: (
              loadedEntry.restartRecoveryDeliverySourceRunId ?? loadedEntry.lifecycleRunId
            )?.slice(0, 256),
            recoveryRunId: loadedEntry.restartRecoveryDeliveryRunId?.slice(0, 256),
            interruptedRunIds: loadedEntry.restartRecoveryRuns
              ?.slice(0, 8)
              .map(({ runId }) => runId.slice(0, 256)),
            ...decision,
          })}`,
        );
      }
    }
  }

  return result;
}
