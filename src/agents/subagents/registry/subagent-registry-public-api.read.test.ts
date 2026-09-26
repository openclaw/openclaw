import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import * as stateReads from "../../../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { createSubagentRegistryPublicApi } from "./subagent-registry-public-api.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import * as registryState from "./subagent-registry-state.js";
import {
  clearSubagentRunsReadCacheForTest,
  prepareSubagentSessionListReadCache,
} from "./subagent-registry-state.js";
import { saveSubagentRegistryToSqlite } from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function createRun(runId: string, overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "collector task",
    cleanup: "keep",
    createdAt: 100,
    execution: { status: "terminal", endedAt: 200 },
    completion: { required: false, resultText: `result-${runId}` },
    delivery: { status: "not_required" },
    collect: true,
    swarmRequesterSessionKey: "agent:main:main",
    collectorCompletion: { status: "done" },
    ...overrides,
  };
}

function createReadApi(runs = new Map<string, SubagentRunRecord>()) {
  const unexpectedMutation = () => {
    throw new Error("registry read invoked a lifecycle mutation");
  };
  return createSubagentRegistryPublicApi({
    runs,
    persist: unexpectedMutation,
    persistOrThrow: unexpectedMutation,
    restoreOnce: unexpectedMutation,
    startAnnounceCleanup: unexpectedMutation,
    settleRequesterTurn: unexpectedMutation,
  });
}

async function withPersistedReads(run: () => Promise<void>): Promise<void> {
  await withOpenClawTestState(
    {
      scenario: "minimal",
      env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" },
    },
    async () => {
      clearSubagentRunsReadCacheForTest();
      subagentRuns.clear();
      try {
        await run();
      } finally {
        subagentRuns.clear();
        clearSubagentRunsReadCacheForTest();
      }
    },
  );
}

describe("subagent registry known-run reads", () => {
  it("does not revisit unrelated resident or live rows when waiting for known collectors", async () => {
    await withPersistedReads(async () => {
      const target = createRun("physical", { swarmRunId: "collector" });
      const unrelated = Array.from({ length: 16 }, (_, index) => createRun(`unrelated-${index}`));
      for (const entry of [target, ...unrelated]) {
        subagentRuns.set(entry.runId, entry);
      }
      registryState.persistSubagentRunsToDiskOrThrow(subagentRuns);
      const api = createReadApi(subagentRuns);
      const warm = await api.prepareSubagentRunsByRunIds(["collector"]);
      expect(warm.consume((runs) => runs.get("collector"))).toEqual({ ready: true, value: target });

      const snapshot = registryState.getSubagentSessionListReadSnapshotIdentity();
      expect(snapshot).toBeInstanceOf(Map);
      let unrelatedVisits = 0;
      const restore: Array<() => void> = [];
      for (const entry of unrelated) {
        const persisted = (snapshot as Map<string, SubagentRunReadRecord>).get(entry.runId)!;
        for (const row of [entry, persisted]) {
          const runId = row.runId;
          Object.defineProperty(row, "runId", {
            configurable: true,
            get() {
              unrelatedVisits += 1;
              return runId;
            },
          });
          restore.push(() =>
            Object.defineProperty(row, "runId", {
              configurable: true,
              writable: true,
              value: runId,
            }),
          );
        }
      }
      try {
        const prepared = await api.prepareSubagentRunsByRunIds([
          " collector ",
          "physical",
          "missing",
        ]);
        const replacement = { ...target, completion: { required: false, resultText: "updated" } };
        subagentRuns.set(replacement.runId, replacement);
        registryState.persistSubagentRunsToDiskOrThrow(subagentRuns, [replacement.runId]);
        expect(prepared.consume((runs) => [...runs])).toEqual({
          ready: true,
          value: [
            [" collector ", replacement],
            ["physical", replacement],
          ],
        });
        expect(unrelatedVisits).toBe(0);
      } finally {
        restore.forEach((reset) => reset());
      }
    });
  });

  it("uses the replacement owner published while collector payload hydration is pending", async () => {
    await withPersistedReads(async () => {
      const original = createRun("original", { swarmRunId: "collector" });
      saveSubagentRegistryToSqlite(new Map([[original.runId, original]]));
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const execute = stateReads.executeExistingOpenClawStateRead;
      let held = false;
      const read = vi
        .spyOn(stateReads, "executeExistingOpenClawStateRead")
        .mockImplementation(async (...args) => {
          const result = await execute(...args);
          if (!held && args[1].type === "subagents.runs") {
            held = true;
            entered.resolve();
            await release.promise;
          }
          return result;
        });
      const pending = createReadApi(subagentRuns).prepareSubagentRunsByRunIds([
        "collector",
        "original",
      ]);
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("Expected pending payload hydration");
          }),
        ]);
        const replacement = createRun("replacement", {
          swarmRunId: "collector",
          requesterSessionKey: "agent:other:current-owner",
        });
        registryState.persistSubagentRunsToDiskOrThrow(
          new Map([[replacement.runId, replacement]]),
          [original.runId, replacement.runId],
        );
        release.resolve();
        const prepared = await pending;
        expect(prepared.consume((runs) => [...runs])).toEqual({
          ready: true,
          value: [["collector", replacement]],
        });
      } finally {
        release.resolve();
        await pending.catch(() => {});
        read.mockRestore();
      }
    });
  });

  it.each([0, 4])(
    "counts %i retained children without preparing unrelated descendant graphs",
    async (activeChildren) => {
      await withPersistedReads(async () => {
        const rows = Array.from({ length: 256 }, (_, index) =>
          createRun(`unrelated-${index}`, {
            requesterSessionKey: "agent:other:main",
            swarmRequesterSessionKey: "agent:other:main",
          }),
        );
        rows.push(
          ...Array.from({ length: activeChildren }, (_, index) =>
            createRun(`active-${index}`, {
              collect: false,
              requesterAgentId: "main",
              createdAt: Date.now(),
              execution: { status: "running", startedAt: Date.now() },
            }),
          ),
        );
        saveSubagentRegistryToSqlite(new Map(rows.map((row) => [row.runId, row])));
        const readSnapshot = registryState.getSubagentRunsSnapshotForRead;
        const snapshots: Map<string, SubagentRunRecord>[] = [];
        let visitedRows = 0;
        const read = vi
          .spyOn(registryState, "getSubagentRunsSnapshotForRead")
          .mockImplementation((runs) => {
            const snapshot = readSnapshot(runs);
            snapshots.push(snapshot);
            const values = snapshot.values.bind(snapshot);
            Object.defineProperty(snapshot, "values", {
              configurable: true,
              value: () => {
                const iterator = values();
                const next = iterator.next.bind(iterator);
                iterator.next = () => {
                  const result = next();
                  if (!result.done) {
                    visitedRows += 1;
                  }
                  return result;
                };
                return iterator;
              },
            });
            return snapshot;
          });
        try {
          expect(
            createReadApi().countActiveRunsForSession("agent:main:main", {
              collect: false,
              requesterAgentId: "main",
            }),
          ).toBe(activeChildren);
          expect(snapshots).toHaveLength(1);
          expect(snapshots[0]?.size).toBe(rows.length);
          // These children need only selection and current retention checks.
          expect(visitedRows).toBeLessThanOrEqual(rows.length);
        } finally {
          read.mockRestore();
          for (const snapshot of snapshots) {
            Reflect.deleteProperty(snapshot, "values");
          }
        }
      });
    },
  );

  it("resolves retained collector aliases without hydrating unrelated results", async () => {
    await withPersistedReads(async () => {
      const retainedResult = "unrelated-retained-result".repeat(128);
      const rows = [
        createRun("collector"),
        createRun("same-zulu", { swarmRunId: "collector", createdAt: 300 }),
        createRun("same-alpha", { swarmRunId: "collector", createdAt: 300 }),
        createRun("retained", { completion: { required: false, resultText: retainedResult } }),
        createRun("malformed"),
      ];
      saveSubagentRegistryToSqlite(new Map(rows.map((row) => [row.runId, row])));
      openOpenClawStateDatabase()
        .db.prepare("UPDATE subagent_runs SET payload_json = ? WHERE run_id = ?")
        .run("{", "malformed");
      const api = createReadApi();
      const parse = vi.spyOn(JSON, "parse");
      const read = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
      try {
        const prepared = await api.prepareSubagentRunsByRunIds([
          " collector ",
          "same-alpha",
          "missing",
        ]);
        expect(
          prepared.consume((selected) => {
            expect([...selected.keys()]).toEqual([" collector ", "same-alpha"]);
            expect(selected.get(" collector ")).toMatchObject({
              runId: "same-zulu",
              completion: { resultText: "result-same-zulu" },
            });
            expect(selected.get("same-alpha")?.runId).toBe("same-alpha");
          }),
        ).toEqual({ ready: true, value: undefined });
        expect(read.mock.calls.map(([, command]) => command)).toEqual([
          { type: "subagents.sessionList" },
          {
            type: "subagents.runs",
            scope: { kind: "ids", runIds: ["collector", "same-alpha", "same-zulu"] },
          },
        ]);
        expect(parse.mock.calls.some(([raw]) => raw.includes(retainedResult))).toBe(false);
      } finally {
        read.mockRestore();
        parse.mockRestore();
      }

      // A scoped result must never masquerade as a complete registry cache.
      expect(api.getSubagentRunByRunId("retained")?.completion?.resultText).toBe(retainedResult);
    });
  });

  it("keeps live alias changes authoritative", async () => {
    await withPersistedReads(async () => {
      const direct = createRun("collector");
      const replacement = createRun("replacement", { swarmRunId: "collector", createdAt: 300 });
      const promoted = createRun("promoted", { swarmRunId: "other", createdAt: 200 });
      saveSubagentRegistryToSqlite(
        new Map([direct, promoted, replacement].map((row) => [row.runId, row])),
      );
      const moved = { ...replacement, swarmRunId: "different-collector" };
      const memory = subagentRuns;
      memory.set(moved.runId, moved);
      const api = createReadApi(memory);

      const original = await api.prepareSubagentRunsByRunIds(["collector"]);
      expect(
        original.consume((selected) => {
          expect(selected.get("collector")?.runId).toBe("collector");
        }),
      ).toEqual({ ready: true, value: undefined });

      const live = createRun("live", { swarmRunId: "collector", execution: { status: "queued" } });
      memory.set(live.runId, live);
      const current = await api.prepareSubagentRunsByRunIds(["collector"]);
      expect(
        current.consume((selected) => {
          expect(selected.get("collector")).toBe(live);
        }),
      ).toEqual({ ready: true, value: undefined });
      const different = await api.prepareSubagentRunsByRunIds(["different-collector"]);
      expect(
        different.consume((selected) => {
          expect(selected.get("different-collector")).toBe(moved);
        }),
      ).toEqual({ ready: true, value: undefined });

      memory.set(moved.runId, { ...moved, swarmRunId: "collector" });
      expect(current.consume((selected) => selected.get("collector"))).toEqual({
        ready: true,
        value: live,
      });
      memory.delete(live.runId);
      expect(current.consume((selected) => selected.get("collector")?.runId)).toEqual({
        ready: true,
        value: "replacement",
      });
      memory.clear();
      // The live replacement disappeared; this read never hydrated its durable payload.
      expect(current.consume((selected) => selected.get("collector")?.runId)).toEqual({
        ready: false,
      });
      const durable = await api.prepareSubagentRunsByRunIds(["collector"]);
      // A live move into the selection keeps the persisted row's original order.
      // Appending all live selections would incorrectly make `promoted` win.
      memory.set(promoted.runId, { ...promoted, swarmRunId: "collector" });
      expect(durable.consume((selected) => selected.get("collector")?.runId)).toEqual({
        ready: true,
        value: "replacement",
      });
    });
  });

  it("refreshes physical rows replaced or deleted after another reader cached their aliases", async () => {
    await withPersistedReads(async () => {
      const previous = createRun("previous", { swarmRunId: "collector" });
      saveSubagentRegistryToSqlite(new Map([[previous.runId, previous]]));
      await prepareSubagentSessionListReadCache();

      // A direct store write models another process without publishing local cache updates.
      const replacement = createRun("replacement", {
        swarmRunId: "collector",
        createdAt: 300,
        swarmRequesterSessionKey: "agent:other:main",
      });
      saveSubagentRegistryToSqlite(new Map([[replacement.runId, replacement]]));
      const api = createReadApi();
      const prepared = await api.prepareSubagentRunsByRunIds(["collector"]);
      expect(
        prepared.consume((selected) => {
          expect(selected.get("collector")).toMatchObject({
            runId: "replacement",
            swarmRequesterSessionKey: "agent:other:main",
          });
        }),
      ).toEqual({ ready: true, value: undefined });

      saveSubagentRegistryToSqlite(new Map());
      const deleted = await api.prepareSubagentRunsByRunIds(["collector"]);
      expect(
        deleted.consume((selected) => {
          expect(selected.size).toBe(0);
        }),
      ).toEqual({ ready: true, value: undefined });
    });
  });
});
