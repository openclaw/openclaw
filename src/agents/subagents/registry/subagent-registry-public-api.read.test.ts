import { describe, expect, it, vi } from "vitest";
import * as stateReads from "../../../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRegistryPublicApi } from "./subagent-registry-public-api.js";
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
      try {
        await run();
      } finally {
        clearSubagentRunsReadCacheForTest();
      }
    },
  );
}

describe("subagent registry known-run reads", () => {
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
      saveSubagentRegistryToSqlite(new Map([direct, replacement].map((row) => [row.runId, row])));
      const moved = { ...replacement, swarmRunId: "different-collector" };
      const memory = new Map<string, SubagentRunRecord>([[moved.runId, moved]]);
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
