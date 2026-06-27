// Subagent orphan-recovery tests cover restart recovery for child sessions whose
// embedded run was interrupted while the registry still considers them active.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sessions from "../config/sessions.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import * as gateway from "../gateway/call.js";
import * as sessionUtils from "../gateway/session-transcript-readers.js";
import { resolveInternalSessionEffectsTranscriptPath } from "./internal-session-effects.js";
import * as announceDelivery from "./subagent-announce-delivery.js";
import {
  recoverOrphanedSubagentSessions,
  scheduleOrphanRecovery,
} from "./subagent-orphan-recovery.js";
import * as subagentRegistrySteerRuntime from "./subagent-registry-steer-runtime.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

// Mocks are installed before importing the recovery module so registry/runtime
// helpers resolve to deterministic restart fixtures.
const sessionMocks = vi.hoisted(() => {
  type MockSessionEntry = Record<string, unknown>;
  type MockSessionStore = Record<string, MockSessionEntry>;
  const loadSessionStore = vi.fn(
    (_storePath?: string, _options?: { clone?: boolean }): MockSessionStore => ({}),
  );
  return {
    loadSessionStore,
    resolveAgentIdFromSessionKey: vi.fn(() => "main"),
    resolveStorePath: vi.fn(() => "/tmp/test-sessions.json"),
    loadSessionEntry: vi.fn(
      (scope: { storePath?: string; sessionKey: string }) =>
        loadSessionStore(scope.storePath, {
          clone: false,
        })[scope.sessionKey],
    ),
    patchSessionEntry: vi.fn(
      async (
        scope: { storePath?: string; sessionKey: string },
        update: (
          entry: MockSessionEntry,
        ) =>
          | MockSessionEntry
          | Partial<MockSessionEntry>
          | null
          | Promise<MockSessionEntry | Partial<MockSessionEntry> | null>,
        options: { replaceEntry?: boolean } = {},
      ) => {
        const store = loadSessionStore(scope.storePath, {
          clone: false,
        });
        const current = store[scope.sessionKey];
        if (!current) {
          return null;
        }
        const patch = await update({ ...current });
        if (!patch) {
          return current;
        }
        const next = options.replaceEntry ? patch : { ...current, ...patch };
        store[scope.sessionKey] = next;
        return next;
      },
    ),
  };
});

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({
    session: { store: undefined },
  })),
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: sessionMocks.loadSessionStore,
  resolveAgentIdFromSessionKey: sessionMocks.resolveAgentIdFromSessionKey,
  resolveStorePath: sessionMocks.resolveStorePath,
}));

vi.mock("../config/sessions/session-accessor.js", () => ({
  loadSessionEntry: sessionMocks.loadSessionEntry,
  patchSessionEntry: sessionMocks.patchSessionEntry,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({ runId: "test-run-id" })),
}));

vi.mock("../gateway/session-transcript-readers.js", () => ({
  readSessionMessagesAsync: vi.fn(async () => []),
}));

vi.mock("./subagent-announce-delivery.js", () => ({
  deliverSubagentAnnouncement: vi.fn(async () => ({ delivered: true, path: "direct" })),
  isInternalAnnounceRequesterSession: vi.fn(() => false),
  loadRequesterSessionEntry: vi.fn(() => ({ entry: {} })),
}));

vi.mock("./subagent-announce-origin.js", () => ({
  resolveAnnounceOrigin: vi.fn((entry, requesterOrigin) => requesterOrigin),
}));

vi.mock("./subagent-registry-steer-runtime.js", () => ({
  replaceSubagentRunAfterSteer: vi.fn(() => true),
  finalizeInterruptedSubagentRun: vi.fn(async () => 1),
}));

function createTestRunRecord(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:test-session-1",
    requesterSessionKey: "agent:main:quietchat:direct:+1234567890",
    requesterDisplayKey: "main",
    task: "Test task: implement feature X",
    cleanup: "delete",
    createdAt: Date.now() - 60_000,
    startedAt: Date.now() - 55_000,
    ...overrides,
  };
}

function createActiveRuns(...runs: SubagentRunRecord[]) {
  return new Map(runs.map((run) => [run.runId, run] satisfies [string, SubagentRunRecord]));
}

function mockSingleAbortedSession(
  overrides: Partial<NonNullable<ReturnType<typeof sessions.loadSessionStore>[string]>> = {},
) {
  const store = {
    "agent:main:subagent:test-session-1": {
      sessionId: "session-abc",
      updatedAt: Date.now(),
      abortedLastRun: true,
      ...overrides,
    },
  };
  vi.mocked(sessions.loadSessionStore).mockReturnValue(store);
  return store;
}

async function expectSkippedRecovery(store: ReturnType<typeof sessions.loadSessionStore>) {
  vi.mocked(sessions.loadSessionStore).mockReturnValue(store);

  const result = await recoverOrphanedSubagentSessions({
    getActiveRuns: () => createActiveRuns(createTestRunRecord()),
  });

  expect(result.recovered).toBe(0);
  expect(result.skipped).toBe(1);
  expect(gateway.callGateway).not.toHaveBeenCalled();
}

function getResumeMessage() {
  const call = requireRecord(
    firstCallParam(vi.mocked(gateway.callGateway).mock.calls, "resume gateway"),
    "resume gateway params",
  );
  const params = call.params as Record<string, unknown>;
  return params.message as string;
}

function firstCallParam(calls: ReadonlyArray<readonly unknown[]>, label: string) {
  const call = calls[0];
  if (call === undefined) {
    throw new Error(`expected ${label} call`);
  }
  return call[0];
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
}

describe("subagent-orphan-recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("recovers orphaned sessions with abortedLastRun=true", async () => {
    const sessionEntry = {
      sessionId: "session-abc",
      updatedAt: Date.now(),
      abortedLastRun: true,
    };

    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": sessionEntry,
    });

    const run = createTestRunRecord();
    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set("run-1", run);

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(result.recovered).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);

    // Recovery resumes through the gateway and records the new run id so the
    // registry follows the resumed transcript instead of the idempotency key.
    expect(gateway.callGateway).toHaveBeenCalledOnce();
    const opts = requireRecord(
      firstCallParam(vi.mocked(gateway.callGateway).mock.calls, "gateway resume"),
      "gateway resume params",
    );
    expect(opts.method).toBe("agent");
    const params = opts.params as Record<string, unknown>;
    expect(params.sessionKey).toBe("agent:main:subagent:test-session-1");
    expect(params.message).toContain("gateway reload");
    expect(params.message).toContain("Test task: implement feature X");
    expect(subagentRegistrySteerRuntime.replaceSubagentRunAfterSteer).toHaveBeenCalledOnce();
    const replaceParams = requireRecord(
      firstCallParam(
        vi.mocked(subagentRegistrySteerRuntime.replaceSubagentRunAfterSteer).mock.calls,
        "run replacement",
      ),
      "run replacement params",
    );
    expect(replaceParams.previousRunId).toBe("run-1");
    expect(replaceParams.nextRunId).toBe("test-run-id");
    expect(replaceParams.fallback).toBe(run);
    expect(replaceParams.transcriptFile).toBe(
      resolveInternalSessionEffectsTranscriptPath("test-run-id"),
    );
    expect(replaceParams.transcriptFile).not.toBe(
      resolveInternalSessionEffectsTranscriptPath(params.idempotencyKey as string),
    );
  });

  it("skips sessions that are not aborted", async () => {
    await expectSkippedRecovery({
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: Date.now(),
        abortedLastRun: false,
      },
    });
  });

  it("skips runs that have already ended", async () => {
    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set(
      "run-1",
      createTestRunRecord({
        endedAt: Date.now() - 1000,
      }),
    );

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(result.recovered).toBe(0);
    expect(result.skipped).toBe(1);
    expect(gateway.callGateway).not.toHaveBeenCalled();
  });

  it("recovers restart-aborted timeout runs even when the registry marked them ended", async () => {
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: Date.now(),
        abortedLastRun: true,
      },
    });

    const activeRuns = createActiveRuns(
      createTestRunRecord({
        endedAt: Date.now() - 1_000,
        outcome: {
          status: "timeout",
        },
      }),
    );

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(result.recovered).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(gateway.callGateway).toHaveBeenCalledOnce();
  });

  it("handles multiple orphaned sessions", async () => {
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:session-a": {
        sessionId: "id-a",
        updatedAt: Date.now(),
        abortedLastRun: true,
      },
      "agent:main:subagent:session-b": {
        sessionId: "id-b",
        updatedAt: Date.now(),
        abortedLastRun: true,
      },
      "agent:main:subagent:session-c": {
        sessionId: "id-c",
        updatedAt: Date.now(),
        abortedLastRun: false,
      },
    });

    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set(
      "run-a",
      createTestRunRecord({
        runId: "run-a",
        childSessionKey: "agent:main:subagent:session-a",
        task: "Task A",
      }),
    );
    activeRuns.set(
      "run-b",
      createTestRunRecord({
        runId: "run-b",
        childSessionKey: "agent:main:subagent:session-b",
        task: "Task B",
      }),
    );
    activeRuns.set(
      "run-c",
      createTestRunRecord({
        runId: "run-c",
        childSessionKey: "agent:main:subagent:session-c",
        task: "Task C",
      }),
    );

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(result.recovered).toBe(2);
    expect(result.skipped).toBe(1);
    expect(gateway.callGateway).toHaveBeenCalledTimes(2);
  });

  it("handles callGateway failure gracefully and preserves abortedLastRun flag", async () => {
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: Date.now(),
        abortedLastRun: true,
      },
    });

    vi.mocked(gateway.callGateway).mockRejectedValue(new Error("gateway unavailable"));

    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set("run-1", createTestRunRecord());

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(result.recovered).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.failedRuns).toHaveLength(1);
    const failedRun = requireRecord(result.failedRuns[0], "failed run");
    expect(failedRun.runId).toBe("run-1");
    expect(failedRun.childSessionKey).toBe("agent:main:subagent:test-session-1");
    expect(failedRun.error).toBe("gateway unavailable");

    // abortedLastRun flag should NOT be cleared on failure, so the next
    // restart can retry recovery through the canonical session accessor.
    expect(sessionAccessor.patchSessionEntry).not.toHaveBeenCalled();
  });

  it("returns empty results when no active runs exist", async () => {
    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => new Map(),
    });

    expect(result.recovered).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it("skips sessions with missing session entry in store", async () => {
    await expectSkippedRecovery({});
  });

  it("clears abortedLastRun flag after successful resume", async () => {
    // Ensure callGateway succeeds for this test
    vi.mocked(gateway.callGateway).mockResolvedValue({ runId: "resumed-run" } as never);

    const store = {
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: Date.now(),
        abortedLastRun: true,
      },
    };
    vi.mocked(sessions.loadSessionStore).mockReturnValue(store);

    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set("run-1", createTestRunRecord());

    await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(sessionAccessor.patchSessionEntry).toHaveBeenCalledOnce();
    expect(sessionAccessor.patchSessionEntry).toHaveBeenCalledWith(
      {
        storePath: "/tmp/test-sessions.json",
        sessionKey: "agent:main:subagent:test-session-1",
      },
      expect.any(Function),
      {
        replaceEntry: true,
        skipMaintenance: true,
      },
    );
    expect(store["agent:main:subagent:test-session-1"]?.abortedLastRun).toBe(false);
  });

  it("persists accepted recovery attempts after successful resume", async () => {
    vi.mocked(gateway.callGateway).mockResolvedValue({ runId: "resumed-run" } as never);
    const store = mockSingleAbortedSession();

    await recoverOrphanedSubagentSessions({
      getActiveRuns: () => createActiveRuns(createTestRunRecord()),
    });

    expect(sessionAccessor.patchSessionEntry).toHaveBeenCalledOnce();
    const sessionEntry = requireRecord(
      store["agent:main:subagent:test-session-1"],
      "updated session entry",
    );
    expect(sessionEntry.abortedLastRun).toBe(false);
    const recovery = requireRecord(sessionEntry.subagentRecovery, "subagent recovery");
    expect(recovery.automaticAttempts).toBe(1);
    expect(recovery.lastRunId).toBe("run-1");
    expect(recovery.lastAttemptAt).toBeTypeOf("number");
  });

  it("tombstones rapid repeated accepted recovery before resuming again", async () => {
    const now = Date.now();
    const store = mockSingleAbortedSession({
      subagentRecovery: {
        automaticAttempts: 2,
        lastAttemptAt: now - 30_000,
        lastRunId: "previous-run",
      },
    });

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => createActiveRuns(createTestRunRecord()),
    });

    expect(result.recovered).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.failedRuns).toHaveLength(1);
    const blockedRun = requireRecord(result.failedRuns[0], "blocked run");
    expect(blockedRun.runId).toBe("run-1");
    expect(blockedRun.childSessionKey).toBe("agent:main:subagent:test-session-1");
    expect(blockedRun.error).toContain("recovery blocked after 2 rapid accepted resume attempts");
    expect(gateway.callGateway).not.toHaveBeenCalled();
    expect(sessionAccessor.patchSessionEntry).toHaveBeenCalledOnce();

    const sessionEntry = requireRecord(
      store["agent:main:subagent:test-session-1"],
      "wedged session entry",
    );
    expect(sessionEntry.abortedLastRun).toBe(false);
    const recovery = requireRecord(sessionEntry.subagentRecovery, "wedged recovery");
    expect(recovery.automaticAttempts).toBe(2);
    expect(recovery.lastRunId).toBe("run-1");
    expect(recovery.wedgedAt).toBeTypeOf("number");
    expect(recovery.wedgedReason).toContain("recovery blocked");
  });

  it("skips already tombstoned wedged sessions without rewriting them", async () => {
    mockSingleAbortedSession({
      subagentRecovery: {
        automaticAttempts: 2,
        lastAttemptAt: Date.now() - 20_000,
        lastRunId: "previous-run",
        wedgedAt: Date.now() - 10_000,
        wedgedReason: "subagent orphan recovery blocked after 2 rapid accepted resume attempts",
      },
    });

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => createActiveRuns(createTestRunRecord()),
    });

    expect(result.recovered).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.failedRuns).toHaveLength(1);
    expect(gateway.callGateway).not.toHaveBeenCalled();
    expect(sessionAccessor.patchSessionEntry).not.toHaveBeenCalled();
  });

  it("truncates long task descriptions in resume message", async () => {
    mockSingleAbortedSession();

    const longTask = "x".repeat(5000);
    const activeRuns = createActiveRuns(createTestRunRecord({ task: longTask }));

    await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    const message = getResumeMessage();
    // Message should contain truncated task (2000 chars + "...")
    expect(message.length).toBeLessThan(5000);
    expect(message).toContain("...");
  });

  it("includes last human message in resume when available", async () => {
    mockSingleAbortedSession({ sessionFile: "session-abc.jsonl" });

    vi.mocked(sessionUtils.readSessionMessagesAsync).mockResolvedValue([
      { role: "user", content: [{ type: "text", text: "Please build feature Y" }] },
      { role: "assistant", content: [{ type: "text", text: "Working on it..." }] },
      { role: "user", content: [{ type: "text", text: "Also add tests for it" }] },
      { role: "assistant", content: [{ type: "text", text: "Sure, adding tests now." }] },
    ]);

    const activeRuns = createActiveRuns(createTestRunRecord());

    await recoverOrphanedSubagentSessions({ getActiveRuns: () => activeRuns });

    const message = getResumeMessage();
    expect(message).toContain("Also add tests for it");
    expect(message).toContain("last message from the user");
  });

  it("adds config change hint when assistant messages reference config modifications", async () => {
    mockSingleAbortedSession();

    vi.mocked(sessionUtils.readSessionMessagesAsync).mockResolvedValue([
      { role: "user", content: "Update the config" },
      { role: "assistant", content: "I've modified openclaw.json to add the new setting." },
    ]);

    const activeRuns = createActiveRuns(createTestRunRecord());

    await recoverOrphanedSubagentSessions({ getActiveRuns: () => activeRuns });

    const message = getResumeMessage();
    expect(message).toContain("config changes from your previous run were already applied");
  });

  it("does not send parent-visible recovery-progress announcements on retry", async () => {
    mockSingleAbortedSession();

    const activeRuns = createActiveRuns(createTestRunRecord());

    await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(announceDelivery.deliverSubagentAnnouncement).not.toHaveBeenCalled();

    await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(announceDelivery.deliverSubagentAnnouncement).not.toHaveBeenCalled();
  });

  it("prevents duplicate resume when the session accessor write fails", async () => {
    vi.mocked(gateway.callGateway).mockResolvedValue({ runId: "new-run" } as never);
    vi.mocked(sessionAccessor.patchSessionEntry).mockRejectedValueOnce(new Error("write failed"));

    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: Date.now(),
        abortedLastRun: true,
      },
    });

    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set("run-1", createTestRunRecord());
    activeRuns.set(
      "run-2",
      createTestRunRecord({
        runId: "run-2",
      }),
    );

    const result = await recoverOrphanedSubagentSessions({ getActiveRuns: () => activeRuns });

    expect(result.recovered).toBe(1);
    expect(result.skipped).toBe(1);
    expect(gateway.callGateway).toHaveBeenCalledOnce();
    expect(sessionAccessor.patchSessionEntry).toHaveBeenCalledOnce();
  });

  it("does not retry a session after the gateway accepted resume but run remap failed", async () => {
    vi.mocked(gateway.callGateway).mockResolvedValue({ runId: "new-run" } as never);
    vi.mocked(subagentRegistrySteerRuntime.replaceSubagentRunAfterSteer).mockReturnValue(false);

    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: Date.now(),
        abortedLastRun: true,
      },
    });

    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set("run-1", createTestRunRecord());
    const resumedSessionKeys = new Set<string>();

    const first = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
      resumedSessionKeys,
    });
    const second = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
      resumedSessionKeys,
    });

    expect(first.recovered).toBe(1);
    expect(first.failed).toBe(0);
    expect(second.recovered).toBe(0);
    expect(second.skipped).toBe(1);
    expect(gateway.callGateway).toHaveBeenCalledOnce();
    expect(sessionAccessor.patchSessionEntry).toHaveBeenCalledOnce();
  });

  it("finalizes interrupted runs with a readable failure after recovery retries are exhausted", async () => {
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: Date.now(),
        abortedLastRun: true,
      },
    });
    vi.mocked(gateway.callGateway).mockRejectedValue(new Error("service restart"));

    const activeRuns = createActiveRuns(createTestRunRecord());

    scheduleOrphanRecovery({
      getActiveRuns: () => activeRuns,
      delayMs: 1,
      maxRetries: 1,
    });

    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2);
    await Promise.resolve();

    expect(subagentRegistrySteerRuntime.finalizeInterruptedSubagentRun).toHaveBeenCalledOnce();
    const finalizeParams = requireRecord(
      firstCallParam(
        vi.mocked(subagentRegistrySteerRuntime.finalizeInterruptedSubagentRun).mock.calls,
        "interrupted run finalization",
      ),
      "interrupted run finalization params",
    );
    expect(finalizeParams.runId).toBe("run-1");
    expect(finalizeParams.childSessionKey).toBe("agent:main:subagent:test-session-1");
    expect(finalizeParams.error).toContain("Automatic recovery failed after 2 attempts");
    expect(finalizeParams.error).toContain("service restart");
  });
});
