import { aroundEach, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../../test/helpers/promise.js";
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
  persistRegistryFixture as persist,
  saveSubagentRegistryToSqlite as save,
} from "./subagent-registry-state.fixture.test-support.js";
import {
  clearSubagentRunsReadCacheForTest as clearReadCache,
  prepareSubagentMaintenanceRunsSnapshotForRead as prepareMaintenance,
  prepareSubagentRunsSnapshotForRunIds,
  prepareSubagentRunsSnapshotForSessions as prepareSessions,
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

let entry: SubagentRunRecord;
let memory: Map<string, SubagentRunRecord>;
aroundEach((runTest) =>
  withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
    async () => {
      openOpenClawStateDatabase();
      clearReadCache();
      entry = createSubagentRunRecord({
        runId: "physical",
        childSessionKey: "agent:main:subagent:collector",
        swarmRunId: "collector",
        collect: true,
        completion: { required: false, resultText: "prepared result" },
        delivery: { status: "not_required" },
      });
      memory = rows(entry);
      try {
        await runTest();
      } finally {
        clearReadCache();
      }
    },
  ),
);

it("captures current committed maintenance protection", async () => {
  persist(memory);
  const prepared = await prepareMaintenance(rows());
  const completed = { ...entry, cleanupCompletedAt: 100 };
  const active = { ...entry, runId: "new-child", childSessionKey: "agent:main:subagent:new" };
  persist(rows(completed, active), [completed.runId, active.runId]);
  const current = prepared.capture();
  expect(current.get(entry.runId)).toMatchObject({ cleanupCompletedAt: 100 });
  expect(current.get(active.runId)).toMatchObject({ childSessionKey: active.childSessionKey });
});

it.each(["live-only delete", "update", "delete"] as const)(
  "consumes committed resident %s",
  async (kind) => {
    if (kind !== "live-only delete") {
      persist(memory);
    }
    const prepared = await prepareRun(memory);
    if (kind === "live-only delete") {
      memory.delete(entry.runId);
      expect(prepared.consume((runs) => [...runs.values()])).toEqual({ ready: true, value: [] });
    } else {
      await mutateSubagentRuns(
        [entry.runId],
        (current) => {
          const next = {
            ...current.get(entry.runId)!,
            completion: { required: false, resultText: "committed child result" },
          };
          return change(entry, kind === "delete" ? null : next);
        },
        { runs: memory },
      );
      expect(prepared.consume(resultText)).toEqual({
        ready: true,
        value: kind === "delete" ? undefined : "committed child result",
      });
    }
  },
);

it.each(["preparing caller", "consuming caller", "database"] as const)(
  "rejects a read after %s loses admission",
  async (owner) => {
    save(memory);
    const work = new AsyncWorkScope();
    onTestFinished(() => work.drain());
    const prepared =
      owner === "preparing caller" ? await work.track(() => prepareRun()) : await prepareRun();
    const consume = vi.fn();
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
  },
);

it("confines private reads to their exact active snapshot", async () => {
  save(memory);
  const prepared = createDeferredCore<PreparedSubagentRunsRead>();
  const release = createDeferredCore();
  const privateRead = withOpenClawStateDatabaseReadSnapshot(async () => {
    const read = await prepareRun();
    expect(read.consume(resultText)).toEqual({ ready: true, value: "prepared result" });
    prepared.resolve(read);
    await release.promise;
  });
  onTestFinished(async () => {
    release.resolve();
    await privateRead;
  });
  const consume = vi.fn();
  const read = await awaitGateBeforeSettlement(
    prepared.promise,
    privateRead,
    "Private snapshot closed before preparing its read",
  );
  const outside = () => read.consume(consume);
  expect(outside).toThrow("left its database snapshot scope");
  await withOpenClawStateDatabaseReadSnapshot(async () => {
    expect(outside).toThrow("left its database snapshot scope");
  });
  release.resolve();
  await privateRead;
  expect(outside).toThrow();
  expect(consume).not.toHaveBeenCalled();
});

it("hydrates live-parent descendants and rejects changed topology", async () => {
  const root = "agent:main:cron:prepared";
  const child = (runId: string, requesterSessionKey: string) => ({
    ...entry,
    runId,
    requesterSessionKey,
    childSessionKey: `agent:main:subagent:${runId}`,
  });
  const parent = child("live-parent", root);
  const grandchild = child("persisted-grandchild", parent.childSessionKey);
  save(rows(grandchild));
  memory = rows(parent);
  const prepared = await prepareSessions(memory, [root]);
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
  persist(memory);
  // A foreign commit must beat the old resident snapshot, even after a refused local write.
  const foreign = { ...entry, task: "foreign committed task" };
  save(rows(foreign));
  const prepare = () => prepareSessions(rows(), [entry.requesterSessionKey]);
  const expected = { ready: true, value: foreign.task };
  expect((await prepare()).consume((runs) => runs.get(entry.runId)?.task)).toEqual(expected);
  await configureMockSubagentRegistryPersistence({
    persistRegistryRows: () => {
      throw new Error("synthetic persistence refusal");
    },
  });
  await expect(
    mutateSubagentRuns(
      [entry.runId],
      () => change(entry, { ...entry, task: "refused local task" }),
      { runs: rows(foreign) },
    ),
  ).rejects.toThrow("synthetic persistence refusal");
  expect((await prepare()).consume((runs) => runs.get(entry.runId)?.task)).toEqual(expected);
});
