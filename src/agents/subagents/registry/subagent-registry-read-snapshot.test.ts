import { renameSync } from "node:fs";
import { expect, it, onTestFinished, vi } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../../infra/kysely-sync.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  registerOpenClawStateDatabaseAsyncResource,
} from "../../../state/openclaw-state-db-cache.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../../../state/openclaw-state-db-readonly.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import type { PreparedSubagentRunsRead } from "./subagent-registry-read-snapshot.js";
import {
  clearSubagentRunsReadCacheForTest,
  persistSubagentRunsToDiskOrThrow,
  persistSubagentRunsToDisk,
  prepareSubagentMaintenanceRunsSnapshotForRead,
  prepareSubagentRunsSnapshotForRunIds,
  prepareSubagentRunsSnapshotForSessions,
} from "./subagent-registry-state.js";
import {
  saveSubagentRegistryToSqlite,
  loadSubagentRunsForSessionsInDatabase,
  subagentRunsDurableBasisMatches,
} from "./subagent-registry.store.sqlite.js";
import * as registryStore from "./subagent-registry.store.sqlite.js";

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

it("does not retain a removed live-only row as a prepared durable payload", async () => {
  await withPersistedReads(async () => {
    const entry = retainedRun();
    const memory = new Map([[entry.runId, entry]]);
    const prepared = await prepareSubagentRunsSnapshotForRunIds(memory, ["collector"]);
    memory.delete(entry.runId);
    expect(prepared.consume((runs) => [...runs.values()])).toEqual({ ready: true, value: [] });
  });
});

it.each(["reopening", "replacing"] as const)(
  "rejects a retired published snapshot after %s the database file",
  async (change) => {
    await withPersistedReads(async () => {
      const entry = retainedRun();
      persistSubagentRunsToDiskOrThrow(new Map([[entry.runId, entry]]));
      const context = captureOpenClawStateWorkerContext();
      const original = await prepareSubagentRunsSnapshotForRunIds(new Map(), ["collector"]);
      const release = createDeferredCore();
      const unregister = registerOpenClawStateDatabaseAsyncResource({
        close: () => release.promise,
      });
      const closing = closeOpenClawStateDatabaseByPathAsync(context.admission.databasePath);
      try {
        expect(() => captureOpenClawStateWorkerContext()).toThrow("read admission is closed");
        const retired = {
          ...entry,
          completion: { required: false, resultText: "retired publication" },
        };
        persistSubagentRunsToDiskOrThrow(new Map([[entry.runId, retired]]), [entry.runId]);
        release.resolve();
        await closing;
        if (change === "replacing") {
          renameSync(context.admission.databasePath, `${context.admission.databasePath}.retired`);
        }
        const reopened = {
          ...entry,
          completion: { required: false, resultText: "reopened durable result" },
        };
        saveSubagentRegistryToSqlite(new Map([[entry.runId, reopened]]));
        const current = captureOpenClawStateWorkerContext();
        expect(current.admission.identity.key === context.admission.identity.key).toBe(
          change === "reopening",
        );
        const consume = vi.fn();
        expect(() => original.consume(consume)).toThrow("read admission changed");
        expect(consume).not.toHaveBeenCalled();
        const prepared = await prepareSubagentRunsSnapshotForRunIds(new Map(), ["collector"]);
        expect(prepared.consume((runs) => runs.get(entry.runId)?.completion?.resultText)).toEqual({
          ready: true,
          value: "reopened durable result",
        });
      } finally {
        release.resolve();
        await closing;
        unregister();
      }
    });
  },
);

it.each(["delete", "replace", "move alias", "full publication"] as const)(
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
      persistSubagentRunsToDiskOrThrow(
        current,
        publication === "full publication" ? undefined : [entry.runId, replacement.runId],
      );
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
    onTestFinished(() => prepared.dispose());
    expect(
      prepared.consume((runs) => ({
        rawParent: runs.get(parent.runId) === parent,
        grandchild: runs.get(grandchild.runId)?.childSessionKey,
      })),
    ).toEqual({
      ready: true,
      value: { rawParent: true, grandchild: grandchild.childSessionKey },
    });
    expect(prepared.basis.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(prepared.basis)).toBe(true);
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

it.each(["unrelated", "relevant"] as const)(
  "handles a committed %s publication after durable descendant preparation",
  async (kind) => {
    await withPersistedReads(async () => {
      const entry = retainedRun();
      saveSubagentRegistryToSqlite(new Map([[entry.runId, entry]]));
      const prepared = await prepareSubagentRunsSnapshotForSessions(new Map(), [
        entry.requesterSessionKey,
      ]);
      try {
        const update =
          kind === "relevant"
            ? { ...entry, task: "updated" }
            : {
                ...entry,
                runId: "unrelated",
                requesterSessionKey: "agent:other:main",
                childSessionKey: "agent:other:subagent:child",
              };
        persistSubagentRunsToDiskOrThrow(new Map([[update.runId, update]]), [update.runId]);
        expect(prepared.consume((runs) => runs.get(entry.runId)?.task)).toEqual(
          kind === "relevant" ? { ready: false } : { ready: true, value: entry.task },
        );
      } finally {
        prepared.dispose();
      }
    });
  },
);

it.each(["update", "delete"] as const)(
  "preserves an unpublished named %s over fresh durable descendants",
  async (kind) => {
    await withPersistedReads(async () => {
      const entry = retainedRun();
      persistSubagentRunsToDiskOrThrow(new Map([[entry.runId, entry]]));
      // A foreign committed value must beat the old resident committed snapshot.
      const foreign = { ...entry, task: "foreign committed task" };
      saveSubagentRegistryToSqlite(new Map([[foreign.runId, foreign]]));
      const fresh = await prepareSubagentRunsSnapshotForSessions(new Map(), [
        entry.requesterSessionKey,
      ]);
      try {
        expect(fresh.consume((runs) => runs.get(entry.runId)?.task)).toEqual({
          ready: true,
          value: foreign.task,
        });
      } finally {
        fresh.dispose();
      }
      const write = vi
        .spyOn(registryStore, "saveSubagentRegistryChangesToSqlite")
        .mockImplementation(() => {
          throw new Error("synthetic persistence refusal");
        });
      try {
        const update = { ...entry, task: "unpublished local task" };
        persistSubagentRunsToDisk(
          kind === "update" ? new Map([[entry.runId, update]]) : new Map(),
          [entry.runId],
        );
        const prepared = await prepareSubagentRunsSnapshotForSessions(new Map(), [
          entry.requesterSessionKey,
        ]);
        try {
          expect(prepared.consume((runs) => runs.get(entry.runId)?.task)).toEqual({
            ready: true,
            value: kind === "update" ? update.task : undefined,
          });
        } finally {
          prepared.dispose();
        }
      } finally {
        write.mockRestore();
      }
    });
  },
);

it.each(["malformed payload", "duplicate identity", "topology", "unrelated row"] as const)(
  "compares the durable descendant basis after a physical %s change",
  async (change) => {
    await withPersistedReads(async () => {
      const root = "agent:main:cron:basis";
      const liveTopology = [{ requesterSessionKey: root, childSessionKey: "agent:main:live" }];
      const child = { ...retainedRun(), requesterSessionKey: "agent:main:live" };
      const malformed = {
        ...retainedRun(),
        runId: "malformed",
        childSessionKey: "agent:main:malformed",
        requesterSessionKey: ["duplicate identity", "unrelated row"].includes(change)
          ? "agent:main:other"
          : root,
      };
      saveSubagentRegistryToSqlite(
        new Map([
          [child.runId, child],
          [malformed.runId, malformed],
        ]),
      );
      const database = openOpenClawStateDatabase();
      const db = getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "subagent_runs">>(
        database.db,
      );
      const physicalId = change === "duplicate identity" ? ` ${child.runId} ` : malformed.runId;
      executeSqliteQuerySync(
        database.db,
        db
          .updateTable("subagent_runs")
          .set({ run_id: physicalId, payload_json: "{}" })
          .where("run_id", "=", malformed.runId),
      );
      const before = loadSubagentRunsForSessionsInDatabase(database, [root], liveTopology);
      expect([...before.runs.keys()]).toEqual([child.runId]);
      const basis = {
        databasePath: database.path,
        databaseIdentity: "comparison-owned-by-caller",
        sessionKeys: [root],
        liveTopology,
        digest: before.digest,
      };
      expect(subagentRunsDurableBasisMatches(database, basis)).toBe(true);
      executeSqliteQuerySync(
        database.db,
        db
          .updateTable("subagent_runs")
          .set(
            change === "topology"
              ? { requester_session_key: "agent:main:moved" }
              : { payload_json: '{"unreadable":true}' },
          )
          .where("run_id", "=", physicalId),
      );
      expect([
        ...loadSubagentRunsForSessionsInDatabase(database, [root], liveTopology).runs.keys(),
      ]).toEqual([child.runId]);
      expect(subagentRunsDurableBasisMatches(database, basis)).toBe(change === "unrelated row");
    });
  },
);

it.each(["named", "full"] as const)(
  "keeps prepared maintenance facts across payload-only %s publication and refuses changed protection",
  async (publication) => {
    await withPersistedReads(async () => {
      const entry = retainedRun();
      saveSubagentRegistryToSqlite(new Map([[entry.runId, entry]]));
      const prepared = await prepareSubagentMaintenanceRunsSnapshotForRead(new Map());
      try {
        const original = prepared.capture();
        const payloadOnly = {
          ...entry,
          task: "new retained prompt",
          completion: { required: false, resultText: "new retained result" },
        };
        const changedRunIds = publication === "named" ? [entry.runId] : undefined;
        persistSubagentRunsToDiskOrThrow(new Map([[entry.runId, payloadOnly]]), changedRunIds);
        expect(prepared.capture()).toEqual(original);

        const completed = { ...payloadOnly, cleanupCompletedAt: Date.now() };
        persistSubagentRunsToDiskOrThrow(new Map([[entry.runId, completed]]), changedRunIds);
        expect(() => prepared.capture()).toThrow("maintenance facts changed");
      } finally {
        prepared.dispose();
      }
    });
  },
);
