import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";

/**
 * Regression test for #18264: Gateway announcement delivery loop.
 *
 * When `runSubagentAnnounceFlow` repeatedly returns `false` (deferred),
 * `finalizeSubagentCleanup` must eventually give up rather than retrying
 * forever via the max-retry and expiration guards.
 */

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({
    session: { store: "/tmp/test-store", mainKey: "main" },
    agents: {},
  }),
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: () => ({}),
  resolveAgentIdFromSessionKey: (key: string) => {
    const match = key.match(/^agent:([^:]+)/);
    return match?.[1] ?? "main";
  },
  resolveMainSessionKey: () => "agent:main:main",
  resolveStorePath: () => "/tmp/test-store",
  updateSessionStore: vi.fn(),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn().mockResolvedValue({ status: "ok" }),
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn().mockReturnValue(() => {}),
}));

vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: vi.fn().mockResolvedValue(false),
}));

vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: () => new Map(),
  saveSubagentRegistryToDisk: vi.fn(),
}));

vi.mock("./subagent-announce-queue.js", () => ({
  resetAnnounceQueuesForTests: vi.fn(),
}));

vi.mock("./timeout.js", () => ({
  resolveAgentTimeoutMs: () => 60_000,
}));

describe("announce loop guard (#18264)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("SubagentRunRecord has announceRetryCount and lastAnnounceRetryAt fields", async () => {
    const registry = await import("./subagent-registry.js");
    registry.resetSubagentRegistryForTests();

    const now = Date.now();
    // Add a run that has already ended and exhausted retries
    registry.addSubagentRunForTests({
      runId: "test-loop-guard",
      childSessionKey: "agent:main:subagent:child-1",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "agent:main:main",
      task: "test task",
      cleanup: "keep",
      createdAt: now - 60_000,
      startedAt: now - 55_000,
      endedAt: now - 50_000,
      announceRetryCount: 3,
      lastAnnounceRetryAt: now - 10_000,
    });

    const runs = registry.listSubagentRunsForRequester("agent:main:main");
    const entry = runs.find((r) => r.runId === "test-loop-guard");
    expect(entry).toBeDefined();
    expect(entry!.announceRetryCount).toBe(3);
    expect(entry!.lastAnnounceRetryAt).toBeDefined();
  });

  test("expired entries with high retry count are skipped by resumeSubagentRun", async () => {
    const registry = await import("./subagent-registry.js");
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    const announceFn = vi.mocked(runSubagentAnnounceFlow);
    announceFn.mockClear();

    registry.resetSubagentRegistryForTests();

    const now = Date.now();
    // Add a run that ended 10 minutes ago (well past ANNOUNCE_EXPIRY_MS of 5 min)
    // with 3 retries already attempted
    registry.addSubagentRunForTests({
      runId: "test-expired-loop",
      childSessionKey: "agent:main:subagent:expired-child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "agent:main:main",
      task: "expired test task",
      cleanup: "keep",
      createdAt: now - 15 * 60_000,
      startedAt: now - 14 * 60_000,
      endedAt: now - 10 * 60_000, // 10 minutes ago
      announceRetryCount: 3,
      lastAnnounceRetryAt: now - 9 * 60_000,
    });

    // Initialize the registry — this triggers resumeSubagentRun for persisted entries
    registry.initSubagentRegistry();

    // The announce flow should NOT be called because the entry has exceeded
    // both the retry count and the expiry window.
    expect(announceFn).not.toHaveBeenCalled();
  });
});
