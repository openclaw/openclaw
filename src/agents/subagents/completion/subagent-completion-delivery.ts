import { isDeepStrictEqual } from "node:util";
import type { DeliveryQueueStoredStatus } from "../../../infra/delivery-queue-sqlite.kernel.js";
import { withSessionDeliveryEnqueueAdmission } from "../../../infra/session-delivery-queue-storage.js";
import {
  prepareClaimedSessionDelivery,
  SessionDeliveryDeadLetteredError,
  SessionDeliveryDeferredError,
  type QueuedSessionDelivery,
  type QueuedSessionDeliveryPayload,
  type SessionDeliverySettledOutcome,
} from "../../../infra/session-delivery-queue.records.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import type { RuntimeContextFragment } from "../../internal-runtime-context.js";
import { ensureDeliveryState } from "../registry/subagent-delivery-state.js";
import { ANNOUNCE_COMPLETION_HARD_EXPIRY_MS } from "../registry/subagent-registry-helpers.js";
import { loadPendingFinalDeliveryPayload } from "../registry/subagent-registry-lifecycle-delivery.js";
import {
  getSubagentRunsForChildSession,
  subagentRuns,
} from "../registry/subagent-registry-memory.js";
import { withSubagentRegistryWriteAuthority } from "../registry/subagent-registry-persistence.js";
import { compareSubagentRunGeneration } from "../registry/subagent-run-generation.js";
import {
  admitSubagentCompletionDelivery,
  blockSubagentCompletionDelivery,
  publishCommittedRecords,
  settleSubagentCompletionDelivery,
} from "./subagent-completion-admission.store.js";
import { SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION } from "./subagent-completion-instructions.js";
import { resolveSubagentCompletionResultText } from "./subagent-completion-result.js";

const CLAIM_LEASE_MS = 125_000;
const CANONICAL_RESULT_PROMPT = `A completed subagent task is ready for parent review. ${SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION} The canonical result follows.`;

/** Atomically admits a queue generation and publishes process mirrors only after commit. */
export async function admitCorrelatedSubagentSessionDelivery(params: {
  runId: string;
  payload: Extract<QueuedSessionDeliveryPayload, { kind: "agentTurn" }>;
  queueContext: OpenClawStateWorkerContext;
}): Promise<{ id: string; claimed: boolean; status: DeliveryQueueStoredStatus }> {
  const payload = structuredClone(params.payload);
  const runId = params.runId;
  const context = params.queueContext;
  return withSessionDeliveryEnqueueAdmission(payload, context, async (assertCurrent) => {
    assertCurrent();
    const current = subagentRuns.get(runId);
    if (!current) {
      throw new Error(`subagent completion owner not found: ${runId}`);
    }
    const expected = structuredClone(current);
    const sourceIsCurrent = () =>
      subagentRuns.get(runId) === current &&
      isDeepStrictEqual(current, expected) &&
      ![...getSubagentRunsForChildSession(expected.childSessionKey)].some(
        (candidate) => compareSubagentRunGeneration(candidate, expected) > 0,
      );
    return withSubagentRegistryWriteAuthority(
      [runId],
      {
        context,
        assertCurrent: () => {
          assertCurrent();
          if (!sourceIsCurrent()) {
            throw new Error("Subagent completion source changed during admission");
          }
        },
      },
      async (authority) => {
        const now = Date.now();
        const subagent = structuredClone(expected);
        const delivery = ensureDeliveryState(subagent);
        const generation = delivery.generation ?? 1;
        const windowStartedAt = delivery.windowStartedAt ?? subagent.execution.endedAt ?? now;
        const deadlineAt =
          delivery.deadlineAt ?? windowStartedAt + ANNOUNCE_COMPLETION_HARD_EXPIRY_MS;
        const generationSuffix = generation > 1 ? `:generation:${generation}` : "";
        const queueEntry = prepareClaimedSessionDelivery(
          {
            ...payload,
            idempotencyKey: `${payload.idempotencyKey ?? payload.messageId}${generationSuffix}`,
            messageId: `${payload.messageId}${generationSuffix}`,
            message: CANONICAL_RESULT_PROMPT,
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
          nextAttemptAt: queueEntry.availableAt,
          enqueuedAt: now,
        });
        delivery.payload ??= loadPendingFinalDeliveryPayload(subagent);
        const admission = await admitSubagentCompletionDelivery({
          queueEntry,
          expected,
          subagent,
          context,
          assertCurrent: authority.assertCurrent,
        });
        const result = { id: queueEntry.id, claimed: admission.claimed, status: admission.status };
        try {
          authority.assertDatabase();
        } catch {
          // A settled receipt stays authoritative, but cannot publish into a successor database.
          return result;
        }
        if (authority.currentRunIds().includes(runId) && sourceIsCurrent()) {
          // Row decoding clears the restart-only cleanup lock; the active attempt still owns it.
          admission.subagent.cleanupHandled = current.cleanupHandled;
          publishCommittedRecords(admission.subagent, context.admission.databasePath);
        }
        return result;
      },
    );
  });
}

export function resolveCorrelatedSubagentDelivery(
  queued: QueuedSessionDelivery,
): QueuedSessionDelivery & { runtimeContextFragments?: RuntimeContextFragment[] } {
  if (queued.kind !== "agentTurn" || queued.owner?.kind !== "subagent_completion") {
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
  const result = resolveSubagentCompletionResultText(entry) ?? "(no output)";
  return {
    ...queued,
    message: `${CANONICAL_RESULT_PROMPT}\n\n${result}`,
    runtimeContextFragments: [
      { kind: "runtime-instruction", text: CANONICAL_RESULT_PROMPT },
      { kind: "conversation-data", text: result },
    ],
  };
}

export async function settleCorrelatedSubagentDelivery(
  queued: QueuedSessionDelivery,
  outcome: SessionDeliverySettledOutcome,
): Promise<void> {
  if (queued.kind !== "agentTurn" || queued.owner?.kind !== "subagent_completion") {
    return;
  }
  const current = subagentRuns.get(queued.owner.runId);
  if (
    !current ||
    current.delivery?.queueId !== queued.id ||
    current.delivery.generation !== queued.owner.generation
  ) {
    return;
  }
  const now = Date.now();
  const subagent = structuredClone(current);
  const delivery = ensureDeliveryState(subagent);
  if (outcome !== "recovered") {
    await blockSubagentCompletionDelivery({
      subagent: current,
      reason: queued.lastError ?? "completion delivery failed",
      suspendedReason: "permanent_failure",
    });
    return;
  }
  Object.assign(delivery, {
    status: "delivered" as const,
    disposition: "delivered" as const,
    deliveredAt: now,
    announcedAt: now,
    lastError: undefined,
    nextAttemptAt: undefined,
    queueId: undefined,
  });
  delivery.payload = undefined;
  await settleSubagentCompletionDelivery({ subagent });
  if (
    subagentRuns.get(current.runId) !== current ||
    current.delivery?.generation !== queued.owner.generation ||
    current.delivery.status !== "delivered"
  ) {
    return;
  }
  const { resumeSubagentRun } = await import("../registry/subagent-registry.js");
  resumeSubagentRun(subagent.runId);
}
