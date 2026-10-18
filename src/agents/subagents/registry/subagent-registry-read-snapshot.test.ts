import { aroundEach, expect, it, vi } from "vitest";
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
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const rows = (...entries: SubagentRunRecord[]) => new Map(entries.map((row) => [row.runId, row]));
const prepareRun = (memory = rows()) => prepareSubagentRunsSnapshotForRunIds(memory, ["collector"]);
const resultText = (runs: ReadonlyMap<string, SubagentRunRecord>) =>
  runs.get("physical")?.completion?.resultText;
const change = (entry: SubagentRunRecord, next: SubagentRunRecord | null) => ({
  value: undefined,
  postimages: new Map([[entry.runId, next]]),
});

function fixture() {
  const entry = createSubagentRunRecord({
    runId: "physical",
    childSessionKey: "agent:main:subagent:collector",
    swarmRunId: "collector",
    collect: true,
    completion: { required: false, resultText: "prepared result" },
    delivery: { status: "not_required" },
  });
  return { entry, memory: rows(entry) };
}

let entry: ReturnType<typeof fixture>["entry"];
let memory: ReturnType<typeof fixture>["memory"];
aroundEach((runTest) =>
  withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
    async () => {
      openOpenClawStateDatabase();
      clearSubagentRunsReadCacheForTest();
      ({ entry, memory } = fixture());
      try {
        await runTest();
      } finally {
        clearSubagentRunsReadCacheForTest();
      }
    },
  ),
);

it("captures current committed maintenance protection", async () => {
  persistRegistryFixture(memory);
  const prepared = await prepareSubagentMaintenanceRunsSnapshotForRead(rows());
  const completed = { ...entry, cleanupCompletedAt: 100 };
  const active = { ...entry, runId: "new-child", childSessionKey: "agent:main:subagent:new" };
  persistRegistryFixture(rows(completed, active), [completed.runId, active.runId]);
  const current = prepared.capture();
  expect(current.get(entry.runId)).toMatchObject({ cleanupCompletedAt: 100 });
  expect(current.get(active.runId)).toMatchObject({ childSessionKey: active.childSessionKey });
});

it("drops removed live-only rows", async () => {
  const prepared = await prepareRun(memory);
  memory.delete(entry.runId);
  expect(prepared.consume((runs) => [...runs.values()])).toEqual({ ready: true, value: [] });
});

it.each(["update", "delete"] as const)(
  "consumes committed resident %s",
  async (kind: "update" | "delete") => {
    persistRegistryFixture(memory);
    const prepared = await prepareRun(memory);
    await mutateSubagentRuns(
      [entry.runId],
      (current) =>
        change(
          entry,
          kind === "delete"
            ? null
            : {
                ...current.get(entry.runId)!,
                completion: { required: false, resultText: "committed child result" },
              },
        ),
      { runs: memory },
    );
    expect(prepared.consume(resultText)).toEqual({
      ready: true,
      value: kind === "delete" ? undefined : "committed child result",
    });
  },
);

it.each(["preparing caller", "consuming caller", "database"] as const)(
  "rejects a read after %s loses admission",
  async (owner: "preparing caller" | "consuming caller" | "database") => {
    saveSubagentRegistryToSqlite(memory);
    const work = new AsyncWorkScope();
    const prepared =
      owner === "preparing caller" ? await work.track(() => prepareRun()) : await prepareRun();
    const consume = vi.fn();
    try {
      if (owner === "database") {
        await closeOpenClawStateDatabaseByPathAsync(
          captureOpenClawStateWorkerContext().admission.databasePath,
        );
      } else {
        work.beginClose(new Error("prepared read caller canceled"));
      }
      const read = () => prepared.consume(consume);
      expect(() => (owner === "consuming caller" ? work.run(read) : read())).toThrow();
      expect(consume).not.toHaveBeenCalled();
    } finally {
      await work.drain();
    }
  },
);

it("confines private reads to their exact active snapshot", async () => {
  saveSubagentRegistryToSqlite(memory);
  const prepared = createDeferredCore<PreparedSubagentRunsRead>();
  const release = createDeferredCore();
  const privateRead = withOpenClawStateDatabaseReadSnapshot(async () => {
    const read = await prepareRun();
    expect(read.consume(resultText)).toEqual({ ready: true, value: "prepared result" });
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
    const outside = () => read.consume(consume);
    expect(outside).toThrow("left its database snapshot scope");
    await withOpenClawStateDatabaseReadSnapshot(async () => {
      expect(outside).toThrow("left its database snapshot scope");
    });
    release.resolve();
    await privateRead;
    expect(outside).toThrow();
    expect(consume).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await privateRead;
  }
});

it("hydrates live-parent descendants and rejects changed topology", async () => {
  const root = "agent:main:cron:prepared";
  const parent = {
    ...entry,
    runId: "live-parent",
    requesterSessionKey: root,
    childSessionKey: "agent:main:subagent:live-parent",
  };
  const grandchild = {
    ...entry,
    runId: "persisted-grandchild",
    requesterSessionKey: parent.childSessionKey,
    childSessionKey: "agent:main:subagent:persisted-grandchild",
  };
  saveSubagentRegistryToSqlite(rows(grandchild));
  memory = rows(parent);
  const prepared = await prepareSubagentRunsSnapshotForSessions(memory, [root]);
  expect(
    prepared.consume((runs) => ({
      rawParent: runs.get(parent.runId) === parent,
      grandchild: runs.get(grandchild.runId)?.childSessionKey,
    })),
  ).toEqual({ ready: true, value: { rawParent: true, grandchild: grandchild.childSessionKey } });
  memory.set("new-child", {
    ...parent,
    runId: "new-child",
    childSessionKey: "agent:main:subagent:new",
  });
  const consume = vi.fn();
  expect(prepared.consume(consume)).toEqual({ ready: false });
  expect(consume).not.toHaveBeenCalled();
});

it("keeps fresh descendants after a refused update", async () => {
  persistRegistryFixture(memory);
  // A foreign commit must beat the old resident snapshot, even after a refused local write.
  const foreign = { ...entry, task: "foreign committed task" };
  saveSubagentRegistryToSqlite(rows(foreign));
  const prepare = () => prepareSubagentRunsSnapshotForSessions(rows(), [entry.requesterSessionKey]);
  const expected = { ready: true, value: foreign.task };
  expect((await prepare()).consume((runs) => runs.get(entry.runId)?.task)).toEqual(expected);
  const write = await configureMockSubagentRegistryPersistence({
    persistRegistryRows: () => {
      throw new Error("synthetic persistence refusal");
    },
  });
  try {
    await expect(
      mutateSubagentRuns(
        [entry.runId],
        () => change(entry, { ...entry, task: "refused local task" }),
        { runs: rows(foreign) },
      ),
    ).rejects.toThrow("synthetic persistence refusal");
    expect((await prepare()).consume((runs) => runs.get(entry.runId)?.task)).toEqual(expected);
  } finally {
    write.mockRestore();
  }
});
