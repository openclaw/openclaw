import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { attachSessionTranscriptRunId } from "../../../sessions/transcript-events.js";
import * as stateReads from "../../../state/openclaw-state-db-readonly.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { compactSubagentRunForMemory, subagentRuns } from "../registry/subagent-registry-memory.js";
import {
  loadSubagentRegistryFromSqlite,
  persistRegistryFixture,
} from "../registry/subagent-registry-state.fixture.test-support.js";
import {
  clearSubagentRunsReadCacheForTest,
  prepareSubagentSessionListReadCache,
} from "../registry/subagent-registry-state.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { copySubagentRunRuntimeOwner } from "../registry/subagent-run-generation.js";
import { readChildCompletionFindings } from "./subagent-announce-output.js";
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

it.each(["error", "timeout"] as const)(
  "returns a failed %s member without waiting for its collector subtree",
  async (status) => {
    const { entry, params, child } = fixture();
    const failed = child("failed", {
      execution: { status: "terminal", endedAt: 5, outcome: { status, error: "provider failed" } },
      delivery: { status: "pending" },
    });
    const collector = child("collector", {
      requesterSessionKey: failed.childSessionKey,
      collect: true,
      swarmRunId: "accepted-collector",
      execution: { status: "running" },
      delivery: { status: "not_required" },
    });
    const healthy = child("healthy", { execution: { status: "running" } });
    const healthyDescendant = child("healthy-descendant", {
      requesterSessionKey: healthy.childSessionKey,
      execution: { status: "running" },
    });
    for (const run of [failed, collector, healthy, healthyDescendant]) {
      subagentRuns.set(run.runId, run);
    }
    const read = createRequesterDescendantReader({
      ...params,
      rootRunIds: new Set([entry.runId, failed.runId, healthy.runId]),
    });
    // Every direct member still settles; only a failed member's descendants stop blocking.
    await expect(read()).resolves.toEqual({ unsettled: true, active: 2 });
    subagentRuns.set(healthy.runId, {
      ...healthy,
      execution: { status: "terminal", endedAt: 6, outcome: { status: "ok" } },
    });
    await expect(read()).resolves.toEqual({ unsettled: true, active: 1 });
    subagentRuns.set(healthyDescendant.runId, {
      ...healthyDescendant,
      execution: { status: "terminal", endedAt: 7, outcome: { status: "ok" } },
    });
    await expect(read()).resolves.toEqual({
      unsettled: true,
      active: 0,
      deliveryWaitUntil: 300_007,
    });
    subagentRuns.set(failed.runId, { ...failed, delivery: { status: "delivered" } });
    await expect(read()).resolves.toEqual({ unsettled: false, active: 0 });
    expect(subagentRuns.get(collector.runId)?.execution.status).toBe("running");
  },
);

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

it("returns ready but unconsumed failed collectors with the failed root, without consuming them", async () => {
  await withOpenClawTestState(
    { env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
    async (state) => {
      const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
      setRuntimeConfigSnapshot({ session: { store: storePath } });
      const { child } = fixture();
      const root = child("root", {
        execution: {
          status: "terminal",
          endedAt: 8,
          outcome: { status: "error", error: "Root provider failed" },
        },
        delivery: { status: "pending" },
      });
      const failed = child("ready-failed", {
        requesterSessionKey: root.childSessionKey,
        collect: true,
        swarmRunId: "public-ready-failed",
        execution: {
          status: "terminal",
          endedAt: 7,
          outcome: { status: "error", error: "Collector provider failed" },
        },
        collectorCompletion: { status: "failed" },
        completion: { required: false },
        delivery: { status: "not_required" },
        // Completion cleanup is not consumption either.
        cleanupCompletedAt: 9,
      });
      const consumed = {
        ...failed,
        runId: "consumed",
        swarmRunId: "public-consumed",
        childSessionKey: "agent:main:subagent:consumed",
        delivery: {
          status: "not_required" as const,
          failureHandoff: {
            requesterSessionKey: root.childSessionKey,
            requesterSessionId: "root",
            requesterStorePath: storePath,
          },
        },
      };
      const healthy = {
        ...failed,
        runId: "healthy",
        swarmRunId: "public-healthy",
        childSessionKey: "agent:main:subagent:healthy",
        execution: { status: "terminal" as const, endedAt: 7, outcome: { status: "ok" as const } },
        collectorCompletion: { status: "done" as const },
      };
      const killed = {
        ...failed,
        runId: "killed",
        swarmRunId: "public-killed",
        childSessionKey: "agent:main:subagent:killed",
        endedReason: "subagent-killed" as const,
        collectorCompletion: { status: "killed" as const },
      };
      const active = {
        ...failed,
        runId: "active",
        swarmRunId: "public-active",
        childSessionKey: "agent:main:subagent:active",
        execution: { status: "running" as const },
        collectorCompletion: undefined,
        cleanupCompletedAt: undefined,
      };
      for (const row of [root, failed]) {
        const target = {
          agentId: "main",
          sessionKey: row.childSessionKey,
          sessionId: row.runId,
          storePath,
        };
        await upsertSessionEntryCore(target, { sessionId: row.runId, updatedAt: 1 });
        const manager = await SessionManager.openAsync(target, state.sessionsDir());
        await manager.appendMessageAsync(
          attachSessionTranscriptRunId(
            makeAgentAssistantMessage({
              content: [
                {
                  type: "text",
                  text: row === root ? "Root saved progress" : "Collector saved investigation",
                },
              ],
              stopReason: "toolUse",
            }),
            row.runId,
          ),
        );
        await manager.appendMessageAsync(
          attachSessionTranscriptRunId(
            {
              role: "toolResult",
              toolName: "exec",
              toolCallId: "spawn",
              isError: false,
              content: [{ type: "text", text: "private raw tool output; public-ready-failed" }],
              timestamp: 3,
            },
            row.runId,
          ),
        );
      }
      persistRegistryFixture(
        new Map([root, failed, consumed, healthy, killed, active].map((row) => [row.runId, row])),
      );
      const before = loadSubagentRegistryFromSqlite();
      // Cold topology must retain consumed receipts without hydrating full child rows.
      subagentRuns.clear();
      subagentRuns.set(root.runId, root);
      clearSubagentRunsReadCacheForTest();
      await prepareSubagentSessionListReadCache();
      const report = await readChildCompletionFindings([subagentRuns.get(root.runId)!]);
      expect(report.isCurrent()).toBe(true);
      expect(report.text).toContain("Root provider failed");
      expect(report.text).toContain("Root saved progress");
      expect(report.text).toContain("public-ready-failed");
      expect(report.text).toContain("Collector provider failed");
      expect(report.text).toContain("Collector saved investigation");
      expect(report.text).toContain("public-active");
      expect(report.text).not.toMatch(
        /public-consumed|public-healthy|public-killed|private raw tool/,
      );
      expect(loadSubagentRegistryFromSqlite()).toEqual(before);
    },
  );
});
