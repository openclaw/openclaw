import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Regression test for #18264: Gateway announcement delivery loop.
 *
 * When `runSubagentAnnounceFlow` repeatedly returns `false` (deferred),
 * `finalizeSubagentCleanup` must eventually give up rather than retrying
 * forever via the max-retry and expiration guards.
 */

function createLoopGuardConfigModuleMock() {
  return {
    loadConfig: () => ({
      session: { store: "/tmp/test-store", mainKey: "main" },
      agents: {},
    }),
  };
}

function createLoopGuardSessionsModuleMock() {
  return {
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
  };
}

function createLoopGuardGatewayCallModuleMock() {
  return {
    callGateway: vi.fn().mockResolvedValue({ status: "ok" }),
  };
}

function createLoopGuardAgentEventsModuleMock() {
  return {
    onAgentEvent: vi.fn().mockReturnValue(() => {}),
  };
}

function createLoopGuardSubagentAnnounceModuleMock() {
  return {
    runSubagentAnnounceFlow: vi.fn().mockResolvedValue(false),
  };
}

function createLoopGuardAnnounceQueueModuleMock() {
  return {
    resetAnnounceQueuesForTests: vi.fn(),
  };
}

function createLoopGuardTimeoutModuleMock() {
  return {
    resolveAgentTimeoutMs: () => 60_000,
  };
}

vi.mock("../config/config.js", createLoopGuardConfigModuleMock);

vi.mock("../config/sessions.js", createLoopGuardSessionsModuleMock);

vi.mock("../gateway/call.js", createLoopGuardGatewayCallModuleMock);

vi.mock("../infra/agent-events.js", createLoopGuardAgentEventsModuleMock);

vi.mock("./subagent-announce.js", createLoopGuardSubagentAnnounceModuleMock);

const loadSubagentRegistryFromDisk = vi.fn(() => new Map());
const saveSubagentRegistryToDisk = vi.fn();

vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk,
  saveSubagentRegistryToDisk,
}));

vi.mock("./subagent-announce-queue.js", createLoopGuardAnnounceQueueModuleMock);

vi.mock("./timeout.js", createLoopGuardTimeoutModuleMock);

describe("announce loop guard (#18264)", () => {
  let registry: typeof import("./subagent-registry.js");
  let announceFn: ReturnType<typeof vi.fn>;

  async function loadFreshSubagentRegistryLoopGuardModulesForTest() {
    vi.resetModules();
    vi.doMock("../config/config.js", createLoopGuardConfigModuleMock);
    vi.doMock("../config/sessions.js", createLoopGuardSessionsModuleMock);
    vi.doMock("../gateway/call.js", createLoopGuardGatewayCallModuleMock);
    vi.doMock("../infra/agent-events.js", createLoopGuardAgentEventsModuleMock);
    vi.doMock("./subagent-announce.js", createLoopGuardSubagentAnnounceModuleMock);
    vi.doMock("./subagent-registry.store.js", () => ({
      loadSubagentRegistryFromDisk,
      saveSubagentRegistryToDisk,
    }));
    vi.doMock("./subagent-announce-queue.js", createLoopGuardAnnounceQueueModuleMock);
    vi.doMock("./timeout.js", createLoopGuardTimeoutModuleMock);
    registry = await import("./subagent-registry.js");
    const subagentAnnounce = await import("./subagent-announce.js");
    announceFn = vi.mocked(subagentAnnounce.runSubagentAnnounceFlow);
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    await loadFreshSubagentRegistryLoopGuardModulesForTest();
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
        cleanupCompletedAt: undefined,
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
        cleanupCompletedAt: undefined,
        announceRetryCount: 3,
        lastAnnounceRetryAt: now - 30_000,
      }),
    },
  ])("$name", async ({ createEntry }) => {
    announceFn.mockClear();
    registry.resetSubagentRegistryForTests();

    const entry = createEntry(Date.now());
    loadSubagentRegistryFromDisk.mockReturnValue(new Map([[entry.runId, entry]]));

    // Initialization attempts resume once, then gives up for exhausted entries.
    registry.initSubagentRegistry();
    await Promise.resolve();
    await Promise.resolve();

    expect(announceFn).not.toHaveBeenCalled();
    expect(entry.cleanupCompletedAt).toBeDefined();
  });

  test("expired completion-message entries are still resumed for announce", async () => {
    announceFn.mockReset();
    announceFn.mockResolvedValueOnce(true);
    registry.resetSubagentRegistryForTests();

    const now = Date.now();
    const runId = "test-expired-completion-message";
    loadSubagentRegistryFromDisk.mockReturnValue(
      new Map([
        [
          runId,
          {
            runId,
            childSessionKey: "agent:main:subagent:child-1",
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "agent:main:main",
            task: "completion announce after long descendants",
            cleanup: "keep" as const,
            createdAt: now - 20 * 60_000,
            startedAt: now - 19 * 60_000,
            endedAt: now - 10 * 60_000,
            cleanupHandled: false,
            expectsCompletionMessage: true,
          },
        ],
      ]),
    );

    registry.initSubagentRegistry();
    await Promise.resolve();
    await Promise.resolve();

    expect(announceFn).toHaveBeenCalledTimes(1);
  });

  test("suppresses announce flow when auto-announce is disabled", async () => {
    announceFn.mockReset();
    announceFn.mockResolvedValueOnce(true);
    registry.resetSubagentRegistryForTests();

    const now = Date.now();
    const runId = "test-suppress-auto-announce";
    loadSubagentRegistryFromDisk.mockReturnValue(
      new Map([
        [
          runId,
          {
            runId,
            childSessionKey: "agent:main:subagent:child-1",
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "agent:main:main",
            task: "inline wait completed",
            cleanup: "keep" as const,
            createdAt: now - 20_000,
            startedAt: now - 10_000,
            endedAt: now - 5_000,
            cleanupHandled: false,
            expectsCompletionMessage: true,
            suppressAutoAnnounce: true,
          },
        ],
      ]),
    );

    registry.initSubagentRegistry();
    await Promise.resolve();
    await Promise.resolve();

    expect(announceFn).not.toHaveBeenCalled();
  });

  test("announce rejection resets cleanupHandled so retries can resume", async () => {
    announceFn.mockReset();
    announceFn.mockRejectedValueOnce(new Error("announce failed"));
    registry.resetSubagentRegistryForTests();

    const now = Date.now();
    const runId = "test-announce-rejection";
    loadSubagentRegistryFromDisk.mockReturnValue(
      new Map([
        [
          runId,
          {
            runId,
            childSessionKey: "agent:main:subagent:child-1",
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "agent:main:main",
            task: "rejection test",
            cleanup: "keep" as const,
            createdAt: now - 30_000,
            startedAt: now - 20_000,
            endedAt: now - 10_000,
            cleanupHandled: false,
          },
        ],
      ]),
    );

    registry.initSubagentRegistry();
    await Promise.resolve();
    await Promise.resolve();

    const runs = registry.listSubagentRunsForRequester("agent:main:main");
    const stored = runs.find((run) => run.runId === runId);
    expect(stored?.cleanupHandled).toBe(false);
    expect(stored?.cleanupCompletedAt).toBeUndefined();
    expect(stored?.announceRetryCount).toBe(1);
    expect(stored?.lastAnnounceRetryAt).toBeTypeOf("number");
  });
});
