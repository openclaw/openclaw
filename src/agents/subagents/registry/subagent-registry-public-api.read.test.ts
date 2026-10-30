import { aroundEach, expect, it, vi } from "vitest";
import * as stateReads from "../../../state/openclaw-state-db-readonly.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  createOpenClawSwarmToolGroups,
  createSwarmCollectorWriteAuthority,
} from "../../openclaw-tools.swarm.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import {
  createAgentsWaitTool,
  withNativeSubagentCollectorOwner,
} from "../../tools/agents-wait-tool.js";
import {
  consumeSwarmStructuredOutput,
  createStructuredOutputTool,
  peekSwarmStructuredOutput,
} from "../../tools/structured-output-tool.js";
import { updateSwarmCollectorCompletion } from "../swarm/swarm-collector.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { createSubagentRegistryPublicApi } from "./subagent-registry-public-api.js";
import type { PreparedSubagentRunsRead } from "./subagent-registry-read-snapshot.js";
import {
  persistRegistryFixture,
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry-state.fixture.test-support.js";
import {
  clearSubagentRunsReadCacheForTest,
  prepareSubagentSessionListReadCache,
} from "./subagent-registry-state.js";
import { holdFirstCompactRead } from "./subagent-registry-state.read.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function createRun(runId: string, overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return createSubagentRunRecord({
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    task: "collector task",
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
    settleRequesterTurn: unexpectedMutation,
    markRequesterYielded: unexpectedMutation,
  });
}

aroundEach((run) =>
  withOpenClawTestState(
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
  ),
);

function expectSelected(
  prepared: PreparedSubagentRunsRead,
  entry: SubagentRunRecord,
  key = "collector",
) {
  expect(
    prepared.consume((selected) => {
      expect(selected.get(key)).toBe(entry);
    }),
  ).toEqual({ ready: true, value: undefined });
}

it("uses the replacement owner published while collector payload hydration is pending", async () => {
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

it("retains a valid late collector result after the missing-output completion freezes", async () => {
  const runId = "late-structured-output";
  const entry = createRun(runId, {
    execution: { status: "terminal", endedAt: 200, outcome: { status: "ok" } },
    collectorCompletion: undefined,
    outputSchema: {
      type: "object",
      properties: { answer: { type: "number" } },
      required: ["answer"],
    },
  });
  const runs = subagentRuns;
  runs.set(runId, entry);
  let grantCurrent = true;
  const tool = createOpenClawSwarmToolGroups({
    effectiveRequesterAgentId: "main",
    runSessionKey: entry.childSessionKey,
    runId,
    swarmCollector: true,
    swarmOutputSchema: entry.outputSchema,
    assertCollectorWriteAuthority: createSwarmCollectorWriteAuthority({
      admission: {
        childSessionKey: entry.childSessionKey,
        childAgentId: "main",
        admittedRunId: runId,
      },
      isGrantCurrent: () => grantCurrent,
    }),
  }).structuredOutput[0]!;
  const waitTool = createAgentsWaitTool({ agentId: "main", agentSessionKey: "agent:main:main" });
  const wait = () =>
    withNativeSubagentCollectorOwner(
      waitTool,
      "wait",
      {
        currentSessionKeys: new Set(["agent:main:main"]),
        currentAgentId: "main",
        assertCurrent: () => {
          if (!grantCurrent) {
            throw new Error("requester retired");
          }
        },
      },
      () => waitTool.execute("wait", { ids: [runId], timeoutSeconds: 0 }),
    );
  updateSwarmCollectorCompletion(entry, {}, { entry: undefined });
  persistRegistryFixture(runs);
  expect(entry.collectorCompletion).toEqual({
    status: "failed",
    schemaError: "structured_output was not called",
  });
  try {
    expect((await wait()).details).toMatchObject({
      completed: [{ runId, status: "failed", schemaError: "structured_output was not called" }],
    });
    expect((await tool.execute("late", { result: { answer: 42 } })).details).toEqual({
      status: "recorded",
    });
    expect(loadSubagentRegistryFromSqlite().get(runId)?.collectorCompletion).toEqual({
      status: "done",
      structured: { answer: 42 },
    });
    grantCurrent = false;
    await expect(tool.execute("revoked", { result: { answer: 43 } })).rejects.toThrow(
      "grant is no longer active",
    );
    grantCurrent = true;
    await expect(tool.execute("duplicate", { result: { answer: 43 } })).rejects.toThrow(
      "collector run is unavailable",
    );
    runs.clear();
    for (let read = 0; read < 2; read += 1) {
      expect((await wait()).details).toMatchObject({
        completed: [{ runId, status: "done", structured: { answer: 42 } }],
        pending: [],
      });
    }
    expect(peekSwarmStructuredOutput(runId)).toBeUndefined();
    grantCurrent = false;
    await expect(wait()).rejects.toThrow("requester retired");
    expect(loadSubagentRegistryFromSqlite().get(runId)?.collectorCompletion?.structured).toEqual({
      answer: 42,
    });
  } finally {
    consumeSwarmStructuredOutput(runId);
  }
});

it("leaves a frozen missing-output failure unchanged when its late result cannot commit", async () => {
  const runId = "uncommitted-collector";
  const entry = createRun(runId, {
    execution: { status: "terminal", outcome: { status: "ok" } },
    collectorCompletion: { status: "failed", schemaError: "structured_output was not called" },
  });
  const runs = new Map([[runId, entry]]);
  persistRegistryFixture(runs);
  const api = createReadApi(runs);
  const tool = createStructuredOutputTool({
    runId,
    schema: { type: "object" },
    onStateChange: (state) => api.recordSwarmStructuredOutput({ runId }, state),
  });
  await expect(tool.execute("invalid", { result: 42 })).rejects.toThrow(
    "collector run is unavailable",
  );
  const rejectedWrite = vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockRejectedValueOnce(new Error("sqlite unavailable"));
  try {
    await expect(tool.execute("late", { result: { answer: 42 } })).rejects.toThrow(
      "sqlite unavailable",
    );
    expect(loadSubagentRegistryFromSqlite().get(runId)?.collectorCompletion).toEqual(
      entry.collectorCompletion,
    );
    expect(runs.get(runId)?.collectorCompletion).toEqual(entry.collectorCompletion);
    expect(peekSwarmStructuredOutput(runId)).toBeUndefined();
  } finally {
    rejectedWrite.mockRestore();
  }
});

it.each([
  { execution: { status: "terminal", outcome: { status: "error", error: "completed" } } },
  { execution: { status: "terminal", outcome: { status: "error", error: "provider failed" } } },
  { execution: { status: "terminal", outcome: { status: "timeout" } } },
  { collectorCompletion: { status: "killed", schemaError: "structured_output was not called" } },
  { collectorCompletion: { status: "failed", schemaError: "invalid type" } },
  {
    collectorCompletion: {
      status: "failed",
      schemaError: "structured_output was not called",
      structured: { answer: 7 },
    },
  },
  {
    collectorCompletion: {
      status: "failed",
      schemaError: "structured_output was not called",
      reason: "yielded_without_result",
    },
  },
] satisfies Partial<SubagentRunRecord>[])(
  "preserves a terminal failure that is not solely missing output: %j",
  async (overrides) => {
    const runId = "failed-collector";
    const entry = createRun(runId, {
      execution: { status: "terminal", outcome: { status: "ok" } },
      collectorCompletion: { status: "failed", schemaError: "structured_output was not called" },
      ...overrides,
    });
    const runs = new Map([[runId, entry]]);
    const api = createReadApi(runs);
    persistRegistryFixture(runs);
    const tool = createStructuredOutputTool({
      runId,
      schema: { type: "object" },
      onStateChange: (state) => api.recordSwarmStructuredOutput({ runId }, state),
    });
    await expect(tool.execute("late", { result: { answer: 42 } })).rejects.toThrow(
      "collector run is unavailable",
    );
    expect(loadSubagentRegistryFromSqlite().get(runId)?.collectorCompletion).toEqual(
      entry.collectorCompletion,
    );
    expect(peekSwarmStructuredOutput(runId)).toBeUndefined();
  },
);

it("counts retained children without preparing unrelated descendant graphs", async () => {
  const activeChildren = 4;
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
    const count = () =>
      api.countActiveRunsForSession("agent:main:main", {
        collect: false,
        requesterAgentId: "main",
      });
    expect(count()).toBe(activeChildren);
    expect(read.mock.calls.map(([, command]) => command.type)).toEqual(["subagents.sessionList"]);
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

it("keeps live alias changes authoritative", async () => {
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
  expect(original.consume((selected) => selected.get("collector")?.runId)).toEqual({
    ready: true,
    value: "collector",
  });

  const live = createRun("live", { swarmRunId: "collector", execution: { status: "queued" } });
  memory.set(live.runId, live);
  const current = await api.prepareSubagentRunsByRunIds(["collector"]);
  expectSelected(current, live);
  const different = await api.prepareSubagentRunsByRunIds(["different-collector"]);
  expectSelected(different, moved, "different-collector");

  memory.set(moved.runId, { ...moved, swarmRunId: "collector" });
  expectSelected(current, live);
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
