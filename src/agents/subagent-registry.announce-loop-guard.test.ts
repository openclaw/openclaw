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
  let callGatewayMock: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    registry = await import("./subagent-registry.js");
    const subagentAnnounce = await import("./subagent-announce.js");
    const gateway = await import("../gateway/call.js");
    announceFn = vi.mocked(subagentAnnounce.runSubagentAnnounceFlow);
    callGatewayMock = vi.mocked(gateway.callGateway);
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

  const flushAsyncCleanup = async (rounds = 6) => {
    for (let i = 0; i < rounds; i++) {
      await Promise.resolve();
    }
  };

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
    await flushAsyncCleanup();

    expect(announceFn).toHaveBeenCalledTimes(1);
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
    await flushAsyncCleanup();

    const runs = registry.listSubagentRunsForRequester("agent:main:main");
    const stored = runs.find((run) => run.runId === runId);
    expect(stored?.cleanupHandled).toBe(false);
    expect(stored?.cleanupCompletedAt).toBeUndefined();
    expect(stored?.announceRetryCount).toBe(1);
    expect(stored?.lastAnnounceRetryAt).toBeTypeOf("number");
  });

  test("external completion notify stays deferred while descendants are still pending", async () => {
    announceFn.mockReset();
    announceFn.mockResolvedValueOnce(false);
    registry.resetSubagentRegistryForTests();

    const now = Date.now();
    const runId = "test-external-notify-deferred-descendants";
    const childRunId = "test-external-notify-deferred-descendants-child";
    loadSubagentRegistryFromDisk.mockReturnValue(
      new Map([
        [
          runId,
          {
            runId,
            childSessionKey: "agent:main:subagent:child-1",
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "agent:main:main",
            notifyChannel: "telegram",
            notifyTarget: "telegram:123",
            task: "wait for descendants",
            cleanup: "keep" as const,
            createdAt: now - 30_000,
            startedAt: now - 20_000,
            endedAt: now - 10_000,
            cleanupHandled: false,
            expectsCompletionMessage: true,
          },
        ],
        [
          childRunId,
          {
            runId: childRunId,
            childSessionKey: "agent:main:subagent:grandchild-1",
            requesterSessionKey: "agent:main:subagent:child-1",
            requesterDisplayKey: "agent:main:subagent:child-1",
            task: "still running",
            cleanup: "keep" as const,
            createdAt: now - 25_000,
            startedAt: now - 15_000,
            cleanupHandled: false,
          },
        ],
      ]),
    );

    registry.initSubagentRegistry();
    await flushAsyncCleanup();

    const sendCalls = callGatewayMock.mock.calls.filter(
      (call) => (call[0] as { method?: string })?.method === "send",
    );
    expect(sendCalls).toHaveLength(0);

    const runs = registry.listSubagentRunsForRequester("agent:main:main");
    const stored = runs.find((run) => run.runId === runId);
    expect(stored?.cleanupHandled).toBe(false);
    expect(stored?.cleanupCompletedAt).toBeUndefined();
  });

  test("external completion notify still sends when cleanup gives up after announce failure", async () => {
    announceFn.mockReset();
    announceFn.mockResolvedValueOnce(false);
    registry.resetSubagentRegistryForTests();

    const now = Date.now();
    const runId = "test-external-notify-give-up";
    loadSubagentRegistryFromDisk.mockReturnValue(
      new Map([
        [
          runId,
          {
            runId,
            childSessionKey: "agent:main:subagent:child-1",
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "agent:main:main",
            notifyChannel: "telegram",
            notifyTarget: "telegram:123",
            task: "give up notify",
            cleanup: "keep" as const,
            createdAt: now - 30_000,
            startedAt: now - 20_000,
            endedAt: now - 10_000,
            cleanupHandled: false,
            announceRetryCount: 2,
          },
        ],
      ]),
    );

    registry.initSubagentRegistry();
    await flushAsyncCleanup();

    const sendCall = callGatewayMock.mock.calls.find(
      (call) => (call[0] as { method?: string })?.method === "send",
    )?.[0] as { params?: { channel?: string; to?: string } } | undefined;
    expect(sendCall?.params?.channel).toBe("telegram");
    expect(sendCall?.params?.to).toBe("telegram:123");

    const runs = registry.listSubagentRunsForRequester("agent:main:main");
    const stored = runs.find((run) => run.runId === runId);
    expect(stored?.cleanupCompletedAt).toBeTypeOf("number");
  });

  test("external completion notify is skipped when announce wakes a continuation run", async () => {
    announceFn.mockReset();
    announceFn.mockImplementationOnce(async (params: unknown) => {
      (params as { onWakeContinuationStarted?: () => void }).onWakeContinuationStarted?.();
      return true;
    });
    registry.resetSubagentRegistryForTests();

    const now = Date.now();
    const runId = "test-external-notify-wake-continuation";
    loadSubagentRegistryFromDisk.mockReturnValue(
      new Map([
        [
          runId,
          {
            runId,
            childSessionKey: "agent:main:subagent:child-1",
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "agent:main:main",
            notifyChannel: "telegram",
            notifyTarget: "telegram:123",
            task: "wake continuation notify",
            cleanup: "keep" as const,
            createdAt: now - 30_000,
            startedAt: now - 20_000,
            endedAt: now - 10_000,
            cleanupHandled: false,
            expectsCompletionMessage: true,
            wakeOnDescendantSettle: true,
          },
        ],
      ]),
    );

    registry.initSubagentRegistry();
    await flushAsyncCleanup();

    const sendCalls = callGatewayMock.mock.calls.filter(
      (call) => (call[0] as { method?: string })?.method === "send",
    );
    expect(sendCalls).toHaveLength(0);

    const runs = registry.listSubagentRunsForRequester("agent:main:main");
    const stored = runs.find((run) => run.runId === runId);
    expect(stored?.cleanupCompletedAt).toBeTypeOf("number");
  });

  test("external completion notify keeps requester accountId for same-channel sends", async () => {
    announceFn.mockReset();
    announceFn.mockResolvedValueOnce(true);
    registry.resetSubagentRegistryForTests();

    const now = Date.now();
    const runId = "test-external-notify-same-channel";
    loadSubagentRegistryFromDisk.mockReturnValue(
      new Map([
        [
          runId,
          {
            runId,
            childSessionKey: "agent:main:subagent:child-1",
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "agent:main:main",
            requesterOrigin: { channel: " telegram ", accountId: " acct-main " },
            notifyChannel: "telegram",
            notifyTarget: "telegram:123",
            task: "same-channel notify",
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
    await flushAsyncCleanup();

    const sendCall = callGatewayMock.mock.calls.find(
      (call) => (call[0] as { method?: string })?.method === "send",
    )?.[0] as { params?: { accountId?: string } } | undefined;
    expect(sendCall?.params?.accountId).toBe("acct-main");
  });

  test("external completion notify drops requester accountId for cross-channel sends", async () => {
    announceFn.mockReset();
    announceFn.mockResolvedValueOnce(true);
    registry.resetSubagentRegistryForTests();

    const now = Date.now();
    const runId = "test-external-notify-cross-channel";
    loadSubagentRegistryFromDisk.mockReturnValue(
      new Map([
        [
          runId,
          {
            runId,
            childSessionKey: "agent:main:subagent:child-1",
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "agent:main:main",
            requesterOrigin: { channel: "telegram", accountId: "acct-main" },
            notifyChannel: "discord",
            notifyTarget: "channel:results",
            task: "cross-channel notify",
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
    await flushAsyncCleanup();

    const sendCall = callGatewayMock.mock.calls.find(
      (call) => (call[0] as { method?: string })?.method === "send",
    )?.[0] as { params?: { accountId?: string } } | undefined;
    expect(sendCall?.params?.accountId).toBeUndefined();
  });
});
