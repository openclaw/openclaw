import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

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
  loadSessionStore: () => ({
    "agent:main:subagent:child-1": { sessionId: "sess-child-1", updatedAt: 1 },
    "agent:main:subagent:expired-child": { sessionId: "sess-expired", updatedAt: 1 },
    "agent:main:subagent:retry-budget": { sessionId: "sess-retry", updatedAt: 1 },
  }),
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

const loadSubagentRegistryFromDisk = vi.fn(() => new Map());
const saveSubagentRegistryToDisk = vi.fn();

vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk,
  saveSubagentRegistryToDisk,
}));

vi.mock("./subagent-announce-queue.js", () => ({
  resetAnnounceQueuesForTests: vi.fn(),
}));

vi.mock("./timeout.js", () => ({
  resolveAgentTimeoutMs: () => 60_000,
}));

describe("announce loop guard (#18264)", () => {
  let registry: typeof import("./subagent-registry.js");
  let announceFn: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    registry = await import("./subagent-registry.js");
    const subagentAnnounce = await import("./subagent-announce.js");
    announceFn = vi.mocked(subagentAnnounce.runSubagentAnnounceFlow);
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    loadSubagentRegistryFromDisk.mockClear();
    loadSubagentRegistryFromDisk.mockReturnValue(new Map());
    saveSubagentRegistryToDisk.mockClear();
    vi.clearAllMocks();
  });

  test("SubagentRunRecord has announceRetryCount and lastAnnounceRetryAt fields", () => {
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

  test.each([
    {
      name: "expired entries with high retry count are skipped by resumeSubagentRun",
      createEntry: (now: number) => ({
        // Ended 10 minutes ago (well past ANNOUNCE_EXPIRY_MS of 5 min).
        runId: "test-expired-loop",
        childSessionKey: "agent:main:subagent:expired-child",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "agent:main:main",
        task: "expired test task",
        cleanup: "keep" as const,
        createdAt: now - 15 * 60_000,
        startedAt: now - 14 * 60_000,
        endedAt: now - 10 * 60_000,
        announceRetryCount: 3,
        lastAnnounceRetryAt: now - 9 * 60_000,
      }),
    },
    {
      name: "entries over retry budget are marked completed without announcing",
      createEntry: (now: number) => ({
        runId: "test-retry-budget",
        childSessionKey: "agent:main:subagent:retry-budget",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "agent:main:main",
        task: "retry budget test",
        cleanup: "keep" as const,
        createdAt: now - 2 * 60_000,
        startedAt: now - 90_000,
        endedAt: now - 60_000,
        announceRetryCount: 3,
        lastAnnounceRetryAt: now - 30_000,
      }),
    },
  ])("$name", ({ createEntry }) => {
    announceFn.mockClear();
    registry.resetSubagentRegistryForTests();

    const entry = createEntry(Date.now());
    loadSubagentRegistryFromDisk.mockReturnValue(new Map([[entry.runId, entry]]));

    // Initialization attempts resume once, then gives up for exhausted entries.
    registry.initSubagentRegistry();

    expect(announceFn).not.toHaveBeenCalled();
    const runs = registry.listSubagentRunsForRequester("agent:main:main");
    const stored = runs.find((run) => run.runId === entry.runId);
    expect(stored?.cleanupCompletedAt).toBeDefined();
  });
});
