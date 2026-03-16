import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

// Mock dependencies before importing the module under test
vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    session: { store: undefined },
  })),
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: vi.fn(() => ({})),
  resolveAgentIdFromSessionKey: vi.fn(() => "main"),
  resolveStorePath: vi.fn(() => "/tmp/test-sessions.json"),
  updateSessionStore: vi.fn(async () => {}),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({ runId: "test-run-id" })),
}));

function createTestRunRecord(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:test-session-1",
    requesterSessionKey: "agent:main:signal:direct:+1234567890",
    requesterDisplayKey: "main",
    task: "Test task: implement feature X",
    cleanup: "delete",
    createdAt: Date.now() - 60_000,
    startedAt: Date.now() - 55_000,
    ...overrides,
  };
}

describe("subagent-orphan-recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recovers orphaned sessions with abortedLastRun=true", async () => {
    const sessions = await import("../config/sessions.js");
    const gateway = await import("../gateway/call.js");

    const sessionEntry = {
      sessionId: "session-abc",
      updatedAt: Date.now(),
      abortedLastRun: true,
    };

    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": sessionEntry,
    });

    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set("run-1", createTestRunRecord());

    const { recoverOrphanedSubagentSessions } = await import("./subagent-orphan-recovery.js");

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(result.recovered).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);

    // Should have called callGateway to resume the session
    expect(gateway.callGateway).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(gateway.callGateway).mock.calls[0];
    const opts = callArgs[0];
    expect(opts.method).toBe("agent");
    const params = opts.params as Record<string, unknown>;
    expect(params.sessionKey).toBe("agent:main:subagent:test-session-1");
    expect(params.message).toContain("gateway reload");
    expect(params.message).toContain("Test task: implement feature X");
  });

  it("skips sessions that are not aborted", async () => {
    const sessions = await import("../config/sessions.js");
    const gateway = await import("../gateway/call.js");

    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: Date.now(),
        abortedLastRun: false,
      },
    });

    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set("run-1", createTestRunRecord());

    const { recoverOrphanedSubagentSessions } = await import("./subagent-orphan-recovery.js");

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(result.recovered).toBe(0);
    expect(result.skipped).toBe(1);
    expect(gateway.callGateway).not.toHaveBeenCalled();
  });

  it("skips runs that have already ended", async () => {
    const gateway = await import("../gateway/call.js");

    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set(
      "run-1",
      createTestRunRecord({
        endedAt: Date.now() - 1000,
      }),
    );

    const { recoverOrphanedSubagentSessions } = await import("./subagent-orphan-recovery.js");

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(result.recovered).toBe(0);
    expect(gateway.callGateway).not.toHaveBeenCalled();
  });

  it("handles multiple orphaned sessions", async () => {
    const sessions = await import("../config/sessions.js");
    const gateway = await import("../gateway/call.js");

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

    const { recoverOrphanedSubagentSessions } = await import("./subagent-orphan-recovery.js");

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(result.recovered).toBe(2);
    expect(result.skipped).toBe(1);
    expect(gateway.callGateway).toHaveBeenCalledTimes(2);
  });

  it("handles callGateway failure gracefully", async () => {
    const sessions = await import("../config/sessions.js");
    const gateway = await import("../gateway/call.js");

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

    const { recoverOrphanedSubagentSessions } = await import("./subagent-orphan-recovery.js");

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(result.recovered).toBe(0);
    expect(result.failed).toBe(1);
  });

  it("returns empty results when no active runs exist", async () => {
    const { recoverOrphanedSubagentSessions } = await import("./subagent-orphan-recovery.js");

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => new Map(),
    });

    expect(result.recovered).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it("skips sessions with missing session entry in store", async () => {
    const sessions = await import("../config/sessions.js");
    const gateway = await import("../gateway/call.js");

    // Store has no matching entry
    vi.mocked(sessions.loadSessionStore).mockReturnValue({});

    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set("run-1", createTestRunRecord());

    const { recoverOrphanedSubagentSessions } = await import("./subagent-orphan-recovery.js");

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(result.recovered).toBe(0);
    expect(result.skipped).toBe(1);
    expect(gateway.callGateway).not.toHaveBeenCalled();
  });

  it("clears abortedLastRun flag before resuming", async () => {
    const sessions = await import("../config/sessions.js");

    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: Date.now(),
        abortedLastRun: true,
      },
    });

    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set("run-1", createTestRunRecord());

    const { recoverOrphanedSubagentSessions } = await import("./subagent-orphan-recovery.js");

    await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    // updateSessionStore should have been called to clear the flag
    expect(sessions.updateSessionStore).toHaveBeenCalledOnce();
    const calls = vi.mocked(sessions.updateSessionStore).mock.calls;
    const [storePath, updater] = calls[0];
    expect(storePath).toBe("/tmp/test-sessions.json");

    // Simulate the updater to verify it clears abortedLastRun
    const mockStore: Record<string, { abortedLastRun?: boolean; updatedAt?: number }> = {
      "agent:main:subagent:test-session-1": {
        abortedLastRun: true,
        updatedAt: 0,
      },
    };
    (updater as (store: Record<string, unknown>) => void)(mockStore);
    expect(mockStore["agent:main:subagent:test-session-1"]?.abortedLastRun).toBe(false);
  });

  it("truncates long task descriptions in resume message", async () => {
    const sessions = await import("../config/sessions.js");
    const gateway = await import("../gateway/call.js");

    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: Date.now(),
        abortedLastRun: true,
      },
    });

    const longTask = "x".repeat(5000);
    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set("run-1", createTestRunRecord({ task: longTask }));

    const { recoverOrphanedSubagentSessions } = await import("./subagent-orphan-recovery.js");

    await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    const callArgs = vi.mocked(gateway.callGateway).mock.calls[0];
    const opts = callArgs[0];
    const params = opts.params as Record<string, unknown>;
    const message = params.message as string;
    // Message should contain truncated task (2000 chars + "...")
    expect(message.length).toBeLessThan(5000);
    expect(message).toContain("...");
  });
});
