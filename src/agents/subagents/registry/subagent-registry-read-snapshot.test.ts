import { expect, it, vi } from "vitest";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../../state/openclaw-state-db-cache.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../../../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  createSubagentRunRecord,
  configureMockSubagentRegistryPersistence,
} from "../../subagent-test-fixtures.test-helpers.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import type { PreparedSubagentRunsRead } from "./subagent-registry-read-snapshot.js";
import {
  persistRegistryFixture,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry-state.fixture.test-support.js";
import {
  clearSubagentRunsReadCacheForTest,
  prepareSubagentMaintenanceRunsSnapshotForRead,
  prepareSubagentRunsSnapshotForRunIds,
  prepareSubagentRunsSnapshotForSessions,
} from "./subagent-registry-state.js";

function retainedRun() {
  return createSubagentRunRecord({
    runId: "physical",
    childSessionKey: "agent:main:subagent:collector",
    swarmRunId: "collector",
    collect: true,
    completion: { required: false, resultText: "prepared result" },
    delivery: { status: "not_required" },
  });
}

async function withPersistedReads(run: () => Promise<void>) {
  await withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
    async () => {
      openOpenClawStateDatabase();
      clearSubagentRunsReadCacheForTest();
      try {
        await run();
      } finally {
        clearSubagentRunsReadCacheForTest();
      }
    },
  );
}

it("captures current committed maintenance protection after preparation", async () => {
  await withPersistedReads(async () => {
    const entry = retainedRun();
    persistRegistryFixture(new Map([[entry.runId, entry]]));
    const prepared = await prepareSubagentMaintenanceRunsSnapshotForRead(new Map());
    const completed = { ...entry, cleanupCompletedAt: 100 };
    const active = { ...entry, runId: "new-child", childSessionKey: "agent:main:subagent:new" };
    persistRegistryFixture(
      new Map([
        [completed.runId, completed],
        [active.runId, active],
      ]),
      [completed.runId, active.runId],
    );
    const current = prepared.capture();
    expect(current.get(entry.runId)?.cleanupCompletedAt).toBe(100);
    expect(current.get(active.runId)?.childSessionKey).toBe(active.childSessionKey);
  });
});

it("does not retain a removed live-only row as a prepared durable payload", async () => {
  await withPersistedReads(async () => {
    const entry = retainedRun();
    const memory = new Map([[entry.runId, entry]]);
    const prepared = await prepareSubagentRunsSnapshotForRunIds(memory, ["collector"]);
    memory.delete(entry.runId);
    expect(prepared.consume((runs) => [...runs.values()])).toEqual({ ready: true, value: [] });
  });
});

it.each(["delete", "replace", "move alias", "update"] as const)(
  "applies a %s in the prepared read's consuming frame",
  async (publication) => {
    await withPersistedReads(async () => {
      const entry = retainedRun();
      saveSubagentRegistryToSqlite(new Map([[entry.runId, entry]]));
      const prepared = await prepareSubagentRunsSnapshotForRunIds(new Map(), ["collector"]);
      const replacement = {
        ...entry,
        runId: publication === "replace" ? "replacement" : entry.runId,
        swarmRunId: publication === "move alias" ? "other-collector" : entry.swarmRunId,
        requesterSessionKey: "agent:main:current-owner",
        completion: { required: false, resultText: "current result" },
      };
      const current = new Map(publication === "delete" ? [] : [[replacement.runId, replacement]]);
      persistRegistryFixture(current, [entry.runId, replacement.runId]);
      expect(prepared.consume((runs) => [...runs.values()])).toEqual({
        ready: true,
        value: publication === "delete" || publication === "move alias" ? [] : [replacement],
      });
    });
  },
);

it.each(["preparing caller", "consuming caller", "database"] as const)(
  "rejects a prepared read after its %s loses admission",
  async (owner) => {
    await withPersistedReads(async () => {
      const entry = retainedRun();
      saveSubagentRegistryToSqlite(new Map([[entry.runId, entry]]));
      const work = new AsyncWorkScope();
      const prepare = () => prepareSubagentRunsSnapshotForRunIds(new Map(), ["collector"]);
      const prepared = owner === "preparing caller" ? await work.track(prepare) : await prepare();
      const reason = new Error("prepared read caller canceled");
      const consume = vi.fn();
      try {
        if (owner === "database") {
          await closeOpenClawStateDatabaseByPathAsync(
            captureOpenClawStateWorkerContext().admission.databasePath,
          );
        } else {
          work.beginClose(reason);
        }
        const read = () => prepared.consume(consume);
        expect(() => (owner === "consuming caller" ? work.run(read) : read())).toThrow();
        expect(consume).not.toHaveBeenCalled();
      } finally {
        await work.drain();
      }
    });
  },
);

it("keeps a prepared private read inside its exact active snapshot", async () => {
  await withPersistedReads(async () => {
    const entry = retainedRun();
    saveSubagentRegistryToSqlite(new Map([[entry.runId, entry]]));
    const prepared = createDeferredCore<PreparedSubagentRunsRead>();
    const release = createDeferredCore();
    const privateRead = withOpenClawStateDatabaseReadSnapshot(async () => {
      const read = await prepareSubagentRunsSnapshotForRunIds(new Map(), ["collector"]);
      expect(read.consume((runs) => runs.get(entry.runId)?.completion?.resultText)).toEqual({
        ready: true,
        value: "prepared result",
      });
      prepared.resolve(read);
      await release.promise;
    });
    const consume = vi.fn();
    try {
      const read = await Promise.race([
        prepared.promise,
        privateRead.then(() => {
          throw new Error("Private snapshot closed before preparing its read");
        }),
      ]);
      expect(() => read.consume(consume)).toThrow("left its database snapshot scope");
      await withOpenClawStateDatabaseReadSnapshot(async () => {
        expect(() => read.consume(consume)).toThrow("left its database snapshot scope");
      });
      release.resolve();
      await privateRead;
      expect(() => read.consume(consume)).toThrow();
      expect(consume).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await privateRead;
    }
  });
});

it("prepares durable grandchildren through live-only parents and refuses changed live topology", async () => {
  await withPersistedReads(async () => {
    const root = "agent:main:cron:prepared";
    const parent = {
      ...retainedRun(),
      runId: "live-parent",
      requesterSessionKey: root,
      childSessionKey: "agent:main:subagent:live-parent",
    };
    const grandchild = {
      ...retainedRun(),
      runId: "persisted-grandchild",
      requesterSessionKey: parent.childSessionKey,
      childSessionKey: "agent:main:subagent:persisted-grandchild",
    };
    saveSubagentRegistryToSqlite(new Map([[grandchild.runId, grandchild]]));
    const memory = new Map([[parent.runId, parent]]);
    const prepared = await prepareSubagentRunsSnapshotForSessions(memory, [root]);
    expect(
      prepared.consume((runs) => ({
        rawParent: runs.get(parent.runId) === parent,
        grandchild: runs.get(grandchild.runId)?.childSessionKey,
      })),
    ).toEqual({
      ready: true,
      value: { rawParent: true, grandchild: grandchild.childSessionKey },
    });
    memory.set("new-child", {
      ...parent,
      runId: "new-child",
      childSessionKey: "agent:main:subagent:new",
    });
    const consume = vi.fn();
    expect(prepared.consume(consume)).toEqual({ ready: false });
    expect(consume).not.toHaveBeenCalled();
  });
});

it.each(["update", "delete"] as const)(
  "preserves fresh durable descendants after a refused named %s",
  async (kind) => {
    await withPersistedReads(async () => {
      const entry = retainedRun();
      persistRegistryFixture(new Map([[entry.runId, entry]]));
      // A foreign committed value must beat the old resident committed snapshot.
      const foreign = { ...entry, task: "foreign committed task" };
      saveSubagentRegistryToSqlite(new Map([[foreign.runId, foreign]]));
      const fresh = await prepareSubagentRunsSnapshotForSessions(new Map(), [
        entry.requesterSessionKey,
      ]);
      expect(fresh.consume((runs) => runs.get(entry.runId)?.task)).toEqual({
        ready: true,
        value: foreign.task,
      });
      const write = await configureMockSubagentRegistryPersistence({
        persistRegistryRows: () => {
          throw new Error("synthetic persistence refusal");
        },
      });
      try {
        const update = { ...entry, task: "refused local task" };
        await expect(
          mutateSubagentRuns(
            [entry.runId],
            () => ({
              value: undefined,
              postimages: new Map([[entry.runId, kind === "update" ? update : null]]),
            }),
            { runs: new Map([[foreign.runId, foreign]]) },
          ),
        ).rejects.toThrow("synthetic persistence refusal");
        const prepared = await prepareSubagentRunsSnapshotForSessions(new Map(), [
          entry.requesterSessionKey,
        ]);
        expect(prepared.consume((runs) => runs.get(entry.runId)?.task)).toEqual({
          ready: true,
          value: foreign.task,
        });
      } finally {
        write.mockRestore();
      }
    });
  },
);
