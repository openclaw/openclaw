import {
  createSubagentRunRecord,
  type SubagentRunRecordOverrides,
} from "../../subagent-test-fixtures.test-helpers.js";
import { loadPendingFinalDeliveryPayload } from "./subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type KilledRunOverrides = SubagentRunRecordOverrides &
  Pick<SubagentRunRecord, "task" | "createdAt">;
type SuspendedDeliveryRunOverrides = Omit<
  SubagentRunRecordOverrides,
  "startedAt" | "outcome" | "expectsCompletionMessage" | "delivery"
> &
  Pick<
    SubagentRunRecord,
    "childSessionKey" | "requesterSessionKey" | "requesterDisplayKey" | "task" | "createdAt"
  > & {
    endedAt: number;
    delivery: Partial<NonNullable<SubagentRunRecord["delivery"]>>;
  };

export const makeKilledRun = (
  killedAt: number,
  overrides: KilledRunOverrides,
): SubagentRunRecordOverrides => ({
  endedAt: killedAt,
  endedReason: SUBAGENT_ENDED_REASON_KILLED,
  outcome: { status: "error", error: "manual kill" },
  suppressAnnounceReason: "killed",
  killReconciliation: { killedAt },
  cleanupHandled: true,
  cleanupCompletedAt: killedAt,
  ...overrides,
});
export const makeCompletedCollectorRun = (
  overrides: SubagentRunRecordOverrides,
): SubagentRunRecordOverrides => ({
  collect: true,
  collectorCompletion: { status: "done" },
  ...overrides,
});
export const makeQueuedRun = (overrides: SubagentRunRecordOverrides): SubagentRunRecord =>
  createSubagentRunRecord({
    childSessionKey: overrides.childSessionKey ?? `agent:main:subagent:${overrides.runId}`,
    requesterSessionKey: overrides.requesterSessionKey ?? "agent:main:main",
    collect: true,
    execution: { status: "queued" },
    completion: { required: false },
    ...overrides,
  });
export const makeSuspendedDeliveryRun = ({
  delivery: deliveryOverrides,
  ...overrides
}: SuspendedDeliveryRunOverrides): SubagentRunRecordOverrides => ({
  expectsCompletionMessage: true,
  startedAt: overrides.createdAt,
  outcome: { status: "ok" },
  ...overrides,
  delivery: {
    status: "suspended",
    createdAt: overrides.createdAt,
    attemptCount: 3,
    lastError: "gateway request timeout for agent",
    payload: loadPendingFinalDeliveryPayload(
      createSubagentRunRecord({
        ...overrides,
        outcome: { status: "ok" },
        expectsCompletionMessage: true,
      }),
    ),
    suspendedReason: "expiry",
    ...deliveryOverrides,
  },
});
