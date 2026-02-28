import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Tests for subagent resilience improvements:
 *
 * Fix 1: waitForSubagentCompletion catches gateway errors and marks runs as
 *         errored instead of silently swallowing the exception.
 *
 * Fix 2: When announcement retries are exhausted (give-up), the parent session
 *         is notified via a gateway "agent" message about the lost results.
 */

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted by vitest)
// ---------------------------------------------------------------------------

const callGatewayMock = vi.fn(async () => ({ status: "ok" }));

vi.mock("../gateway/call.js", () => ({
  callGateway: callGatewayMock,
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn(() => () => {}),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({
    session: { store: "/tmp/test-store", mainKey: "main" },
    agents: {},
  }),
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: () => ({
    "agent:main:subagent:child-err": { sessionId: "sess-err", updatedAt: 1 },
    "agent:main:subagent:child-giveup": { sessionId: "sess-giveup", updatedAt: 1 },
  }),
  resolveAgentIdFromSessionKey: (key: string) => {
    const match = key.match(/^agent:([^:]+)/);
    return match?.[1] ?? "main";
  },
  resolveMainSessionKey: () => "agent:main:main",
  resolveStorePath: () => "/tmp/test-store",
  updateSessionStore: vi.fn(),
}));

const announceMock = vi.fn(async () => true);
vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: announceMock,
}));

const loadFromDisk = vi.fn(() => new Map());
const saveToDisk = vi.fn();
vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: loadFromDisk,
  saveSubagentRegistryToDisk: saveToDisk,
}));

vi.mock("./subagent-announce-queue.js", () => ({
  resetAnnounceQueuesForTests: vi.fn(),
}));

vi.mock("./timeout.js", () => ({
  resolveAgentTimeoutMs: () => 60_000,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("subagent resilience", () => {
  let registry: typeof import("./subagent-registry.js");

  beforeAll(async () => {
    registry = await import("./subagent-registry.js");
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    registry.resetSubagentRegistryForTests({ persist: false });
    callGatewayMock.mockReset();
    callGatewayMock.mockResolvedValue({ status: "ok" });
    announceMock.mockReset();
    announceMock.mockResolvedValue(true);
    loadFromDisk.mockReset();
    loadFromDisk.mockReturnValue(new Map());
    saveToDisk.mockClear();
  });

  const flushAsync = async () => {
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
  };

  // -------------------------------------------------------------------------
  // Fix 1: Error recovery in waitForSubagentCompletion
  // -------------------------------------------------------------------------

  describe("error recovery — waitForSubagentCompletion catch block", () => {
    test("marks run as errored when agent.wait throws", async () => {
      callGatewayMock.mockImplementation(async (req: { method: string }) => {
        if (req.method === "agent.wait") {
          throw new Error("gateway connection lost");
        }
        return { status: "ok" };
      });

      registry.registerSubagentRun({
        runId: "run-error-recovery",
        childSessionKey: "agent:main:subagent:child-err",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "error recovery test",
        cleanup: "keep",
        expectsCompletionMessage: true,
      });

      // waitForSubagentCompletion is fire-and-forget — flush microtasks
      await flushAsync();
      await vi.advanceTimersByTimeAsync(1_000);
      await flushAsync();

      const runs = registry.listSubagentRunsForRequester("agent:main:main");
      const entry = runs.find((r) => r.runId === "run-error-recovery");
      expect(entry).toBeDefined();
      expect(entry!.endedAt).toBeTypeOf("number");
      expect(entry!.outcome?.status).toBe("error");
      expect((entry!.outcome as { error?: string }).error).toContain("gateway connection lost");
    });

    test("error message includes the original exception text", async () => {
      callGatewayMock.mockImplementation(async (req: { method: string }) => {
        if (req.method === "agent.wait") {
          throw new Error("ECONNREFUSED 127.0.0.1:18789");
        }
        return { status: "ok" };
      });

      registry.registerSubagentRun({
        runId: "run-error-msg",
        childSessionKey: "agent:main:subagent:child-err",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "error message test",
        cleanup: "keep",
        expectsCompletionMessage: true,
      });

      await flushAsync();
      await vi.advanceTimersByTimeAsync(1_000);
      await flushAsync();

      const runs = registry.listSubagentRunsForRequester("agent:main:main");
      const entry = runs.find((r) => r.runId === "run-error-msg");
      const outcome = entry!.outcome as { error?: string };
      expect(outcome.error).toContain("ECONNREFUSED");
    });
  });

  // -------------------------------------------------------------------------
  // Fix 3: Give-up notification — parent session gets notified
  // -------------------------------------------------------------------------

  describe("give-up notification — parent session notified on lost results", () => {
    test("notifies parent session when announcement retries are exhausted", async () => {
      // Announce always returns false (deferred/failed)
      announceMock.mockResolvedValue(false);

      const now = Date.now();
      // announceRetryCount: 2 → resolveDeferredCleanupDecision increments to 3
      // 3 >= MAX_ANNOUNCE_RETRY_COUNT (3) → give-up
      const entry = {
        runId: "run-giveup-notify",
        childSessionKey: "agent:main:subagent:child-giveup",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "important research task",
        cleanup: "keep" as const,
        createdAt: now - 60_000,
        startedAt: now - 55_000,
        endedAt: now - 30_000,
        announceRetryCount: 2,
        lastAnnounceRetryAt: now - 20_000,
        outcome: { status: "ok" as const },
      };

      loadFromDisk.mockReturnValue(new Map([[entry.runId, entry]]));
      registry.initSubagentRegistry();

      await flushAsync();
      await vi.advanceTimersByTimeAsync(5_000);
      await flushAsync();

      // Find the "agent" call that notifies the parent
      const notifyCall = callGatewayMock.mock.calls.find(
        (call) => (call[0] as { method: string }).method === "agent",
      );
      expect(notifyCall).toBeDefined();
      const params = (
        notifyCall![0] as {
          params: { message: string; sessionKey: string; deliver: boolean };
        }
      ).params;
      expect(params.sessionKey).toBe("agent:main:main");
      expect(params.message).toContain("important research task");
      expect(params.message).toContain("results lost");
      expect(params.deliver).toBe(false);
    });

    test("uses label over task for the notification message", async () => {
      announceMock.mockResolvedValue(false);

      const now = Date.now();
      const entry = {
        runId: "run-giveup-label",
        childSessionKey: "agent:main:subagent:child-giveup",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "generic task description",
        label: "Weather Report Agent",
        cleanup: "keep" as const,
        createdAt: now - 60_000,
        startedAt: now - 55_000,
        endedAt: now - 30_000,
        announceRetryCount: 2,
        lastAnnounceRetryAt: now - 20_000,
        outcome: { status: "ok" as const },
      };

      loadFromDisk.mockReturnValue(new Map([[entry.runId, entry]]));
      registry.initSubagentRegistry();

      await flushAsync();
      await vi.advanceTimersByTimeAsync(5_000);
      await flushAsync();

      const notifyCall = callGatewayMock.mock.calls.find(
        (call) => (call[0] as { method: string }).method === "agent",
      );
      expect(notifyCall).toBeDefined();
      const params = (notifyCall![0] as { params: { message: string } }).params;
      // label takes priority: `entry.label || entry.task || entry.runId`
      expect(params.message).toContain("Weather Report Agent");
      expect(params.message).not.toContain("generic task description");
    });

    test("completes cleanup even if gateway notification fails", async () => {
      announceMock.mockResolvedValue(false);

      callGatewayMock.mockImplementation(async (req: { method: string }) => {
        if (req.method === "agent") {
          throw new Error("parent session unavailable");
        }
        return { status: "ok" };
      });

      const now = Date.now();
      const entry = {
        runId: "run-giveup-notify-fail",
        childSessionKey: "agent:main:subagent:child-giveup",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "notification-fail test",
        cleanup: "keep" as const,
        createdAt: now - 60_000,
        startedAt: now - 55_000,
        endedAt: now - 30_000,
        announceRetryCount: 2,
        lastAnnounceRetryAt: now - 20_000,
        outcome: { status: "ok" as const },
      };

      loadFromDisk.mockReturnValue(new Map([[entry.runId, entry]]));
      registry.initSubagentRegistry();

      await flushAsync();
      await vi.advanceTimersByTimeAsync(5_000);
      await flushAsync();

      // Cleanup should complete despite notification failure
      const runs = registry.listSubagentRunsForRequester("agent:main:main");
      const stored = runs.find((r) => r.runId === "run-giveup-notify-fail");
      expect(stored?.cleanupCompletedAt).toBeDefined();
    });

    test("falls back to runId when both label and task are missing", async () => {
      announceMock.mockResolvedValue(false);

      const now = Date.now();
      const entry = {
        runId: "run-giveup-fallback-id",
        childSessionKey: "agent:main:subagent:child-giveup",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "",
        cleanup: "keep" as const,
        createdAt: now - 60_000,
        startedAt: now - 55_000,
        endedAt: now - 30_000,
        announceRetryCount: 2,
        lastAnnounceRetryAt: now - 20_000,
        outcome: { status: "ok" as const },
      };

      loadFromDisk.mockReturnValue(new Map([[entry.runId, entry]]));
      registry.initSubagentRegistry();

      await flushAsync();
      await vi.advanceTimersByTimeAsync(5_000);
      await flushAsync();

      const notifyCall = callGatewayMock.mock.calls.find(
        (call) => (call[0] as { method: string }).method === "agent",
      );
      expect(notifyCall).toBeDefined();
      const params = (notifyCall![0] as { params: { message: string } }).params;
      // Falls back to runId: `entry.label || entry.task || entry.runId`
      expect(params.message).toContain("run-giveup-fallback-id");
    });
  });
});
