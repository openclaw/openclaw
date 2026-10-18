import {
  getRestartRecoveryTerminalDeliveryEvidence,
  hasMainSessionRecoveryClaim,
  hasRestartRecoverySourceClaim,
  hasRestartRecoveryTerminalRun,
} from "../../../config/sessions/restart-recovery-state.js";
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
import { readInterruptedRunId } from "../../main-session-recovery/main-session-restart-recovery-shared.js";
import { subagentCompletionSourceId } from "../registry/subagent-controller-inputs.js";
import { getCurrentSubagentRunOwner, subagentRuns } from "../registry/subagent-registry-memory.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import {
  buildRequesterSettleWakeIdentity,
  hasRequesterCompletionCohort,
} from "../registry/subagent-requester-settle-identity.js";
import { loadRequesterSessionEntry } from "./subagent-announce-delivery.runtime.js";

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
) => reserveSubagentControllerSource(entry, subagentCompletionSourceId(entry), protocolRunId);

/** Rebuilds process-local mailbox custody from durable completion obligations in owed order. */
export async function reserveRestoredSubagentControllerSources(
  entries: readonly SubagentRunRecord[],
): Promise<SessionControllerInput[]> {
  const reservations: Array<[number, () => Promise<SessionControllerInput | undefined>]> = [];
  const entriesById = new Map(entries.map((entry) => [entry.runId, entry]));
  for (const entry of entries) {
    if (
      entry.expectsCompletionMessage === true &&
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
          // A live finalizer can settle this obligation while restore reads its requester.
          const current = getCurrentSubagentRunOwner(subagentRuns, entry);
          if (
            !current ||
            hasRequesterCompletionCohort(current) ||
            (current.delivery?.status !== "pending" &&
              current.delivery?.status !== "in_progress") ||
            (current.delivery.nextAttemptAt ?? 0) > Date.now()
          ) {
            return undefined;
          }
          return reserveSubagentControllerSource(
            current,
            subagentCompletionSourceId(current),
            undefined,
            undefined,
            { replaceInactiveTarget: true, requester },
          );
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
    if (entry !== batch[0]) {
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
    const caller = Object.freeze({
      deliveryRoute: entry.requesterOrigin && Object.freeze(structuredClone(entry.requesterOrigin)),
      run: <T>(run: () => Promise<T>) => run(),
    });
    reservations.push([
      Math.max(...batch.map((member) => member.execution.endedAt ?? member.createdAt)),
      async () => {
        const requester = await loadRequesterSessionEntry(
          entry.requesterSessionKey,
          entry.requesterAgentId,
        );
        if (
          !(wake.status === "pending" && wake.nextAttemptAt !== undefined) &&
          resolveRequesterSettleRecoveryCustody(requester.entry, identity)
        ) {
          return undefined;
        }
        return reserveSubagentControllerSource(entry, identity.batchKey, undefined, caller, {
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
