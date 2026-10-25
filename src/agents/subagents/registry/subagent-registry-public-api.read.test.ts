import { describe, expect, it, vi } from "vitest";
import * as stateReads from "../../../state/openclaw-state-db-readonly.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { createSubagentRegistryPublicApi } from "./subagent-registry-public-api.js";
import {
  persistRegistryFixture,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry-state.fixture.test-support.js";
import {
  clearSubagentRunsReadCacheForTest,
  prepareSubagentSessionListReadCache,
} from "./subagent-registry-state.js";
import { holdFirstCompactRead } from "./subagent-registry-state.read.test-support.js";
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
    restoreOnce: unexpectedMutation,
    settleRequesterTurn: unexpectedMutation,
    markRequesterYielded: unexpectedMutation,
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
  it("uses the replacement owner published while collector payload hydration is pending", async () => {
    await withPersistedReads(async () => {
      const original = createRun("original", { swarmRunId: "collector" });
      saveSubagentRegistryToSqlite(new Map([[original.runId, original]]));
      const { entered, release, read } = holdFirstCompactRead("subagents.runs");
      const pending = createReadApi(subagentRuns).prepareSubagentRunsByRunIds([
        "collector",
        "original",
      ]);
      try {
        await Promise.race([
          entered,
          pending.then(() => {
            throw new Error("Expected pending payload hydration");
          }),
        ]);
        const replacement = createRun("replacement", {
          swarmRunId: "collector",
          requesterSessionKey: "agent:other:current-owner",
        });
        persistRegistryFixture(new Map([[replacement.runId, replacement]]), [
          original.runId,
          replacement.runId,
        ]);
        release();
        const prepared = await pending;
        expect(prepared.consume((runs) => [...runs])).toEqual({
          ready: true,
          value: [["collector", replacement]],
        });
      } finally {
        release();
        await pending.catch(() => {});
        read.mockRestore();
      }
    });
  });

  it.each([4])(
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
        const memory = new Map<string, SubagentRunRecord>();
        const api = createReadApi(memory);
        expect(() => api.countActiveRunsForSession("agent:main:main")).toThrow("must be prepared");
        const read = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
        try {
          await prepareSubagentSessionListReadCache();
          expect(
            api.countActiveRunsForSession("agent:main:main", {
              collect: false,
              requesterAgentId: "main",
            }),
          ).toBe(activeChildren);
          expect(read.mock.calls.map(([, command]) => command.type)).toEqual([
            "subagents.sessionList",
          ]);
          const count = () =>
            api.countActiveRunsForSession("agent:main:main", {
              collect: false,
              requesterAgentId: "main",
            });
          const settled = createRun("active-0", { collect: false, requesterAgentId: "main" });
          memory.set(settled.runId, settled);
          expect(count()).toBe(activeChildren - 1);

          const descendant = createRun("descendant", {
            collect: false,
            requesterSessionKey: settled.childSessionKey,
            execution: { status: "running", startedAt: Date.now() },
          });
          memory.set(descendant.runId, descendant);
          expect(count()).toBe(activeChildren);
          memory.set(descendant.runId, {
            ...descendant,
            execution: { status: "terminal", endedAt: Date.now() },
            cleanupCompletedAt: Date.now(),
          });
          expect(count()).toBe(activeChildren - 1);
          memory.set(
            "active-1",
            createRun("active-1", {
              collect: false,
              controllerSessionKey: "agent:other:main",
              execution: { status: "running", startedAt: Date.now() },
            }),
          );
          expect(count()).toBe(activeChildren - 2);
        } finally {
          read.mockRestore();
        }
      });
    },
  );

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
});
