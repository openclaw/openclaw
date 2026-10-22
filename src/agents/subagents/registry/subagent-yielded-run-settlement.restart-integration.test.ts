// Real registry, SQLite and sweeper proof that a yielded run no continuation can reach settles.
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { makeRestartRecoveryRun as makeRunRecord, useSubagentRestartRecoveryFixture } from "./subagent-restart-recovery.test-support.js";
import { cleanupBrowserSessionsForLifecycleEnd } from "../../../browser-lifecycle-cleanup.js";
import { appendTranscriptMessage } from "../../../config/sessions/session-accessor.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { isSubagentRegistryWriteCommand } from "../../subagent-test-fixtures.test-helpers.js";
import { createAgentsWaitTool } from "../../tools/agents-wait-tool.js";
import { createSubagentsTool } from "../../tools/subagents-tool.js";
import { captureSubagentCompletionReply as readCompletionReply } from "../announce/subagent-announce-output.js";
import {
  captureSubagentCompletionReply,
  runSubagentAnnounceFlow,
} from "../announce/subagent-announce.js";
import { observeSubagentExecution } from "./subagent-execution-observation.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
import { rowToSubagentRunRecord } from "./subagent-registry.store.codec.js";
import {
  addSubagentRunForTests,
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

  beforeEach(() => {
    vi.mocked(captureSubagentCompletionReply).mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetGatewayWorkAdmission();
  });

  const useRealCapture = () =>
    vi.mocked(captureSubagentCompletionReply).mockImplementation(readCompletionReply);
  const freezeTime = () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  };
  const writeYieldedTranscript = async (
    text = YIELDED_REPLY,
    laterReplies = 0,
    visibility?: { display?: false; earlierReply: string },
  ) => {
    const sessionId = "sess-legacy-collector";
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: COLLECTOR_KEY,
      sessionId,
      lifecycleRevision: "collector-incarnation",
      defaultSessionId: sessionId,
    });
    const target = { agentId: "main", sessionKey: COLLECTOR_KEY, sessionId, storePath };
    const append = (
      minutes: number,
      message: Parameters<typeof appendTranscriptMessage>[1]["message"],
      offset = 0,
    ) => appendTranscriptMessage(target, { now: T0 - minutes * MINUTE_MS + offset, message });
    await append(7, { role: "user", content: "Previous task" });
    await append(6, { role: "assistant", content: "Not the collector result either" });
    await append(5, { role: "user", content: "Collect the findings" });
    if (visibility) {
      await append(
        5,
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "progress-1", name: "read", arguments: {} }],
        },
        1,
      );
      await append(
        5,
        { role: "toolResult", toolCallId: "progress-1", content: "intermediate data" },
        2,
      );
      await append(5, { role: "assistant", content: visibility.earlierReply }, 3);
    }
    await append(
      4,
      {
        role: "assistant",
        ...(visibility ? { display: visibility.display } : {}),
        content: [
          { type: "text", text },
          { type: "toolCall", id: "yield-1", name: "sessions_yield", arguments: {} },
        ],
      },
      -1,
    );
    await append(4, {
      role: "toolResult",
      toolCallId: "yield-1",
      toolName: "sessions_yield",
      content: [{ type: "text", text: JSON.stringify({ status: "yielded" }) }],
    });
    for (let i = 0; i < laterReplies; i++) {
      await append(1, { role: "user", content: "Unrelated later turn" }, i * 2);
      await append(1, { role: "assistant", content: "Not the collector result" }, i * 2 + 1);
    }
    useRealCapture();
  };
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
    // The published output schema is the guest-facing contract for every projected field.
    expect(Value.Check(tool.outputSchema!, result.details)).toBe(true);
    return result.details as {
      completed: Array<{ status: string; error?: string; result?: string; reason?: string }>;
      pending: string[];
    };
  };
  // #141474: preserve recorded outcomes; diagnose only yielded collectors with no outcome.
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
    outcome?: { status: "ok" | "timeout" } | { status: "error"; error: string },
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
    });
  const sweep = async () => {
    await testing.sweepOnceForTests();
    await fixture.settle();
  };
  const settleCollector = async (
    outcome: Parameters<typeof legacyYieldedCollector>[0],
    transcript: Parameters<typeof writeYieldedTranscript> = [],
  ) => {
    freezeTime();
    await writeYieldedTranscript(...transcript);
    await addSubagentRunForTests(legacyYieldedCollector(outcome));
    await restartRegistry();
    await sweep();
  };
  const expectSilentResult = async (runId: string, expected: Record<string, unknown>) => {
    expect((await waitSurface(runId)).completed).toMatchObject([expected]);
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(fixture.gatewayRuntime.sendRecoveryNotice).not.toHaveBeenCalled();
  };

  it.each(LEGACY_SHAPES)(
    "settles a collector persisted yielded without a result when the registry restarts ($shape)",
    async ({ outcome, settledOutcome, endedReason, waited: expectedWait, reason }) => {
      freezeTime();
      await writeYieldedTranscript();
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

      await sweep();

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
      expect(settled?.collectorCompletion?.reason).toBe(reason);
      const waited = await waitSurface("legacy-yielded-collector");
      expect(waited.pending).toEqual([]);
      expect(waited.completed).toMatchObject([expectedWait]);
      expect(waited.completed[0]?.reason).toBe(reason);
      if (outcome?.status === "ok") {
        expect(waited.completed[0]?.error).toBeUndefined();
      }
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

  it("reads the yielded turn rather than unrelated later turns beyond the recent-message window", async () => {
    await settleCollector({ status: "ok" }, [YIELDED_REPLY, 65]);
    await expectSilentResult("legacy-yielded-collector", { status: "done", result: YIELDED_REPLY });
  });

  it.each(
    [
      { name: "explicitly hidden", text: "Hidden collector text", display: false as const },
      { name: "empty", text: "" },
      { name: "whitespace-only", text: "  \n  " },
    ].flatMap((shape) => [
      { ...shape, status: "ok" as const },
      { ...shape, status: "timeout" as const },
    ]),
  )(
    "does not resurrect earlier output when the $status collector yield is $name",
    async ({ text, display, status }) => {
      await settleCollector({ status }, [
        text,
        1,
        {
          display,
          earlierReply: "Earlier progress is not the final result",
        },
      ]);
      expect(persisted("legacy-yielded-collector")?.execution.outcome?.status).toBe(status);
      expect(persisted("legacy-yielded-collector")?.completion?.resultText).toBeNull();
      await expectSilentResult("legacy-yielded-collector", {
        status: status === "ok" ? "done" : "timeout",
        result: "",
      });
    },
  );

  it.each(["", "NO_REPLY", "HEARTBEAT_OK"])(
    "preserves intentional empty or silent collector output (%j)",
    async (reply) => {
      await settleCollector({ status: "ok" }, [reply, 1]);
      expect(persisted("legacy-yielded-collector")?.completion?.resultText).toBe(reply || null);
      // The existing delivery policy consumes silent tokens rather than exposing them.
      await expectSilentResult("legacy-yielded-collector", { status: "done", result: "" });
    },
  );

  it.each(["immediate", "restart"] as const)(
    "retries a failed postcommit cleanup claim without losing or announcing the collected result (%s)",
    async (retry) => {
      vi.useFakeTimers({
        toFake: retry === "restart" ? ["Date", "setTimeout", "clearTimeout"] : ["Date"],
      });
      vi.setSystemTime(T0);
      await writeYieldedTranscript();
      await addSubagentRunForTests({
        ...legacyYieldedCollector({ status: "ok" }),
        childSessionIdentity: {
          sessionId: "sess-legacy-collector",
          lifecycleRevision: "collector-incarnation",
        },
        // Isolate postcommit retry from transcript capture: this reply is already frozen.
        completion: { required: false, resultText: YIELDED_REPLY, capturedAt: T0 - 4 * MINUTE_MS },
      });
      await restartRegistry();
      const execute = stateWorker.runOpenClawStateWorkerOperation;
      let injected = 0;
      let refusedFallback = false;
      vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
        (context, operation, options) =>
          execute(
            context,
            (scope) =>
              operation({
                execute: async (command, executeOptions) => {
                  if (
                    injected < (retry === "restart" ? 2 : 1) &&
                    isSubagentRegistryWriteCommand(command) &&
                    command.input.values.some(
                      (row) =>
                        row.run_id === "legacy-yielded-collector" &&
                        rowToSubagentRunRecord(row)?.browserCleanupDispatchedAt !== undefined,
                    )
                  ) {
                    injected += 1;
                    if (retry === "restart") {
                      markGatewayRestartDraining();
                    }
                    // Observe the real terminal commit independently before refusing this later write.
                    expect(persisted("legacy-yielded-collector")).toMatchObject({
                      collectorCompletion: { status: "done" },
                      completion: { resultText: YIELDED_REPLY },
                    });
                    expect(
                      persisted("legacy-yielded-collector")?.browserCleanupDispatchedAt,
                    ).toBeUndefined();
                    throw new Error("injected postcommit browser claim write failure");
                  }
                  if (
                    retry === "restart" &&
                    !refusedFallback &&
                    injected === 2 &&
                    isSubagentRegistryWriteCommand(command) &&
                    command.input.values.some(
                      (row) =>
                        row.run_id === "legacy-yielded-collector" &&
                        rowToSubagentRunRecord(row)?.cleanupHandled === false,
                    )
                  ) {
                    refusedFallback = true;
                    throw new Error("injected restart fallback write refusal");
                  }
                  return scope.execute(command, executeOptions);
                },
              }),
            options,
          ),
      );
      await testing.sweepOnceForTests();
      // The observer retains the first failed root even though the completion owner retries it.
      await expect(fixture.settle()).rejects.toThrow("Failed to settle subagent cleanup roots");
      await fixture.settle();
      if (retry === "restart") {
        expect(refusedFallback).toBe(true);
        expect(persisted("legacy-yielded-collector")?.browserCleanupDispatchedAt).toBeUndefined();
        resetGatewayWorkAdmission();
        await vi.advanceTimersByTimeAsync(1_000);
        await fixture.settle();
      }
      expect(injected).toBe(retry === "restart" ? 2 : 1);
      expect(persisted("legacy-yielded-collector")?.browserCleanupDispatchedAt).toBeTypeOf(
        "number",
      );
      expect(cleanupBrowserSessionsForLifecycleEnd).toHaveBeenCalledTimes(1);
      await expectSilentResult("legacy-yielded-collector", {
        status: "done",
        result: YIELDED_REPLY,
      });
      await sweep();
      expect(cleanupBrowserSessionsForLifecycleEnd).toHaveBeenCalledTimes(1);
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
      expect(fixture.gatewayRuntime.sendRecoveryNotice).not.toHaveBeenCalled();
    },
  );

  it("never reports a yielded run as done or finished while its waiter pends", async () => {
    freezeTime();
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
    await sweep();
    // After settlement every surface answers "failed" and none still answers "waiting".
    expect(await surfaces()).toEqual({
      display: "failed",
      observed: "finished",
      waiter: "failed",
      list: "recent: failed",
    });
  });
});
