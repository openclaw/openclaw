import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDefaultsSchema } from "../config/zod-schema.agent-defaults.js";
import { AgentEntrySchema } from "../config/zod-schema.agent-runtime.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { callGatewaySpy, queueEmbeddedPiMessageSpy, abortEmbeddedPiRunSpy, onAgentEventListeners } =
  vi.hoisted(() => ({
    callGatewaySpy: vi.fn(async (params: { method?: string }) => {
      // agent.wait must never resolve — otherwise the run is immediately completed.
      if (params?.method === "agent.wait") {
        return new Promise(() => {});
      }
      return { status: "ok" };
    }),
    queueEmbeddedPiMessageSpy: vi.fn(() => false),
    abortEmbeddedPiRunSpy: vi.fn(() => true),
    onAgentEventListeners: new Set<(evt: unknown) => void>(),
  }));

vi.mock("../gateway/call.js", () => ({
  callGateway: callGatewaySpy,
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn((listener: (evt: unknown) => void) => {
    onAgentEventListeners.add(listener);
    return () => onAgentEventListeners.delete(listener);
  }),
  emitAgentEvent: vi.fn((event: Record<string, unknown>) => {
    const enriched = { ...event, seq: 1, ts: Date.now() };
    for (const listener of onAgentEventListeners) {
      listener(enriched);
    }
  }),
}));

vi.mock("./pi-embedded.js", () => ({
  isEmbeddedPiRunActive: vi.fn(() => false),
  isEmbeddedPiRunStreaming: vi.fn(() => false),
  queueEmbeddedPiMessage: queueEmbeddedPiMessageSpy,
  abortEmbeddedPiRun: abortEmbeddedPiRunSpy,
  waitForEmbeddedPiRunEnd: vi.fn(async () => true),
}));

vi.mock("./subagent-announce.js", () => ({
  captureSubagentCompletionReply: vi.fn(async () => "done"),
  runSubagentAnnounceFlow: vi.fn(async () => true),
}));

vi.mock("./subagent-registry-state.js", () => ({
  getSubagentRunsSnapshotForRead: vi.fn((runs: Map<string, unknown>) => runs),
  persistSubagentRunsToDisk: vi.fn(),
  restoreSubagentRunsFromDisk: vi.fn(() => 0),
}));

vi.mock("./subagent-announce-queue.js", () => ({
  resetAnnounceQueuesForTests: vi.fn(),
  enqueueAnnounce: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    session: { mainKey: "main", store: "/tmp/test-store" },
    agents: {
      defaults: {
        subagents: {
          stallNudgeAfterSeconds: 90,
          stallKillAfterSeconds: 180,
        },
      },
    },
  })),
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: vi.fn(() => ({
    "agent:main:subagent:stall-child": {
      sessionId: "child-session-id-stall",
    },
  })),
  resolveAgentIdFromSessionKey: vi.fn(() => "main"),
  resolveStorePath: vi.fn(() => "/tmp/test-store/sessions.json"),
}));

vi.mock("../context-engine/init.js", () => ({
  ensureContextEnginesInitialized: vi.fn(),
}));

vi.mock("../context-engine/registry.js", () => ({
  resolveContextEngine: vi.fn(async () => ({})),
}));

vi.mock("./subagent-registry-cleanup.js", () => ({
  resolveCleanupCompletionReason: vi.fn(() => "complete"),
  resolveDeferredCleanupDecision: vi.fn(() => ({ kind: "give-up", reason: "expiry" })),
}));

vi.mock("./subagent-registry-completion.js", () => ({
  emitSubagentEndedHookOnce: vi.fn(async () => undefined),
  resolveLifecycleOutcomeFromRunOutcome: vi.fn(() => "completed"),
  runOutcomesEqual: vi.fn(
    (a: { status?: string } | undefined, b: { status?: string } | undefined) =>
      a?.status === b?.status,
  ),
}));

// Provide real-ish query implementations so listSubagentRunsForRequester works.
vi.mock("./subagent-registry-queries.js", () => ({
  countActiveDescendantRunsFromRuns: vi.fn(() => 0),
  countActiveRunsForSessionFromRuns: vi.fn(() => 0),
  countPendingDescendantRunsExcludingRunFromRuns: vi.fn(() => 0),
  countPendingDescendantRunsFromRuns: vi.fn(() => 0),
  findRunIdsByChildSessionKeyFromRuns: vi.fn(
    (runs: Map<string, { childSessionKey?: string }>, key: string) => {
      const ids: string[] = [];
      for (const [runId, entry] of runs.entries()) {
        if (entry.childSessionKey === key) {
          ids.push(runId);
        }
      }
      return ids;
    },
  ),
  listDescendantRunsForRequesterFromRuns: vi.fn(() => []),
  listRunsForRequesterFromRuns: vi.fn(
    (runs: Map<string, { requesterSessionKey?: string }>, requesterSessionKey: string) => {
      const result: unknown[] = [];
      for (const entry of runs.values()) {
        if (entry.requesterSessionKey === requesterSessionKey) {
          result.push(entry);
        }
      }
      return result;
    },
  ),
  resolveRequesterForChildSessionFromRuns: vi.fn(() => null),
  shouldIgnorePostCompletionAnnounceForSessionFromRuns: vi.fn(() => false),
}));

vi.mock("./subagent-lifecycle-events.js", async () => {
  const actual = await vi.importActual<typeof import("./subagent-lifecycle-events.js")>(
    "./subagent-lifecycle-events.js",
  );
  return actual;
});

vi.mock("./timeout.js", () => ({
  resolveAgentTimeoutMs: vi.fn(() => 600_000),
}));

vi.mock("../logging/subsystem.js", () => {
  const makeLogger = (): Record<string, unknown> => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => makeLogger()),
  });
  return {
    createSubsystemLogger: vi.fn(() => makeLogger()),
  };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime: { log: vi.fn() },
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => ({})),
}));

// ---------------------------------------------------------------------------
// Import SUT after mocks
// ---------------------------------------------------------------------------

import { emitAgentEvent } from "../infra/agent-events.js";
import {
  addSubagentRunForTests,
  listSubagentRunsForRequester,
  registerSubagentRun,
  resetSubagentRegistryForTests,
} from "./subagent-registry.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStallTestRun(overrides?: Partial<SubagentRunRecord>): SubagentRunRecord {
  const now = Date.now();
  return {
    runId: "run-stall-1",
    childSessionKey: "agent:main:subagent:stall-child",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "stall test task",
    cleanup: "keep" as const,
    createdAt: now,
    startedAt: now,
    cleanupHandled: false,
    stallNudgeAfterSeconds: 5,
    stallKillAfterSeconds: 10,
    lastToolCallAt: now,
    ...overrides,
  };
}

function emitToolEvent(runId: string) {
  (emitAgentEvent as unknown as (evt: Record<string, unknown>) => void)({
    runId,
    stream: "tool",
    data: { phase: "start", name: "read" },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("stall recovery config validation", () => {
  it("stallNudgeAfterSeconds accepts 0 (disabled)", () => {
    const result = AgentDefaultsSchema.safeParse({
      subagents: { stallNudgeAfterSeconds: 0 },
    });
    expect(result.success).toBe(true);
  });

  it("stallNudgeAfterSeconds accepts positive integers", () => {
    const result = AgentDefaultsSchema.safeParse({
      subagents: { stallNudgeAfterSeconds: 90 },
    });
    expect(result.success).toBe(true);
  });

  it("stallKillAfterSeconds accepts 0 (disabled)", () => {
    const result = AgentDefaultsSchema.safeParse({
      subagents: { stallKillAfterSeconds: 0 },
    });
    expect(result.success).toBe(true);
  });

  it("stallKillAfterSeconds accepts positive integers", () => {
    const result = AgentDefaultsSchema.safeParse({
      subagents: { stallKillAfterSeconds: 120 },
    });
    expect(result.success).toBe(true);
  });

  it("rejects negative stallNudgeAfterSeconds", () => {
    const result = AgentDefaultsSchema.safeParse({
      subagents: { stallNudgeAfterSeconds: -1 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative stallKillAfterSeconds", () => {
    const result = AgentDefaultsSchema.safeParse({
      subagents: { stallKillAfterSeconds: -5 },
    });
    expect(result.success).toBe(false);
  });
});

describe("stall recovery detection (sweeper)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetSubagentRegistryForTests({ persist: false });
    callGatewaySpy.mockClear();
    // Restore the default implementation after mockClear.
    callGatewaySpy.mockImplementation(async (params: { method?: string }) => {
      if (params?.method === "agent.wait") {
        return new Promise(() => {});
      }
      return { status: "ok" };
    });
    queueEmbeddedPiMessageSpy.mockClear();
    queueEmbeddedPiMessageSpy.mockReturnValue(false);
    abortEmbeddedPiRunSpy.mockClear();
    onAgentEventListeners.clear();
  });

  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
    vi.useRealTimers();
  });

  it("nudge fires after stallNudgeAfterSeconds of inactivity", async () => {
    const baseTime = 1_000_000;
    vi.setSystemTime(baseTime);

    registerSubagentRun({
      runId: "run-nudge-1",
      childSessionKey: "agent:main:subagent:stall-child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "nudge test",
      cleanup: "keep",
      stallNudgeAfterSeconds: 5,
      stallKillAfterSeconds: 10,
    });

    callGatewaySpy.mockClear();
    callGatewaySpy.mockImplementation(async (params: { method?: string }) => {
      if (params?.method === "agent.wait") {
        return new Promise(() => {});
      }
      return { status: "ok" };
    });
    queueEmbeddedPiMessageSpy.mockClear();

    // Advance time past the nudge threshold (5s) and trigger the sweeper (60s interval).
    vi.setSystemTime(baseTime + 6_000);
    await vi.advanceTimersByTimeAsync(60_000);

    // The nudge should attempt queueEmbeddedPiMessage first (returns false),
    // then fall back to callGateway with method "agent".
    const agentCalls = callGatewaySpy.mock.calls.filter(
      (call: unknown[]) => (call[0] as { method?: string })?.method === "agent",
    );
    expect(agentCalls.length).toBeGreaterThanOrEqual(1);
    const nudgeCall = agentCalls[0][0] as {
      params?: { sessionKey?: string; message?: string };
    };
    expect(nudgeCall.params?.sessionKey).toBe("agent:main:subagent:stall-child");
    expect(nudgeCall.params?.message).toContain("stalled");
  });

  it("kill fires after stallKillAfterSeconds past nudge", async () => {
    const baseTime = 1_000_000;
    vi.setSystemTime(baseTime);

    // Register a run to start the sweeper.
    registerSubagentRun({
      runId: "run-kill-1",
      childSessionKey: "agent:main:subagent:stall-child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "kill test",
      cleanup: "keep",
      stallNudgeAfterSeconds: 5,
      stallKillAfterSeconds: 10,
    });

    // Now overwrite the run record with pre-set stall state
    // (already nudged 11s ago, kill threshold is 10s).
    addSubagentRunForTests(
      makeStallTestRun({
        runId: "run-kill-1",
        createdAt: baseTime - 20_000,
        startedAt: baseTime - 20_000,
        lastToolCallAt: baseTime - 20_000,
        stallNudgeAfterSeconds: 5,
        stallKillAfterSeconds: 10,
        stallNudgedAt: baseTime - 11_000,
      }),
    );

    callGatewaySpy.mockClear();
    callGatewaySpy.mockImplementation(async (params: { method?: string }) => {
      if (params?.method === "agent.wait") {
        return new Promise(() => {});
      }
      return { status: "ok" };
    });
    abortEmbeddedPiRunSpy.mockClear();

    // Trigger the sweeper.
    await vi.advanceTimersByTimeAsync(60_000);

    // The run should have been killed — abortEmbeddedPiRun called.
    expect(abortEmbeddedPiRunSpy).toHaveBeenCalled();

    // Verify the run is marked as ended.
    const runs = listSubagentRunsForRequester("agent:main:main");
    const killed = runs.find((r) => r.runId === "run-kill-1");
    expect(killed?.endedAt).toBeDefined();
    expect(killed?.outcome?.status).toBe("error");
  });

  it("tool activity resets stall timer", () => {
    const baseTime = 1_000_000;
    vi.setSystemTime(baseTime);

    registerSubagentRun({
      runId: "run-tool-reset",
      childSessionKey: "agent:main:subagent:stall-child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "tool reset test",
      cleanup: "keep",
      stallNudgeAfterSeconds: 5,
      stallKillAfterSeconds: 10,
    });

    // Advance time and emit a tool event.
    const toolTime = baseTime + 3_000;
    vi.setSystemTime(toolTime);

    emitToolEvent("run-tool-reset");

    const runs = listSubagentRunsForRequester("agent:main:main");
    const entry = runs.find((r) => r.runId === "run-tool-reset");
    expect(entry).toBeDefined();
    // lastToolCallAt should be updated to the time the tool event was emitted.
    expect(entry!.lastToolCallAt).toBe(toolTime);
  });

  it("tool activity after nudge clears stallNudgedAt", () => {
    const baseTime = 1_000_000;
    vi.setSystemTime(baseTime);

    registerSubagentRun({
      runId: "run-clear-nudge",
      childSessionKey: "agent:main:subagent:stall-child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "clear nudge test",
      cleanup: "keep",
      stallNudgeAfterSeconds: 5,
      stallKillAfterSeconds: 10,
    });

    // Manually set stallNudgedAt on the entry.
    const runs = listSubagentRunsForRequester("agent:main:main");
    const entry = runs.find((r) => r.runId === "run-clear-nudge");
    expect(entry).toBeDefined();
    entry!.stallNudgedAt = baseTime - 2_000;

    // Emit a tool event — should clear the nudge state.
    vi.setSystemTime(baseTime + 1_000);
    emitToolEvent("run-clear-nudge");

    const updatedRuns = listSubagentRunsForRequester("agent:main:main");
    const updated = updatedRuns.find((r) => r.runId === "run-clear-nudge");
    expect(updated?.stallNudgedAt).toBeUndefined();
  });

  it("disabled when both values are 0", async () => {
    const baseTime = 1_000_000;
    vi.setSystemTime(baseTime);

    registerSubagentRun({
      runId: "run-disabled",
      childSessionKey: "agent:main:subagent:stall-child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "disabled stall test",
      cleanup: "keep",
      stallNudgeAfterSeconds: 0,
      stallKillAfterSeconds: 0,
    });

    callGatewaySpy.mockClear();
    callGatewaySpy.mockImplementation(async (params: { method?: string }) => {
      if (params?.method === "agent.wait") {
        return new Promise(() => {});
      }
      return { status: "ok" };
    });
    queueEmbeddedPiMessageSpy.mockClear();
    abortEmbeddedPiRunSpy.mockClear();

    // Advance well past any stall threshold.
    vi.setSystemTime(baseTime + 300_000);
    await vi.advanceTimersByTimeAsync(60_000);

    // No nudge or kill should fire.
    const agentCalls = callGatewaySpy.mock.calls.filter(
      (call: unknown[]) => (call[0] as { method?: string })?.method === "agent",
    );
    expect(agentCalls).toHaveLength(0);
    expect(abortEmbeddedPiRunSpy).not.toHaveBeenCalled();
  });

  it("completed runs are not checked", async () => {
    const baseTime = 1_000_000;
    vi.setSystemTime(baseTime);

    registerSubagentRun({
      runId: "run-completed",
      childSessionKey: "agent:main:subagent:stall-child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "completed stall test",
      cleanup: "keep",
      stallNudgeAfterSeconds: 5,
      stallKillAfterSeconds: 10,
    });

    // Mark it as ended.
    const runs = listSubagentRunsForRequester("agent:main:main");
    const entry = runs.find((r) => r.runId === "run-completed");
    expect(entry).toBeDefined();
    entry!.endedAt = baseTime;

    callGatewaySpy.mockClear();
    callGatewaySpy.mockImplementation(async (params: { method?: string }) => {
      if (params?.method === "agent.wait") {
        return new Promise(() => {});
      }
      return { status: "ok" };
    });
    queueEmbeddedPiMessageSpy.mockClear();
    abortEmbeddedPiRunSpy.mockClear();

    // Advance well past stall thresholds.
    vi.setSystemTime(baseTime + 300_000);
    await vi.advanceTimersByTimeAsync(60_000);

    // No stall actions should fire for ended runs.
    const agentCalls = callGatewaySpy.mock.calls.filter(
      (call: unknown[]) => (call[0] as { method?: string })?.method === "agent",
    );
    expect(agentCalls).toHaveLength(0);
    expect(abortEmbeddedPiRunSpy).not.toHaveBeenCalled();
  });

  it("nudge falls back to callGateway when queueEmbeddedPiMessage returns false", async () => {
    const baseTime = 1_000_000;
    vi.setSystemTime(baseTime);

    queueEmbeddedPiMessageSpy.mockReturnValue(false);

    registerSubagentRun({
      runId: "run-nudge-fallback",
      childSessionKey: "agent:main:subagent:stall-child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "nudge fallback test",
      cleanup: "keep",
      stallNudgeAfterSeconds: 5,
      stallKillAfterSeconds: 10,
    });

    callGatewaySpy.mockClear();
    callGatewaySpy.mockImplementation(async (params: { method?: string }) => {
      if (params?.method === "agent.wait") {
        return new Promise(() => {});
      }
      return { status: "ok" };
    });
    queueEmbeddedPiMessageSpy.mockClear();
    queueEmbeddedPiMessageSpy.mockReturnValue(false);

    // Advance past nudge threshold and trigger sweeper.
    vi.setSystemTime(baseTime + 6_000);
    await vi.advanceTimersByTimeAsync(60_000);

    // queueEmbeddedPiMessage should have been called first.
    expect(queueEmbeddedPiMessageSpy).toHaveBeenCalled();

    // Since it returned false, callGateway should be called with method "agent".
    const agentCalls = callGatewaySpy.mock.calls.filter(
      (call: unknown[]) => (call[0] as { method?: string })?.method === "agent",
    );
    expect(agentCalls.length).toBeGreaterThanOrEqual(1);
    const nudgeCall = agentCalls[0][0] as {
      params?: { message?: string };
    };
    expect(nudgeCall.params?.message).toContain("stalled");
  });

  it("nudge uses queueEmbeddedPiMessage when it returns true", async () => {
    const baseTime = 1_000_000;
    vi.setSystemTime(baseTime);

    queueEmbeddedPiMessageSpy.mockReturnValue(true);

    registerSubagentRun({
      runId: "run-nudge-embedded",
      childSessionKey: "agent:main:subagent:stall-child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "nudge embedded test",
      cleanup: "keep",
      stallNudgeAfterSeconds: 5,
      stallKillAfterSeconds: 10,
    });

    callGatewaySpy.mockClear();
    callGatewaySpy.mockImplementation(async (params: { method?: string }) => {
      if (params?.method === "agent.wait") {
        return new Promise(() => {});
      }
      return { status: "ok" };
    });
    queueEmbeddedPiMessageSpy.mockClear();
    queueEmbeddedPiMessageSpy.mockReturnValue(true);

    // Advance past nudge threshold and trigger sweeper.
    vi.setSystemTime(baseTime + 6_000);
    await vi.advanceTimersByTimeAsync(60_000);

    // queueEmbeddedPiMessage should have succeeded.
    expect(queueEmbeddedPiMessageSpy).toHaveBeenCalled();
    const callArgs = queueEmbeddedPiMessageSpy.mock.calls[0] as unknown as [string, string];
    expect(callArgs[1]).toContain("stalled");

    // callGateway should NOT have been called with method "agent" for fallback.
    const agentCalls = callGatewaySpy.mock.calls.filter(
      (call: unknown[]) => (call[0] as { method?: string })?.method === "agent",
    );
    expect(agentCalls).toHaveLength(0);
  });

  it("gateway fallback includes idempotencyKey (Bug #1 fix)", async () => {
    const baseTime = 1_000_000;
    vi.setSystemTime(baseTime);

    queueEmbeddedPiMessageSpy.mockReturnValue(false);

    registerSubagentRun({
      runId: "run-idem-key",
      childSessionKey: "agent:main:subagent:stall-child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "idempotency key test",
      cleanup: "keep",
      stallNudgeAfterSeconds: 5,
      stallKillAfterSeconds: 10,
    });

    callGatewaySpy.mockClear();
    callGatewaySpy.mockImplementation(async (params: { method?: string }) => {
      if (params?.method === "agent.wait") {
        return new Promise(() => {});
      }
      return { status: "ok" };
    });
    queueEmbeddedPiMessageSpy.mockClear();
    queueEmbeddedPiMessageSpy.mockReturnValue(false);

    // Advance past nudge threshold and trigger sweeper.
    vi.setSystemTime(baseTime + 6_000);
    await vi.advanceTimersByTimeAsync(60_000);

    const agentCalls = callGatewaySpy.mock.calls.filter(
      (call: unknown[]) => (call[0] as { method?: string })?.method === "agent",
    );
    expect(agentCalls.length).toBeGreaterThanOrEqual(1);
    const nudgeCall = agentCalls[0][0] as {
      params?: { idempotencyKey?: string };
    };
    // The gateway requires idempotencyKey — verify it's present and non-empty.
    expect(nudgeCall.params?.idempotencyKey).toBeDefined();
    expect(nudgeCall.params!.idempotencyKey!.length).toBeGreaterThan(0);
    expect(nudgeCall.params!.idempotencyKey).toContain("stall-nudge");
  });

  it("nudge not marked sent when both delivery paths fail (Bug #1 fix)", async () => {
    const baseTime = 1_000_000;
    vi.setSystemTime(baseTime);

    // Both delivery paths will fail.
    queueEmbeddedPiMessageSpy.mockReturnValue(false);

    registerSubagentRun({
      runId: "run-nudge-fail",
      childSessionKey: "agent:main:subagent:stall-child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "nudge fail test",
      cleanup: "keep",
      stallNudgeAfterSeconds: 5,
      stallKillAfterSeconds: 10,
    });

    callGatewaySpy.mockClear();
    callGatewaySpy.mockImplementation(async (params: { method?: string }) => {
      if (params?.method === "agent.wait") {
        return new Promise(() => {});
      }
      // Simulate gateway failure for nudge delivery.
      if (params?.method === "agent") {
        throw new Error("gateway unavailable");
      }
      return { status: "ok" };
    });
    queueEmbeddedPiMessageSpy.mockClear();
    queueEmbeddedPiMessageSpy.mockReturnValue(false);

    // Advance past nudge threshold and trigger sweeper.
    vi.setSystemTime(baseTime + 6_000);
    await vi.advanceTimersByTimeAsync(60_000);

    // Both paths failed — stallNudgedAt should NOT be set.
    const runs = listSubagentRunsForRequester("agent:main:main");
    const entry = runs.find((r) => r.runId === "run-nudge-fail");
    expect(entry).toBeDefined();
    expect(entry!.stallNudgedAt).toBeUndefined();

    // On the next sweep, nudge should be retried (not skipped).
    callGatewaySpy.mockClear();
    callGatewaySpy.mockImplementation(async (params: { method?: string }) => {
      if (params?.method === "agent.wait") {
        return new Promise(() => {});
      }
      return { status: "ok" };
    });
    queueEmbeddedPiMessageSpy.mockClear();
    queueEmbeddedPiMessageSpy.mockReturnValue(false);

    // Trigger another sweep (still past the nudge threshold).
    vi.setSystemTime(baseTime + 12_000);
    await vi.advanceTimersByTimeAsync(60_000);

    // The nudge should be retried via callGateway.
    const retryCalls = callGatewaySpy.mock.calls.filter(
      (call: unknown[]) => (call[0] as { method?: string })?.method === "agent",
    );
    expect(retryCalls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("stall recovery per-agent config validation (Bug #3 fix)", () => {
  it("per-agent subagents schema accepts stallNudgeAfterSeconds", () => {
    const result = AgentEntrySchema.safeParse({
      id: "test",
      subagents: { stallNudgeAfterSeconds: 120 },
    });
    expect(result.success).toBe(true);
  });

  it("per-agent subagents schema accepts stallKillAfterSeconds", () => {
    const result = AgentEntrySchema.safeParse({
      id: "test",
      subagents: { stallKillAfterSeconds: 300 },
    });
    expect(result.success).toBe(true);
  });

  it("per-agent subagents schema rejects negative stall values", () => {
    const result = AgentEntrySchema.safeParse({
      id: "test",
      subagents: { stallNudgeAfterSeconds: -1 },
    });
    expect(result.success).toBe(false);
  });
});
