// Real registry, SQLite and sweeper proof that a yielded run no continuation can reach settles.
import { afterEach, describe, expect, it, vi } from "vitest";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { makeRestartRecoveryRun as makeRunRecord, useSubagentRestartRecoveryFixture } from "./subagent-restart-recovery.test-support.js";
import { codeModeSwarmHandlers } from "../../code-mode-swarm.runtime.js";
import type { ToolSearchToolContext } from "../../tool-search-types.js";
import { createAgentsWaitTool } from "../../tools/agents-wait-tool.js";
import { createSubagentsTool } from "../../tools/subagents-tool.js";
import { captureSubagentCompletionReply } from "../announce/subagent-announce.js";
import { observeSubagentExecution } from "./subagent-execution-observation.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
import {
  addSubagentRunForTests,
  finalizeInterruptedSubagentRun,
  initSubagentRegistry,
  resetSubagentRegistryForTests,
  testing,
} from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { resolveSubagentDisplayStatus } from "./subagent-session-metrics.js";

type RunView = { runId: string; status: string };

const T0 = Date.parse("2026-10-03T08:00:00Z");
const MINUTE_MS = 60_000;
const COLLECTOR_KEY = "agent:main:subagent:legacy-collector";
const YIELDED_REPLY = "Collector reply written before the yield";

describe("yielded run settlement", () => {
  const fixture = useSubagentRestartRecoveryFixture();

  afterEach(() => {
    vi.useRealTimers();
  });

  const persisted = (runId: string) => loadSubagentRegistryFromSqlite().get(runId);
  const restartRegistry = async () => {
    await fixture.settle();
    await resetSubagentRegistryForTests({ persist: false });
    await initSubagentRegistry();
    await fixture.activateGatewayRuntime();
  };
  const waitSurface = async (runId: string) => {
    const tool = createAgentsWaitTool({ agentSessionKey: "agent:main:main", agentId: "main" });
    const result = await tool.execute("wait", { ids: [runId], timeoutSeconds: 0 });
    return result.details as {
      completed: Array<{
        status: string;
        error?: string;
        schemaError?: string;
        reason?: string;
      }>;
      pending: string[];
    };
  };
  // The pre-fix shapes seen in the field: the yield marker with no collector completion, and the
  // execution outcome either absent (#141474 comment of 9/13) or `ok` (the issue body). A recorded
  // `ok` is kept and read as the result, as a collector that yields now settles; only the absent
  // shape takes the diagnostic error. A recorded `error` is kept as the failure and is not marked
  // either: the marker means the sweeper substituted the diagnostic.
  const DIAGNOSTIC = expect.stringContaining("no recorded collectorCompletion");
  const LEGACY_SHAPES = [
    {
      shape: "execution.outcome absent",
      outcome: undefined,
      settledOutcome: { status: "error", error: DIAGNOSTIC },
      endedReason: "subagent-error",
      waited: { status: "failed", error: DIAGNOSTIC, result: "" },
      reason: "yielded_without_result",
    },
    {
      shape: "execution.outcome ok with endedAt",
      outcome: { status: "ok" as const },
      settledOutcome: { status: "ok" },
      endedReason: "subagent-complete",
      waited: { status: "done", result: YIELDED_REPLY },
      reason: undefined,
    },
    {
      shape: "execution.outcome error with endedAt",
      outcome: { status: "error" as const, error: "recorded failure" },
      settledOutcome: { status: "error", error: "recorded failure" },
      endedReason: "subagent-error",
      waited: { status: "failed", error: "recorded failure", result: "" },
      reason: undefined,
    },
  ];
  const legacyYieldedCollector = (
    outcome?: { status: "ok" } | { status: "error"; error: string },
    overrides: Partial<SubagentRunRecord> = {},
  ) =>
    makeRunRecord({
      runId: "legacy-yielded-collector",
      childSessionKey: COLLECTOR_KEY,
      requesterAgentId: "main",
      collect: true,
      groupId: "group-legacy",
      swarmRequesterSessionKey: "agent:main:main",
      expectsCompletionMessage: false,
      pauseReason: "sessions_yield",
      startedAt: T0 - 5 * MINUTE_MS,
      endedAt: T0 - 4 * MINUTE_MS,
      ...(outcome ? { outcome } : {}),
      ...overrides,
    });

  it.each(LEGACY_SHAPES)(
    "settles a collector persisted yielded without a result when the registry restarts ($shape)",
    async ({ outcome, settledOutcome, endedReason, waited: expectedWait, reason }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(T0);
      await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey: COLLECTOR_KEY,
        sessionId: "sess-legacy-collector",
        defaultSessionId: "sess-legacy-collector",
      });
      // The fixture stubs reply capture; the collector's last reply is what a capture would read.
      vi.mocked(captureSubagentCompletionReply).mockImplementation(async (sessionKey) =>
        sessionKey === COLLECTOR_KEY ? YIELDED_REPLY : undefined,
      );
      // Controls: yielded rows that a continuation can still reach stay untouched.
      const orchestrator = makeRunRecord({
        runId: "yielded-orchestrator",
        childSessionKey: "agent:main:subagent:orchestrator",
        expectsCompletionMessage: true,
        wakeOnDescendantSettle: true,
        pauseReason: "sessions_yield",
        startedAt: T0 - 5 * MINUTE_MS,
        endedAt: T0 - 4 * MINUTE_MS,
      });
      const legacyLeaf = makeRunRecord({
        runId: "yielded-legacy-leaf",
        childSessionKey: "agent:main:subagent:legacy-leaf",
        expectsCompletionMessage: true,
        pauseReason: "sessions_yield",
        startedAt: T0 - 5 * MINUTE_MS,
        endedAt: T0 - 4 * MINUTE_MS,
      });
      // Controls: collectors the sweep must never settle, one with a recorded result and one
      // whose stop is already claimed.
      const frozenCollector = makeRunRecord({
        ...legacyYieldedCollector(),
        runId: "yielded-frozen-collector",
        childSessionKey: "agent:main:subagent:frozen-collector",
        outcome: { status: "ok" },
        collectorCompletion: { status: "done" },
      });
      const killClaimedCollector = makeRunRecord({
        ...legacyYieldedCollector(),
        runId: "yielded-kill-claimed-collector",
        childSessionKey: "agent:main:subagent:kill-claimed-collector",
        killIntent: { requestedAt: T0 - 3 * MINUTE_MS, reason: "operator" },
      });
      for (const run of [
        legacyYieldedCollector(outcome),
        orchestrator,
        legacyLeaf,
        frozenCollector,
        killClaimedCollector,
      ]) {
        await addSubagentRunForTests(run);
      }
      expect(persisted("legacy-yielded-collector")?.execution.outcome?.status).toBe(
        outcome?.status,
      );
      const frozenBefore = persisted("yielded-frozen-collector");
      await restartRegistry();
      expect(
        await waitSurface("legacy-yielded-collector"),
        "before the sweep the waiter has no result",
      ).toMatchObject({ completed: [], pending: ["legacy-yielded-collector"] });

      await testing.sweepOnceForTests();
      await fixture.settle();

      const settled = persisted("legacy-yielded-collector");
      expect(settled?.pauseReason).toBeUndefined();
      // The yield time stays the end time for either stored shape, and a recorded outcome stays.
      expect(settled?.execution).toMatchObject({
        status: "terminal",
        startedAt: T0 - 5 * MINUTE_MS,
        endedAt: T0 - 4 * MINUTE_MS,
        outcome: settledOutcome,
      });
      expect(settled?.endedReason).toBe(endedReason);
      expect(settled?.collectorCompletion?.status).toBe(expectedWait.status);
      // Only the settlement that records the diagnostic failure marks the completion.
      expect(settled?.collectorCompletion?.reason).toBe(reason);
      const waited = await waitSurface("legacy-yielded-collector");
      expect(waited.pending).toEqual([]);
      expect(waited.completed).toMatchObject([expectedWait]);
      expect(waited.completed[0]?.reason).toBe(reason);
      expect("reason" in (waited.completed[0] ?? {})).toBe(reason !== undefined);
      if (outcome?.status === "ok") {
        expect(waited.completed[0]?.error).toBeUndefined();
      }
      // The agents.run wait bridge returns the same completion.
      const bridged = await codeModeSwarmHandlers.agentWait({
        request: {
          id: "bridge:agentWait:1",
          method: "agentWait",
          args: ["legacy-yielded-collector"],
        },
        ctx: { sessionKey: "agent:main:main", agentId: "main" } as ToolSearchToolContext,
      });
      expect(bridged).toMatchObject({ status: expectedWait.status });
      expect((bridged as { reason?: string }).reason).toBe(reason);
      for (const control of [orchestrator, legacyLeaf]) {
        expect(persisted(control.runId), control.runId).toMatchObject({
          pauseReason: "sessions_yield",
          execution: { status: "terminal" },
        });
        expect(persisted(control.runId)?.execution.outcome).toBeUndefined();
      }
      const frozen = persisted("yielded-frozen-collector");
      expect(frozen?.execution).toEqual(frozenBefore?.execution);
      expect(frozen?.collectorCompletion).toEqual({ status: "done" });
      expect(frozen?.endedReason).toBe(frozenBefore?.endedReason);
      // The claimed stop owns the row: it completes as a cancellation, not as the sweep's failure.
      expect(persisted("yielded-kill-claimed-collector")).toMatchObject({
        endedReason: "subagent-killed",
        collectorCompletion: { status: "killed" },
        execution: { outcome: { status: "error", error: "operator" } },
      });
    },
  );

  it("records both schemaError and reason on a legacy collector with an outputSchema", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: COLLECTOR_KEY,
      sessionId: "sess-legacy-collector",
      defaultSessionId: "sess-legacy-collector",
    });
    await addSubagentRunForTests(
      legacyYieldedCollector(undefined, {
        outputSchema: { type: "object", properties: { answer: { type: "number" } } },
      }),
    );
    await restartRegistry();

    await testing.sweepOnceForTests();
    await fixture.settle();

    expect(persisted("legacy-yielded-collector")?.collectorCompletion).toEqual({
      status: "failed",
      schemaError: "structured_output was not called",
      reason: "yielded_without_result",
    });
    const waited = await waitSurface("legacy-yielded-collector");
    expect(waited.completed).toMatchObject([
      {
        status: "failed",
        schemaError: "structured_output was not called",
        reason: "yielded_without_result",
      },
    ]);
  });

  it("carries no reason on a collector that fails for any other cause", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    await addSubagentRunForTests(
      makeRunRecord({
        runId: "ordinary-failed-collector",
        childSessionKey: "agent:main:subagent:ordinary-collector",
        requesterAgentId: "main",
        collect: true,
        groupId: "group-ordinary",
        swarmRequesterSessionKey: "agent:main:main",
        expectsCompletionMessage: false,
        startedAt: T0 - MINUTE_MS,
      }),
    );
    await finalizeInterruptedSubagentRun({
      runId: "ordinary-failed-collector",
      error: "interrupted by restart",
    });
    await fixture.settle();

    expect(persisted("ordinary-failed-collector")?.collectorCompletion).toEqual({
      status: "failed",
    });
    const waited = await waitSurface("ordinary-failed-collector");
    expect(waited.completed).toHaveLength(1);
    expect(waited.completed[0]).toMatchObject({
      status: "failed",
      error: "interrupted by restart",
    });
    expect("reason" in (waited.completed[0] ?? {})).toBe(false);
  });

  it("never reports a yielded run as done or finished while its waiter pends", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: COLLECTOR_KEY,
      sessionId: "sess-legacy-collector",
      defaultSessionId: "sess-legacy-collector",
    });
    await addSubagentRunForTests(legacyYieldedCollector());
    const surfaces = async () => {
      const entry = subagentRuns.get("legacy-yielded-collector") as SubagentRunRecord;
      const waiter = await waitSurface("legacy-yielded-collector");
      const listed = (
        await createSubagentsTool({ agentSessionKey: "agent:main:main", agentId: "main" }).execute(
          "list",
          { action: "list" },
        )
      ).details as { active: Array<RunView>; recent: Array<RunView> };
      const active = listed.active.find((run) => run.runId === entry.runId);
      const recent = listed.recent.find((run) => run.runId === entry.runId);
      return {
        display: resolveSubagentDisplayStatus(entry),
        observed: observeSubagentExecution(entry, []).state,
        waiter: waiter.completed.length > 0 ? waiter.completed[0]?.status : "pending",
        list: active ? `active: ${active.status}` : recent ? `recent: ${recent.status}` : "absent",
      };
    };
    // Before settlement every surface answers "not finished".
    expect(await surfaces()).toEqual({
      display: "waiting for external continuation",
      observed: "waiting",
      waiter: "pending",
      list: "active: waiting for external continuation",
    });
    await testing.sweepOnceForTests();
    await fixture.settle();
    // After settlement every surface answers "failed" and none still answers "waiting".
    expect(await surfaces()).toEqual({
      display: "failed",
      observed: "finished",
      waiter: "failed",
      list: "recent: failed",
    });
  });
});
