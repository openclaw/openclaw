import { afterEach, expect, it, vi } from "vitest";
import * as stateReads from "../../../state/openclaw-state-db-readonly.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { compactSubagentRunForMemory, subagentRuns } from "../registry/subagent-registry-memory.js";
import { persistRegistryFixture } from "../registry/subagent-registry-state.fixture.test-support.js";
import { clearSubagentRunsReadCacheForTest } from "../registry/subagent-registry-state.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { copySubagentRunRuntimeOwner } from "../registry/subagent-run-generation.js";
import { createRequesterDescendantReader } from "./subagent-announce.requester-settle-descendants.js";
import { makeSettledChild } from "./subagent-announce.requester-settle-wake.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
  subagentRuns.clear();
  clearSubagentRunsReadCacheForTest();
});

function fixture() {
  const child = (runId: string, overrides: Partial<SubagentRunRecord> = {}) =>
    makeSettledChild({
      requesterAgentId: "main",
      createdAt: 1,
      expectsCompletionMessage: undefined,
      execution: { status: "terminal", startedAt: 2, endedAt: 3 },
      completion: { required: false },
      delivery: { status: "delivered" },
      requesterSettleWake: { status: "pending", attemptCount: 0, rearmGeneration: 1 },
      ...overrides,
      runId,
      childSessionKey: `agent:main:subagent:${runId}`,
    });
  const entry = child("settled");
  subagentRuns.set(entry.runId, entry);
  const params = {
    requesterSessionKey: entry.requesterSessionKey,
    requesterAgentId: entry.requesterAgentId,
    requesterStorePath: null,
    settledEntry: entry,
    settledBefore: 4,
    isSourceCurrent: () => true,
  };
  return { entry, params, child, read: createRequesterDescendantReader(params) };
}

it("counts resident and durable descendants without restoring settled text", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
    async () => {
      const { entry, read, child } = fixture();
      subagentRuns.set(
        "unrelated",
        child("unrelated", { requesterSessionKey: "agent:main:other" }),
      );
      const completed = child("completed", {
        requesterSettleWake: undefined,
        cleanupCompletedAt: 5,
        task: "retained task ".repeat(100),
        completion: { required: false, resultText: "retained result" },
      });
      const pending = child("pending", {
        ...completed,
        cleanupCompletedAt: undefined,
        execution: { status: "terminal", endedAt: 5 },
        delivery: { status: "failed", disposition: "retryable" },
      });
      persistRegistryFixture(new Map([entry, completed, pending].map((row) => [row.runId, row])));
      subagentRuns.set(completed.runId, compactSubagentRunForMemory(completed));
      clearSubagentRunsReadCacheForTest();
      const values = vi.spyOn(subagentRuns, "values");
      const execute = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
      await expect(read()).resolves.toEqual({
        unsettled: true,
        active: 0,
        deliveryWaitUntil: 300_005,
      });
      for (const delivery of [
        { status: "delivered" },
        { status: "not_required" },
        { status: "discarded" },
        { status: "failed", disposition: "intentional_non_delivery" },
        { status: "failed", disposition: "permanent_failure" },
      ] as const) {
        persistRegistryFixture(new Map([[pending.runId, { ...pending, delivery }]]), [
          pending.runId,
        ]);
        await expect(read()).resolves.toEqual({ unsettled: false, active: 0 });
      }
      expect(execute.mock.calls.filter(([, command]) => command.type === "subagents.runs")).toEqual(
        [],
      );
      expect(subagentRuns.get(completed.runId)?.completion?.resultText).toBeUndefined();
      expect(values).not.toHaveBeenCalled();
    },
  );
});

it.each(["removed", "replaced", "rearmed"] as const)(
  "discards descendant facts when the owner is %s during preparation",
  async (change) => {
    const { entry, read } = fixture();
    queueMicrotask(() => {
      if (change === "removed") {
        subagentRuns.delete(entry.runId);
      } else if (change === "replaced") {
        subagentRuns.set(entry.runId, { ...entry, generation: 2 });
      } else {
        subagentRuns.set(
          entry.runId,
          copySubagentRunRuntimeOwner(entry, {
            ...entry,
            requesterSettleWake: { status: "pending", attemptCount: 0, rearmGeneration: 2 },
          }),
        );
      }
    });
    await expect(read()).resolves.toBeUndefined();
  },
);

it.each([
  { requesterSessionKey: "agent:main:other" },
  { requesterAgentId: "other" },
  { requesterStorePath: "other-store" },
])("keeps requester scope restrictions: %j", async (scope) => {
  const { params } = fixture();
  await expect(createRequesterDescendantReader({ ...params, ...scope })()).resolves.toBeUndefined();
});

it("follows an accepted collector address without adopting a different owner", async () => {
  const { entry, params } = fixture();
  const queued = { ...entry, collect: true, swarmRunId: entry.runId };
  subagentRuns.set(queued.runId, queued);
  const read = createRequesterDescendantReader({ ...params, settledEntry: queued });
  queueMicrotask(() => {
    subagentRuns.delete(queued.runId);
    subagentRuns.set(
      "accepted",
      copySubagentRunRuntimeOwner(queued, { ...queued, runId: "accepted" }),
    );
  });
  await expect(read()).resolves.toEqual({ unsettled: false, active: 0 });
});
