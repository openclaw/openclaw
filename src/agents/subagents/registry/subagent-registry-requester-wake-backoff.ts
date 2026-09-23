import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { SubagentLifecycleWakeContext } from "./subagent-registry-lifecycle-context.js";
import { maskLifecycleIdentifier } from "./subagent-registry-lifecycle-delivery.js";
import { SubagentRegistryWriteError } from "./subagent-registry-persistence.js";
import { getPendingWakeCommit } from "./subagent-registry-requester-wake-commit.js";
import { persistSubagentRunsToDiskAsyncOrThrow } from "./subagent-registry-state.js";
import { bindSubagentRunRecord } from "./subagent-registry.store.codec.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const FAILURE_DELAYS_MS = [60_000, 300_000, 3_600_000] as const;

/** Retain custody after a failed settlement, with a durable, capped retry deadline. */
export async function deferFailedRequesterSettleWake(params: {
  context: SubagentLifecycleWakeContext;
  entries: readonly SubagentRunRecord[];
  isCurrent: () => boolean;
  reason: string;
}): Promise<void> {
  const { context, entries, isCurrent, reason } = params;
  if (!isCurrent()) {
    return;
  }
  const failureCount = Math.min(
    FAILURE_DELAYS_MS.length,
    Math.max(...entries.map((entry) => entry.requesterSettleWake?.settleFailureCount ?? 0), 0) + 1,
  );
  const nextAttemptAt = Date.now() + FAILURE_DELAYS_MS[failureCount - 1]!;
  const owners = entries.map((entry) => {
    const wake = entry.requesterSettleWake!;
    const expectedPayload = bindSubagentRunRecord(entry).payload_json;
    if (expectedPayload === undefined) {
      throw new Error("Requester settle wake has no durable payload");
    }
    const previous = {
      settleFailureCount: wake.settleFailureCount,
      nextAttemptAt: wake.nextAttemptAt,
      lastError: wake.lastError,
    };
    // Keep the wake reference: a retained commit still owns its captured outcome.
    Object.assign(wake, {
      settleFailureCount: failureCount,
      nextAttemptAt: Math.max(wake.nextAttemptAt ?? 0, nextAttemptAt),
      lastError: reason,
    });
    return {
      entry,
      wake,
      previous,
      expectedPayload,
      payload: bindSubagentRunRecord(entry).payload_json,
    };
  });
  const ownsRows = () =>
    isCurrent() &&
    owners.every(
      ({ entry, wake, payload }) =>
        entry.requesterSettleWake === wake && bindSubagentRunRecord(entry).payload_json === payload,
    );
  try {
    await persistSubagentRunsToDiskAsyncOrThrow(
      context.options.runs,
      entries.map((entry) => entry.runId),
      {
        context: captureOpenClawStateWorkerContext(),
        expectedPayloads: owners.map(({ entry, expectedPayload }) => ({
          runId: entry.runId,
          payloadJson: expectedPayload,
        })),
        assertCurrent: () => {
          if (!ownsRows()) {
            throw new Error("Requester settle wake changed before retry deadline committed");
          }
        },
      },
    );
  } catch (error) {
    if (
      error instanceof SubagentRegistryWriteError &&
      error.outcome === "not-committed" &&
      ownsRows()
    ) {
      for (const { wake, previous } of owners) {
        Object.assign(wake, previous);
      }
    }
    throw error;
  }
  for (const { entry, wake } of owners) {
    if (entry.requesterSettleWake === wake) {
      const pending = getPendingWakeCommit(context, entry);
      if (pending) {
        pending.nextAttemptAt = Math.max(pending.nextAttemptAt, wake.nextAttemptAt ?? 0);
      }
    }
  }
  context.options.warn(
    `requester settle wake deferred after ${failureCount} settlement failures: ${reason}`,
    { failureCount, runIds: entries.map((entry) => maskLifecycleIdentifier(entry.runId, "run")) },
  );
}
