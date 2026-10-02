import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseAsync } from "../../../state/openclaw-state-db-cache.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { configureMockSubagentRegistryPersistence } from "../../subagent-test-fixtures.test-helpers.js";
import * as delivery from "./subagent-delivery-state.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { getLatestSubagentRunByChildSessionKeyFromRuns } from "./subagent-registry-queries.js";
import type { SubagentRunReadScope } from "./subagent-registry-read-snapshot.js";
import {
  persistRegistryFixture,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry-state.fixture.test-support.js";
import {
  clearSubagentRunsReadCacheForTest,
  getSubagentRunsSnapshotForRead,
  withSubagentRunReadSnapshot,
} from "./subagent-registry-state.js";
import * as store from "./subagent-registry.store.sqlite.js";
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
function readLatest() {
  return withSubagentRunReadSnapshot(
    subagentRuns,
    (snapshot) => ({
      runIds: [...snapshot.values()]
        .filter((entry) => entry.childSessionKey === childSessionKey)
        .map((entry) => entry.runId),
      sessionKeys: [],
    }),
    (_selection, runs) =>
      getLatestSubagentRunByChildSessionKeyFromRuns(runs.values(), childSessionKey) ?? null,
    { sessionKeys: [childSessionKey], descendants: true },
  );
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

describe("prepared subagent publication ownership", () => {
  it.each(["run", "session"] as const)(
    "copies only the selected %s from 5,000 retained records",
    async (kind) => {
      const records = new Map(
        Array.from({ length: 5_000 }, (_, i) => {
          const entry = {
            ...run(`run-${i}`),
            childSessionKey: `agent:main:child-${i}`,
            requesterSessionKey: `agent:main:parent-${i}`,
          };
          return [entry.runId, entry] as const;
        }),
      );
      persistRegistryFixture(records);
      for (const entry of [...records.values()].slice(0, 300)) {
        subagentRuns.set(entry.runId, entry);
      }
      const readScope: SubagentRunReadScope =
        kind === "run"
          ? { runIds: new Set(["run-0"]) }
          : { sessionKeys: ["agent:main:parent-0"], descendants: true };
      const read = () =>
        withSubagentRunReadSnapshot(
          subagentRuns,
          (snapshot) => ({ snapshot, runIds: ["run-0"], sessionKeys: [] }),
          ({ snapshot }, selected) => ({ snapshot, ids: [...selected.keys()] }),
          readScope,
        );
      await read();
      const projected = vi.spyOn(delivery, "projectSubagentRunForSessionList");
      const scan = vi.spyOn(subagentRuns, Symbol.iterator).mockImplementation(() => {
        throw new Error("A keyed read must not scan the live registry");
      });
      const result = await read();
      scan.mockRestore();
      expect(result.ids).toEqual(["run-0"]);
      expect([...result.snapshot.keys()]).toEqual(["run-0"]);
      expect(new Set(projected.mock.calls.map(([entry]) => entry.runId))).toEqual(
        new Set(["run-0"]),
      );
      // Each preparation/capture frame owns at most one copy of its matching record.
      expect(projected.mock.calls.length).toBeLessThanOrEqual(3);
      const current = subagentRuns.get("run-0")!;
      subagentRuns.set(current.runId, {
        ...current,
        execution: { ...current.execution, status: "terminal" },
      });
      expect(result.snapshot.get("run-0")?.execution.status).toBe("running");
    },
  );

  it.each([
    { warm: false, preparedFirst: false },
    { warm: true, preparedFirst: false },
    { warm: false, preparedFirst: true },
  ])(
    "retains committed rows after refused deletion through hydration (warm=$warm, prepared first=$preparedFirst)",
    async ({ warm, preparedFirst }) => {
      const first = run("first", 100);
      const second = run("second", 200);
      const committed = new Map([
        [first.runId, first],
        [second.runId, second],
      ]);
      saveSubagentRegistryToSqlite(committed);
      if (warm) {
        getSubagentRunsSnapshotForRead(new Map());
      }
      const fail = await configureMockSubagentRegistryPersistence({
        persistRegistryRows: () => {
          throw new Error("Synthetic disk failure");
        },
      });
      try {
        await expect(
          mutateSubagentRuns(
            [first.runId, second.runId],
            () => ({
              value: undefined,
              postimages: new Map([
                [first.runId, null],
                [second.runId, null],
              ]),
            }),
            { runs: committed },
          ),
        ).rejects.toThrow("Synthetic disk failure");
      } finally {
        fail.mockRestore();
      }
      if (preparedFirst) {
        expect(await readLatest()).toMatchObject(second);
      }
      expect(getSubagentRunsSnapshotForRead(new Map()).size).toBe(2);
      expect(store.loadSubagentRegistryFromSqlite().size).toBe(2);
      expect(await readLatest()).toMatchObject(second);
      persistRegistryFixture(new Map(), [second.runId]);
      expect(await readLatest()).toMatchObject(first);
      expect(getSubagentRunsSnapshotForRead(new Map()).has(second.runId)).toBe(false);
    },
  );

  it("keeps committed rows after refused replacement and applies acknowledged publications", async () => {
    const removed = run("removed", 900);
    const retained = run("retained", 100);
    const intended = run("intended", 300);
    const original = new Map([
      [removed.runId, removed],
      [retained.runId, retained],
    ]);
    saveSubagentRegistryToSqlite(original);
    getSubagentRunsSnapshotForRead(new Map());
    const fail = await configureMockSubagentRegistryPersistence({
      persistRegistryRows: () => {
        throw new Error("Synthetic replacement failure");
      },
    });
    try {
      await expect(
        mutateSubagentRuns(
          [removed.runId, retained.runId, intended.runId],
          () => ({
            value: undefined,
            postimages: new Map<string, SubagentRunRecord | null>([
              [removed.runId, null],
              [retained.runId, retained],
              [intended.runId, intended],
            ]),
          }),
          { runs: original },
        ),
      ).rejects.toThrow("Synthetic replacement failure");
    } finally {
      fail.mockRestore();
    }
    const copy = expectDefined(await readLatest(), "retained committed row");
    copy.task = "Caller must not mutate committed facts";
    expect(await readLatest()).toMatchObject(removed);
    expect(getSubagentRunsSnapshotForRead(new Map()).has(intended.runId)).toBe(false);
    const committed = { ...retained, createdAt: 1_000 };
    persistRegistryFixture(new Map([[committed.runId, committed]]), [committed.runId]);
    expect(await readLatest()).toMatchObject(committed);
    expect(getSubagentRunsSnapshotForRead(new Map()).has(removed.runId)).toBe(true);
    persistRegistryFixture(new Map([[retained.runId, retained]]));
    expect(await readLatest()).toMatchObject(retained);
    expect(getSubagentRunsSnapshotForRead(new Map()).has(removed.runId)).toBe(false);
  });

  it("keeps committed snapshots with their database after refused writes and source switches", async () => {
    const retained = run();
    const original = new Map([[retained.runId, retained]]);
    saveSubagentRegistryToSqlite(original);
    getSubagentRunsSnapshotForRead(new Map());
    const fail = await configureMockSubagentRegistryPersistence({
      persistRegistryRows: () => {
        throw new Error("Synthetic database failure");
      },
    });
    const other = await createOpenClawTestState({
      prefix: "openclaw-subagent-other-",
      applyEnv: false,
    });
    try {
      await expect(
        mutateSubagentRuns(
          [retained.runId],
          () => ({ value: undefined, postimages: new Map([[retained.runId, null]]) }),
          { runs: original },
        ),
      ).rejects.toThrow("Synthetic database failure");
      const otherDurable = { ...retained, task: "Other database durable row" };
      const otherIntent = { ...retained, task: "Other database refused owner intent" };
      await withEnvAsync({ OPENCLAW_STATE_DIR: other.stateDir }, async () => {
        const otherRows = new Map([[otherDurable.runId, otherDurable]]);
        saveSubagentRegistryToSqlite(otherRows);
        expect(await readLatest()).toMatchObject(otherDurable);
        await expect(
          mutateSubagentRuns(
            [otherIntent.runId],
            () => ({ value: undefined, postimages: new Map([[otherIntent.runId, otherIntent]]) }),
            { runs: otherRows },
          ),
        ).rejects.toThrow("Synthetic database failure");
        const copy = expectDefined(await readLatest(), "other database committed row");
        copy.task = "Caller must not mutate committed facts";
        expect(await readLatest()).toMatchObject(otherDurable);
      });
      expect(await readLatest()).toMatchObject(retained);
      await withEnvAsync({ OPENCLAW_STATE_DIR: other.stateDir }, async () => {
        expect(await readLatest()).toMatchObject(otherDurable);
      });
    } finally {
      fail.mockRestore();
      await other.cleanup();
    }
  });
});
