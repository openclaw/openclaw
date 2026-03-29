import { beforeEach, describe, expect, it, vi } from "vitest";

type AgentCallRequest = { method?: string; params?: Record<string, unknown> };

const agentSpy = vi.fn(async (_req: AgentCallRequest) => ({ runId: "run-main", status: "ok" }));
const sessionsDeleteSpy = vi.fn((_req: AgentCallRequest) => undefined);
const callGatewayMock = vi.fn(async (_request: unknown) => ({}));
const loadSessionStoreMock = vi.fn((_storePath: string) => ({}));
const resolveAgentIdFromSessionKeyMock = vi.fn((sessionKey: string) => {
  return sessionKey.match(/^agent:([^:]+)/)?.[1] ?? "main";
});
const resolveStorePathMock = vi.fn((_store: unknown, _options: unknown) => "/tmp/sessions.json");
const resolveMainSessionKeyMock = vi.fn((_cfg: unknown) => "agent:main:main");
const readLatestAssistantReplyMock = vi.fn(async (_params?: unknown) => "raw subagent reply");
const isEmbeddedPiRunActiveMock = vi.fn((_sessionId: string) => false);
const queueEmbeddedPiMessageMock = vi.fn((_sessionId: string, _text: string) => false);
const waitForEmbeddedPiRunEndMock = vi.fn(async (_sessionId: string, _timeoutMs?: number) => true);
let mockConfig: Record<string, unknown> = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
};

const { subagentRegistryRuntimeMock } = vi.hoisted(() => ({
  subagentRegistryRuntimeMock: {
    shouldIgnorePostCompletionAnnounceForSession: vi.fn(() => false),
    isSubagentSessionRunActive: vi.fn(() => true),
    countActiveDescendantRuns: vi.fn(() => 0),
    countPendingDescendantRuns: vi.fn(() => 0),
    countPendingDescendantRunsExcludingRun: vi.fn(() => 0),
    listSubagentRunsForRequester: vi.fn(() => []),
    replaceSubagentRunAfterSteer: vi.fn(() => true),
    resolveRequesterForChildSession: vi.fn(() => null),
  },
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => mockConfig,
  };
});

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: (storePath: string) => loadSessionStoreMock(storePath),
  resolveAgentIdFromSessionKey: (sessionKey: string) =>
    resolveAgentIdFromSessionKeyMock(sessionKey),
  resolveMainSessionKey: (cfg: unknown) => resolveMainSessionKeyMock(cfg),
  resolveStorePath: (store: unknown, options: unknown) => resolveStorePathMock(store, options),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: (request: unknown) => callGatewayMock(request),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({ hasHooks: () => false }),
}));

vi.mock("./pi-embedded.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pi-embedded.js")>();
  return {
    ...actual,
    isEmbeddedPiRunActive: (sessionId: string) => isEmbeddedPiRunActiveMock(sessionId),
    queueEmbeddedPiMessage: (sessionId: string, text: string) =>
      queueEmbeddedPiMessageMock(sessionId, text),
    waitForEmbeddedPiRunEnd: (sessionId: string, timeoutMs?: number) =>
      waitForEmbeddedPiRunEndMock(sessionId, timeoutMs),
  };
});

vi.mock("./tools/agent-step.js", () => ({
  readLatestAssistantReply: (params?: unknown) => readLatestAssistantReplyMock(params),
}));

vi.mock("./subagent-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent-registry.js")>();
  return {
    ...actual,
    ...subagentRegistryRuntimeMock,
  };
});
vi.mock("./subagent-registry-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent-registry-runtime.js")>();
  return {
    ...actual,
    ...subagentRegistryRuntimeMock,
  };
});

describe("subagent announce seam flow", () => {
  let runSubagentAnnounceFlow: (typeof import("./subagent-announce.js"))["runSubagentAnnounceFlow"];

  beforeEach(() => {
    vi.resetModules();
    agentSpy.mockClear();
    sessionsDeleteSpy.mockClear();
    callGatewayMock.mockReset().mockImplementation(async (req: unknown) => {
      const typed = req as AgentCallRequest;
      if (typed.method === "agent") {
        return await agentSpy(typed);
      }
      if (typed.method === "agent.wait") {
        return { status: "ok", startedAt: 10, endedAt: 20 };
      }
      if (typed.method === "chat.history") {
        return { messages: [] as Array<unknown> };
      }
      if (typed.method === "sessions.patch") {
        return {};
      }
      if (typed.method === "sessions.delete") {
        sessionsDeleteSpy(typed);
        return {};
      }
      return {};
    });
    loadSessionStoreMock.mockReset().mockImplementation(() => ({}));
    resolveAgentIdFromSessionKeyMock.mockReset().mockImplementation(() => "main");
    resolveStorePathMock.mockReset().mockImplementation(() => "/tmp/sessions.json");
    resolveMainSessionKeyMock.mockReset().mockImplementation(() => "agent:main:main");
    readLatestAssistantReplyMock.mockReset().mockResolvedValue("raw subagent reply");
    isEmbeddedPiRunActiveMock.mockReset().mockReturnValue(false);
    queueEmbeddedPiMessageMock.mockReset().mockReturnValue(false);
    waitForEmbeddedPiRunEndMock.mockReset().mockResolvedValue(true);
    mockConfig = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    };
    subagentRegistryRuntimeMock.shouldIgnorePostCompletionAnnounceForSession.mockReset();
    subagentRegistryRuntimeMock.shouldIgnorePostCompletionAnnounceForSession.mockReturnValue(false);
    subagentRegistryRuntimeMock.isSubagentSessionRunActive.mockReset();
    subagentRegistryRuntimeMock.isSubagentSessionRunActive.mockReturnValue(true);
    subagentRegistryRuntimeMock.countActiveDescendantRuns.mockReset();
    subagentRegistryRuntimeMock.countActiveDescendantRuns.mockReturnValue(0);
    subagentRegistryRuntimeMock.countPendingDescendantRuns.mockReset();
    subagentRegistryRuntimeMock.countPendingDescendantRuns.mockReturnValue(0);
    subagentRegistryRuntimeMock.countPendingDescendantRunsExcludingRun.mockReset();
    subagentRegistryRuntimeMock.countPendingDescendantRunsExcludingRun.mockReturnValue(0);
    subagentRegistryRuntimeMock.listSubagentRunsForRequester.mockReset();
    subagentRegistryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([]);
    subagentRegistryRuntimeMock.replaceSubagentRunAfterSteer.mockReset();
    subagentRegistryRuntimeMock.replaceSubagentRunAfterSteer.mockReturnValue(true);
    subagentRegistryRuntimeMock.resolveRequesterForChildSession.mockReset();
    subagentRegistryRuntimeMock.resolveRequesterForChildSession.mockReturnValue(null);
  });

  it("suppresses ANNOUNCE_SKIP delivery while still deleting the child session", async () => {
    ({ runSubagentAnnounceFlow } = await import("./subagent-announce.js"));
    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-direct-skip-whitespace",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      timeoutMs: 10,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "  ANNOUNCE_SKIP  ",
    });

    expect(didAnnounce).toBe(true);
    expect(agentSpy).not.toHaveBeenCalled();
    expect(sessionsDeleteSpy).toHaveBeenCalledTimes(1);
    expect(sessionsDeleteSpy).toHaveBeenCalledWith({
      method: "sessions.delete",
      params: {
        key: "agent:main:subagent:test",
        deleteTranscript: true,
        emitLifecycleHooks: false,
      },
      timeoutMs: 10_000,
    });
  });

  it("keeps lifecycle hooks enabled when deleting a completed session-mode child session", async () => {
    ({ runSubagentAnnounceFlow } = await import("./subagent-announce.js"));
    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-session-delete-cleanup",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "thread-bound cleanup",
      timeoutMs: 10,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "completed",
      spawnMode: "session",
      expectsCompletionMessage: true,
    });

    expect(didAnnounce).toBe(true);
    expect(sessionsDeleteSpy).toHaveBeenCalledTimes(1);
    expect(sessionsDeleteSpy).toHaveBeenCalledWith({
      method: "sessions.delete",
      params: {
        key: "agent:main:subagent:test",
        deleteTranscript: true,
        emitLifecycleHooks: true,
      },
      timeoutMs: 10_000,
    });
  });

  it("uses origin.provider for channel-specific queue settings in active announce delivery", async () => {
    mockConfig = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      messages: {
        queue: {
          byChannel: {
            discord: "steer",
          },
        },
      },
    };
    loadSessionStoreMock.mockImplementation(() => ({
      "agent:main:main": {
        sessionId: "session-origin-provider-steer",
        updatedAt: Date.now(),
        origin: { provider: "discord" },
      },
    }));
    isEmbeddedPiRunActiveMock.mockReturnValue(true);
    queueEmbeddedPiMessageMock.mockReturnValue(true);

    ({ runSubagentAnnounceFlow } = await import("./subagent-announce.js"));
    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-origin-provider-steer",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      timeoutMs: 10,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
    });

    expect(didAnnounce).toBe(true);
    expect(queueEmbeddedPiMessageMock).toHaveBeenCalledWith(
      "session-origin-provider-steer",
      expect.stringContaining("[Internal task completion event]"),
    );
    expect(agentSpy).not.toHaveBeenCalled();
  });
});
