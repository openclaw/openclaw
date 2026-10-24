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
import {
  mutateSubagentRuns,
  restoreSubagentRunsFromDisk,
} from "./subagent-registry-persistence.js";
import { getLatestSubagentRunByChildSessionKeyFromRuns } from "./subagent-registry-queries.js";
import type { SubagentRunReadScope } from "./subagent-registry-read-snapshot.js";
import {
  loadSubagentRegistryFromSqlite,
  persistRegistryFixture,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry-state.fixture.test-support.js";
import {
  clearSubagentRunsReadCacheForTest,
  getSubagentRunsSnapshotForRead,
  withSubagentRunReadSnapshot,
} from "./subagent-registry-state.js";
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
const runMap = (...runs: SubagentRunRecord[]) => new Map(runs.map((row) => [row.runId, row]));
const readSnapshot = () => getSubagentRunsSnapshotForRead(new Map());
const restore = () => restoreSubagentRunsFromDisk({ runs: new Map() });
const writeFailure = "Synthetic write failure";
async function withRefusedWrites(work: () => Promise<void>) {
  const fail = await configureMockSubagentRegistryPersistence({
    persistRegistryRows: () => {
      throw new Error(writeFailure);
    },
  });
  try {
    await work();
  } finally {
    fail.mockRestore();
  }
}
async function expectRefusedMutation(
  runs: Map<string, SubagentRunRecord>,
  postimages: Record<string, SubagentRunRecord | null>,
) {
  await expect(
    mutateSubagentRuns(
      Object.keys(postimages),
      () => ({ value: undefined, postimages: new Map(Object.entries(postimages)) }),
      { runs },
    ),
  ).rejects.toThrow(writeFailure);
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
    "reuses the selected %s projection from 5,000 retained records",
    async (kind) => {
      const records = runMap(
        ...Array.from({ length: 5_000 }, (_, i) => ({
          ...run(`run-${i}`),
          childSessionKey: `agent:main:child-${i}`,
          requesterSessionKey: `agent:main:parent-${i}`,
        })),
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
          (snapshot) => ({
            snapshot,
            runIds: kind === "run" ? ["run-0"] : [],
            sessionKeys: kind === "session" ? ["agent:main:parent-0"] : [],
          }),
          ({ snapshot }, selected) => ({ snapshot, ids: [...selected.keys()] }),
          readScope,
        );
      const warmed = await read();
      const projected = vi.spyOn(delivery, "projectSubagentRunForSessionList");
      const scan = vi.spyOn(subagentRuns, Symbol.iterator).mockImplementation(() => {
        throw new Error("A keyed read must not scan the live registry");
      });
      const result = await read();
      scan.mockRestore();
      expect(result.ids).toEqual(["run-0"]);
      expect([...result.snapshot.keys()]).toEqual(["run-0"]);
      expect(result.snapshot.get("run-0")).toBe(warmed.snapshot.get("run-0"));
      expect(projected).not.toHaveBeenCalled();
      const current = subagentRuns.get("run-0")!;
      subagentRuns.set(current.runId, {
        ...current,
        execution: { ...current.execution, status: "terminal" },
      });
      expect(result.snapshot.get("run-0")?.execution.status).toBe("running");
      expect((await read()).snapshot.get("run-0")?.execution.status).toBe("terminal");
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
      const committed = runMap(first, second);
      saveSubagentRegistryToSqlite(committed);
      if (warm) {
        await restore();
      }
      await withRefusedWrites(() =>
        expectRefusedMutation(committed, {
          [first.runId]: null,
          [second.runId]: null,
        }),
      );
      if (preparedFirst) {
        expect(await readLatest()).toMatchObject(second);
      }
      await restore();
      expect(readSnapshot().size).toBe(2);
      expect(loadSubagentRegistryFromSqlite().size).toBe(2);
      expect(await readLatest()).toMatchObject(second);
      persistRegistryFixture(new Map(), [second.runId]);
      expect(await readLatest()).toMatchObject(first);
      expect(readSnapshot().has(second.runId)).toBe(false);
    },
  );

  it("keeps committed rows after refused replacement and applies acknowledged publications", async () => {
    const removed = run("removed", 900);
    const retained = run("retained", 100);
    const intended = run("intended", 300);
    const original = runMap(removed, retained);
    saveSubagentRegistryToSqlite(original);
    await restore();
    await withRefusedWrites(() =>
      expectRefusedMutation(original, {
        [removed.runId]: null,
        [retained.runId]: retained,
        [intended.runId]: intended,
      }),
    );
    const copy = expectDefined(await readLatest(), "retained committed row");
    expect(() => {
      copy.task = "Caller must not mutate committed facts";
    }).toThrow(TypeError);
    expect(await readLatest()).toBe(copy);
    expect(await readLatest()).toMatchObject(removed);
    expect(readSnapshot().has(intended.runId)).toBe(false);
    const committed = { ...retained, createdAt: 1_000 };
    persistRegistryFixture(runMap(committed), [committed.runId]);
    expect(await readLatest()).toMatchObject(committed);
    expect(readSnapshot().has(removed.runId)).toBe(true);
    persistRegistryFixture(runMap(retained));
    expect(await readLatest()).toMatchObject(retained);
    expect(readSnapshot().has(removed.runId)).toBe(false);
  });

  it("keeps committed snapshots with their database after refused writes and source switches", async () => {
    const retained = run();
    const original = runMap(retained);
    saveSubagentRegistryToSqlite(original);
    await restore();
    const other = await createOpenClawTestState({
      prefix: "openclaw-subagent-other-",
      applyEnv: false,
    });
    try {
      await withRefusedWrites(async () => {
        await expectRefusedMutation(original, { [retained.runId]: null });
        const otherDurable = { ...retained, task: "Other database durable row" };
        const otherIntent = { ...retained, task: "Other database refused owner intent" };
        await withEnvAsync({ OPENCLAW_STATE_DIR: other.stateDir }, async () => {
          const otherRows = runMap(otherDurable);
          saveSubagentRegistryToSqlite(otherRows);
          expect(await readLatest()).toMatchObject(otherDurable);
          await expectRefusedMutation(otherRows, { [otherIntent.runId]: otherIntent });
          const copy = expectDefined(await readLatest(), "other database committed row");
          expect(() => {
            copy.task = "Caller must not mutate committed facts";
          }).toThrow(TypeError);
          expect(await readLatest()).toMatchObject(otherDurable);
        });
        expect(await readLatest()).toMatchObject(retained);
        await withEnvAsync({ OPENCLAW_STATE_DIR: other.stateDir }, async () => {
          expect(await readLatest()).toMatchObject(otherDurable);
        });
      });
    } finally {
      await other.cleanup();
    }
  });
});
