import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseAsync } from "../../../state/openclaw-state-db-cache.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { getLatestSubagentRunByChildSessionKeyFromRuns } from "./subagent-registry-queries.js";
import {
  clearSubagentRunsReadCacheForTest,
  getSubagentRunsSnapshotForRead,
  getSubagentRunsSnapshotForSessions,
  persistSubagentRunsToDiskOrThrow,
  persistSubagentRunsToDisk,
  withSubagentRunReadSnapshot,
} from "./subagent-registry-state.js";
import * as store from "./subagent-registry.store.sqlite.js";
import { saveSubagentRegistryToSqlite } from "./subagent-registry.store.sqlite.js";
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
      expect(await readLatest()).toBeNull();
      persistSubagentRunsToDiskOrThrow(new Map([[first.runId, first]]), [first.runId]);
      expect(await readLatest()).toMatchObject(first);
      expect(getSubagentRunsSnapshotForRead(new Map()).has(second.runId)).toBe(false);
    },
  );

  it("preserves failed full replacement intent and applies only acknowledged owner publications", async () => {
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
    const copy = expectDefined(await readLatest(), "failed replacement row");
    copy.task = "Caller must not mutate the replacement owner";
    expect(await readLatest()).toMatchObject(intended);
    const committed = { ...retained, createdAt: 400 };
    persistSubagentRunsToDiskOrThrow(new Map([[committed.runId, committed]]), [committed.runId]);
    expect(await readLatest()).toMatchObject(committed);
    persistSubagentRunsToDiskOrThrow(new Map([[retained.runId, retained]]));
    expect(await readLatest()).toMatchObject(retained);
    expect(getSubagentRunsSnapshotForRead(new Map()).has(removed.runId)).toBe(false);
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
