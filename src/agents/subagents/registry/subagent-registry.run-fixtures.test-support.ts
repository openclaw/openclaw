import {
  createSubagentRunRecord,
  type SubagentRunRecordOverrides,
} from "../../subagent-test-fixtures.test-helpers.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type RunRecordFixtureOverrides = Pick<SubagentRunRecordOverrides, "runId"> &
  Partial<Omit<SubagentRunRecordOverrides, "runId">>;
type KilledRunOverrides = Pick<SubagentRunRecordOverrides, "runId"> &
  Required<Pick<SubagentRunRecord, "task" | "createdAt">> &
  Partial<Omit<SubagentRunRecordOverrides, "runId" | "task" | "createdAt">>;
type QueuedRunOverrides = Pick<SubagentRunRecordOverrides, "runId" | "createdAt" | "groupId"> &
  Partial<Omit<SubagentRunRecordOverrides, "runId" | "createdAt" | "groupId" | "queuedLaunch">> & {
    queuedLaunch?: Partial<NonNullable<SubagentRunRecord["queuedLaunch"]>>;
  };
type SuspendedDeliveryRunOverrides = Pick<SubagentRunRecordOverrides, "runId"> &
  Required<
    Pick<
      SubagentRunRecord,
      "childSessionKey" | "requesterSessionKey" | "requesterDisplayKey" | "task" | "createdAt"
    >
  > & {
    endedAt: number;
    delivery: Partial<NonNullable<SubagentRunRecord["delivery"]>>;
  } & Partial<
    Omit<
      SubagentRunRecordOverrides,
      | "runId"
      | "childSessionKey"
      | "requesterSessionKey"
      | "requesterDisplayKey"
      | "task"
      | "createdAt"
      | "startedAt"
      | "endedAt"
      | "outcome"
      | "expectsCompletionMessage"
      | "delivery"
    >
  >;

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
  overrides: RunRecordFixtureOverrides,
): SubagentRunRecordOverrides => ({
  collect: true,
  collectorCompletion: { status: "done" },
  ...overrides,
});
export const makeQueuedRun = ({
  queuedLaunch: queuedLaunchOverrides,
  ...overrides
}: QueuedRunOverrides): SubagentRunRecord => {
  const childSessionKey = overrides.childSessionKey ?? `agent:main:subagent:${overrides.runId}`;
  const requesterSessionKey = overrides.requesterSessionKey ?? "agent:main:main";
  return createSubagentRunRecord({
    childSessionKey,
    requesterSessionKey,
    requesterDisplayKey: "main",
    task: overrides.runId,
    cleanup: "keep",
    collect: true,
    execution: { status: "queued" },
    completion: { required: false },
    ...overrides,
    queuedLaunch: {
      request: {
        sessionKey: childSessionKey,
        idempotencyKey: overrides.runId,
      },
      timeoutMs: 1_000,
      schedulerGroupKey: JSON.stringify([requesterSessionKey, overrides.groupId]),
      maxConcurrent: 1,
      ...queuedLaunchOverrides,
    },
  });
};
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
    payload: {
      requesterSessionKey: overrides.requesterSessionKey,
      requesterDisplayKey: overrides.requesterDisplayKey,
      childSessionKey: overrides.childSessionKey,
      childRunId: overrides.runId,
      task: overrides.task,
      endedAt: overrides.endedAt,
      outcome: { status: "ok" },
      expectsCompletionMessage: true,
    },
    suspendedReason: "expiry",
    ...deliveryOverrides,
  },
});
