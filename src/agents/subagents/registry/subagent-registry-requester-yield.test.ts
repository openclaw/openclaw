import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import {
  consumeRequesterFinalAttachment,
  registerRequesterFinalAttachment,
} from "../requester-final-attachment.js";
import {
  adoptSubagentRunForRequesterTurnInRuns,
  listUnsettledRequesterChildrenInRuns,
  markRequesterTurnYieldedInRuns,
  settleRequesterTurnAfterSessionSpawns,
} from "./subagent-registry-requester-yield.js";
import { createRequesterInitialTransferFixture } from "./subagent-registry-requester-yield.test-support.js";
import { persistSubagentRunsToDiskAsyncOrThrow } from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const REQUESTER = "agent:main:main";
const REQUESTER_TURN = "run-requester";

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
    persistOrThrow?: (...runIds: string[]) => void;
  } = {},
) {
  const { persistOrThrow = vi.fn(), ...options } = overrides;
  const runs = options.runs ?? new Map(entries.map((entry) => [entry.runId, entry]));
  return settleRequesterTurnAfterSessionSpawns({
    requesterSessionKey: REQUESTER,
    requesterTurnRunId: REQUESTER_TURN,
    requesterYielded: true,
    acceptedSessionSpawns: entries.map(accepted),
    runs,
    transfer: createRequesterInitialTransferFixture(runs, persistOrThrow),
    schedule: vi.fn(),
    ...options,
  });
}

describe("adoptSubagentRunForRequesterTurnInRuns", () => {
  let state: OpenClawTestState;
  beforeAll(async () => {
    state = await createOpenClawTestState({ scenario: "minimal" });
  });
  afterAll(async () => {
    await state.cleanup();
  });

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
    const persist: Parameters<typeof adoptSubagentRunForRequesterTurnInRuns>[0]["persist"] = (
      context,
      callbacks,
      ...runIds
    ) => persistSubagentRunsToDiskAsyncOrThrow(runs, runIds, { ...callbacks, context });
    return {
      expected: entry,
      requesterSessionKey: REQUESTER,
      requesterAgentId: "main",
      requesterTurnRunId: REQUESTER_TURN,
      assertCurrent: () => {},
      runs,
      persist,
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
    expect(child).toEqual({
      ...before,
      requesterTurnRunId: REQUESTER_TURN,
      requesterTurnYielded: undefined,
      requesterSettleWake: { status: "pending", attemptCount: 0, rearmGeneration: 1 },
    });
    expect(
      await markRequesterTurnYieldedInRuns({
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
      const context = captureOpenClawStateWorkerContext();
      if (order === "before") {
        params.runs.set(sibling.runId, sibling);
      }
      await persistSubagentRunsToDiskAsyncOrThrow(params.runs, [...params.runs.keys()], {
        context,
      });
      const receipt = await adoptSubagentRunForRequesterTurnInRuns(params);
      if (!receipt) {
        throw new Error("Expected the watched steer to claim its child");
      }
      if (order === "after") {
        params.runs.set(sibling.runId, sibling);
        await persistSubagentRunsToDiskAsyncOrThrow(params.runs, [sibling.runId], { context });
      }
      const requester = {
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
        expect(entry.requesterTurnRunId).toBeUndefined();
        expect(entry.requesterSettleWake).toMatchObject({
          requesterYieldBatch: true,
          batchRunIds: [child.runId, sibling.runId],
          rearmGeneration: 2,
        });
      }
    },
  );

  it.each([
    "stale",
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
    if (reason === "stale") {
      params.runs.set(child.runId, structuredClone(child));
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
    const before = structuredClone(child);
    const persist = vi.fn(async () => {});
    expect(await adoptSubagentRunForRequesterTurnInRuns({ ...params, persist })).toBeUndefined();
    expect(persist).not.toHaveBeenCalled();
    expect(child).toEqual(before);
  });

  it.each(["persistence failure", "revoked caller"] as const)(
    "retains the previous requester claim after an asynchronous %s",
    async (failure) => {
      const child = pendingChild();
      const before = structuredClone(child);
      const params = adoption(child);
      let current = true;
      await expect(
        adoptSubagentRunForRequesterTurnInRuns({
          ...params,
          assertCurrent: () => {
            if (!current) {
              throw new Error("caller retired");
            }
          },
          persist: async (_context, callbacks) => {
            await Promise.resolve();
            if (failure === "revoked caller") {
              current = false;
              callbacks.assertCurrent();
            }
            throw new Error("storage unavailable");
          },
        }),
      ).rejects.toThrow(failure === "revoked caller" ? "caller retired" : "storage unavailable");
      expect(child).toEqual(before);
    },
  );
});

describe("settleRequesterTurnAfterSessionSpawns", () => {
  it.each([false, true])(
    "publishes a nested requester's pause with its wake batch (persistence failure: %s)",
    async (failPersistence) => {
      const requester: SubagentRunRecord = {
        ...makeRun(REQUESTER_TURN),
        childSessionKey: REQUESTER,
        requesterSessionKey: "agent:main:parent",
        execution: { status: "running", startedAt: 1_000 },
        delivery: undefined,
      };
      const child = makeRun("run-child");
      const originalRequester = structuredClone(requester);
      const originalChild = structuredClone(child);
      const runs = new Map([
        [requester.runId, requester],
        [child.runId, child],
      ]);
      const schedule = vi.fn(() => {
        expect(requester.pauseReason).toBe("sessions_yield");
        expect(requester.execution.status).toBe("terminal");
      });
      const persistOrThrow = vi.fn((...runIds: string[]) => {
        expect(runIds).toContain(requester.runId);
        expect(runIds).toContain(child.runId);
        expect(requester.pauseReason).toBe("sessions_yield");
        if (failPersistence) {
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
          transfer: createRequesterInitialTransferFixture(runs, persistOrThrow),
          schedule,
        });

      if (failPersistence) {
        await expect(settle()).rejects.toThrow("storage unavailable");
        expect(requester).toEqual(originalRequester);
        expect(child).toEqual(originalChild);
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
      expect(requester).toEqual(before);
    },
  );

  it("persists explicit yield intent before settlement", async () => {
    const entry = makeRun("run-child", false);
    const runs = new Map([[entry.runId, entry]]);
    const persistOrThrow = vi.fn();

    expect(
      await markRequesterTurnYieldedInRuns({
        requesterSessionKey: REQUESTER,
        requesterTurnRunId: REQUESTER_TURN,
        runs,
        transfer: createRequesterInitialTransferFixture(runs, persistOrThrow),
      }),
    ).toBe(1);
    expect(entry.requesterTurnYielded).toBe(true);
    expect(persistOrThrow).toHaveBeenCalledOnce();
  });

  it("persists and schedules the exact yielded child batch", async () => {
    const first = makeRun("run-b");
    const second = makeRun("run-a");
    const persistOrThrow = vi.fn();
    const schedule = vi.fn();

    expect(
      await settleRuns([first, second], {
        persistOrThrow,
        schedule,
      }),
    ).toBe(true);

    expect(persistOrThrow).toHaveBeenCalledTimes(2);
    expect(first.requesterSettleWake?.batchRunIds).toEqual(["run-a", "run-b"]);
    expect(second.requesterSettleWake?.batchRunIds).toEqual(["run-a", "run-b"]);
    expect(first.requesterSettleWake).toMatchObject({
      requesterYieldBatch: true,
      afterRequesterYield: true,
      rearmGeneration: 1,
    });
    expect(first.requesterTurnRunId).toBeUndefined();
    expect(schedule).toHaveBeenCalledOnce();
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
      const persistOrThrow = vi.fn(() => {
        expect(entry.delivery?.windowStartedAt).toBeGreaterThanOrEqual(
          windowStartedAt ?? releasedAt,
        );
        expect(entry.delivery?.deadlineAt).toBe(
          (entry.delivery?.windowStartedAt ?? 0) + 30 * 60_000,
        );
      });

      expect(
        await settleRequesterTurnAfterSessionSpawns({
          requesterSessionKey: REQUESTER,
          requesterTurnRunId: REQUESTER_TURN,
          requesterYielded: false,
          acceptedSessionSpawns: [accepted(entry)],
          runs,
          transfer: createRequesterInitialTransferFixture(runs, persistOrThrow),
          schedule: vi.fn(),
        }),
      ).toBe(true);
      expect(persistOrThrow).toHaveBeenCalledOnce();
      if (windowStartedAt !== undefined) {
        expect(entry.delivery?.windowStartedAt).toBe(windowStartedAt);
      }
    },
  );

  it("promotes the requester attachment only after durable settlement", async () => {
    const entry = makeRun("run-child");
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
    const persistOrThrow = vi.fn(() => {
      if (++persistenceStage === 2) {
        expect(entry.requesterTurnRunId).toBeUndefined();
        expect(append).not.toHaveBeenCalled();
        return;
      }
      expect(entry.requesterTurnRunId).toBe(REQUESTER_TURN);
      expect(
        consumeRequesterFinalAttachment({
          requesterAgentId: "main",
          requesterSessionKey: REQUESTER,
          requesterSessionId: "session-main",
          batchRunIds: [entry.runId],
          rearmGeneration: 1,
          text: "too early",
        }),
      ).toBe("missing");
    });

    expect(
      await settleRuns([entry], {
        requesterAgentId: "main",
        persistOrThrow,
      }),
    ).toBe(true);
    expect(persistOrThrow).toHaveBeenCalledTimes(2);
    expect(
      consumeRequesterFinalAttachment({
        requesterAgentId: "main",
        requesterSessionKey: REQUESTER,
        requesterSessionId: "session-main",
        batchRunIds: [entry.runId],
        rearmGeneration: 1,
        text: "settled",
      }),
    ).toBe("appended");
    expect(append).toHaveBeenCalledExactlyOnceWith("settled");
  });

  it("does not promote requester attachment when durable settlement fails", async () => {
    const entry = makeRun("run-child-failed");
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
        requesterAgentId: "main",
        persistOrThrow: () => {
          throw new Error("persist failed");
        },
      }),
    ).rejects.toThrow("persist failed");
    expect(
      consumeRequesterFinalAttachment({
        requesterAgentId: "main",
        requesterSessionKey: REQUESTER,
        requesterSessionId: "session-main",
        batchRunIds: [entry.runId],
        rearmGeneration: 1,
        text: "must not append",
      }),
    ).toBe("missing");
    expect(append).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "does not transfer a partial accepted completion batch (yielded: %s)",
    async (requesterYielded) => {
      const first = makeRun("run-a");
      const missing = makeRun("run-b");
      const runs = new Map([[first.runId, first]]);
      const before = structuredClone(runs);
      const persistOrThrow = vi.fn();
      const schedule = vi.fn();

      expect(
        await settleRuns([first, missing], {
          requesterYielded,
          runs,
          transfer: createRequesterInitialTransferFixture(runs, persistOrThrow),
          schedule,
        }),
      ).toBe(false);
      expect(runs).toEqual(before);
      expect(persistOrThrow).not.toHaveBeenCalled();
      expect(schedule).not.toHaveBeenCalled();
    },
  );

  it("retires a completed yielded batch whose requester already produced its final", async () => {
    const entry = makeRun("run-child");
    entry.cleanupCompletedAt = 2_100;
    entry.delivery = {
      status: "delivered",
      requesterVisibleFinal: { requesterTurnRunId: REQUESTER_TURN, batchRunIds: [entry.runId] },
    };
    entry.requesterSettleWake = { status: "pending", attemptCount: 0 };
    const schedule = vi.fn();

    expect(
      await settleRuns([entry], {
        schedule,
      }),
    ).toBe(true);
    expect(entry.requesterSettleWake).toBeUndefined();
    expect(entry.requesterTurnRunId).toBeUndefined();
    expect(entry.delivery?.requesterVisibleFinal).toBeUndefined();
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

    expect(await settleRuns([entry])).toBe(true);
    expect(entry.requesterSettleWake?.requesterYieldBatch).toBe(true);
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
      const persistOrThrow = vi.fn();
      const schedule = vi.fn();

      expect(
        await markRequesterTurnYieldedInRuns({
          requesterSessionKey: REQUESTER,
          requesterTurnRunId: REQUESTER_TURN,
          runs,
          transfer: createRequesterInitialTransferFixture(runs, persistOrThrow),
        }),
      ).toBe(1);
      expect(
        await settleRuns([entry], {
          acceptedSessionSpawns: [
            { runId: originalRunId, childSessionKey: sessionKey, expectsCompletionMessage: true },
          ],
          runs,
          transfer: createRequesterInitialTransferFixture(runs, persistOrThrow),
          schedule,
        }),
      ).toBe(expected);
      expect(persistOrThrow).toHaveBeenCalledTimes(expected ? 3 : 1);
      if (expected) {
        expect(entry.requesterSettleWake?.batchRunIds).toEqual([entry.runId]);
        expect(schedule).toHaveBeenCalledExactlyOnceWith(entry.runId, entry, "settle");
      } else {
        expect(entry.requesterSettleWake).toBeUndefined();
        expect(entry.requesterTurnRunId).toBe(REQUESTER_TURN);
        expect(schedule).not.toHaveBeenCalled();
      }
    },
  );

  it("freezes active yielded children without scheduling before terminal delivery", async () => {
    const entry = makeRun("run-child");
    entry.execution = { ...entry.execution, status: "running", endedAt: undefined };
    entry.delivery = { status: "pending" };
    const schedule = vi.fn();

    expect(
      await settleRuns([entry], {
        schedule,
      }),
    ).toBe(true);
    expect(entry.requesterSettleWake).toMatchObject({
      batchRunIds: [entry.runId],
      requesterYieldBatch: true,
    });
    expect(entry.requesterSettleWake?.afterRequesterYield).toBeUndefined();
    expect(schedule).not.toHaveBeenCalled();
  });

  it("persists a mixed delivered and in-progress yielded batch before scheduling", async () => {
    const alpha = makeRun("run-alpha");
    const beta = makeRun("run-beta");
    beta.delivery = { status: "in_progress" };
    const calls: string[] = [];
    const persistOrThrow = vi.fn(() => calls.push("persist"));
    const schedule = vi.fn(() => calls.push("schedule"));

    expect(
      await settleRuns([alpha, beta], {
        persistOrThrow,
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
    expect(alpha.requesterSettleWake).toEqual(frozenState);
    expect(beta.requesterSettleWake).toEqual(frozenState);
    expect(alpha.requesterTurnRunId).toBeUndefined();
    expect(beta.requesterTurnRunId).toBeUndefined();
    expect(beta.delivery?.disposition).toBe("intentional_non_delivery");
    expect(calls).toEqual(["persist", "persist", "schedule"]);
    expect(schedule).toHaveBeenCalledExactlyOnceWith(alpha.runId, alpha, "settle");
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
      const persistOrThrow = vi.fn();
      const schedule = vi.fn();

      if (requesterYielded) {
        expect(
          await markRequesterTurnYieldedInRuns({
            requesterSessionKey: REQUESTER,
            requesterTurnRunId: REQUESTER_TURN,
            runs,
            transfer: createRequesterInitialTransferFixture(runs, persistOrThrow),
          }),
        ).toBe(1);
      }

      expect(
        await settleRuns([inline, completion], {
          requesterYielded,
          runs,
          transfer: createRequesterInitialTransferFixture(runs, persistOrThrow),
          schedule,
        }),
      ).toBe(true);
      expect(persistOrThrow.mock.calls).toEqual(
        requesterYielded
          ? [[completion.runId], [completion.runId], [completion.runId]]
          : [[completion.runId]],
      );
      if (requesterYielded) {
        expect(completion.requesterSettleWake).toMatchObject({
          batchRunIds: [completion.runId],
          afterRequesterYield: true,
        });
        expect(schedule).toHaveBeenCalledExactlyOnceWith(completion.runId, completion, "settle");
      } else {
        expect(completion.requesterSettleWake).toBeUndefined();
        expect(schedule).toHaveBeenCalledExactlyOnceWith(completion.runId, completion, "settle");
      }
      expect(inline.requesterTurnRunId).toBe(REQUESTER_TURN);
      expect(inline.requesterTurnYielded).toBeUndefined();
      expect(inline.requesterSettleWake).toBeUndefined();
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
    expect(runs.get(entry.runId)).toBe(entry);
    expect(entry.requesterSettleWake).toMatchObject({
      afterRequesterYield: true,
      retireAfterSettle: true,
    });
    expect(entry.retireAfterRequesterTurn).toBeUndefined();
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
        requesterYielded: false,
        runs,
      }),
    ).toBe(true);
    expect(runs.has(entry.runId)).toBe(false);
  });

  it("rolls back every row when durable persistence fails", async () => {
    const entry = makeRun("run-delete", false);
    entry.retireAfterRequesterTurn = true;
    const runs = new Map([[entry.runId, entry]]);
    const failure = new Error("sqlite unavailable");

    await expect(
      settleRuns([entry], {
        requesterYielded: false,
        runs,
        persistOrThrow: () => {
          throw failure;
        },
      }),
    ).rejects.toMatchObject({ outcome: "not-committed", cause: failure });
    expect(runs.get(entry.runId)).toBe(entry);
    expect(entry.requesterTurnRunId).toBe(REQUESTER_TURN);
    expect(entry.retireAfterRequesterTurn).toBe(true);
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
