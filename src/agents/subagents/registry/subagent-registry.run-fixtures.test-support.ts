import { expectDefined } from "@openclaw/normalization-core/expect";
import type { SubagentRunRecordOverrides } from "../../subagent-test-fixtures.test-helpers.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
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

export async function updateSubagentRunFixture(
  runId: string,
  update: (entry: SubagentRunRecord) => void,
) {
  await mutateSubagentRuns([runId], (rows) => {
    const current = expectDefined(rows.get(runId), "registered fixture run");
    const next = structuredClone(current);
    update(next);
    return { value: undefined, postimages: new Map([[runId, next]]) };
  });
}
