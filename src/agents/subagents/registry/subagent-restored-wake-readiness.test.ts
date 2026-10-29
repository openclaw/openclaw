import { describe, expect, it } from "vitest";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isRestoredRequesterWakeRunnable } from "./subagent-restored-wake-readiness.js";
function row(overrides: Partial<SubagentRunRecord> = {}) {
  return createSubagentRunRecord({
    runId: "child",
    childAgentId: "main",
    childSessionKey: "agent:main:subagent:child",
    requesterAgentId: "main",
    requesterSessionKey: "agent:main:main",
    requesterSettleWake: { status: "dispatching", attemptCount: 1, rearmGeneration: 0 },
    execution: { status: "terminal", startedAt: 1, endedAt: 2 },
    ...overrides,
  });
}
const runnable = (entry: SubagentRunRecord, rows = [entry], pause = false) =>
  isRestoredRequesterWakeRunnable(entry, rows, pause);
describe("restored requester FIFO readiness", () => {
  it("admits a completed cohort but not an unattempted tombstone", () => {
    expect(runnable(row())).toBe(true);
    expect(
      runnable(
        row({ requesterSettleWake: { status: "pending", attemptCount: 0, rearmGeneration: 0 } }),
      ),
    ).toBe(false);
  });
  it.each(["collect", "suppressCompletionDelivery"] as const)("does not admit %s rows", (field) => {
    expect(runnable(row({ [field]: true }))).toBe(false);
  });
  it("blocks unfinished descendants until their exact generation settles", () => {
    const parent = row();
    const child = row({
      runId: "grandchild",
      childSessionKey: "agent:main:subagent:grandchild",
      requesterSessionKey: parent.childSessionKey,
      execution: { status: "running", startedAt: 1 },
    });
    expect(runnable(parent, [parent, child])).toBe(false);
    child.execution = { status: "terminal", startedAt: 1, endedAt: 3 };
    expect(runnable(parent, [parent, child])).toBe(true);
  });
  it("keeps paused children out of normal FIFO and admits only explicit pause notice", () => {
    const child = row({
      pauseReason: "sessions_yield",
      requesterSettleWake: {
        status: "dispatching",
        attemptCount: 1,
        rearmGeneration: 0,
        pauseNotice: { acknowledgment: "Paused" },
      },
    });
    expect(runnable(child)).toBe(false);
    expect(runnable(child, [child], true)).toBe(true);
    child.pauseReason = undefined;
    expect(runnable(child, [child], true)).toBe(false);
  });
  it("blocks interrupted recovery owners including terminal descendants", () => {
    expect(runnable(row({ terminalOwner: "interrupted-recovery" }))).toBe(false);
    const parent = row();
    const child = row({
      runId: "grandchild",
      requesterSessionKey: parent.childSessionKey,
      childSessionKey: "grandchild",
      terminalOwner: "interrupted-recovery",
    });
    expect(runnable(parent, [parent, child])).toBe(false);
  });
  it("never treats a cyclic restored tree as settled", () => {
    const parent = row({ requesterSessionKey: "grandchild" });
    const child = row({
      runId: "grandchild",
      requesterSessionKey: parent.childSessionKey,
      childSessionKey: "grandchild",
    });
    expect(runnable(parent, [parent, child])).toBe(false);
  });
});
