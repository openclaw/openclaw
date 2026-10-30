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
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  adoptSubagentRunForRequesterTurnInRuns,
  listUnsettledRequesterChildrenInRuns,
  markRequesterTurnYieldedInRuns,
  settleRequesterTurnAfterSessionSpawns,
} from "./subagent-registry-requester-yield.js";
import { createRequesterInitialTransferFixture } from "./subagent-registry-requester-yield.test-support.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryChangesToSqlite,
} from "./subagent-registry-state.fixture.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { copySubagentRunRuntimeOwner } from "./subagent-run-generation.js";

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

function runMap(...entries: SubagentRunRecord[]) {
  return new Map(entries.map((entry) => [entry.runId, entry]));
}

function runningRun(runId: string, overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    ...makeRun(runId, false),
    requesterTurnRunId: undefined,
    requesterAgentId: "main",
    execution: { status: "running", startedAt: 1_000 },
    delivery: { status: "pending" },
    ...overrides,
  };
}

function settleRuns(
  entries: SubagentRunRecord[],
  overrides: Partial<Parameters<typeof settleRequesterTurnAfterSessionSpawns>[0]> & {
    beforeWrite?: (...runIds: string[]) => void;
  } = {},
) {
  const { beforeWrite = vi.fn(), ...options } = overrides;
  const runs = options.runs ?? runMap(...entries);
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

function markYielded(
  runs: Map<string, SubagentRunRecord>,
  beforeWrite?: (...runIds: string[]) => void,
) {
  return markRequesterTurnYieldedInRuns({
    preparedAuthority: null,
    requesterSessionKey: REQUESTER,
    requesterTurnRunId: REQUESTER_TURN,
    runs,
    transfer: createRequesterInitialTransferFixture(runs, beforeWrite),
  });
}

let state: OpenClawTestState;
beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
});
afterAll(() => state.cleanup());

afterEach(() => vi.restoreAllMocks());

describe("markRequesterTurnYieldedInRuns", () => {
  it("tracks current requester cohorts without scanning unrelated retained runs", async () => {
    subagentRuns.clear();
    try {
      for (let index = 0; index < 256; index++) {
        const entry = makeRun(`retained-${index}`);
        entry.requesterTurnRunId = `retained-turn-${index}`;
        subagentRuns.set(entry.runId, entry);
      }
      const previous = {
        ...makeRun("previous", false),
        childAgentId: "main",
        requesterAgentId: "main",
        generation: 1,
      };
      const current = {
        ...previous,
        runId: "current",
        taskRunId: previous.runId,
        generation: 2,
      };
      const independent = {
        ...current,
        runId: "independent",
        taskRunId: "independent",
        requesterTurnRunId: "independent-turn",
        generation: 3,
      };
      for (const entry of [
        previous,
        current,
        independent,
        { ...makeRun("other-agent"), requesterAgentId: "other" },
        { ...makeRun("other-session"), requesterSessionKey: "agent:main:other" },
        { ...makeRun("no-completion"), expectsCompletionMessage: false },
      ]) {
        subagentRuns.set(entry.runId, entry);
      }
      const enumeration = vi.spyOn(subagentRuns, "values").mockImplementation(() => {
        throw new Error("Requester selection must not enumerate retained registry rows");
      });
      const mark = async (expectedRunIds: string[]) => {
        const beforeWrite = vi.fn();
        expect(
          await markRequesterTurnYieldedInRuns({
            preparedAuthority: null,
            requesterSessionKey: REQUESTER,
            requesterAgentId: "main",
            requesterTurnRunId: REQUESTER_TURN,
            runs: subagentRuns,
            transfer: createRequesterInitialTransferFixture(subagentRuns, beforeWrite),
          }),
        ).toBe(expectedRunIds.length);
        expect(beforeWrite.mock.calls).toEqual(expectedRunIds.length ? [expectedRunIds] : []);
        const stored = loadSubagentRegistryFromSqlite();
        for (const runId of expectedRunIds) {
          expect(subagentRuns.get(runId)?.requesterTurnYielded).toBe(true);
          expect(stored.get(runId)?.requesterTurnYielded).toBe(true);
        }
      };

      await mark([current.runId]);
      expect(subagentRuns.get(previous.runId)?.requesterTurnYielded).toBeUndefined();
      expect(subagentRuns.get(independent.runId)?.requesterTurnYielded).toBeUndefined();
      subagentRuns.set(current.runId, { ...current, requesterTurnRunId: "rebound-turn" });
      await mark([]);
      subagentRuns.set(current.runId, current);
      await mark([current.runId]);
      subagentRuns.delete(current.runId);
      await mark([previous.runId]);
      subagentRuns.clear();
      await mark([]);
      subagentRuns.set(current.runId, current);
      await mark([current.runId]);
      expect(enumeration).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      subagentRuns.clear();
    }
  });
});

describe("adoptSubagentRunForRequesterTurnInRuns", () => {
  function pendingChild(runId = "steered-child"): SubagentRunRecord {
    return runningRun(runId, {
      taskRunId: "original-task",
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        batchRunIds: [runId],
        requesterYieldBatch: true,
        rearmGeneration: 1,
      },
    });
  }

  function adoption(entry: SubagentRunRecord) {
    const runs = runMap(entry);
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

  it.each(["before", "after"] as const)(
    "preserves adoption ownership and rearms with sibling timing %s",
    async (order) => {
      const child = pendingChild(`adopted-${order}`);
      child.taskRunId = `original-task-${order}`;
      const sibling = runningRun(`sibling-${order}`, { requesterTurnRunId: REQUESTER_TURN });
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
      const batch = [child, sibling];
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
          acceptedSessionSpawns: [receipt, accepted(sibling)],
          schedule: vi.fn(),
        }),
      ).resolves.toBe(true);
      for (const entry of batch) {
        expect(params.runs.get(entry.runId)).toMatchObject({
          requesterTurnRunId: undefined,
          requesterSettleWake: {
            requesterYieldBatch: true,
            batchRunIds: batch.map((member) => member.runId),
            rearmGeneration: 2,
          },
        });
      }
    },
  );

  it.each<{ reason: string; changes: Partial<SubagentRunRecord>; replaced?: boolean }>([
    { reason: "replaced execution", changes: { generation: 2 }, replaced: true },
    {
      reason: "cancelled",
      changes: { killIntent: { requestedAt: 2_000, reason: "operator stop" } },
    },
    { reason: "different turn", changes: { requesterTurnRunId: "another-live-requester-turn" } },
    {
      reason: "different cohort",
      changes: {
        requesterSettleWake: {
          status: "pending",
          attemptCount: 0,
          batchRunIds: ["steered-child", "another-child"],
          requesterYieldBatch: true,
          rearmGeneration: 1,
        },
      },
    },
    {
      reason: "ordinary cohort",
      changes: {
        requesterSettleWake: {
          status: "pending",
          attemptCount: 0,
          batchRunIds: ["steered-child", "another-child"],
        },
      },
    },
    {
      reason: "missing cohort",
      changes: {
        requesterSettleWake: {
          status: "pending",
          attemptCount: 0,
          requesterYieldBatch: true,
          rearmGeneration: 1,
        },
      },
    },
  ])("does not take a $reason child completion", async ({ changes, replaced }) => {
    const child = pendingChild();
    const params = adoption(child);
    if (replaced) {
      params.runs.set(child.runId, { ...child, ...changes });
    } else {
      Object.assign(child, changes);
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
  it("accounts for a superseded retired receipt without transferring its obligation", async () => {
    const retired = {
      ...makeRun("run-retired"),
      killReconciliation: { killedAt: 2_000, supersededAt: 2_100 },
    };
    const current = makeRun("run-current");
    const runs = runMap(retired, current);
    const beforeWrite = vi.fn();
    const schedule = vi.fn();

    expect(await settleRuns([retired, current], { runs, beforeWrite, schedule })).toBe(true);
    expect(beforeWrite).toHaveBeenCalledExactlyOnceWith(current.runId);
    expect(runs.get(retired.runId)).toEqual(retired);
    expect(loadSubagentRegistryFromSqlite().get(current.runId)).toMatchObject({
      requesterTurnRunId: undefined,
      requesterSettleWake: {
        status: "pending",
        requesterYieldBatch: true,
        batchRunIds: [current.runId],
      },
    });
    expect(schedule).toHaveBeenCalledExactlyOnceWith(
      current.runId,
      runs.get(current.runId),
      "settle",
    );
  });

  it.each(["yield intent", "cohort release"] as const)(
    "keeps a selected child's current requester turn at %s",
    async (kind) => {
      const child = makeRun("run-child");
      const runs = runMap(child);
      const commit = createRequesterInitialTransferFixture(runs);
      const transfer: Parameters<
        typeof settleRequesterTurnAfterSessionSpawns
      >[0]["transfer"] = async (params) => {
        runs.set(
          child.runId,
          copySubagentRunRuntimeOwner(child, { ...child, requesterTurnRunId: "run-other" }),
        );
        await commit(params);
      };
      const operation =
        kind === "yield intent"
          ? markRequesterTurnYieldedInRuns({
              preparedAuthority: null,
              requesterSessionKey: REQUESTER,
              requesterTurnRunId: REQUESTER_TURN,
              runs,
              transfer,
            })
          : settleRuns([child], { runs, transfer });

      await expect(operation).rejects.toThrow(/Requester (child changed its turn|spawn receipt)/);
      expect(runs.get(child.runId)?.requesterTurnRunId).toBe("run-other");
      expect(runs.get(child.runId)?.requesterSettleWake).toBeUndefined();
    },
  );

  function nestedRequester(delivery: "pending" | "delivered" = "delivered"): SubagentRunRecord {
    return {
      ...makeRun(REQUESTER_TURN),
      childSessionKey: REQUESTER,
      requesterSessionKey: "agent:main:parent",
      execution: { status: "running", startedAt: 1_000 },
      delivery: { status: delivery },
    };
  }

  it.each([false, true])(
    "publishes a nested requester's pause with its wake batch (plan rejection: %s)",
    async (rejectPlan) => {
      const requester = nestedRequester("pending");
      const child = makeRun("run-child");
      const originalRequester = structuredClone(requester);
      const originalChild = structuredClone(child);
      const runs = runMap(requester, child);
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
      const settle = () => settleRuns([child], { runs, beforeWrite, schedule });

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
        ...nestedRequester(),
        childSessionKey: kind === "different-session" ? "agent:main:other" : REQUESTER,
        generation: 1,
        ...(kind === "cancelled"
          ? { killIntent: { requestedAt: 2_000, reason: "killed" as const } }
          : {}),
      };
      if (kind === "terminal") {
        requester.execution = { status: "terminal", endedAt: 2_000, outcome: { status: "ok" } };
      }
      const child = makeRun("run-child");
      const runs = runMap(requester, child);
      if (kind === "superseded") {
        runs.set("new-requester", { ...requester, runId: "new-requester", generation: 2 });
      }
      const before = structuredClone(requester);
      await settleRuns([child], { runs });
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
      vi.spyOn(Date, "now").mockReturnValue(releasedAt);
      const runs = runMap(entry);
      expect(await settleRuns([entry], { requesterYielded: false, runs })).toBe(true);
      expect(runs.get(entry.runId)!.delivery).toMatchObject({
        windowStartedAt: windowStartedAt ?? releasedAt,
        deadlineAt: (windowStartedAt ?? releasedAt) + 30 * 60_000,
      });
    },
  );

  it.each([false, true])(
    "promotes requester attachments only after durable settlement (reject: %s)",
    async (reject) => {
      const entry = makeRun("run-child");
      entry.requesterAgentId = "main";
      const runs = runMap(entry);
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
        expect(beforeWrite).toHaveBeenCalledOnce();
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
      const runs = runMap(first);
      const before = structuredClone(runs);
      const beforeWrite = vi.fn();
      const schedule = vi.fn();

      expect(
        await settleRuns([first, missing], {
          requesterYielded,
          runs,
          beforeWrite,
          schedule,
        }),
      ).toBe(false);
      expect(runs).toEqual(before);
      expect(beforeWrite).not.toHaveBeenCalled();
      expect(schedule).not.toHaveBeenCalled();
    },
  );

  it.each([
    "valid receipt",
    "valid delete receipt",
    "another requester turn",
    "changed child membership",
    "unfinished cleanup",
    "unfinished delivery",
    "a replayed running child",
  ] as const)("settles requester batches according to %s", async (kind) => {
    const entry = makeRun("run-child");
    entry.cleanupCompletedAt = kind === "unfinished cleanup" ? undefined : 2_100;
    entry.delivery = {
      status: kind === "unfinished delivery" ? "in_progress" : "delivered",
      requesterVisibleFinal: {
        requesterTurnRunId: kind === "another requester turn" ? "run-other" : REQUESTER_TURN,
        batchRunIds:
          kind === "changed child membership" ? [entry.runId, "run-later"] : [entry.runId],
      },
    };
    if (kind === "valid receipt") {
      entry.requesterSettleWake = { status: "pending", attemptCount: 0 };
    } else if (kind === "valid delete receipt") {
      entry.cleanup = "delete";
      entry.retireAfterRequesterTurn = true;
    } else if (kind === "a replayed running child") {
      entry.execution.status = "running";
    }
    const runs = runMap(entry);

    const schedule = vi.fn();
    expect(await settleRuns([entry], { runs, schedule })).toBe(true);
    if (kind === "valid delete receipt") {
      expect(runs.has(entry.runId)).toBe(false);
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
      const inline = {
        ...makeRun("inline", false),
        expectsCompletionMessage: false,
        delivery: { status: "not_required" as const },
      };
      const originalInline = structuredClone(inline);
      const runs = runMap(entry, inline);
      const schedule = vi.fn();

      expect(await markYielded(runs)).toBe(1);
      expect(runs.get(entry.runId)!.requesterTurnYielded).toBe(true);
      const beforeWrite = vi.fn();
      expect(
        await settleRuns([entry], {
          runs,
          beforeWrite,
          acceptedSessionSpawns: [
            accepted(inline),
            { runId: originalRunId, childSessionKey: sessionKey, expectsCompletionMessage: true },
          ],
          schedule,
        }),
      ).toBe(expected);
      expect(runs.get(inline.runId)).toEqual(originalInline);
      expect(beforeWrite).toHaveBeenCalledTimes(expected ? 1 : 0);
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
        expect(beforeWrite).not.toHaveBeenCalled();
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
      const runs = runMap(...entries);
      const calls: string[] = [];
      const beforeWrite = () => {
        calls.push("persist");
      };
      const schedule = vi.fn(() => calls.push("schedule"));
      const write = vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation");
      expect(await settleRuns(entries, { runs, beforeWrite, schedule })).toBe(true);
      expect(write).toHaveBeenCalledOnce();
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
          ...(kind === "delete" ? { retireAfterSettle: true } : {}),
        });
        expect(runs.get(entry.runId)!.requesterTurnRunId).toBeUndefined();
        expect(runs.get(entry.runId)!.retireAfterRequesterTurn).toBeUndefined();
      }
      expect(loadSubagentRegistryFromSqlite().get(first.runId)).toMatchObject({
        requesterTurnRunId: undefined,
        requesterTurnYielded: undefined,
        requesterSettleWake: { status: "pending", requesterYieldBatch: true, batchRunIds },
      });
      if (kind === "running") {
        expect(schedule).not.toHaveBeenCalled();
        expect(calls).toEqual(["persist"]);
      } else {
        expect(schedule).toHaveBeenCalledExactlyOnceWith(
          first.runId,
          runs.get(first.runId),
          "settle",
        );
        expect(calls).toEqual(["persist", "schedule"]);
      }
      if (kind === "in_progress") {
        expect(runs.get(second.runId)!.delivery?.disposition).toBe("intentional_non_delivery");
      }
    },
  );

  it.each([false, true])(
    "retires normal-answer children only after a committed plan (reject: %s)",
    async (reject) => {
      const entry = makeRun("run-delete", false);
      entry.retireAfterRequesterTurn = true;
      const runs = runMap(entry);
      const original = structuredClone(entry);
      const failure = new Error("sqlite unavailable");
      if (reject) {
        vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockRejectedValueOnce(failure);
      }
      const settling = settleRuns([entry], {
        requesterYielded: false,
        runs,
      });
      if (reject) {
        await expect(settling).rejects.toMatchObject({ outcome: "not-committed", cause: failure });
        expect(runs.get(entry.runId)).toEqual(original);
      } else {
        expect(await settling).toBe(true);
        expect(runs.has(entry.runId)).toBe(false);
      }
    },
  );
});

describe("listUnsettledRequesterChildrenInRuns", () => {
  const NOW = 10_000;

  const rosterRun = (runId: string, overrides: Partial<SubagentRunRecord> = {}) =>
    runningRun(runId, { execution: { status: "running", startedAt: NOW - 1_000 }, ...overrides });

  function expectedChild(
    runId: string,
    startedAt: number,
    childState: "running" | "completing" | "paused" = "running",
    wakeArmed = false,
    extra: { label?: string; childSessionKey?: string } = {},
  ) {
    return {
      runId,
      childSessionKey: `agent:main:subagent:${runId}`,
      startedAt,
      state: childState,
      wakeArmed,
      ...extra,
    };
  }

  it("lists the ordered current roster while excluding unowned, settled, and superseded children", () => {
    const yielded = rosterRun("run-yielded", {
      label: "Work session",
      requesterSettleWake: { status: "pending", attemptCount: 0, requesterYieldBatch: true },
    });
    const earlierTurn = rosterRun("run-earlier", { requesterTurnRunId: "run-turn-0" });
    const completing = rosterRun("run-completing", {
      execution: { status: "terminal", startedAt: NOW - 3_000, endedAt: NOW - 100 },
      delivery: { status: "in_progress" },
    });
    const paused = rosterRun("run-paused", {
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
    const old = rosterRun("old", {
      generation: 1,
      execution: { status: "terminal", startedAt: NOW - 2_000, endedAt: NOW - 1_500 },
    });
    const current = rosterRun("current", { generation: 2, childSessionKey: old.childSessionKey });
    const superseded = rosterRun("superseded", { generation: 1 });
    const killed = rosterRun("killed", {
      generation: 2,
      childSessionKey: superseded.childSessionKey,
      killIntent: { requestedAt: NOW, reason: "stop" },
    });
    const runs = runMap(
      yielded,
      earlierTurn,
      completing,
      paused,
      old,
      current,
      superseded,
      killed,
      ...excluded.map((overrides, index) => rosterRun(`excluded-${index}`, overrides)),
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
      expectedChild("run-completing", NOW - 3_000, "completing"),
      expectedChild("run-paused", NOW - 2_000, "paused", true),
      expectedChild("run-yielded", NOW - 1_000, "running", true, { label: "Work session" }),
      expectedChild("run-earlier", NOW - 1_000),
      expectedChild("current", NOW - 1_000, "running", false, {
        childSessionKey: "agent:main:subagent:old",
      }),
    ]);
  });
});
