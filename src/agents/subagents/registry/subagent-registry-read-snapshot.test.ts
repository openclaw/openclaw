import { renameSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  registerOpenClawStateDatabaseAsyncResource,
} from "../../../state/openclaw-state-db-cache.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../../../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import type { PreparedSubagentRunsRead } from "./subagent-registry-read-snapshot.js";
import {
  clearSubagentRunsReadCacheForTest,
  persistSubagentRunsToDiskOrThrow,
  prepareSubagentRunsSnapshotForRunIds,
} from "./subagent-registry-state.js";
import { saveSubagentRegistryToSqlite } from "./subagent-registry.store.sqlite.js";

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
