import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import {
  finalizeRequesterFinalAttachment,
  registerRequesterFinalAttachment,
} from "../requester-final-attachment.js";
import {
  adoptSubagentRunForRequesterTurnInRuns,
  listUnsettledRequesterChildrenInRuns,
  markRequesterTurnYieldedInRuns,
  settleRequesterTurnAfterSessionSpawns,
} from "./subagent-registry-requester-yield.js";
import { createRequesterInitialTransferFixture } from "./subagent-registry-requester-yield.test-support.js";
import { saveSubagentRegistryChangesToSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const REQUESTER = "agent:main:main";
const REQUESTER_TURN = "run-requester";

function finalizeRequesterBatch(runId: string, text: string) {
  finalizeRequesterFinalAttachment({
    requesterAgentId: "main",
    requesterSessionKey: REQUESTER,
    requesterSessionId: "session-main",
    batchRunIds: [runId],
    rearmGeneration: 1,
    requesterYieldBatch: true,
    pause: false,
    delivered: true,
    finalAssistantVisibleText: text,
  });
}

function makeRun(runId: string, requesterTurnYielded = true): SubagentRunRecord {
  return {
    runId,
    requesterTurnRunId: REQUESTER_TURN,
    ...(requesterTurnYielded ? { requesterTurnYielded: true } : {}),
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey: REQUESTER,
    requesterDisplayKey: "main",
    task: "finish",
    cleanup: "keep",
    createdAt: 1_000,
    execution: { status: "terminal", endedAt: 2_000 },
    expectsCompletionMessage: true,
    completion: { required: true },
    delivery: { status: "delivered" },
  };
}

function accepted(entry: SubagentRunRecord) {
  return {
    runId: entry.runId,
    childSessionKey: entry.childSessionKey,
    expectsCompletionMessage: entry.expectsCompletionMessage,
  };
}

function settleRuns(
  entries: SubagentRunRecord[],
  overrides: Partial<Parameters<typeof settleRequesterTurnAfterSessionSpawns>[0]> & {
    beforeWrite?: (...runIds: string[]) => void;
  } = {},
) {
  const { beforeWrite = vi.fn(), ...options } = overrides;
  const runs = options.runs ?? new Map(entries.map((entry) => [entry.runId, entry]));
  return settleRequesterTurnAfterSessionSpawns({
    requesterSessionKey: REQUESTER,
    requesterTurnRunId: REQUESTER_TURN,
    requesterYielded: true,
    acceptedSessionSpawns: entries.map(accepted),
    runs,
    transfer: createRequesterInitialTransferFixture(runs, beforeWrite),
    schedule: vi.fn(),
    ...options,
  });
}

let state: OpenClawTestState;
beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
});
afterAll(() => state.cleanup());

afterEach(() => vi.restoreAllMocks());

describe("adoptSubagentRunForRequesterTurnInRuns", () => {
  function pendingChild(): SubagentRunRecord {
    return {
      ...makeRun("steered-child", false),
      taskRunId: "original-task",
      requesterAgentId: "main",
      requesterTurnRunId: undefined,
      execution: { status: "running", startedAt: 1_000 },
      completion: { required: true },
      delivery: { status: "pending" },
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        batchRunIds: ["steered-child"],
        requesterYieldBatch: true,
        rearmGeneration: 1,
      },
    };
  }

  function adoption(entry: SubagentRunRecord) {
    const runs = new Map([[entry.runId, entry]]);
    saveSubagentRegistryChangesToSqlite(runs, [...runs.keys()]);
    return {
      expected: entry,
      requesterSessionKey: REQUESTER,
      requesterAgentId: "main",
      requesterTurnRunId: REQUESTER_TURN,
      assertCurrent: () => {},
      runs,
    };
  }

  it("retains the pending wake counter and logical task while claiming the current turn", async () => {
    const child = pendingChild();
    const before = structuredClone(child);
    const params = adoption(child);
    const receipt = await adoptSubagentRunForRequesterTurnInRuns(params);
    expect(receipt).toEqual({
      runId: "original-task",
      childSessionKey: child.childSessionKey,
      expectsCompletionMessage: true,
    });
    expect(params.runs.get(child.runId)).toEqual({
      ...before,
      requesterTurnRunId: REQUESTER_TURN,
      requesterTurnYielded: undefined,
      requesterSettleWake: { status: "pending", attemptCount: 0, rearmGeneration: 1 },
    });
    expect(
      await markRequesterTurnYieldedInRuns({
        preparedAuthority: null,
        requesterSessionKey: REQUESTER,
        requesterAgentId: "main",
        requesterTurnRunId: REQUESTER_TURN,
        runs: params.runs,
        transfer: createRequesterInitialTransferFixture(params.runs),
      }),
    ).toBe(1);
  });

  it.each(["before", "after"] as const)(
    "rearms an adopted wake with another child claimed %s adoption",
    async (order) => {
      const child = pendingChild();
      child.runId = `adopted-${order}`;
      child.childSessionKey = `agent:main:subagent:${child.runId}`;
      child.taskRunId = `original-task-${order}`;
      child.requesterSettleWake = {
        status: "pending",
        attemptCount: 0,
        batchRunIds: [child.runId],
        requesterYieldBatch: true,
        rearmGeneration: 1,
      };
      const sibling: SubagentRunRecord = {
        ...makeRun(`sibling-${order}`, false),
        requesterAgentId: "main",
        execution: { status: "running", startedAt: 1_000 },
        completion: { required: true },
        delivery: { status: "pending" },
      };
      const params = adoption(child);
      if (order === "before") {
        params.runs.set(sibling.runId, sibling);
      }
      saveSubagentRegistryChangesToSqlite(params.runs, [...params.runs.keys()]);
      const receipt = await adoptSubagentRunForRequesterTurnInRuns(params);
      if (!receipt) {
        throw new Error("Expected the watched steer to claim its child");
      }
      if (order === "after") {
        params.runs.set(sibling.runId, sibling);
        saveSubagentRegistryChangesToSqlite(params.runs, [sibling.runId]);
      }
      const requester = {
        preparedAuthority: null,
        requesterSessionKey: REQUESTER,
        requesterAgentId: "main",
        requesterTurnRunId: REQUESTER_TURN,
        runs: params.runs,
        transfer: createRequesterInitialTransferFixture(params.runs),
      };
      expect(await markRequesterTurnYieldedInRuns(requester)).toBe(2);
      await expect(
        settleRequesterTurnAfterSessionSpawns({
          ...requester,
          requesterYielded: true,
          acceptedSessionSpawns: [receipt, accepted(sibling)],
          schedule: vi.fn(),
        }),
      ).resolves.toBe(true);
      for (const entry of [child, sibling]) {
        expect(params.runs.get(entry.runId)?.requesterTurnRunId).toBeUndefined();
        expect(params.runs.get(entry.runId)?.requesterSettleWake).toMatchObject({
          requesterYieldBatch: true,
          batchRunIds: [child.runId, sibling.runId],
          rearmGeneration: 2,
        });
      }
    },
  );

  it.each([
    "replaced execution",
    "cancelled",
    "dispatching",
    "different-turn",
    "different-cohort",
    "ordinary-cohort",
    "missing-cohort",
    "retrying-cohort",
  ] as const)("does not take a %s child completion", async (reason) => {
    const child = pendingChild();
    const params = adoption(child);
    if (reason === "replaced execution") {
      params.runs.set(child.runId, { ...child, generation: 2 });
    } else if (reason === "cancelled") {
      child.killIntent = { requestedAt: 2_000, reason: "operator stop" };
    } else if (reason === "dispatching") {
      child.requesterSettleWake = { status: "dispatching", attemptCount: 1 };
    } else if (reason === "different-cohort" || reason === "ordinary-cohort") {
      child.requesterSettleWake = {
        status: "pending",
        attemptCount: 0,
        batchRunIds: [child.runId, "another-child"],
        ...(reason === "different-cohort" ? { requesterYieldBatch: true, rearmGeneration: 1 } : {}),
      };
    } else if (reason === "retrying-cohort") {
      child.requesterSettleWake = {
        status: "pending",
        attemptCount: 1,
        batchRunIds: [child.runId],
        requesterYieldBatch: true,
        rearmGeneration: 1,
      };
    } else if (reason === "missing-cohort") {
      child.requesterSettleWake = {
        status: "pending",
        attemptCount: 0,
        requesterYieldBatch: true,
        rearmGeneration: 1,
      };
    } else {
      child.requesterTurnRunId = "another-live-requester-turn";
    }
    const before = structuredClone(params.runs.get(child.runId));
    saveSubagentRegistryChangesToSqlite(params.runs, [...params.runs.keys()]);
    expect(await adoptSubagentRunForRequesterTurnInRuns(params)).toBeUndefined();
    expect(params.runs.get(child.runId)).toEqual(before);
  });

  it.each(["persistence failure", "revoked caller"] as const)(
    "retains the previous requester claim after an asynchronous %s",
    async (failure) => {
      const child = pendingChild();
      const before = structuredClone(child);
      const params = adoption(child);
      let current = true;
      const execute = stateWorker.runOpenClawStateWorkerOperation;
      vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementationOnce(
        async (...args) => {
          await Promise.resolve();
          if (failure === "revoked caller") {
            current = false;
            return execute(...args);
          }
          throw new Error("storage unavailable");
        },
      );
      await expect(
        adoptSubagentRunForRequesterTurnInRuns({
          ...params,
          assertCurrent: () => {
            if (!current) {
              throw new Error("caller retired");
            }
          },
        }),
      ).rejects.toThrow(failure === "revoked caller" ? "caller retired" : "storage unavailable");
      expect(params.runs.get(child.runId)).toEqual(before);
    },
  );
});

describe("settleRequesterTurnAfterSessionSpawns", () => {
  it.each([false, true])(
    "publishes a nested requester's pause with its wake batch (plan rejection: %s)",
    async (rejectPlan) => {
      const requester: SubagentRunRecord = {
        ...makeRun(REQUESTER_TURN),
        childSessionKey: REQUESTER,
        requesterSessionKey: "agent:main:parent",
        execution: { status: "running", startedAt: 1_000 },
        delivery: { status: "pending" },
      };
      const child = makeRun("run-child");
      const originalRequester = structuredClone(requester);
      const originalChild = structuredClone(child);
      const runs = new Map([
        [requester.runId, requester],
        [child.runId, child],
      ]);
      const schedule = vi.fn(() => {
        expect(runs.get(requester.runId)!.pauseReason).toBe("sessions_yield");
        expect(runs.get(requester.runId)!.execution.status).toBe("terminal");
      });
      const beforeWrite = vi.fn((...runIds: string[]) => {
        expect(runIds).toContain(requester.runId);
        expect(runIds).toContain(child.runId);
        if (beforeWrite.mock.calls.length === 1) {
          expect(runs.get(requester.runId)!.pauseReason).toBeUndefined();
        }
        if (rejectPlan) {
          throw new Error("storage unavailable");
        }
      });
      const settle = async () =>
        await settleRequesterTurnAfterSessionSpawns({
          requesterSessionKey: REQUESTER,
          requesterTurnRunId: REQUESTER_TURN,
          requesterYielded: true,
          acceptedSessionSpawns: [accepted(child)],
          runs,
          transfer: createRequesterInitialTransferFixture(runs, beforeWrite),
          schedule,
        });

      if (rejectPlan) {
        await expect(settle()).rejects.toThrow("storage unavailable");
        expect(runs.get(requester.runId)).toEqual(originalRequester);
        expect(runs.get(child.runId)).toEqual(originalChild);
        expect(schedule).not.toHaveBeenCalled();
      } else {
        expect(await settle()).toBe(true);
        expect(schedule).toHaveBeenCalledOnce();
      }
    },
  );

  it.each(["cancelled", "superseded", "terminal", "different-session"] as const)(
    "does not pause a %s requester while settling its children",
    async (kind) => {
      const requester: SubagentRunRecord = {
        ...makeRun(REQUESTER_TURN),
        childSessionKey: kind === "different-session" ? "agent:main:other" : REQUESTER,
        requesterSessionKey: "agent:main:parent",
        execution: { status: "running", startedAt: 1_000 },
        generation: 1,
        ...(kind === "cancelled"
          ? { killIntent: { requestedAt: 2_000, reason: "killed" as const } }
          : {}),
      };
      if (kind === "terminal") {
        requester.execution = { status: "terminal", endedAt: 2_000, outcome: { status: "ok" } };
      }
      const child = makeRun("run-child");
      const runs = new Map([
        [requester.runId, requester],
        [child.runId, child],
      ]);
      if (kind === "superseded") {
        runs.set("new-requester", { ...requester, runId: "new-requester", generation: 2 });
      }
      const before = structuredClone(requester);
      await settleRequesterTurnAfterSessionSpawns({
        requesterSessionKey: REQUESTER,
        requesterTurnRunId: REQUESTER_TURN,
        requesterYielded: true,
        acceptedSessionSpawns: [accepted(child)],
        runs,
        transfer: createRequesterInitialTransferFixture(runs, () => {}),
        schedule: () => {},
      });
      expect(runs.get(requester.runId)).toEqual(before);
    },
  );

  it("persists explicit yield intent before settlement", async () => {
    const entry = makeRun("run-child", false);
    const runs = new Map([[entry.runId, entry]]);
    const beforeWrite = vi.fn();

    expect(
      await markRequesterTurnYieldedInRuns({
        preparedAuthority: null,
        requesterSessionKey: REQUESTER,
        requesterTurnRunId: REQUESTER_TURN,
        runs,
        transfer: createRequesterInitialTransferFixture(runs, beforeWrite),
      }),
    ).toBe(1);
    expect(runs.get(entry.runId)!.requesterTurnYielded).toBe(true);
    expect(beforeWrite).toHaveBeenCalledOnce();
  });

  it("persists and schedules the exact yielded child batch", async () => {
    const first = makeRun("run-b");
    const second = makeRun("run-a");
    const runs = new Map([
      [first.runId, first],
      [second.runId, second],
    ]);
    const beforeWrite = vi.fn();
    const schedule = vi.fn();

    expect(
      await settleRuns([first, second], {
        runs,
        beforeWrite,
        schedule,
      }),
    ).toBe(true);

    expect(beforeWrite).toHaveBeenCalledTimes(2);
    expect(runs.get(first.runId)!.requesterSettleWake?.batchRunIds).toEqual(["run-a", "run-b"]);
    expect(runs.get(second.runId)!.requesterSettleWake?.batchRunIds).toEqual(["run-a", "run-b"]);
    expect(runs.get(first.runId)!.requesterSettleWake).toMatchObject({
      requesterYieldBatch: true,
      afterRequesterYield: true,
      rearmGeneration: 1,
    });
    expect(runs.get(first.runId)!.requesterTurnRunId).toBeUndefined();
    expect(schedule).toHaveBeenCalledOnce();
    expect(
      loadSubagentRegistryFromSqlite().get(first.runId)?.requesterSettleWake?.batchRunIds,
    ).toEqual(["run-a", "run-b"]);
  });

  it.each([undefined, 1_000])(
    "starts a private delivery window on normal release without renewing an existing window (%s)",
    async (windowStartedAt) => {
      const entry = makeRun("private-child", false);
      entry.completionTarget = "parent";
      entry.delivery = {
        status: "pending",
        ...(windowStartedAt === undefined
          ? {}
          : { windowStartedAt, deadlineAt: windowStartedAt + 30 * 60_000 }),
      };
      const releasedAt = Date.now();
      const runs = new Map([[entry.runId, entry]]);
      const beforeWrite = vi.fn();

      expect(
        await settleRequesterTurnAfterSessionSpawns({
          requesterSessionKey: REQUESTER,
          requesterTurnRunId: REQUESTER_TURN,
          requesterYielded: false,
          acceptedSessionSpawns: [accepted(entry)],
          runs,
          transfer: createRequesterInitialTransferFixture(runs, beforeWrite),
          schedule: vi.fn(),
        }),
      ).toBe(true);
      expect(beforeWrite).toHaveBeenCalledOnce();
      expect(runs.get(entry.runId)!.delivery?.windowStartedAt).toBeGreaterThanOrEqual(
        windowStartedAt ?? releasedAt,
      );
      expect(runs.get(entry.runId)!.delivery?.deadlineAt).toBe(
        (runs.get(entry.runId)?.delivery?.windowStartedAt ?? 0) + 30 * 60_000,
      );

      if (windowStartedAt !== undefined) {
        expect(runs.get(entry.runId)!.delivery?.windowStartedAt).toBe(windowStartedAt);
      }
    },
  );

  it("promotes the requester attachment only after durable settlement", async () => {
    const entry = makeRun("run-child");
    const runs = new Map([[entry.runId, entry]]);
    entry.requesterAgentId = "main";
    const append = vi.fn(() => true);
    registerRequesterFinalAttachment({
      requesterAgentId: "main",
      requesterSessionKey: REQUESTER,
      requesterSessionId: "session-main",
      requesterTurnRunId: REQUESTER_TURN,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      timeoutMs: 60_000,
      append,
    });
    let persistenceStage = 0;
    const beforeWrite = vi.fn(() => {
      if (++persistenceStage === 2) {
        expect(runs.get(entry.runId)!.requesterTurnRunId).toBe(REQUESTER_TURN);
        expect(append).not.toHaveBeenCalled();
        return;
      }
      expect(runs.get(entry.runId)!.requesterTurnRunId).toBe(REQUESTER_TURN);
      finalizeRequesterBatch(entry.runId, "too early");
      expect(append).not.toHaveBeenCalled();
    });

    expect(
      await settleRuns([entry], {
        runs,
        requesterAgentId: "main",
        beforeWrite,
      }),
    ).toBe(true);
    expect(beforeWrite).toHaveBeenCalledTimes(2);
    finalizeRequesterBatch(entry.runId, "settled");
    expect(append).toHaveBeenCalledExactlyOnceWith("settled");
  });

  it("does not promote requester attachment when the admitted plan rejects", async () => {
    const entry = makeRun("run-child-failed");
    const runs = new Map([[entry.runId, entry]]);
    entry.requesterAgentId = "main";
    const append = vi.fn(() => true);
    registerRequesterFinalAttachment({
      requesterAgentId: "main",
      requesterSessionKey: REQUESTER,
      requesterSessionId: "session-main",
      requesterTurnRunId: REQUESTER_TURN,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      timeoutMs: 60_000,
      append,
    });

    await expect(
      settleRuns([entry], {
        runs,
        requesterAgentId: "main",
        beforeWrite: () => {
          throw new Error("persist failed");
        },
      }),
    ).rejects.toThrow("persist failed");
    finalizeRequesterBatch(entry.runId, "must not append");
    expect(append).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "does not transfer a partial accepted completion batch (yielded: %s)",
    async (requesterYielded) => {
      const first = makeRun("run-a");
      const missing = makeRun("run-b");
      const runs = new Map([[first.runId, first]]);
      const before = structuredClone(runs);
      const beforeWrite = vi.fn();
      const schedule = vi.fn();

      expect(
        await settleRuns([first, missing], {
          requesterYielded,
          runs,
          transfer: createRequesterInitialTransferFixture(runs, beforeWrite),
          schedule,
        }),
      ).toBe(false);
      expect(runs).toEqual(before);
      expect(beforeWrite).not.toHaveBeenCalled();
      expect(schedule).not.toHaveBeenCalled();
    },
  );

  it("retires a completed yielded batch whose requester already produced its final", async () => {
    const entry = makeRun("run-child");
    const runs = new Map([[entry.runId, entry]]);
    entry.cleanupCompletedAt = 2_100;
    entry.delivery = {
      status: "delivered",
      requesterVisibleFinal: { requesterTurnRunId: REQUESTER_TURN, batchRunIds: [entry.runId] },
    };
    entry.requesterSettleWake = { status: "pending", attemptCount: 0 };
    const schedule = vi.fn();

    expect(
      await settleRuns([entry], {
        runs,
        schedule,
      }),
    ).toBe(true);
    expect(runs.get(entry.runId)!.requesterSettleWake).toBeUndefined();
    expect(runs.get(entry.runId)!.requesterTurnRunId).toBeUndefined();
    expect(runs.get(entry.runId)!.delivery?.requesterVisibleFinal).toBeUndefined();
    expect(schedule).not.toHaveBeenCalled();
  });

  it.each([
    [
      "another requester turn",
      (entry: SubagentRunRecord) => {
        entry.delivery!.requesterVisibleFinal!.requesterTurnRunId = "run-other";
      },
    ],
    [
      "changed child membership",
      (entry: SubagentRunRecord) => {
        entry.delivery!.requesterVisibleFinal!.batchRunIds.push("run-later");
      },
    ],
    [
      "unfinished cleanup",
      (entry: SubagentRunRecord) => {
        entry.cleanupCompletedAt = undefined;
      },
    ],
    [
      "unfinished delivery",
      (entry: SubagentRunRecord) => {
        entry.delivery!.status = "in_progress";
      },
    ],
    [
      "a replayed running child",
      (entry: SubagentRunRecord) => {
        entry.execution.status = "running";
      },
    ],
  ] as const)("keeps requester settlement when the final receipt has %s", async (_, invalidate) => {
    const entry = makeRun("run-child");
    entry.cleanupCompletedAt = 2_100;
    entry.delivery = {
      status: "delivered",
      requesterVisibleFinal: { requesterTurnRunId: REQUESTER_TURN, batchRunIds: [entry.runId] },
    };
    invalidate(entry);
    const runs = new Map([[entry.runId, entry]]);

    expect(await settleRuns([entry], { runs })).toBe(true);
    expect(runs.get(entry.runId)!.requesterSettleWake?.requesterYieldBatch).toBe(true);
  });

  it.each([
    ["matches", "agent:main:subagent:worker", true],
    ["rejects", "agent:main:subagent:other", false],
  ] as const)(
    "%s the exact child session after same-turn steer",
    async (_, sessionKey, expected) => {
      const originalRunId = "run-original";
      const entry = makeRun("run-steered", false);
      entry.taskRunId = originalRunId;
      entry.childSessionKey = "agent:main:subagent:worker";
      const runs = new Map([[entry.runId, entry]]);
      const beforeWrite = vi.fn();
      const schedule = vi.fn();

      expect(
        await markRequesterTurnYieldedInRuns({
          preparedAuthority: null,
          requesterSessionKey: REQUESTER,
          requesterTurnRunId: REQUESTER_TURN,
          runs,
          transfer: createRequesterInitialTransferFixture(runs, beforeWrite),
        }),
      ).toBe(1);
      expect(
        await settleRuns([entry], {
          runs,
          acceptedSessionSpawns: [
            { runId: originalRunId, childSessionKey: sessionKey, expectsCompletionMessage: true },
          ],
          transfer: createRequesterInitialTransferFixture(runs, beforeWrite),
          schedule,
        }),
      ).toBe(expected);
      expect(beforeWrite).toHaveBeenCalledTimes(expected ? 3 : 1);
      if (expected) {
        expect(runs.get(entry.runId)!.requesterSettleWake?.batchRunIds).toEqual([entry.runId]);
        expect(schedule).toHaveBeenCalledExactlyOnceWith(
          entry.runId,
          runs.get(entry.runId),
          "settle",
        );
      } else {
        expect(runs.get(entry.runId)!.requesterSettleWake).toBeUndefined();
        expect(runs.get(entry.runId)!.requesterTurnRunId).toBe(REQUESTER_TURN);
        expect(schedule).not.toHaveBeenCalled();
      }
    },
  );

  it("freezes active yielded children without scheduling before terminal delivery", async () => {
    const entry = makeRun("run-child");
    const runs = new Map([[entry.runId, entry]]);
    entry.execution = { ...entry.execution, status: "running", endedAt: undefined };
    entry.delivery = { status: "pending" };
    const schedule = vi.fn();

    expect(
      await settleRuns([entry], {
        runs,
        schedule,
      }),
    ).toBe(true);
    expect(runs.get(entry.runId)!.requesterSettleWake).toMatchObject({
      batchRunIds: [entry.runId],
      requesterYieldBatch: true,
    });
    expect(runs.get(entry.runId)!.requesterSettleWake?.afterRequesterYield).toBeUndefined();
    expect(schedule).not.toHaveBeenCalled();
  });

  it("persists a mixed delivered and in-progress yielded batch before scheduling", async () => {
    const alpha = makeRun("run-alpha");
    const beta = makeRun("run-beta");
    const runs = new Map([
      [alpha.runId, alpha],
      [beta.runId, beta],
    ]);
    beta.delivery = { status: "in_progress" };
    const calls: string[] = [];
    const beforeWrite = vi.fn(() => calls.push("persist"));
    const schedule = vi.fn(() => calls.push("schedule"));

    expect(
      await settleRuns([alpha, beta], {
        runs,
        beforeWrite,
        schedule,
      }),
    ).toBe(true);

    const frozenState = {
      status: "pending",
      attemptCount: 0,
      batchRunIds: ["run-alpha", "run-beta"],
      requesterYieldBatch: true,
      yieldedFinalDeliverable: true,
      afterRequesterYield: true,
      rearmGeneration: 1,
    } as const;
    expect(runs.get(alpha.runId)!.requesterSettleWake).toEqual(frozenState);
    expect(runs.get(beta.runId)!.requesterSettleWake).toEqual(frozenState);
    expect(runs.get(alpha.runId)!.requesterTurnRunId).toBeUndefined();
    expect(runs.get(beta.runId)!.requesterTurnRunId).toBeUndefined();
    expect(runs.get(beta.runId)!.delivery?.disposition).toBe("intentional_non_delivery");
    expect(calls).toEqual(["persist", "persist", "schedule"]);
    expect(schedule).toHaveBeenCalledExactlyOnceWith(alpha.runId, runs.get(alpha.runId), "settle");
  });

  it.each([true, false])(
    "ignores same-turn non-completion spawns during settlement (yielded: %s)",
    async (requesterYielded) => {
      const completion = makeRun("run-completion", false);
      const inline = makeRun("run-inline", false);
      inline.expectsCompletionMessage = false;
      inline.delivery = { status: "not_required" };
      const runs = new Map([
        [inline.runId, inline],
        [completion.runId, completion],
      ]);
      const beforeWrite = vi.fn();
      const schedule = vi.fn();

      if (requesterYielded) {
        expect(
          await markRequesterTurnYieldedInRuns({
            preparedAuthority: null,
            requesterSessionKey: REQUESTER,
            requesterTurnRunId: REQUESTER_TURN,
            runs,
            transfer: createRequesterInitialTransferFixture(runs, beforeWrite),
          }),
        ).toBe(1);
      }

      expect(
        await settleRuns([inline, completion], {
          runs,
          requesterYielded,
          transfer: createRequesterInitialTransferFixture(runs, beforeWrite),
          schedule,
        }),
      ).toBe(true);
      expect(beforeWrite.mock.calls).toEqual(
        requesterYielded
          ? [[completion.runId], [completion.runId], [completion.runId]]
          : [[completion.runId]],
      );
      if (requesterYielded) {
        expect(runs.get(completion.runId)!.requesterSettleWake).toMatchObject({
          batchRunIds: [completion.runId],
          afterRequesterYield: true,
        });
        expect(schedule).toHaveBeenCalledExactlyOnceWith(
          completion.runId,
          runs.get(completion.runId),
          "settle",
        );
      } else {
        expect(runs.get(completion.runId)!.requesterSettleWake).toBeUndefined();
        expect(schedule).toHaveBeenCalledExactlyOnceWith(
          completion.runId,
          runs.get(completion.runId),
          "settle",
        );
      }
      expect(runs.get(inline.runId)!.requesterTurnRunId).toBe(REQUESTER_TURN);
      expect(runs.get(inline.runId)!.requesterTurnYielded).toBeUndefined();
      expect(runs.get(inline.runId)!.requesterSettleWake).toBeUndefined();
    },
  );

  it("re-arms a delivered delete-mode row retained through requester settlement", async () => {
    const entry = makeRun("run-delete");
    entry.cleanup = "delete";
    entry.cleanupCompletedAt = 2_100;
    entry.retireAfterRequesterTurn = true;
    const runs = new Map([[entry.runId, entry]]);

    expect(
      await settleRuns([entry], {
        runs,
      }),
    ).toBe(true);
    expect(runs.get(entry.runId)).toMatchObject({ runId: entry.runId });
    expect(runs.get(entry.runId)!.requesterSettleWake).toMatchObject({
      afterRequesterYield: true,
      retireAfterSettle: true,
    });
    expect(runs.get(entry.runId)!.retireAfterRequesterTurn).toBeUndefined();
  });

  it("retires a delete-mode row after its requester-owned final is already delivered", async () => {
    const entry = makeRun("run-delete");
    entry.cleanup = "delete";
    entry.cleanupCompletedAt = 2_100;
    entry.retireAfterRequesterTurn = true;
    entry.delivery = {
      status: "delivered",
      requesterVisibleFinal: { requesterTurnRunId: REQUESTER_TURN, batchRunIds: [entry.runId] },
    };
    const runs = new Map([[entry.runId, entry]]);

    expect(
      await settleRuns([entry], {
        runs,
      }),
    ).toBe(true);
    expect(runs.has(entry.runId)).toBe(false);
  });

  it("retires a completed delete-mode row after a normal requester answer", async () => {
    const entry = makeRun("run-delete", false);
    entry.retireAfterRequesterTurn = true;
    const runs = new Map([[entry.runId, entry]]);

    expect(
      await settleRuns([entry], {
        runs,
        requesterYielded: false,
      }),
    ).toBe(true);
    expect(runs.has(entry.runId)).toBe(false);
  });

  it("leaves every published row unchanged when the admitted plan rejects", async () => {
    const entry = makeRun("run-delete", false);
    entry.retireAfterRequesterTurn = true;
    const runs = new Map([[entry.runId, entry]]);
    const failure = new Error("sqlite unavailable");

    await expect(
      settleRuns([entry], {
        requesterYielded: false,
        runs,
        beforeWrite: () => {
          throw failure;
        },
      }),
    ).rejects.toMatchObject({ outcome: "not-committed", cause: failure });
    expect(runs.get(entry.runId)).toMatchObject({ runId: entry.runId });
    expect(runs.get(entry.runId)!.requesterTurnRunId).toBe(REQUESTER_TURN);
    expect(runs.get(entry.runId)!.retireAfterRequesterTurn).toBe(true);
  });
});

describe("listUnsettledRequesterChildrenInRuns", () => {
  const NOW = 10_000;

  function runningRun(
    runId: string,
    overrides: Partial<SubagentRunRecord> = {},
  ): SubagentRunRecord {
    return {
      ...makeRun(runId, false),
      requesterTurnRunId: undefined,
      execution: { status: "running", startedAt: NOW - 1_000 },
      delivery: { status: "pending" },
      ...overrides,
    };
  }

  it("lists running and undelivered children owned by earlier turns or armed wakes", () => {
    const yielded = runningRun("run-yielded", {
      label: "Work session",
      requesterSettleWake: { status: "pending", attemptCount: 0, requesterYieldBatch: true },
    });
    const earlierTurn = runningRun("run-earlier", { requesterTurnRunId: "run-turn-0" });
    const completing = runningRun("run-completing", {
      execution: { status: "terminal", startedAt: NOW - 3_000, endedAt: NOW - 100 },
      delivery: { status: "in_progress" },
    });
    const runs = new Map(
      [yielded, earlierTurn, completing].map((entry) => [entry.runId, entry] as const),
    );

    expect(
      listUnsettledRequesterChildrenInRuns({
        requesterSessionKey: REQUESTER,
        requesterAgentId: undefined,
        excludeRequesterTurnRunId: "run-turn-2",
        runs,
        now: NOW,
      }),
    ).toEqual([
      {
        runId: "run-completing",
        childSessionKey: "agent:main:subagent:run-completing",
        startedAt: NOW - 3_000,
        state: "completing",
        wakeArmed: false,
      },
      {
        runId: "run-yielded",
        childSessionKey: "agent:main:subagent:run-yielded",
        label: "Work session",
        startedAt: NOW - 1_000,
        state: "running",
        wakeArmed: true,
      },
      {
        runId: "run-earlier",
        childSessionKey: "agent:main:subagent:run-earlier",
        startedAt: NOW - 1_000,
        state: "running",
        wakeArmed: false,
      },
    ]);
  });

  it.each([
    { name: "the current turn's own child", overrides: { requesterTurnRunId: "run-turn-2" } },
    {
      name: "a delivered child",
      overrides: {
        execution: { status: "terminal", endedAt: NOW - 1 },
        delivery: { status: "delivered" },
      },
    },
    { name: "a collector run", overrides: { collect: true } },
    {
      name: "a child without a completion obligation",
      overrides: { expectsCompletionMessage: false },
    },
    {
      name: "a child being killed",
      overrides: { killIntent: { requestedAt: NOW, reason: "stop" } },
    },
    { name: "another requester's child", overrides: { requesterSessionKey: "agent:main:other" } },
    { name: "another agent's child", overrides: { requesterAgentId: "other" } },
  ] as const)("omits $name", ({ overrides }) => {
    const entry = runningRun("run-child", { requesterAgentId: "main", ...overrides });
    expect(
      listUnsettledRequesterChildrenInRuns({
        requesterSessionKey: REQUESTER,
        requesterAgentId: "main",
        excludeRequesterTurnRunId: "run-turn-2",
        runs: new Map([[entry.runId, entry]]),
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("reports a child paused by its own sessions_yield as paused, not completing", () => {
    const paused = runningRun("run-paused", {
      execution: { status: "terminal", startedAt: NOW - 2_000, endedAt: NOW - 500 },
      pauseReason: "sessions_yield",
      delivery: { status: "pending" },
      requesterSettleWake: { status: "pending", attemptCount: 0, requesterYieldBatch: true },
    });
    expect(
      listUnsettledRequesterChildrenInRuns({
        requesterSessionKey: REQUESTER,
        runs: new Map([[paused.runId, paused]]),
        now: NOW,
      }),
    ).toEqual([
      {
        runId: "run-paused",
        childSessionKey: "agent:main:subagent:run-paused",
        startedAt: NOW - 2_000,
        state: "paused",
        wakeArmed: true,
      },
    ]);
  });

  it("does not let a superseded generation stand in for a killed successor", () => {
    const superseded = runningRun("run-gen-1", { generation: 1 });
    const killed = runningRun("run-gen-2", {
      generation: 2,
      childSessionKey: superseded.childSessionKey,
      killIntent: { requestedAt: NOW, reason: "stop" },
    });
    expect(
      listUnsettledRequesterChildrenInRuns({
        requesterSessionKey: REQUESTER,
        runs: new Map([
          [superseded.runId, superseded],
          [killed.runId, killed],
        ]),
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("reports only the latest generation of a steered child session", () => {
    const superseded = runningRun("run-gen-1", {
      generation: 1,
      execution: { status: "terminal", startedAt: NOW - 2_000, endedAt: NOW - 1_500 },
      delivery: { status: "pending" },
    });
    const current = runningRun("run-gen-2", {
      generation: 2,
      childSessionKey: superseded.childSessionKey,
    });
    expect(
      listUnsettledRequesterChildrenInRuns({
        requesterSessionKey: REQUESTER,
        runs: new Map([
          [superseded.runId, superseded],
          [current.runId, current],
        ]),
        now: NOW,
      }).map((child) => child.runId),
    ).toEqual(["run-gen-2"]);
  });
});
