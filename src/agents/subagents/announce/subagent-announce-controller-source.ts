import {
  getRestartRecoveryTerminalDeliveryEvidence,
  hasMainSessionRecoveryClaim,
  hasOrphanedMainSessionWork,
  hasRestartRecoverySourceClaim,
  hasRestartRecoveryTerminalRun,
} from "../../../config/sessions/restart-recovery-state.js";
import { isRestartRecoveryTombstone } from "../../../config/sessions/session-work-start.js";
import type { InternalSessionEntry } from "../../../config/sessions/types.js";
import {
  getGatewayContextResolver,
  withPluginRuntimeGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import {
  reserveSessionControllerSource,
  type SessionControllerInput,
} from "../../../sessions/session-controller.mailbox.js";
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
} from "../../announce-idempotency.js";
import { readInterruptedRunId } from "../../main-session-recovery/main-session-restart-recovery-shared.js";
import { subagentCompletionSourceId } from "../registry/subagent-controller-inputs.js";
import { getCurrentSubagentRunOwner, subagentRuns } from "../registry/subagent-registry-memory.js";
import { getLatestLiveSubagentRunByChildSessionKey } from "../registry/subagent-registry-read.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import {
  buildRequesterSettleWakeIdentity,
  hasRequesterCompletionCohort,
  isRequesterCompletionCohortCurrent,
  isSubagentObligationRetired,
} from "../registry/subagent-requester-settle-identity.js";
import { captureRequesterFollowupContinuationCaller } from "../requester-cron-authority.js";
import { loadRequesterSessionEntry } from "./subagent-announce-delivery.runtime.js";
import { createRequesterDescendantReader } from "./subagent-announce.requester-settle-descendants.js";
import {
  isRequesterSettleMemberReady,
  waitForRequesterDescendants,
} from "./subagent-announce.requester-settle-state.js";

/** Recovery already owns this exact input; the wake only reconciles its final receipt. */
export function resolveRequesterSettleRecoveryCustody(
  entry: InternalSessionEntry | undefined,
  identity: Pick<ReturnType<typeof buildRequesterSettleWakeIdentity>, "runId" | "retainedRunId">,
): { status: "pending" | "settled"; runId: string } | undefined {
  const runIds = identity.retainedRunId
    ? [identity.runId, identity.retainedRunId]
    : [identity.runId];
  // A current claim outranks receipts from an earlier attempt, regardless of key format.
  for (const runId of runIds) {
    if (
      (entry?.abortedLastRun === true &&
        hasMainSessionRecoveryClaim(entry) &&
        !entry.mainRestartRecovery?.tombstone &&
        (entry.restartRecoveryDeliverySourceRunId ?? readInterruptedRunId(entry)) === runId) ||
      hasRestartRecoverySourceClaim(entry, runId)
    ) {
      // A terminal receipt for this same source is already conclusive, even if
      // claim cleanup has not yet removed its durable source fields.
      const status =
        getRestartRecoveryTerminalDeliveryEvidence(entry, runId) ||
        hasRestartRecoveryTerminalRun(entry, runId)
          ? "settled"
          : "pending";
      return { status, runId };
    }
  }
  const settled = runIds.filter(
    (runId) =>
      getRestartRecoveryTerminalDeliveryEvidence(entry, runId) ||
      hasRestartRecoveryTerminalRun(entry, runId),
  );
  const current = settled.find(
    (runId) =>
      entry?.lifecycleRunId === runId ||
      (entry?.lifecycleRunId !== undefined &&
        getRestartRecoveryTerminalDeliveryEvidence(entry, runId)?.transcriptRunId ===
          entry.lifecycleRunId),
  );
  // If another turn has since run, use the recovery owner's recorded receipt order.
  const runId =
    current ??
    entry?.restartRecoveryTerminalDeliveryEvidence?.findLast((receipt) =>
      settled.includes(receipt.runId),
    )?.runId ??
    entry?.restartRecoveryTerminalRunIds?.findLast((id) => settled.includes(id));
  return runId ? { status: "settled", runId } : undefined;
}

/** Reserves one followup source against the durable registry row that owns it. */
export async function reserveSubagentControllerSource(
  entry: SubagentRunRecord,
  reservationId: string,
  protocolRunId?: string,
  continuationCaller?: SessionControllerInput["continuationCaller"],
  options: {
    replaceInactiveTarget?: boolean;
    requester?: Awaited<ReturnType<typeof loadRequesterSessionEntry>>;
  } = {},
): Promise<SessionControllerInput | undefined> {
  const requester =
    options.requester ??
    (await loadRequesterSessionEntry(entry.requesterSessionKey, entry.requesterAgentId));
  if (!requester.entry?.sessionId || !requester.storePath) {
    return undefined;
  }
  const privateSourceRunId =
    protocolRunId ??
    requester.entry.restartRecoveryDeliverySourceRunId ??
    readInterruptedRunId(requester.entry);
  const { resolvePrivateRequesterSettleRecoveryOwner } =
    await import("../registry/subagent-registry-restart-recovery.js");
  const privateOwner = resolvePrivateRequesterSettleRecoveryOwner(requester, privateSourceRunId);
  // Unadmitted completions must not occupy the mailbox ahead of an operator's Resume.
  if (privateOwner !== "owned" && isRestartRecoveryTombstone(requester.entry)) {
    return undefined;
  }
  // Recover the interrupted requester before another completion wave reserves its mailbox.
  // An exact recovered receipt may still reconcile without starting replacement work.
  if (
    requester.entry.abortedLastRun === true &&
    privateOwner !== "owned" &&
    hasMainSessionRecoveryClaim(requester.entry) &&
    !requester.entry.mainRestartRecovery?.tombstone &&
    (!protocolRunId ||
      resolveRequesterSettleRecoveryCustody(requester.entry, { runId: protocolRunId })?.status !==
        "settled")
  ) {
    return undefined;
  }
  const target = captureSessionTarget({
    storeScope: requester.storePath,
    physicalStorePath: requester.physicalStorePath,
    sessionKey: requester.canonicalKey,
    aliases: [entry.requesterSessionKey],
    agentId: requester.agentId,
    incarnation: requester.entry.sessionId,
  });
  return withPluginRuntimeGatewayContextResolver(getGatewayContextResolver(entry), () =>
    reserveSessionControllerSource(requester.canonicalKey, {
      reservationId,
      protocolRunId,
      replaceInactiveTarget: options.replaceInactiveTarget,
      continuationCaller,
      policy: { mode: "followup" },
      target,
    }),
  );
}

export const reserveSubagentCompletionControllerSource = (
  entry: SubagentRunRecord,
  protocolRunId?: string,
  options: Parameters<typeof reserveSubagentControllerSource>[4] = {},
) =>
  reserveSubagentControllerSource(
    entry,
    subagentCompletionSourceId(entry),
    protocolRunId,
    captureRequesterFollowupContinuationCaller(
      entry,
      protocolRunId ??
        buildAnnounceIdempotencyKey(
          buildAnnounceIdFromChildRun({
            childSessionKey: entry.childSessionKey,
            childRunId: entry.runId,
          }),
        ),
    ),
    options,
  );

/** Rebuilds process-local mailbox custody from durable completion obligations in owed order. */
export async function reserveRestoredSubagentControllerSources(
  entries: readonly SubagentRunRecord[],
  assertCurrent?: () => void,
): Promise<SessionControllerInput[]> {
  const prepareRestoredRequester = async (
    requester: Awaited<ReturnType<typeof loadRequesterSessionEntry>>,
  ) => {
    assertCurrent?.();
    if (
      requester.entry &&
      requester.storePath &&
      hasOrphanedMainSessionWork(requester.entry, requester.canonicalKey) &&
      !(requester.entry.abortedLastRun === true && hasMainSessionRecoveryClaim(requester.entry))
    ) {
      // The early startup scan may precede database preparation. Mark the
      // predecessor before child reservations can block its recovery in FIFO.
      const { markOrphanedMainSessionForRecovery } =
        await import("../../main-session-recovery/main-session-restart-recovery-marking.js");
      const result = await markOrphanedMainSessionForRecovery({
        target: {
          agentId: requester.agentId,
          storePath: requester.storePath,
          sessionKey: requester.canonicalKey,
        },
        expectedSessionId: requester.entry.sessionId,
        expectedLifecycleRevision: requester.entry.lifecycleRevision,
        cfg: requester.cfg,
        assertCommitAllowed: assertCurrent,
      });
      assertCurrent?.();
      return result.marked === 0;
    }
    return true;
  };
  const reservations: Array<[number, () => Promise<SessionControllerInput | undefined>]> = [];
  const entriesById = new Map(entries.map((entry) => [entry.runId, entry]));
  // Matches live dispatch: a yielded cohort still reports its retired members, while
  // an ordinary wave owes nothing once all of them retire.
  const selectWakeOwner = (
    batch: readonly SubagentRunRecord[],
    wake: NonNullable<SubagentRunRecord["requesterSettleWake"]>,
  ) => {
    const pause = batch[0]?.pauseReason === "sessions_yield" && wake.pauseNotice !== undefined;
    // Unsettled work is not yet a runnable input and must not hold foreground FIFO.
    if (!pause && !batch.every(isRequesterSettleMemberReady)) {
      return undefined;
    }
    // Keep the full frozen cohort's custody, but never park the requester behind
    // an unprepared reservation whose members live dispatch can no longer use.
    if (
      !batch.some((member) =>
        isRequesterCompletionCohortCurrent(member, getLatestLiveSubagentRunByChildSessionKey),
      )
    ) {
      return undefined;
    }
    return (
      batch.find((member) => !isSubagentObligationRetired(member)) ??
      (wake.requesterYieldBatch === true ? batch[0] : undefined)
    );
  };
  for (const entry of entries) {
    // A retired child no longer owns its own completion delivery.
    if (
      !isSubagentObligationRetired(entry) &&
      entry.expectsCompletionMessage === true &&
      // Yielded children owe a future result, not a runnable completion. Restore only
      // their explicit pause-notice wake below, otherwise they block requester FIFO.
      entry.pauseReason !== "sessions_yield" &&
      // Interrupted terminal delivery is reserved by recovery after reconciliation.
      entry.terminalOwner !== "interrupted-recovery" &&
      !hasRequesterCompletionCohort(entry) &&
      (entry.delivery?.status === "pending" || entry.delivery?.status === "in_progress") &&
      (entry.delivery.nextAttemptAt ?? 0) <= Date.now()
    ) {
      reservations.push([
        entry.delivery.createdAt ?? entry.execution.endedAt ?? entry.createdAt,
        async () => {
          const requester = await loadRequesterSessionEntry(
            entry.requesterSessionKey,
            entry.requesterAgentId,
          );
          if (!(await prepareRestoredRequester(requester))) {
            return undefined;
          }
          // A live finalizer can settle this obligation while restore reads its requester.
          const current = getCurrentSubagentRunOwner(subagentRuns, entry);
          if (
            !current ||
            isSubagentObligationRetired(current) ||
            current.pauseReason === "sessions_yield" ||
            hasRequesterCompletionCohort(current) ||
            (current.delivery?.status !== "pending" &&
              current.delivery?.status !== "in_progress") ||
            (current.delivery.nextAttemptAt ?? 0) > Date.now()
          ) {
            return undefined;
          }
          return reserveSubagentCompletionControllerSource(current, undefined, {
            replaceInactiveTarget: true,
            requester,
          });
        },
      ]);
    }
    const wake = entry.requesterSettleWake;
    const pause = entry.pauseReason === "sessions_yield" && Boolean(wake?.pauseNotice);
    if (!wake || (wake.nextAttemptAt ?? 0) > Date.now()) {
      continue;
    }
    const batch = (pause ? [entry.runId] : (wake.batchRunIds ?? [])).toSorted().flatMap((runId) => {
      const member = entriesById.get(runId);
      return member?.requesterSettleWake !== undefined &&
        member.requesterSettleWake.rearmGeneration === wake.rearmGeneration &&
        member.requesterSessionKey === entry.requesterSessionKey &&
        member.requesterAgentId === entry.requesterAgentId &&
        member.requesterStorePath === entry.requesterStorePath
        ? [member]
        : [];
    });
    if (entry !== selectWakeOwner(batch, wake)) {
      continue;
    }
    const identity = buildRequesterSettleWakeIdentity({
      requesterSessionKey: entry.requesterSessionKey,
      requesterAgentId: entry.requesterAgentId,
      batchRunIds: batch.map((member) => member.runId),
      rearmGeneration: wake.rearmGeneration,
      pause,
      retainedWake: wake,
      hasPrivateCompletion: batch.some((member) => member.completionTarget === "parent"),
    });
    reservations.push([
      Math.max(...batch.map((member) => member.execution.endedAt ?? member.createdAt)),
      async () => {
        const requester = await loadRequesterSessionEntry(
          entry.requesterSessionKey,
          entry.requesterAgentId,
        );
        const { resolvePrivateRequesterSettleRecoveryOwner } =
          await import("../registry/subagent-registry-restart-recovery.js");
        const privateOwner = resolvePrivateRequesterSettleRecoveryOwner(requester, identity.runId);
        if (
          privateOwner !== "owned" &&
          !(wake.status === "pending" && wake.nextAttemptAt !== undefined) &&
          resolveRequesterSettleRecoveryCustody(requester.entry, identity)
        ) {
          return undefined;
        }
        if (privateOwner !== "owned" && !(await prepareRestoredRequester(requester))) {
          return undefined;
        }
        // Recheck after requester recovery preparation; the same frozen cohort still owns FIFO.
        const currentBatch = batch
          .map((member) => getCurrentSubagentRunOwner(subagentRuns, member))
          .filter(
            (owner): owner is SubagentRunRecord =>
              owner?.requesterSettleWake !== undefined &&
              owner.requesterSettleWake.rearmGeneration === wake.rearmGeneration,
          );
        const current =
          currentBatch.length === batch.length ? selectWakeOwner(currentBatch, wake) : undefined;
        if (!current) {
          return undefined;
        }
        if (!pause) {
          const descendants = await createRequesterDescendantReader({
            requesterSessionKey: current.requesterSessionKey,
            requesterAgentId: current.requesterAgentId,
            requesterStorePath: current.requesterStorePath ?? null,
            settledEntry: current,
            settledBefore: Math.min(...currentBatch.map((member) => member.createdAt)),
            rootRunIds: new Set(wake.batchRunIds),
            isSourceCurrent: () =>
              currentBatch.every(
                (member) => getCurrentSubagentRunOwner(subagentRuns, member) === member,
              ),
          })();
          assertCurrent?.();
          if (!descendants || waitForRequesterDescendants(descendants, true)) {
            return undefined;
          }
        }
        const caller = Object.freeze({
          deliveryRoute:
            current.requesterOrigin && Object.freeze(structuredClone(current.requesterOrigin)),
          run: <T>(run: () => Promise<T>) => run(),
        });
        return reserveSubagentControllerSource(current, identity.batchKey, undefined, caller, {
          replaceInactiveTarget: true,
          requester,
        });
      },
    ]);
  }
  const inputs: SessionControllerInput[] = [];
  for (const [, reserve] of reservations.toSorted(([a], [b]) => a - b)) {
    const input = await reserve();
    if (input) {
      inputs.push(input);
    }
  }
  return inputs;
}
