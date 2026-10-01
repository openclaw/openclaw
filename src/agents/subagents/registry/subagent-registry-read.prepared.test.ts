import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseAsync } from "../../../state/openclaw-state-db-cache.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import * as delivery from "./subagent-delivery-state.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { getLatestSubagentRunByChildSessionKeyFromRuns } from "./subagent-registry-queries.js";
import type { SubagentRunReadScope } from "./subagent-registry-read-snapshot.js";
import {
  clearSubagentRunsReadCacheForTest,
  getSubagentRunsSnapshotForRead,
  persistSubagentRunsToDiskOrThrow,
  persistSubagentRunsToDisk,
  withSubagentRunReadSnapshot,
} from "./subagent-registry-state.js";
import * as store from "./subagent-registry.store.sqlite.js";
import { saveSubagentRegistryToSqlite } from "./subagent-registry.store.test-support.js";
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
      persistSubagentRunsToDiskOrThrow(records, [...records.keys()]);
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
      subagentRuns.get("run-0")!.execution.status = "terminal";
      expect(result.snapshot.get("run-0")?.execution.status).toBe("running");
    },
  );

  it.each([
    { warm: false, preparedFirst: false },
    { warm: true, preparedFirst: false },
    { warm: false, preparedFirst: true },
  ])(
    "retains failed named deletion through hydration (warm=$warm, prepared first=$preparedFirst) and clears only exact successful rows",
    async ({ warm, preparedFirst }) => {
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
      if (preparedFirst) {
        expect(await readLatest()).toBeNull();
      }
      expect(getSubagentRunsSnapshotForRead(new Map()).size).toBe(0);
      expect(store.loadSubagentRegistryFromSqlite().size).toBe(2);
      expect(await readLatest()).toBeNull();
      persistSubagentRunsToDiskOrThrow(new Map([[first.runId, first]]), [first.runId]);
      expect(await readLatest()).toMatchObject(first);
      expect(getSubagentRunsSnapshotForRead(new Map()).has(second.runId)).toBe(false);
    },
  );

  it("does not publish a strict named failure", async () => {
    const retained = run();
    saveSubagentRegistryToSqlite(new Map([[retained.runId, retained]]));
    getSubagentRunsSnapshotForRead(new Map());
    const fail = vi
      .spyOn(store, "saveSubagentRegistryChangesToSqlite")
      .mockImplementationOnce(() => {
        throw new Error("Synthetic strict failure");
      });
    expect(() => persistSubagentRunsToDiskOrThrow(new Map(), [retained.runId])).toThrow(
      "Synthetic strict failure",
    );
    fail.mockRestore();
    expect(await readLatest()).toMatchObject(retained);
  });

  it("keeps failed publication overlays with their database without clearing a newer owner's intent", async () => {
    const retained = run();
    saveSubagentRegistryToSqlite(new Map([[retained.runId, retained]]));
    getSubagentRunsSnapshotForRead(new Map());
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
      await withEnvAsync({ OPENCLAW_STATE_DIR: other.stateDir }, async () => {
        saveSubagentRegistryToSqlite(new Map([[otherDurable.runId, otherDurable]]));
        expect(await readLatest()).toMatchObject(otherDurable);
        const failOther = vi
          .spyOn(store, "saveSubagentRegistryChangesToSqlite")
          .mockImplementationOnce(() => {
            throw new Error("Synthetic other database failure");
          });
        persistSubagentRunsToDisk(new Map([[otherIntent.runId, otherIntent]]), [otherIntent.runId]);
        failOther.mockRestore();
        const copy = expectDefined(await readLatest(), "failed named publication row");
        copy.task = "Caller must not mutate the failed publication owner";
        expect(await readLatest()).toMatchObject(otherIntent);
      });
      expect(await readLatest()).toMatchObject(retained);
      await withEnvAsync({ OPENCLAW_STATE_DIR: other.stateDir }, async () => {
        expect(await readLatest()).toMatchObject(otherIntent);
      });
    } finally {
      await other.cleanup();
    }
  });
});
