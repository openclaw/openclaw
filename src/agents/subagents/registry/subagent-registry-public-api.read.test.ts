import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import * as stateReads from "../../../state/openclaw-state-db-readonly.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
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
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function createRun(runId: string, overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return createSubagentRunRecord({
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    createdAt: 100,
    execution: { status: "terminal", endedAt: 200 },
    completion: { required: false, resultText: `result-${runId}` },
    delivery: { status: "not_required" },
    collect: true,
    swarmRequesterSessionKey: "agent:main:main",
    collectorCompletion: { status: "done" },
    ...overrides,
  });
}

function createReadApi(runs = new Map<string, SubagentRunRecord>()) {
  const unexpectedMutation = () => {
    throw new Error("registry read invoked a lifecycle mutation");
  };
  return createSubagentRegistryPublicApi({
    runs,
    restoreOnce: unexpectedMutation,
    startAnnounceCleanup: unexpectedMutation,
    settleRequesterTurn: unexpectedMutation,
    markRequesterYielded: unexpectedMutation,
  });
}

function persist(...runs: SubagentRunRecord[]) {
  saveSubagentRegistryToSqlite(new Map(runs.map((run) => [run.runId, run])));
}

function activeRun(runId: string, overrides: Partial<SubagentRunRecord> = {}) {
  return createRun(runId, {
    collect: false,
    createdAt: Date.now(),
    execution: { status: "running", startedAt: Date.now() },
    ...overrides,
  });
}

type Prepared = Awaited<
  ReturnType<ReturnType<typeof createReadApi>["prepareSubagentRunsByRunIds"]>
>;
function expectSelection(prepared: Prepared, key: string, expected: SubagentRunRecord | string) {
  expect(
    prepared.consume((selected) => {
      const run = selected.get(key);
      expect(typeof expected === "string" ? run?.runId : run).toBe(expected);
    }),
  ).toEqual({ ready: true, value: undefined });
}

async function withPersistedReads(run: () => Promise<void>): Promise<void> {
  await withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
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
      persist(original);
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
      const api = createReadApi(subagentRuns);
      const pending = api.prepareSubagentRunsByRunIds(["collector", "original"]);
      try {
        await expect(Promise.race([entered.promise, pending])).resolves.toBeUndefined();
        const replacement = createRun("replacement", {
          swarmRunId: "collector",
          requesterSessionKey: "agent:other:current-owner",
        });
        persistRegistryFixture(new Map([[replacement.runId, replacement]]), [
          original.runId,
          replacement.runId,
        ]);
        release.resolve();
        const prepared = await pending;
        const selected = prepared.consume((runs) => [...runs]);
        expect(selected).toEqual({ ready: true, value: [["collector", replacement]] });
      } finally {
        release.resolve();
        await pending.catch(() => {});
        read.mockRestore();
      }
    });
  });

  it("counts retained children without preparing unrelated descendant graphs", async () => {
    const activeChildren = 4;
    const root = "agent:main:main";
    await withPersistedReads(async () => {
      persist(
        ...Array.from({ length: 256 }, (_, index) =>
          createRun(`unrelated-${index}`, {
            requesterSessionKey: "agent:other:main",
            swarmRequesterSessionKey: "agent:other:main",
          }),
        ),
        ...Array.from({ length: activeChildren }, (_, index) =>
          activeRun(`active-${index}`, { requesterAgentId: "main" }),
        ),
      );
      const memory = new Map<string, SubagentRunRecord>();
      const api = createReadApi(memory);
      expect(() => api.countActiveRunsForSession(root)).toThrow("must be prepared");
      const read = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
      onTestFinished(() => read.mockRestore());
      await prepareSubagentSessionListReadCache();
      const count = () =>
        api.countActiveRunsForSession(root, { collect: false, requesterAgentId: "main" });
      expect(count()).toBe(activeChildren);
      expect(read.mock.calls.map(([, command]) => command.type)).toEqual(["subagents.sessionList"]);
      const settled = createRun("active-0", { collect: false, requesterAgentId: "main" });
      memory.set(settled.runId, settled);
      expect(count()).toBe(activeChildren - 1);

      const descendant = activeRun("descendant", { requesterSessionKey: settled.childSessionKey });
      memory.set(descendant.runId, descendant);
      expect(count()).toBe(activeChildren);
      memory.set(descendant.runId, {
        ...descendant,
        execution: { status: "terminal", endedAt: Date.now() },
        cleanupCompletedAt: Date.now(),
      });
      expect(count()).toBe(activeChildren - 1);
      memory.set("active-1", activeRun("active-1", { controllerSessionKey: "agent:other:main" }));
      expect(count()).toBe(activeChildren - 2);
    });
  });

  it("keeps live alias changes authoritative", async () => {
    await withPersistedReads(async () => {
      const direct = createRun("collector");
      const replacement = createRun("replacement", { swarmRunId: "collector", createdAt: 300 });
      const promoted = createRun("promoted", { swarmRunId: "other", createdAt: 200 });
      persist(direct, promoted, replacement);
      const moved = { ...replacement, swarmRunId: "different" };
      const memory = subagentRuns;
      memory.set(moved.runId, moved);
      const api = createReadApi(memory);

      const original = await api.prepareSubagentRunsByRunIds(["collector"]);
      expectSelection(original, "collector", "collector");

      const live = createRun("live", { swarmRunId: "collector", execution: { status: "queued" } });
      memory.set(live.runId, live);
      const current = await api.prepareSubagentRunsByRunIds(["collector"]);
      expectSelection(current, "collector", live);
      const different = await api.prepareSubagentRunsByRunIds(["different"]);
      expectSelection(different, "different", moved);

      memory.set(moved.runId, { ...moved, swarmRunId: "collector" });
      expectSelection(current, "collector", live);
      memory.delete(live.runId);
      expectSelection(current, "collector", "replacement");
      memory.clear();
      // The live replacement disappeared; this read never hydrated its durable payload.
      const stale = current.consume((selected) => selected.get("collector")?.runId);
      expect(stale).toEqual({ ready: false });
      const durable = await api.prepareSubagentRunsByRunIds(["collector"]);
      // Preserve persisted order on a live move; appending would incorrectly promote `promoted`.
      memory.set(promoted.runId, { ...promoted, swarmRunId: "collector" });
      expectSelection(durable, "collector", "replacement");
    });
  });
});
