import { beforeEach, describe, expect, it, vi } from "vitest";

const noop = () => {};
const CHILD_SESSION_KEY = "agent:main:subagent:restore-retry";

const mocks = vi.hoisted(() => ({
  restoreSubagentRunsFromDisk: vi.fn(),
  persistSubagentRunsToDisk: vi.fn(),
  announceSpy: vi.fn(async () => true),
  onAgentEvent: vi.fn(() => noop),
  callGateway: vi.fn(async () => ({ status: "pending" })),
  loadSessionStore: vi.fn(() => ({
    [CHILD_SESSION_KEY]: {
      sessionId: "sess-restore-retry",
      updatedAt: Date.now(),
    },
  })),
}));

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthApiKey: vi.fn(async () => ({
    access: "test-token",
    expires: 0,
    provider: "",
    refresh: "",
  })),
  getOAuthProviders: vi.fn(() => []),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: vi.fn(() => ({
      agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
      session: { store: {} },
    })),
  };
});

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: mocks.loadSessionStore,
  resolveAgentIdFromSessionKey: vi.fn(() => "main"),
  resolveStorePath: vi.fn(() => "/tmp/openclaw-sessions-main.json"),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: mocks.onAgentEvent,
}));

vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: mocks.announceSpy,
  captureSubagentCompletionReply: vi.fn(async () => undefined),
}));

vi.mock("./subagent-announce-queue.js", () => ({
  resetAnnounceQueuesForTests: vi.fn(),
}));

vi.mock("./subagent-orphan-recovery.js", () => ({
  scheduleOrphanRecovery: vi.fn(),
}));

vi.mock("./subagent-registry-state.js", () => ({
  getSubagentRunsSnapshotForRead: vi.fn((runs: Map<string, unknown>) => new Map(runs)),
  persistSubagentRunsToDisk: mocks.persistSubagentRunsToDisk,
  restoreSubagentRunsFromDisk: mocks.restoreSubagentRunsFromDisk,
}));

vi.mock("./timeout.js", () => ({
  resolveAgentTimeoutMs: vi.fn(() => 1_000),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

describe("subagent registry restore retry", () => {
  let mod: typeof import("./subagent-registry.js");

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mod = await import("./subagent-registry.js");
    mod.resetSubagentRegistryForTests({ persist: false });
  });

  it("retries restore on the next init after a transient restore failure", async () => {
    mocks.restoreSubagentRunsFromDisk
      .mockImplementationOnce(({ runs }: { runs: Map<string, unknown> }) => {
        runs.set("run-partial-restore", {
          runId: "run-partial-restore",
          childSessionKey: "agent:main:subagent:partial",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "partial restore",
          cleanup: "keep",
          createdAt: Date.now() - 20,
        });
        throw new Error("transient restore failure");
      })
      .mockImplementationOnce(({ runs }: { runs: Map<string, unknown> }) => {
        expect(runs.has("run-partial-restore")).toBe(false);
        const now = Date.now();
        runs.set("run-restore-retry", {
          runId: "run-restore-retry",
          childSessionKey: CHILD_SESSION_KEY,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "restore retry",
          cleanup: "keep",
          createdAt: now - 10,
          startedAt: now - 5,
          endedAt: now - 1,
          cleanupHandled: false,
          expectsCompletionMessage: true,
        });
        return 1;
      });

    mod.initSubagentRegistry();
    await Promise.resolve();
    expect(mocks.announceSpy).not.toHaveBeenCalled();

    mod.initSubagentRegistry();
    expect(mocks.restoreSubagentRunsFromDisk).toHaveBeenCalledTimes(2);

    const restoredRuns = mod.listSubagentRunsForRequester("agent:main:main");
    expect(restoredRuns).toHaveLength(1);
    expect(restoredRuns[0]).toMatchObject({
      runId: "run-restore-retry",
      childSessionKey: CHILD_SESSION_KEY,
      requesterSessionKey: "agent:main:main",
    });
    expect(restoredRuns.some((entry) => entry.runId === "run-partial-restore")).toBe(false);

    mod.initSubagentRegistry();
    await Promise.resolve();
    expect(mocks.restoreSubagentRunsFromDisk).toHaveBeenCalledTimes(2);
  });
});
