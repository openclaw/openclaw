import { describe, expect, it, vi } from "vitest";
import { resumeRequesterSettleWakeAfterYield } from "./subagent-registry-requester-yield.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const REQUESTER = "agent:main:main";

function makeDeliveredRun(runId: string): SubagentRunRecord {
  return {
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey: REQUESTER,
    requesterDisplayKey: "main",
    task: "finish",
    cleanup: "keep",
    createdAt: 1_000,
    endedAt: 2_000,
    expectsCompletionMessage: true,
    delivery: { status: "delivered" },
  };
}

describe("resumeRequesterSettleWakeAfterYield", () => {
  it("persists and schedules the exact delivered child batch", () => {
    const first = makeDeliveredRun("run-b");
    const second = makeDeliveredRun("run-a");
    const persistOrThrow = vi.fn();
    const schedule = vi.fn();

    expect(
      resumeRequesterSettleWakeAfterYield({
        requesterSessionKey: REQUESTER,
        acceptedSessionSpawns: [
          { runId: first.runId, childSessionKey: first.childSessionKey },
          { runId: second.runId, childSessionKey: second.childSessionKey },
        ],
        runs: new Map([
          [first.runId, first],
          [second.runId, second],
        ]),
        persistOrThrow,
        schedule,
      }),
    ).toBe(true);

    expect(persistOrThrow).toHaveBeenCalledOnce();
    expect(first.requesterSettleWake?.batchRunIds).toEqual(["run-a", "run-b"]);
    expect(second.requesterSettleWake?.batchRunIds).toEqual(["run-a", "run-b"]);
    expect(first.requesterSettleWake).toMatchObject({
      afterRequesterYield: true,
      rearmGeneration: 1,
    });
    expect(schedule).toHaveBeenCalledOnce();
  });

  it("rejects an undelivered spawn record", () => {
    const entry = makeDeliveredRun("run-child");
    entry.delivery = { status: "pending" };
    const schedule = vi.fn();

    expect(
      resumeRequesterSettleWakeAfterYield({
        requesterSessionKey: REQUESTER,
        acceptedSessionSpawns: [{ runId: entry.runId, childSessionKey: entry.childSessionKey }],
        runs: new Map([[entry.runId, entry]]),
        persistOrThrow: vi.fn(),
        schedule,
      }),
    ).toBe(false);
    expect(entry.requesterSettleWake).toBeUndefined();
    expect(schedule).not.toHaveBeenCalled();
  });

  it("rolls back every row when durable persistence fails", () => {
    const first = makeDeliveredRun("run-a");
    const second = makeDeliveredRun("run-b");
    const failure = new Error("sqlite unavailable");

    expect(() =>
      resumeRequesterSettleWakeAfterYield({
        requesterSessionKey: REQUESTER,
        acceptedSessionSpawns: [
          { runId: first.runId, childSessionKey: first.childSessionKey },
          { runId: second.runId, childSessionKey: second.childSessionKey },
        ],
        runs: new Map([
          [first.runId, first],
          [second.runId, second],
        ]),
        persistOrThrow: () => {
          throw failure;
        },
        schedule: vi.fn(),
      }),
    ).toThrow(failure);
    expect(first.requesterSettleWake).toBeUndefined();
    expect(second.requesterSettleWake).toBeUndefined();
  });
});
