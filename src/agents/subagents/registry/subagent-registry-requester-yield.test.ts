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

  it.each(["none", "before", "after"] as const)(
    "preserves adoption ownership and rearms with sibling timing %s",
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
      const before = structuredClone(child);
      const params = adoption(child);
      if (order === "before") {
        params.runs.set(sibling.runId, sibling);
      }
      saveSubagentRegistryChangesToSqlite(params.runs, [...params.runs.keys()]);
      const receipt = await adoptSubagentRunForRequesterTurnInRuns(params);
      expect(receipt).toEqual({
        runId: child.taskRunId,
        childSessionKey: child.childSessionKey,
        expectsCompletionMessage: true,
      });
      expect(params.runs.get(child.runId)).toEqual({
        ...before,
        requesterTurnRunId: REQUESTER_TURN,
        requesterTurnYielded: undefined,
        requesterSettleWake: { status: "pending", attemptCount: 0, rearmGeneration: 1 },
      });
      if (!receipt) {
        throw new Error("Expected adoption receipt");
      }
      const batch = order === "none" ? [child] : [child, sibling];
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
      expect(await markRequesterTurnYieldedInRuns(requester)).toBe(batch.length);
      await expect(
        settleRequesterTurnAfterSessionSpawns({
          ...requester,
          requesterYielded: true,
          acceptedSessionSpawns: [receipt, ...(order === "none" ? [] : [accepted(sibling)])],
          schedule: vi.fn(),
        }),
      ).resolves.toBe(true);
      for (const entry of batch) {
        expect(params.runs.get(entry.runId)?.requesterTurnRunId).toBeUndefined();
        expect(params.runs.get(entry.runId)?.requesterSettleWake).toMatchObject({
          requesterYieldBatch: true,
          batchRunIds: batch.map((member) => member.runId),
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

  it.each([false, true])(
    "promotes requester attachments only after durable settlement (reject: %s)",
    async (reject) => {
      const entry = makeRun("run-child");
      entry.requesterAgentId = "main";
      const runs = new Map([[entry.runId, entry]]);
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
      const beforeWrite = vi.fn(() => {
        expect(runs.get(entry.runId)!.requesterTurnRunId).toBe(REQUESTER_TURN);
        expect(append).not.toHaveBeenCalled();
        if (reject) {
          throw new Error("persist failed");
        }
        if (beforeWrite.mock.calls.length === 1) {
          finalizeRequesterBatch(entry.runId, "too early");
        }
        expect(append).not.toHaveBeenCalled();
      });
      const settling = settleRuns([entry], { runs, requesterAgentId: "main", beforeWrite });
      if (reject) {
        await expect(settling).rejects.toThrow("persist failed");
        finalizeRequesterBatch(entry.runId, "must not append");
        expect(append).not.toHaveBeenCalled();
      } else {
        expect(await settling).toBe(true);
        expect(beforeWrite).toHaveBeenCalledTimes(2);
        finalizeRequesterBatch(entry.runId, "settled");
        expect(append).toHaveBeenCalledExactlyOnceWith("settled");
      }
    },
  );

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

  it.each([
    [
      "valid receipt",
      (entry: SubagentRunRecord) => {
        entry.requesterSettleWake = { status: "pending", attemptCount: 0 };
      },
    ],
    [
      "valid delete receipt",
      (entry: SubagentRunRecord) => {
        entry.cleanup = "delete";
        entry.retireAfterRequesterTurn = true;
      },
    ],
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
  ] as const)("settles requester batches according to %s", async (kind, invalidate) => {
    const entry = makeRun("run-child");
    entry.cleanupCompletedAt = 2_100;
    entry.delivery = {
      status: "delivered",
      requesterVisibleFinal: { requesterTurnRunId: REQUESTER_TURN, batchRunIds: [entry.runId] },
    };
    invalidate(entry);
    const runs = new Map([[entry.runId, entry]]);

    const schedule = vi.fn();
    expect(await settleRuns([entry], { runs, schedule })).toBe(true);
    if (kind === "valid delete receipt") {
      expect(runs.has(entry.runId)).toBe(true);
      expect(runs.get(entry.runId)?.requesterSettleWake).toBeUndefined();
      expect(runs.get(entry.runId)?.retireAfterRequesterTurn).toBeUndefined();
      expect(runs.get(entry.runId)?.requesterTurnRunId).toBeUndefined();
      const retained = loadSubagentRegistryFromSqlite().get(entry.runId);
      expect(retained).toMatchObject({
        runId: entry.runId,
        cleanup: "delete",
        cleanupCompletedAt: 2_100,
        delivery: { status: "delivered" },
      });
      expect(retained?.requesterTurnRunId).toBeUndefined();
      expect(schedule).not.toHaveBeenCalled();
      expect(await settleRuns([entry], { runs, schedule })).toBe(false);
      expect(schedule).not.toHaveBeenCalled();
      expect(loadSubagentRegistryFromSqlite().get(entry.runId)).toEqual(retained);
    } else if (kind === "valid receipt") {
      expect(runs.get(entry.runId)!.requesterSettleWake).toBeUndefined();
      expect(runs.get(entry.runId)!.requesterTurnRunId).toBeUndefined();
      expect(runs.get(entry.runId)!.delivery?.requesterVisibleFinal).toBeUndefined();
      expect(schedule).not.toHaveBeenCalled();
    } else {
      expect(runs.get(entry.runId)!.requesterSettleWake?.requesterYieldBatch).toBe(true);
    }
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
      expect(runs.get(entry.runId)!.requesterTurnYielded).toBe(true);
      expect(beforeWrite).toHaveBeenCalledOnce();
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

  it.each(["delivered", "in_progress", "running", "delete"] as const)(
    "durably freezes a %s yielded batch before scheduling",
    async (kind) => {
      const first = makeRun("run-b");
      const second = makeRun("run-a");
      const entries = kind === "running" || kind === "delete" ? [first] : [first, second];
      if (kind === "running") {
        first.execution = { ...first.execution, status: "running", endedAt: undefined };
        first.delivery = { status: "pending" };
      } else if (kind === "delete") {
        first.cleanup = "delete";
        first.cleanupCompletedAt = 2_100;
        first.retireAfterRequesterTurn = true;
      } else if (kind === "in_progress") {
        second.delivery = { status: "in_progress" };
      }
      const runs = new Map(entries.map((entry) => [entry.runId, entry]));
      const calls: string[] = [];
      const beforeWrite = vi.fn(() => calls.push("persist"));
      const schedule = vi.fn(() => calls.push("schedule"));
      expect(await settleRuns(entries, { runs, beforeWrite, schedule })).toBe(true);
      const batchRunIds = entries.map((entry) => entry.runId).toSorted();
      for (const entry of entries) {
        expect(runs.get(entry.runId)!.requesterSettleWake).toEqual({
          status: "pending",
          attemptCount: 0,
          batchRunIds,
          requesterYieldBatch: true,
          yieldedFinalDeliverable: true,
          rearmGeneration: 1,
          ...(kind === "running" ? {} : { afterRequesterYield: true }),
        });
        expect(runs.get(entry.runId)!.requesterTurnRunId).toBeUndefined();
        expect(runs.get(entry.runId)!.retireAfterRequesterTurn).toBeUndefined();
      }
      expect(beforeWrite).toHaveBeenCalledTimes(2);
      expect(
        loadSubagentRegistryFromSqlite().get(first.runId)?.requesterSettleWake?.batchRunIds,
      ).toEqual(batchRunIds);
      if (kind === "running") {
        expect(schedule).not.toHaveBeenCalled();
        expect(calls).toEqual(["persist", "persist"]);
      } else {
        expect(schedule).toHaveBeenCalledExactlyOnceWith(
          first.runId,
          runs.get(first.runId),
          "settle",
        );
        expect(calls).toEqual(["persist", "persist", "schedule"]);
      }
      if (kind === "in_progress") {
        expect(runs.get(second.runId)!.delivery?.disposition).toBe("intentional_non_delivery");
      }
    },
  );

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

  it.each([false, true])(
    "retires normal-answer children only after a committed plan (reject: %s)",
    async (reject) => {
      const entry = makeRun("run-delete", false);
      entry.retireAfterRequesterTurn = true;
      const runs = new Map([[entry.runId, entry]]);
      const failure = new Error("sqlite unavailable");
      const settling = settleRuns([entry], {
        requesterYielded: false,
        runs,
        beforeWrite: () => {
          if (reject) {
            throw failure;
          }
        },
      });
      if (reject) {
        await expect(settling).rejects.toMatchObject({ outcome: "not-committed", cause: failure });
        expect(runs.get(entry.runId)).toMatchObject({ runId: entry.runId });
        expect(runs.get(entry.runId)!.requesterTurnRunId).toBe(REQUESTER_TURN);
        expect(runs.get(entry.runId)!.retireAfterRequesterTurn).toBe(true);
      } else {
        expect(await settling).toBe(true);
        expect(runs.has(entry.runId)).toBe(false);
      }
    },
  );
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
      requesterAgentId: "main",
      execution: { status: "running", startedAt: NOW - 1_000 },
      delivery: { status: "pending" },
      ...overrides,
    };
  }

  it("lists the ordered current roster while excluding unowned, settled, and superseded children", () => {
    const yielded = runningRun("run-yielded", {
      label: "Work session",
      requesterSettleWake: { status: "pending", attemptCount: 0, requesterYieldBatch: true },
    });
    const earlierTurn = runningRun("run-earlier", { requesterTurnRunId: "run-turn-0" });
    const completing = runningRun("run-completing", {
      execution: { status: "terminal", startedAt: NOW - 3_000, endedAt: NOW - 100 },
      delivery: { status: "in_progress" },
    });
    const paused = runningRun("run-paused", {
      execution: { status: "terminal", startedAt: NOW - 2_000, endedAt: NOW - 500 },
      pauseReason: "sessions_yield",
      delivery: { status: "pending" },
      requesterSettleWake: { status: "pending", attemptCount: 0, requesterYieldBatch: true },
    });
    const excluded: Partial<SubagentRunRecord>[] = [
      { requesterTurnRunId: "run-turn-2" },
      { execution: { status: "terminal", endedAt: NOW - 1 }, delivery: { status: "delivered" } },
      { collect: true },
      { expectsCompletionMessage: false },
      { killIntent: { requestedAt: NOW, reason: "stop" } },
      { requesterSessionKey: "agent:main:other" },
      { requesterAgentId: "other" },
    ];
    const old = runningRun("old", {
      generation: 1,
      execution: { status: "terminal", startedAt: NOW - 2_000, endedAt: NOW - 1_500 },
    });
    const current = runningRun("current", { generation: 2, childSessionKey: old.childSessionKey });
    const superseded = runningRun("superseded", { generation: 1 });
    const killed = runningRun("killed", {
      generation: 2,
      childSessionKey: superseded.childSessionKey,
      killIntent: { requestedAt: NOW, reason: "stop" },
    });
    const runs = new Map(
      [
        yielded,
        earlierTurn,
        completing,
        paused,
        old,
        current,
        superseded,
        killed,
        ...excluded.map((overrides, index) => runningRun(`excluded-${index}`, overrides)),
      ].map((entry) => [entry.runId, entry] as const),
    );

    expect(
      listUnsettledRequesterChildrenInRuns({
        requesterSessionKey: REQUESTER,
        requesterAgentId: "main",
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
        runId: "run-paused",
        childSessionKey: "agent:main:subagent:run-paused",
        startedAt: NOW - 2_000,
        state: "paused",
        wakeArmed: true,
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
      {
        runId: "current",
        childSessionKey: old.childSessionKey,
        startedAt: NOW - 1_000,
        state: "running",
        wakeArmed: false,
      },
    ]);
  });
});
