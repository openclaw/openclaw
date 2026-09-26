import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { StateDatabaseReadAdmissionInvalidatedError } from "../../../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../../../state/openclaw-state-db-cache.js";
import * as reads from "../../../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { withPreparedLatestSubagentRunByChildSessionKey } from "./subagent-registry-read.js";
import {
  clearSubagentRunsReadCacheForTest,
  getSubagentRunsSnapshotForRead,
  getSubagentRunsSnapshotForSessions,
  persistSubagentRunsToDiskOrThrow,
  persistSubagentRunsToDisk,
} from "./subagent-registry-state.js";
import * as store from "./subagent-registry.store.sqlite.js";
import {
  saveSubagentRegistryChangesToSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

let state: OpenClawTestState;
const childSessionKey = "agent:main:subagent:prepared";
function run(runId = "retained", createdAt = 100): SubagentRunRecord {
  return {
    runId,
    childSessionKey,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "Synthetic retained subagent",
    cleanup: "keep",
    createdAt,
    execution: { status: "running", startedAt: createdAt },
    completion: { required: false },
    delivery: { status: "not_required" },
  };
}
function holdReadResult() {
  const held = createDeferredCore();
  const release = createDeferredCore();
  const original = reads.executeExistingOpenClawStateRead;
  let paused = false;
  const spy = vi
    .spyOn(reads, "executeExistingOpenClawStateRead")
    .mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[1].type === "subagents.forChildSession" && !paused) {
        paused = true;
        held.resolve();
        await release.promise;
      }
      return result;
    });
  return { held: held.promise, release: () => release.resolve(), spy };
}
beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "openclaw-subagent-read-", applyEnv: true });
  vi.stubEnv("OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE", "1");
  subagentRuns.clear();
  clearSubagentRunsReadCacheForTest();
});
afterEach(async () => {
  vi.restoreAllMocks();
  subagentRuns.clear();
  clearSubagentRunsReadCacheForTest();
  await closeOpenClawStateDatabaseAsync();
  vi.unstubAllEnvs();
  await state.cleanup();
});

describe("prepared subagent child-session reads", () => {
  it("recovers restart-only rows in the worker and refreshes beyond a warmed host snapshot", async () => {
    const retained = run();
    saveSubagentRegistryToSqlite(new Map([[retained.runId, retained]]));
    await closeOpenClawStateDatabaseAsync();
    expect(subagentRuns.size).toBe(0);
    expect(
      await withPreparedLatestSubagentRunByChildSessionKey(
        childSessionKey,
        captureOpenClawStateWorkerContext(),
        (read) => read(),
      ),
    ).toMatchObject(retained);
    getSubagentRunsSnapshotForRead(new Map());
    const newer = run("newer", 200);
    saveSubagentRegistryChangesToSqlite(new Map([[newer.runId, newer]]), [newer.runId]);
    const tracker = trackSqliteStatementExecutions(
      openOpenClawStateDatabase().db,
      ["subagent"] as const,
      (sql) => (/\bsubagent_runs\b/i.test(sql) ? "subagent" : null),
    );
    try {
      expect(
        await withPreparedLatestSubagentRunByChildSessionKey(
          childSessionKey,
          captureOpenClawStateWorkerContext(),
          (read) => read(),
        ),
      ).toMatchObject(newer);
      expect(tracker.counts.subagent).toBe(0);
    } finally {
      tracker.restore();
    }
  });

  it("applies current live rows last, including a live move outside the persisted child scope", async () => {
    const older = run("older", 100);
    const newer = run("newer", 200);
    saveSubagentRegistryToSqlite(
      new Map([
        [older.runId, older],
        [newer.runId, newer],
      ]),
    );
    const moved = { ...newer, childSessionKey: "agent:main:subagent:moved" };
    const current = { ...older, task: "Current live owner", generation: 2 };
    const hold = holdReadResult();
    const prepared = withPreparedLatestSubagentRunByChildSessionKey(
      childSessionKey,
      captureOpenClawStateWorkerContext(),
      (read) => read(),
    );
    try {
      await hold.held;
      subagentRuns.set(newer.runId, moved);
      subagentRuns.set(older.runId, current);
    } finally {
      hold.release();
    }
    expect(await prepared).toBe(current);
  });

  it("reprepares after an owner publication deletes a row while durable preparation is awaited", async () => {
    const retained = run();
    saveSubagentRegistryToSqlite(new Map([[retained.runId, retained]]));
    const hold = holdReadResult();
    const prepared = withPreparedLatestSubagentRunByChildSessionKey(
      childSessionKey,
      captureOpenClawStateWorkerContext(),
      (read) => read(),
    );
    try {
      await hold.held;
      persistSubagentRunsToDiskOrThrow(new Map(), [retained.runId]);
    } finally {
      hold.release();
    }
    expect(await prepared).toBeNull();
    expect(
      hold.spy.mock.calls.filter((call) => call[1].type === "subagents.forChildSession"),
    ).toHaveLength(2);
  });

  it("refuses a result after its captured database admission closes", async () => {
    const retained = run();
    saveSubagentRegistryToSqlite(new Map([[retained.runId, retained]]));
    const hold = holdReadResult();
    const consume = vi.fn((read: () => SubagentRunRecord | null) => read());
    const prepared = withPreparedLatestSubagentRunByChildSessionKey(
      childSessionKey,
      captureOpenClawStateWorkerContext(),
      consume,
    );
    const rejected = expect(prepared).rejects.toBeInstanceOf(
      StateDatabaseReadAdmissionInvalidatedError,
    );
    try {
      await hold.held;
      await closeOpenClawStateDatabaseAsync();
    } finally {
      hold.release();
    }
    await rejected;
    expect(consume).not.toHaveBeenCalled();
  });

  it("does not let a retained reader outlive its synchronous consumption phase", async () => {
    const retained = run();
    saveSubagentRegistryToSqlite(new Map([[retained.runId, retained]]));
    const escaped = await withPreparedLatestSubagentRunByChildSessionKey(
      childSessionKey,
      captureOpenClawStateWorkerContext(),
      (read) => {
        expect(read()).toMatchObject(retained);
        return read;
      },
    );
    expect(escaped).toThrow(/no longer current/);
  });
  it.each([
    { warm: false, tree: false },
    { warm: true, tree: false },
    { warm: false, tree: true },
  ])(
    "retains failed named deletion through hydration (warm=$warm, tree=$tree) and clears only exact successful rows",
    async ({ warm, tree }) => {
      const first = run("first", 100);
      const second = run("second", 200);
      saveSubagentRegistryToSqlite(
        new Map([
          [first.runId, first],
          [second.runId, second],
        ]),
      );
      if (warm) {
        getSubagentRunsSnapshotForRead(new Map());
      }
      const fail = vi
        .spyOn(store, "saveSubagentRegistryChangesToSqlite")
        .mockImplementationOnce(() => {
          throw new Error("Synthetic disk failure");
        });
      persistSubagentRunsToDisk(new Map(), [first.runId, second.runId]);
      fail.mockRestore();
      if (tree) {
        expect(getSubagentRunsSnapshotForSessions(new Map(), [childSessionKey]).size).toBe(0);
      }
      expect(getSubagentRunsSnapshotForRead(new Map()).size).toBe(0);
      expect(store.loadSubagentRegistryFromSqlite().size).toBe(2);
      const context = captureOpenClawStateWorkerContext();
      expect(
        await withPreparedLatestSubagentRunByChildSessionKey(childSessionKey, context, (read) =>
          read(),
        ),
      ).toBeNull();
      persistSubagentRunsToDiskOrThrow(new Map([[first.runId, first]]), [first.runId]);
      const fresh = { ...first, task: "Durable update after exact commit" };
      saveSubagentRegistryChangesToSqlite(new Map([[fresh.runId, fresh]]), [fresh.runId]);
      expect(
        await withPreparedLatestSubagentRunByChildSessionKey(childSessionKey, context, (read) =>
          read(),
        ),
      ).toMatchObject(fresh);
    },
  );

  it("preserves failed full replacement intent while exact commits release their rows to fresh SQL", async () => {
    const removed = run("removed", 900);
    const retained = run("retained", 100);
    const intended = run("intended", 300);
    saveSubagentRegistryToSqlite(
      new Map([
        [removed.runId, removed],
        [retained.runId, retained],
      ]),
    );
    getSubagentRunsSnapshotForRead(new Map());
    const fail = vi.spyOn(store, "saveSubagentRegistryToSqlite").mockImplementationOnce(() => {
      throw new Error("Synthetic replacement failure");
    });
    persistSubagentRunsToDisk(
      new Map([
        [retained.runId, retained],
        [intended.runId, intended],
      ]),
    );
    fail.mockRestore();
    const context = captureOpenClawStateWorkerContext();
    expect(
      await withPreparedLatestSubagentRunByChildSessionKey(childSessionKey, context, (read) => {
        const copy = expectDefined(read(), "failed replacement row");
        copy.task = "Caller must not mutate the replacement owner";
        return read();
      }),
    ).toMatchObject(intended);
    const committed = { ...retained, createdAt: 400 };
    persistSubagentRunsToDiskOrThrow(new Map([[committed.runId, committed]]), [committed.runId]);
    const fresh = {
      ...committed,
      task: "Fresh SQL owns the exact committed exemption",
      createdAt: 500,
    };
    saveSubagentRegistryChangesToSqlite(new Map([[fresh.runId, fresh]]), [fresh.runId]);
    expect(
      await withPreparedLatestSubagentRunByChildSessionKey(childSessionKey, context, (read) =>
        read(),
      ),
    ).toMatchObject(fresh);
    persistSubagentRunsToDiskOrThrow(new Map([[retained.runId, retained]]));
    saveSubagentRegistryChangesToSqlite(new Map([[removed.runId, removed]]), [removed.runId]);
    expect(
      await withPreparedLatestSubagentRunByChildSessionKey(childSessionKey, context, (read) =>
        read(),
      ),
    ).toMatchObject(removed);
  });

  it.each(["named", "full"] as const)("does not publish a strict %s failure", async (kind) => {
    const retained = run();
    saveSubagentRegistryToSqlite(new Map([[retained.runId, retained]]));
    getSubagentRunsSnapshotForRead(new Map());
    const fail = vi
      .spyOn(
        store,
        kind === "named" ? "saveSubagentRegistryChangesToSqlite" : "saveSubagentRegistryToSqlite",
      )
      .mockImplementationOnce(() => {
        throw new Error("Synthetic strict failure");
      });
    expect(() =>
      persistSubagentRunsToDiskOrThrow(new Map(), kind === "named" ? [retained.runId] : undefined),
    ).toThrow("Synthetic strict failure");
    fail.mockRestore();
    expect(
      await withPreparedLatestSubagentRunByChildSessionKey(
        childSessionKey,
        captureOpenClawStateWorkerContext(),
        (read) => read(),
      ),
    ).toMatchObject(retained);
  });

  it("keeps failed publication overlays with their database without clearing a newer owner's intent", async () => {
    const retained = run();
    saveSubagentRegistryToSqlite(new Map([[retained.runId, retained]]));
    getSubagentRunsSnapshotForRead(new Map());
    const originalContext = captureOpenClawStateWorkerContext();
    const failOriginal = vi
      .spyOn(store, "saveSubagentRegistryChangesToSqlite")
      .mockImplementationOnce(() => {
        throw new Error("Synthetic first database failure");
      });
    persistSubagentRunsToDisk(new Map(), [retained.runId]);
    failOriginal.mockRestore();
    const other = await createOpenClawTestState({
      prefix: "openclaw-subagent-other-",
      applyEnv: false,
    });
    try {
      const otherDurable = { ...retained, task: "Other database durable row" };
      const otherIntent = { ...retained, task: "Other database failed owner intent" };
      const otherContext = await withEnvAsync({ OPENCLAW_STATE_DIR: other.stateDir }, async () => {
        saveSubagentRegistryToSqlite(new Map([[otherDurable.runId, otherDurable]]));
        return captureOpenClawStateWorkerContext();
      });
      expect(
        await withPreparedLatestSubagentRunByChildSessionKey(
          childSessionKey,
          otherContext,
          (read) => read(),
        ),
      ).toMatchObject(otherDurable);
      const hold = holdReadResult();
      const olderRead = withPreparedLatestSubagentRunByChildSessionKey(
        childSessionKey,
        originalContext,
        (read) => read(),
      );
      try {
        await hold.held;
        await withEnvAsync({ OPENCLAW_STATE_DIR: other.stateDir }, async () => {
          const failOther = vi
            .spyOn(store, "saveSubagentRegistryChangesToSqlite")
            .mockImplementationOnce(() => {
              throw new Error("Synthetic other database failure");
            });
          persistSubagentRunsToDisk(new Map([[otherIntent.runId, otherIntent]]), [
            otherIntent.runId,
          ]);
          failOther.mockRestore();
        });
      } finally {
        hold.release();
      }
      expect(await olderRead).toMatchObject(retained);
      expect(
        await withPreparedLatestSubagentRunByChildSessionKey(
          childSessionKey,
          otherContext,
          (read) => {
            const copy = expectDefined(read(), "failed named publication row");
            copy.task = "Caller must not mutate the failed publication owner";
            return read();
          },
        ),
      ).toMatchObject(otherIntent);
      await reads.withOpenClawStateDatabaseReadSnapshot(async () => {
        expect(
          await withPreparedLatestSubagentRunByChildSessionKey(
            childSessionKey,
            otherContext,
            (read) => read(),
          ),
        ).toMatchObject(otherIntent);
      });
    } finally {
      await other.cleanup();
    }
  });
});
