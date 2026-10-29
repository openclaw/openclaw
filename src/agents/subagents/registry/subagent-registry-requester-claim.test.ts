import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { acknowledgeSubagentResultForRequesterTurn } from "./subagent-registry-requester-claim.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
const mocks = vi.hoisted(() => ({
  rows: new Map<string, SubagentRunRecord>(),
  current: true,
  mutate: vi.fn(),
  resume: vi.fn(),
  retire: vi.fn(),
  caller: {
    agentId: "main",
    sessionKey: "agent:main:main",
    operationalRunInstance: { runId: "turn" },
  },
}));
// mock-isolation: Caller identity and reset fencing come from this test turn, not live gateway authority.
vi.mock("../../tools/gateway-caller-context.js", () => ({
  captureGatewayToolCallerAssertion: () => () => {
    if (!mocks.current) {
      throw new Error("requester reset");
    }
  },
  getGatewayToolCallerIdentity: () => mocks.caller,
}));
// mock-isolation: Completion retirement is observed through spies without changing live accepted-spawn state.
vi.mock("../../accepted-session-spawn.js", () => ({
  retireAcceptedSessionSpawnCompletionForRun: mocks.retire,
  mergeAcceptedSessionSpawnsForRun: vi.fn(),
}));
// mock-isolation: Claims operate only on the fixture run map, not the process-wide registry.
vi.mock("./subagent-registry-memory.js", () => ({
  subagentRuns: mocks.rows,
  getSubagentRunsForRequesterSession: () => [],
}));
// mock-isolation: The fixture mutation fence controls reset races without writing the real registry.
vi.mock("./subagent-registry-persistence.js", () => ({ mutateSubagentRuns: mocks.mutate }));
// mock-isolation: Resume and settlement must be observed without starting real subagent work.
vi.mock("./subagent-registry.js", () => ({
  resumeSubagentRun: mocks.resume,
  settleRequesterAfterSessionSpawns: vi.fn(),
}));
const params = {
  runId: "child",
  requesterAgentId: "main",
  requesterSessionKey: "agent:main:main",
  requesterTurnRunId: "turn",
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.current = true;
  mocks.caller.operationalRunInstance.runId = "turn";
  mocks.rows.clear();
  mocks.rows.set(
    "child",
    createSubagentRunRecord({
      ...params,
      expectsCompletionMessage: true,
      execution: { status: "terminal", startedAt: 1, endedAt: 2 },
    }),
  );
  mocks.mutate.mockImplementation(async (_ids, fn, options) => {
    options.assertCurrent();
    const result = fn(mocks.rows);
    options.assertCurrent();
    for (const [id, row] of result.postimages) {
      mocks.rows.set(id, row);
    }
    return result.value;
  });
});
describe("exact requester inline acknowledgement", () => {
  it("consumes the terminal child once for its original turn", async () => {
    await acknowledgeSubagentResultForRequesterTurn(params);
    expect(mocks.rows.get("child")?.expectsCompletionMessage).toBe(false);
    expect(mocks.retire).toHaveBeenCalledOnce();
    expect(mocks.resume).toHaveBeenCalledWith("child");
  });
  it("rejects a caller from another turn before mutation", async () => {
    mocks.caller.operationalRunInstance.runId = "other";
    await expect(acknowledgeSubagentResultForRequesterTurn(params)).rejects.toThrow(
      "admitted requester turn",
    );
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(mocks.retire).not.toHaveBeenCalled();
  });
  it("rejects a reset requester at the persistence fence", async () => {
    mocks.current = false;
    await expect(acknowledgeSubagentResultForRequesterTurn(params)).rejects.toThrow(
      "requester reset",
    );
    expect(mocks.rows.get("child")?.expectsCompletionMessage).toBe(true);
    expect(mocks.retire).not.toHaveBeenCalled();
  });
  it.each(["yielded", "kill"])("does not steal a %s obligation", async (reason) => {
    const row = mocks.rows.get("child")!;
    if (reason === "yielded") {
      row.requesterTurnYielded = true;
    } else {
      row.killIntent = { requestedAt: 3 } as SubagentRunRecord["killIntent"];
    }
    await expect(acknowledgeSubagentResultForRequesterTurn(params)).rejects.toThrow(
      "no longer belongs",
    );
    expect(row.expectsCompletionMessage).toBe(true);
    expect(mocks.retire).not.toHaveBeenCalled();
  });
});
