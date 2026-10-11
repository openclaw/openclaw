import { isDeepStrictEqual } from "node:util";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import { isTerminalSessionStatus } from "../../config/sessions/types.js";
import { findDeliveryIntentOwners } from "../../infra/outbound/delivery-queue-storage.js";
import {
  buildDurableQuestionRecoverySettlementPatch,
  isDurableQuestionCurrentSource,
} from "./main-session-question-recovery.js";
import { buildMainSessionRecoverySettlementPatch } from "./main-session-recovery-clear.js";
import type { MainSessionRecoveryStoreTarget } from "./main-session-recovery-store.js";
import { resolveRestartRecoveryTerminalClientRunId } from "./main-session-restart-recovery-shared.js";
export async function pendingFinalRecoveryAction(
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

export async function completePendingFinalRecoveryWithNotice(
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
        current.pendingFinalDelivery?.intentId !== entry.pendingFinalDelivery?.intentId ||
        (isDurableQuestionCurrentSource(entry) &&
          (current.lifecycleRevision !== entry.lifecycleRevision ||
            current.restartRecoveryDeliveryRunId !== entry.restartRecoveryDeliveryRunId ||
            current.restartRecoveryDeliverySourceRunId !==
              entry.restartRecoveryDeliverySourceRunId ||
            current.mainRestartRecovery?.cycleId !== entry.mainRestartRecovery?.cycleId ||
            current.mainRestartRecovery?.revision !== entry.mainRestartRecovery?.revision ||
            !isDeepStrictEqual(current.restartRecoveryRuns, entry.restartRecoveryRuns) ||
            !isDeepStrictEqual(current.pendingFinalDelivery, entry.pendingFinalDelivery) ||
            !isDeepStrictEqual(current.durableQuestionOwners, entry.durableQuestionOwners)))
      ) {
        return null;
      }
      const pending = current.pendingFinalDelivery;
      completed = true;
      return {
        ...(isDurableQuestionCurrentSource(current)
          ? buildDurableQuestionRecoverySettlementPatch(current, { completedFinal: true })
          : buildMainSessionRecoverySettlementPatch({
              entry: current,
              recordTerminalSource: true,
            })),
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
