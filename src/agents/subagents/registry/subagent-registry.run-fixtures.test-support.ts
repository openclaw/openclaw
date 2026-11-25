import type { SubagentRunRecordOverrides } from "../../subagent-test-fixtures.test-helpers.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type KilledRunOverrides = SubagentRunRecordOverrides &
  Pick<SubagentRunRecord, "task" | "createdAt">;
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
