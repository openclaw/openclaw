import type { DeliveryQueueStoredStatus } from "../../../infra/delivery-queue-sqlite.kernel.js";
import { withSessionDeliveryEnqueueAdmission } from "../../../infra/session-delivery-queue-storage.js";
import {
  isProducedSessionDelivery,
  prepareClaimedSessionDelivery,
  SessionDeliveryDeadLetteredError,
  SessionDeliveryDeferredError,
  type QueuedSessionDelivery,
  type QueuedSessionDeliveryPayload,
  type SessionDeliverySettledOutcome,
} from "../../../infra/session-delivery-queue.records.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import {
  ensureDeliveryState,
  loadPendingFinalDeliveryPayload,
} from "../registry/subagent-delivery-state.js";
import { SESSION_DELIVERY_DEADLINE_MS } from "../registry/subagent-registry-helpers.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { assertSubagentRegistryWriteSourceCurrent } from "../registry/subagent-registry-persistence.js";
import {
  assertSubagentReadContext,
  readFullSubagentRuns,
} from "../registry/subagent-registry-read-cache.js";
import { isSameSubagentRunOwner } from "../registry/subagent-run-generation.js";
import {
  admitSubagentCompletionDelivery,
  blockSubagentCompletionDelivery,
  settleSubagentCompletionDelivery,
  SubagentCompletionSourceChangedError,
} from "./subagent-completion-admission.store.js";

const CLAIM_LEASE_MS = 125_000;

/** Atomically admits a queue generation and publishes process mirrors only after commit. */
export async function admitCorrelatedSubagentSessionDelivery(params: {
  runId: string;
  payload: Extract<QueuedSessionDeliveryPayload, { kind: "agentTurn" }>;
  queueContext: OpenClawStateWorkerContext;
}): Promise<{ id: string; claimed: boolean; status: DeliveryQueueStoredStatus }> {
  const payload = params.payload;
  const runId = params.runId;
  const context = params.queueContext;
  const expected = subagentRuns.get(runId);
  return withSessionDeliveryEnqueueAdmission(payload, context, async (assertCurrent) => {
    return admitSubagentCompletionDelivery({
      runId,
      context,
      assertCurrent() {
        assertCurrent();
        if (!isSameSubagentRunOwner(subagentRuns.get(runId), expected)) {
          throw new SubagentCompletionSourceChangedError(
            "Subagent completion owner changed during enqueue admission",
          );
        }
      },
      plan(current) {
        const now = Date.now();
        // The registry freezes the source row; only delivery changes here.
        const subagent = {
          ...current,
          delivery: current.delivery && { ...current.delivery },
        };
        const delivery = ensureDeliveryState(subagent);
        const generation = delivery.generation ?? 1;
        const windowStartedAt = delivery.windowStartedAt ?? subagent.execution.endedAt ?? now;
        const deadlineAt = delivery.deadlineAt ?? windowStartedAt + SESSION_DELIVERY_DEADLINE_MS;
        const generationSuffix = generation > 1 ? `:generation:${generation}` : "";
        const queueEntry = prepareClaimedSessionDelivery(
          {
            ...payload,
            idempotencyKey: `${payload.idempotencyKey ?? payload.messageId}${generationSuffix}`,
            messageId: `${payload.messageId}${generationSuffix}`,
            maxRetries: Number.MAX_SAFE_INTEGER,
            owner: {
              kind: "subagent_completion",
              runId: subagent.runId,
              taskId: subagent.taskRunId ?? subagent.runId,
              generation,
              deadlineAt,
            },
          },
          CLAIM_LEASE_MS,
          now,
        );
        Object.assign(delivery, {
          status: "in_progress" as const,
          disposition: "session_queued" as const,
          generation,
          queueId: queueEntry.id,
          windowStartedAt,
          deadlineAt,
          enqueuedAt: now,
        });
        delivery.payload ??= loadPendingFinalDeliveryPayload(subagent);
        return { queueEntry, subagent };
      },
    });
  });
}

export function resolveCorrelatedSubagentDelivery(
  queued: QueuedSessionDelivery,
): QueuedSessionDelivery {
  if (
    !isProducedSessionDelivery(queued) ||
    queued.kind !== "agentTurn" ||
    queued.owner?.kind !== "subagent_completion"
  ) {
    return queued;
  }
  if (Date.now() >= queued.owner.deadlineAt) {
    throw new SessionDeliveryDeadLetteredError(
      "correlated subagent completion delivery deadline expired",
    );
  }
  const entry = subagentRuns.get(queued.owner.runId);
  if (
    !entry ||
    entry.delivery?.queueId !== queued.id ||
    entry.delivery.generation !== queued.owner.generation ||
    entry.delivery.deadlineAt !== queued.owner.deadlineAt
  ) {
    throw new SessionDeliveryDeferredError("correlated subagent delivery owner mismatch");
  }
  return queued;
}

export async function settleCorrelatedSubagentDelivery(
  queued: QueuedSessionDelivery,
  outcome: SessionDeliverySettledOutcome,
  queueContext: OpenClawStateWorkerContext,
): Promise<void> {
  if (
    !isProducedSessionDelivery(queued) ||
    queued.kind !== "agentTurn" ||
    queued.owner?.kind !== "subagent_completion"
  ) {
    return;
  }
  const queueOwner = queued.owner;
  assertSubagentReadContext(queueContext);
  if (!subagentRuns.has(queued.owner.runId)) {
    const persisted = await readFullSubagentRuns(
      queueContext,
      { kind: "ids", runIds: [queued.owner.runId] },
      { current: true },
    );
    assertSubagentReadContext(queueContext);
    if (persisted.has(queued.owner.runId) && !subagentRuns.has(queued.owner.runId)) {
      throw new Error("Subagent completion recovery is waiting for registry restoration");
    }
  }
  const current = subagentRuns.get(queued.owner.runId);
  const alreadyDelivered =
    outcome === "recovered" &&
    current?.delivery?.status === "delivered" &&
    current.delivery.queueId === undefined;
  if (
    !current ||
    current.delivery?.generation !== queued.owner.generation ||
    (!alreadyDelivered && current.delivery.queueId !== queued.id)
  ) {
    return;
  }
  const readMatchingDeliveryOwner = () => {
    const latest = subagentRuns.get(current.runId);
    if (!latest) {
      // A later recovery's canonical read distinguishes retirement from a cold map.
      throw new Error("Subagent completion recovery is waiting for registry restoration");
    }
    if (
      !isSameSubagentRunOwner(latest, current) ||
      latest.delivery?.generation !== queueOwner.generation
    ) {
      return undefined;
    }
    return latest;
  };
  if (outcome !== "recovered") {
    await blockSubagentCompletionDelivery({
      context: queueContext,
      subagent: current,
      reason: queued.lastError ?? "completion delivery failed",
      suspendedReason: "permanent_failure",
    });
    return;
  }
  await settleSubagentCompletionDelivery({
    subagent: current,
    queueId: queued.id,
    context: queueContext,
  });
  assertSubagentRegistryWriteSourceCurrent(queueContext);
  const published = readMatchingDeliveryOwner();
  if (!published) {
    return;
  }
  if (published.delivery?.status !== "delivered" || published.delivery.queueId !== undefined) {
    throw new Error("Subagent completion recovery is waiting for committed publication");
  }
}
