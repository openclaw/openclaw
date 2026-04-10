import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSubagentAnnounceDeliveryRuntimeMock } from "./subagent-announce.test-support.js";

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
const readLatestAssistantReplyMock = vi.fn(
  async (_params?: unknown): Promise<string | undefined> => "raw subagent reply",
);
const isEmbeddedPiRunActiveMock = vi.fn((_sessionId: string) => false);
const queueEmbeddedPiMessageMock = vi.fn((_sessionId: string, _text: string) => false);
const waitForEmbeddedPiRunEndMock = vi.fn(async (_sessionId: string, _timeoutMs?: number) => true);
let mockConfig: ReturnType<(typeof import("../config/config.js"))["loadConfig"]> = {
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

vi.mock("./subagent-announce.runtime.js", () => ({
  callGateway: (request: unknown) => callGatewayMock(request),
  isEmbeddedPiRunActive: (sessionId: string) => isEmbeddedPiRunActiveMock(sessionId),
  loadConfig: () => mockConfig,
  loadSessionStore: (storePath: string) => loadSessionStoreMock(storePath),
  queueEmbeddedPiMessage: (sessionId: string, text: string) =>
    queueEmbeddedPiMessageMock(sessionId, text),
  resolveAgentIdFromSessionKey: (sessionKey: string) =>
    resolveAgentIdFromSessionKeyMock(sessionKey),
  resolveMainSessionKey: (cfg: unknown) => resolveMainSessionKeyMock(cfg),
  resolveStorePath: (store: unknown, options: unknown) => resolveStorePathMock(store, options),
  waitForEmbeddedPiRunEnd: (sessionId: string, timeoutMs?: number) =>
    waitForEmbeddedPiRunEndMock(sessionId, timeoutMs),
}));

vi.mock("./tools/agent-step.js", () => ({
  readLatestAssistantReply: (params?: unknown) => readLatestAssistantReplyMock(params),
}));

vi.mock("./subagent-announce-delivery.runtime.js", () =>
  createSubagentAnnounceDeliveryRuntimeMock({
    callGateway: (request: unknown) => callGatewayMock(request),
    loadConfig: () => mockConfig,
    loadSessionStore: (storePath: string) => loadSessionStoreMock(storePath),
    resolveAgentIdFromSessionKey: (sessionKey: string) =>
      resolveAgentIdFromSessionKeyMock(sessionKey),
    resolveMainSessionKey: (cfg: unknown) => resolveMainSessionKeyMock(cfg),
    resolveStorePath: (store: unknown, options: unknown) => resolveStorePathMock(store, options),
    isEmbeddedPiRunActive: (sessionId: string) => isEmbeddedPiRunActiveMock(sessionId),
    queueEmbeddedPiMessage: (sessionId: string, text: string) =>
      queueEmbeddedPiMessageMock(sessionId, text),
  }),
);

vi.mock("./subagent-announce-delivery.js", () => ({
  deliverSubagentAnnouncement: async (params: {
    targetRequesterSessionKey: string;
    triggerMessage: string;
    requesterIsSubagent?: boolean;
    requesterOrigin?: { channel?: string; to?: string; accountId?: string; threadId?: string };
    completionDirectOrigin?: {
      channel?: string;
      to?: string;
      accountId?: string;
      threadId?: string;
    };
    directOrigin?: { channel?: string; to?: string; accountId?: string; threadId?: string };
    requesterSessionOrigin?: { provider?: string; channel?: string };
    bestEffortDeliver?: boolean;
  }) => {
    const store = loadSessionStoreMock("/tmp/sessions.json") as Record<string, unknown>;
    const requesterEntry = (store?.[params.targetRequesterSessionKey] ?? {}) as
      | { sessionId?: string; origin?: { provider?: string; channel?: string } }
      | undefined;
    const sessionId = requesterEntry?.sessionId?.trim();
    const queueChannel =
      requesterEntry?.origin?.provider ??
      requesterEntry?.origin?.channel ??
      params.requesterSessionOrigin?.provider ??
      params.requesterSessionOrigin?.channel;

    if (sessionId && queueChannel === "discord" && isEmbeddedPiRunActiveMock(sessionId)) {
      queueEmbeddedPiMessageMock(
        sessionId,
        `[Internal task completion event]\n${params.triggerMessage}`,
      );
      return { delivered: true, path: "queue" };
    }

    const effectiveOrigin =
      params.completionDirectOrigin ?? params.requesterOrigin ?? params.directOrigin;

    await callGatewayMock({
      method: "agent",
      params: {
        sessionKey: params.targetRequesterSessionKey,
        message: params.triggerMessage,
        deliver:
          !params.requesterIsSubagent &&
          effectiveOrigin?.channel !== "webchat" &&
          Boolean(effectiveOrigin?.channel && effectiveOrigin?.to),
        bestEffortDeliver: params.bestEffortDeliver,
        ...(params.requesterIsSubagent
          ? {}
          : {
              channel: effectiveOrigin?.channel,
              to: effectiveOrigin?.to,
              accountId: effectiveOrigin?.accountId,
              threadId: effectiveOrigin?.threadId,
            }),
      },
    });

    return { delivered: true, path: "direct" };
  },
  loadRequesterSessionEntry: (sessionKey: string) => {
    const store = loadSessionStoreMock("/tmp/sessions.json") as Record<string, unknown>;
    const entry = store?.[sessionKey];
    return { entry };
  },
  loadSessionEntryByKey: (sessionKey: string) => {
    const store = loadSessionStoreMock("/tmp/sessions.json") as Record<string, unknown>;
    return store?.[sessionKey] ?? { sessionId: sessionKey };
  },
  resolveAnnounceOrigin: (
    entry:
      | {
          lastChannel?: string;
          lastTo?: string;
          lastAccountId?: string;
          lastThreadId?: string;
          origin?: { provider?: string; channel?: string; accountId?: string };
        }
      | undefined,
    requesterOrigin?: { channel?: string; to?: string; accountId?: string; threadId?: string },
  ) => ({
    channel:
      requesterOrigin?.channel ??
      entry?.lastChannel ??
      entry?.origin?.provider ??
      entry?.origin?.channel,
    to: requesterOrigin?.to ?? entry?.lastTo,
    accountId: requesterOrigin?.accountId ?? entry?.lastAccountId ?? entry?.origin?.accountId,
    threadId: requesterOrigin?.threadId ?? entry?.lastThreadId,
  }),
  resolveSubagentCompletionOrigin: async (params: { requesterOrigin?: unknown }) =>
    params.requesterOrigin,
  resolveSubagentAnnounceTimeoutMs: () => 10_000,
  runAnnounceDeliveryWithRetry: async <T>(params: { run: () => Promise<T> }) => await params.run(),
}));

vi.mock("./subagent-announce.registry.runtime.js", () => subagentRegistryRuntimeMock);
import { runSubagentAnnounceFlow } from "./subagent-announce.js";

describe("subagent announce seam flow", () => {
  beforeEach(() => {
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

  it("keeps completion direct announce session-only when requester origin is webchat", async () => {
    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:webchat",
      childRunId: "run-webchat-direct-announce",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: {
        channel: "webchat",
        to: "chat:123",
        accountId: "default",
      },
      task: "deliver completion",
      timeoutMs: 10,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done",
      expectsCompletionMessage: true,
      bestEffortDeliver: true,
    });

    expect(didAnnounce).toBe(true);
    expect(agentSpy).toHaveBeenCalledTimes(1);
    expect(agentSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "agent",
        params: expect.objectContaining({
          sessionKey: "agent:main:main",
          deliver: false,
          bestEffortDeliver: true,
          accountId: "default",
        }),
      }),
    );
  });

  it("keeps nested subagent completion announces channel-less in session-only mode", async () => {
    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-nested-subagent-direct-announce",
      requesterSessionKey: "agent:main:subagent:orchestrator",
      requesterDisplayKey: "orchestrator",
      requesterOrigin: {
        channel: "telegram",
        to: "-100123",
        accountId: "default",
      },
      task: "deliver nested completion",
      timeoutMs: 10,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done",
      expectsCompletionMessage: true,
      bestEffortDeliver: true,
    });

    expect(didAnnounce).toBe(true);
    expect(agentSpy).toHaveBeenCalledTimes(1);
    const call = agentSpy.mock.calls[0]?.[0];
    const params = call?.params ?? {};
    expect(params.sessionKey).toBe("agent:main:subagent:orchestrator");
    expect(params.deliver).toBe(false);
    expect(params.bestEffortDeliver).toBe(true);
    expect(params.channel).toBeUndefined();
    expect(params.to).toBeUndefined();
    expect(params.accountId).toBeUndefined();
    expect(params.threadId).toBeUndefined();
  });

  it("falls back to stored delivery target when mocked completion origins omit to", async () => {
    loadSessionStoreMock.mockImplementation(() => ({
      "agent:main:main": {
        sessionId: "session-tg-group",
        updatedAt: Date.now(),
        lastChannel: "telegram",
        lastTo: "-1001234567890",
        lastAccountId: "bot:123",
      },
    }));

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:tg",
      childRunId: "run-tg-group-completion",
      requesterSessionKey: "agent:main:main",
      requesterOrigin: { channel: "telegram" },
      requesterDisplayKey: "main",
      task: "telegram group task",
      timeoutMs: 10,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "task done",
      expectsCompletionMessage: true,
    });

    expect(didAnnounce).toBe(true);
    expect(agentSpy).toHaveBeenCalledTimes(1);
    const agentCall = agentSpy.mock.calls[0]?.[0];
    expect(agentCall?.params).toEqual(
      expect.objectContaining({
        deliver: true,
        channel: "telegram",
        accountId: "bot:123",
        to: "-1001234567890",
      }),
    );
  });

  it("prefers live completion output over cached interim chatter for completion delivery", async () => {
    readLatestAssistantReplyMock.mockResolvedValue(
      "Permanent omnichannel ACP fix applied and verified.",
    );

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:acp",
      childRunId: "run-live-output-wins",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "deliver final completion",
      timeoutMs: 10,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply:
        "I don't have prior context about which four files or what changes are needed.",
      expectsCompletionMessage: true,
    });

    expect(didAnnounce).toBe(true);
    const agentCall = agentSpy.mock.calls[0]?.[0] as {
      params?: {
        message?: string;
      };
    };
    expect(agentCall?.params?.message).toContain(
      "Use the structured internal completion event attached to this turn as the authoritative source.",
    );
    expect(agentCall?.params?.message).toContain(
      "Permanent omnichannel ACP fix applied and verified.",
    );
    expect(agentCall?.params?.message).not.toContain(
      "I don't have prior context about which four files or what changes are needed.",
    );
  });

  it("does not reuse cached interim chatter when no live completion output exists", async () => {
    callGatewayMock.mockImplementation(async (req: unknown) => {
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
    readLatestAssistantReplyMock.mockResolvedValue(undefined);

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:acp-empty",
      childRunId: "run-no-live-output",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "deliver final completion",
      timeoutMs: 10,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "Let me read the source files first.",
      expectsCompletionMessage: true,
    });

    expect(didAnnounce).toBe(true);
    const agentCall = agentSpy.mock.calls[0]?.[0] as {
      params?: {
        message?: string;
      };
    };
    expect(agentCall?.params?.message).toContain(
      "Use the structured internal completion event attached to this turn as the authoritative source.",
    );
    expect(agentCall?.params?.message).toContain("(no output)");
    expect(agentCall?.params?.message).not.toContain("Let me read the source files first.");
  });
});
