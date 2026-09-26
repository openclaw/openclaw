// Subagent announce flow tests cover the seam-level orchestration between wait
// outcomes, requester lookup, delivery, and cleanup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeSessionDeliveryState } from "../../../utils/delivery-context.shared.js";
import type { EmbeddedAgentQueueMessageOutcome } from "../../embedded-agent-runner/runs.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { createSubagentAnnounceDeliveryRuntimeMock } from "./subagent-announce.test-support.js";

type AgentCallRequest = { method?: string; params?: Record<string, unknown> };
type AgentCallResponse = {
  runId?: string;
  status: string;
  error?: string;
  disposition?: "ambiguous";
};

const agentSpy = vi.fn(async (_req: AgentCallRequest): Promise<AgentCallResponse> => ({
  runId: "run-main",
  status: "ok",
}));
const sessionsDeleteSpy = vi.fn((_req: AgentCallRequest) => undefined);
const callGatewayMock = vi.fn(async (_request: unknown) => ({}));
const loadSessionStoreMock = vi.fn((_storePath: string) => ({}));
const resolveAgentIdFromSessionKeyMock = vi.fn<
  typeof import("./subagent-announce.runtime.js").resolveAgentIdFromSessionKey
>((sessionKey, configuredDefaultAgentId) => {
  return sessionKey?.match(/^agent:([^:]+)/)?.[1] ?? configuredDefaultAgentId ?? "main";
});
const resolveStorePathMock = vi.fn((_store: unknown, _options: unknown) => "/tmp/sessions.json");
const resolveMainSessionKeyMock = vi.fn((_cfg: unknown) => "agent:main:main");
const isEmbeddedAgentRunActiveMock = vi.fn((_sessionId: string) => false);
const queueEmbeddedAgentMessageWithOutcomeMock = vi.fn(
  (sessionId: string, _text: string, _options?: unknown): EmbeddedAgentQueueMessageOutcome => ({
    queued: false,
    sessionId,
    reason: "not_streaming" as const,
    gatewayHealth: "live" as const,
  }),
);
const waitForEmbeddedAgentRunEndMock = vi.fn(
  async (_sessionId: string, _timeoutMs?: number) => true,
);
let mockConfig: ReturnType<(typeof import("../../../config/config.js"))["getRuntimeConfig"]> = {
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
    hasDescendantRunAwaitingSettle: vi.fn(() => false),
    getLatestSubagentRunByChildSessionKey: vi.fn(() => undefined),
    listSubagentRunsForRequester: vi.fn<() => SubagentRunRecord[]>(() => []),
    replaceSubagentRunAfterSteer: vi.fn(() => true),
    resolveRequesterForChildSession: vi.fn(() => null),
  },
}));

vi.mock("./subagent-announce.runtime.js", () => ({
  callSubagentLifecycleGateway: (request: unknown) => callGatewayMock(request),
  dispatchGatewayMethodInProcess: (
    method: string,
    params: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ) => callGatewayMock({ method, params, timeoutMs: options?.timeoutMs }),
  isEmbeddedAgentRunActive: (sessionId: string) => isEmbeddedAgentRunActiveMock(sessionId),
  getRuntimeConfig: () => mockConfig,
  loadSessionStore: (storePath: string) => loadSessionStoreMock(storePath),
  readSessionMessagesAsync: vi.fn(async () => []),
  readSubagentSessionEntry: (storePath: string, sessionKey: string) =>
    (loadSessionStoreMock(storePath) as Record<string, unknown>)[sessionKey],
  resolveAgentIdFromSessionKey: (sessionKey: string) =>
    resolveAgentIdFromSessionKeyMock(sessionKey),
  resolveMainSessionKey: (cfg: unknown) => resolveMainSessionKeyMock(cfg),
  resolveSessionStorePathCore: (store: unknown, options: unknown) =>
    resolveStorePathMock(store, options),
  waitForEmbeddedAgentRunEnd: (sessionId: string, timeoutMs?: number) =>
    waitForEmbeddedAgentRunEndMock(sessionId, timeoutMs),
}));

vi.mock("./subagent-announce-delivery.runtime.js", () =>
  createSubagentAnnounceDeliveryRuntimeMock({
    callGateway: (request: unknown) => callGatewayMock(request),
    getRuntimeConfig: () => mockConfig,
    loadSessionStore: (storePath: string) => loadSessionStoreMock(storePath),
    resolveAgentIdFromSessionKey: (sessionKey: string) =>
      resolveAgentIdFromSessionKeyMock(sessionKey),
    resolveMainSessionKey: (cfg: unknown) => resolveMainSessionKeyMock(cfg),
    resolveSessionStorePathCore: (store: unknown, options: unknown) =>
      resolveStorePathMock(store, options),
    isEmbeddedAgentRunActive: (sessionId: string) => isEmbeddedAgentRunActiveMock(sessionId),
    queueEmbeddedAgentMessageWithOutcome: (sessionId: string, text: string, options?: unknown) =>
      queueEmbeddedAgentMessageWithOutcomeMock(sessionId, text, options),
  }),
);

vi.mock("./subagent-announce-delivery.js", () => ({
  deliverSubagentAnnouncement: async (params: {
    targetRequesterSessionKey: string;
    triggerMessage: string;
    requesterIsSubagent?: boolean;
    completionDirectOrigin?: {
      channel?: string;
      to?: string;
      accountId?: string;
      threadId?: string;
    };
    directOrigin?: { channel?: string; to?: string; accountId?: string; threadId?: string };
    requesterSessionOrigin?: { provider?: string; channel?: string };
    bestEffortDeliver?: boolean;
    isSourceSessionEffectsAllowed?: () => boolean;
  }) => {
    if (params.isSourceSessionEffectsAllowed?.() === false) {
      return {
        delivered: false,
        path: "none",
        reason: "source_owner_changed",
        terminal: true,
        disposition: "intentional_non_delivery",
      };
    }
    const effectiveOrigin = params.completionDirectOrigin ?? params.directOrigin;

    const response = (await callGatewayMock({
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
    })) as { status?: string; error?: string; disposition?: "ambiguous" };

    if (response.status === "error") {
      return {
        delivered: false,
        path: "direct",
        error: response.error ?? "agent delivery failed",
        ...(response.disposition ? { disposition: response.disposition } : {}),
      };
    }

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

vi.mock("../registry/subagent-registry-read.js", () => subagentRegistryRuntimeMock);
vi.mock("../registry/subagent-registry-runtime.js", () => subagentRegistryRuntimeMock);
import { defaultRuntime } from "../../../runtime.js";
import { applySubagentWaitOutcome } from "./subagent-announce-output.js";
import { testing as outputTesting } from "./subagent-announce-output.test-support.js";
import { runSubagentAnnounceFlow } from "./subagent-announce.js";

function requireAgentCall() {
  const call = agentSpy.mock.calls[0]?.[0];
  if (!call) {
    throw new Error("expected agent call");
  }
  return call;
}

describe("subagent wait outcome timing", () => {
  it.each([
    { wait: { status: "ok" }, expected: { status: "ok" } },
    { wait: { status: "timeout" }, expected: { status: "timeout" } },
    {
      wait: { status: "error", error: "boom" },
      expected: { status: "error", error: "boom" },
    },
  ] as const)("adds timing to $wait.status outcomes", ({ wait, expected }) => {
    const result = applySubagentWaitOutcome({
      wait,
      outcome: undefined,
      startedAt: 1_000,
      endedAt: 1_250,
    });

    expect(result.outcome).toEqual({
      ...expected,
      startedAt: 1_000,
      endedAt: 1_250,
      elapsedMs: 250,
    });
  });
});

function runAnnounceFlow(overrides: Partial<Parameters<typeof runSubagentAnnounceFlow>[0]>) {
  return runSubagentAnnounceFlow({
    childSessionKey: "agent:main:subagent:test",
    childRunId: "run-test",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "do thing",
    timeoutMs: 10,
    cleanup: "keep",
    waitForCompletion: false,
    outcome: { status: "ok" },
    ...overrides,
  });
}

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
    isEmbeddedAgentRunActiveMock.mockReset().mockReturnValue(false);
    queueEmbeddedAgentMessageWithOutcomeMock
      .mockReset()
      .mockImplementation((sessionId: string) => ({
        queued: false,
        sessionId,
        reason: "not_streaming",
        gatewayHealth: "live",
      }));
    waitForEmbeddedAgentRunEndMock.mockReset().mockResolvedValue(true);
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
    subagentRegistryRuntimeMock.hasDescendantRunAwaitingSettle.mockReset();
    subagentRegistryRuntimeMock.hasDescendantRunAwaitingSettle.mockReturnValue(false);
    subagentRegistryRuntimeMock.listSubagentRunsForRequester.mockReset();
    subagentRegistryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([]);
    subagentRegistryRuntimeMock.replaceSubagentRunAfterSteer.mockReset();
    subagentRegistryRuntimeMock.replaceSubagentRunAfterSteer.mockReturnValue(true);
    subagentRegistryRuntimeMock.resolveRequesterForChildSession.mockReset();
    subagentRegistryRuntimeMock.resolveRequesterForChildSession.mockReturnValue(null);
    outputTesting.setDepsForTest({
      callGateway:
        callGatewayMock as typeof import("./subagent-announce.runtime.js").callSubagentLifecycleGateway,
      getRuntimeConfig: () => mockConfig,
      readSubagentSessionEntry: (storePath, sessionKey) =>
        (
          loadSessionStoreMock(storePath) as Record<
            string,
            ReturnType<typeof import("./subagent-announce.runtime.js").readSubagentSessionEntry>
          >
        )[sessionKey],
      readSessionMessagesAsync: async () => [],
      resolveAgentIdFromSessionKey: resolveAgentIdFromSessionKeyMock,
      resolveSessionStorePathCore: resolveStorePathMock,
    });
  });

  afterEach(() => {
    outputTesting.setDepsForTest();
  });

  it.each([false, true])(
    "keeps the parent's authored result for public and private grandchildren: private=%s",
    async (privateChild) => {
      const parentKey = "agent:main:subagent:parent";
      subagentRegistryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
        {
          runId: "grandchild-run",
          childSessionKey: "agent:main:subagent:grandchild",
          requesterSessionKey: parentKey,
          requesterDisplayKey: parentKey,
          task: "grandchild work",
          cleanup: "keep",
          createdAt: 1,
          execution: { status: "terminal", endedAt: 2, outcome: { status: "ok" } },
          completion: { required: true, resultText: "raw grandchild marker" },
          delivery: { status: "delivered" },
          ...(privateChild
            ? { completionTarget: "parent" as const, completionRequesterSessionId: "parent-id" }
            : {}),
        },
      ]);
      expect(
        await runSubagentAnnounceFlow({
          childSessionKey: parentKey,
          childRunId: "parent-run",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "parent work",
          timeoutMs: 10,
          cleanup: "keep",
          waitForCompletion: false,
          outcome: { status: "ok" },
          expectsCompletionMessage: true,
          terminalReply: { disposition: "visible", text: "parent reviewed and approved" },
        }),
      ).toBe("delivered");
      const message = String(requireAgentCall().params?.message);
      expect(message).toContain("parent reviewed and approved");
      expect(message).not.toContain("raw grandchild marker");
    },
  );

  it("suppresses ANNOUNCE_SKIP delivery while still deleting the child session", async () => {
    loadSessionStoreMock.mockReturnValue({
      "agent:main:subagent:test": {
        sessionId: "child-session-id",
        lifecycleRevision: "child-lifecycle-revision",
      },
    });
    const didAnnounce = await runAnnounceFlow({
      startedAt: 10,
      endedAt: 20,
      childRunId: "run-direct-skip-whitespace",
      cleanup: "delete",
      roundOneReply: "  ANNOUNCE_SKIP  ",
    });

    expect(didAnnounce).toBe("delivered");
    expect(agentSpy).not.toHaveBeenCalled();
    expect(sessionsDeleteSpy).toHaveBeenCalledTimes(1);
    expect(sessionsDeleteSpy).toHaveBeenCalledWith({
      method: "sessions.delete",
      params: {
        key: "agent:main:subagent:test",
        deleteTranscript: true,
        emitLifecycleHooks: false,
        expectedSessionId: "child-session-id",
        expectedLifecycleRevision: "child-lifecycle-revision",
      },
      timeoutMs: 10_000,
      assertDispatchCurrent: expect.any(Function),
    });
  });

  it("skips delete cleanup when the lifecycle owner invalidates the attempt", async () => {
    const didAnnounce = await runAnnounceFlow({
      childRunId: "run-invalidated-delete",
      cleanup: "delete",
      roundOneReply: "ANNOUNCE_SKIP",
      onBeforeDeleteChildSession: () => false,
    });

    expect(didAnnounce).toBe("delivered");
    expect(sessionsDeleteSpy).not.toHaveBeenCalled();
  });

  it("delivers frozen terminal facts while child-session effects stay suppressed", async () => {
    const didAnnounce = await runAnnounceFlow({
      childSessionKey: "agent:main:subagent:retired",
      childRunId: "run-retired-recovery",
      task: "recover interrupted work",
      cleanup: "delete",
      outcome: { status: "error", error: "interrupted by restart" },
      roundOneReply: "frozen terminal result",
      suppressChildSessionEffects: true,
      isChildSessionEffectsAllowed: () => false,
      isCompletionDeliveryAllowed: () => true,
    });

    expect(didAnnounce).toBe("delivered");
    expect(agentSpy).toHaveBeenCalledTimes(1);
    expect(sessionsDeleteSpy).not.toHaveBeenCalled();
  });

  it("drops requester delivery after the cleanup owner changes", async () => {
    const didAnnounce = await runAnnounceFlow({
      childSessionKey: "agent:main:subagent:retired",
      childRunId: "run-retired-owner",
      task: "recover interrupted work",
      outcome: { status: "error", error: "interrupted by restart" },
      roundOneReply: "stale frozen terminal result",
      suppressChildSessionEffects: true,
      isCompletionDeliveryAllowed: () => false,
    });

    expect(didAnnounce).toBe("intentional_non_delivery");
    expect(agentSpy).not.toHaveBeenCalled();
  });

  it.each(["ok", "error"] as const)(
    "keeps private retry input stable when late usage arrives after %s",
    async (status) => {
      let usage: Record<string, number> = {};
      loadSessionStoreMock.mockImplementation(() => ({
        "agent:main:main": { sessionId: "private-parent" },
        "agent:main:subagent:private": { sessionId: "private-child", ...usage },
      }));
      agentSpy.mockResolvedValueOnce({ status }).mockResolvedValueOnce({ status: "ok" });
      const params = {
        childSessionKey: "agent:main:subagent:private",
        childRunId: "private-stable-run",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        completionTarget: "parent" as const,
        completionRequesterSessionId: "private-parent",
        task: "private task",
        timeoutMs: 10,
        cleanup: "keep" as const,
        waitForCompletion: false,
        outcome: { status: "ok" as const },
        roundOneReply: "private child result",
        expectsCompletionMessage: true,
        startedAt: 10,
        endedAt: 20,
      };
      await runSubagentAnnounceFlow(params);
      usage = { inputTokens: 100, outputTokens: 20 };
      await runSubagentAnnounceFlow(params);
      expect(agentSpy).toHaveBeenCalledTimes(2);
      const first = agentSpy.mock.calls[0]?.[0].params?.message;
      expect(first).toContain("private child result");
      expect(first).not.toContain("Stats:");
      expect(agentSpy.mock.calls[1]?.[0].params?.message).toBe(first);
    },
  );

  it("warns when ANNOUNCE_SKIP suppresses a cron job completion", async () => {
    const logSpy = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});

    const didAnnounce = await runAnnounceFlow({
      startedAt: 10,
      endedAt: 20,
      childSessionKey: "agent:main:subagent:cron-worker",
      childRunId: "run-cron-announce-skip",
      requesterSessionKey: "agent:main:cron:daily-report",
      requesterDisplayKey: "cron:daily-report",
      task: "cron job",
      roundOneReply: "ANNOUNCE_SKIP",
    });

    expect(didAnnounce).toBe("delivered");
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("cron job completion for session=agent:main:cron:daily-report"),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("suppressed by ANNOUNCE_SKIP"));
    logSpy.mockRestore();
  });

  it("does not warn when fallback reply is delivered for a cron ANNOUNCE_SKIP", async () => {
    const logSpy = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});

    const didAnnounce = await runAnnounceFlow({
      startedAt: 10,
      endedAt: 20,
      childSessionKey: "agent:main:subagent:cron-worker",
      childRunId: "run-cron-announce-skip-fallback",
      requesterSessionKey: "agent:main:cron:daily-report",
      requesterDisplayKey: "cron:daily-report",
      task: "cron job",
      roundOneReply: "ANNOUNCE_SKIP",
      fallbackReply: "an actual fallback result",
    });

    expect(didAnnounce).toBe("delivered");
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("keeps lifecycle hooks enabled when deleting a completed session-mode child session", async () => {
    loadSessionStoreMock.mockReturnValue({
      "agent:main:subagent:test": {
        sessionId: "child-session-id",
        lifecycleRevision: "child-lifecycle-revision",
      },
    });
    const didAnnounce = await runAnnounceFlow({
      startedAt: 10,
      endedAt: 20,
      childRunId: "run-session-delete-cleanup",
      task: "thread-bound cleanup",
      cleanup: "delete",
      roundOneReply: "completed",
      spawnMode: "session",
      expectsCompletionMessage: true,
    });

    expect(didAnnounce).toBe("delivered");
    expect(sessionsDeleteSpy).toHaveBeenCalledTimes(1);
    expect(sessionsDeleteSpy).toHaveBeenCalledWith({
      method: "sessions.delete",
      params: {
        key: "agent:main:subagent:test",
        deleteTranscript: true,
        emitLifecycleHooks: true,
        expectedSessionId: "child-session-id",
        expectedLifecycleRevision: "child-lifecycle-revision",
      },
      timeoutMs: 10_000,
      assertDispatchCurrent: expect.any(Function),
    });
  });

  it("uses the stored canonical delivery target when mocked completion origins omit to", async () => {
    loadSessionStoreMock.mockImplementation(() => ({
      "agent:main:main": {
        sessionId: "session-tg-group",
        updatedAt: Date.now(),
        delivery: normalizeSessionDeliveryState({
          context: {
            channel: "telegram",
            to: "-1001234567890",
            accountId: "bot:123",
          },
        }),
      },
    }));

    const didAnnounce = await runAnnounceFlow({
      startedAt: 10,
      endedAt: 20,
      childSessionKey: "agent:main:subagent:tg",
      childRunId: "run-tg-group-completion",
      requesterOrigin: { channel: "telegram" },
      task: "telegram group task",
      roundOneReply: "task done",
      expectsCompletionMessage: true,
    });

    expect(didAnnounce).toBe("delivered");
    expect(agentSpy).toHaveBeenCalledTimes(1);
    const agentCall = requireAgentCall();
    expect(agentCall.params?.deliver).toBe(true);
    expect(agentCall.params?.channel).toBe("telegram");
    expect(agentCall.params?.accountId).toBe("bot-123");
    expect(agentCall.params?.to).toBe("-1001234567890");
  });

  it("leaves direct completion failure logging to the shared delivery owner", async () => {
    const logSpy = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    agentSpy.mockResolvedValueOnce({ status: "error", error: "Outbound not configured for slack" });

    const didAnnounce = await runAnnounceFlow({
      startedAt: 10,
      endedAt: 20,
      childSessionKey: "agent:main:subagent:slack",
      childRunId: "run-direct-failure-log",
      requesterOrigin: {
        channel: "slack",
        to: "C123",
      },
      task: "deliver completion",
      roundOneReply: "done",
      expectsCompletionMessage: true,
    });

    expect(didAnnounce).toBe("retryable");
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("does not treat ambiguous direct completion failures as announced", async () => {
    let deliveryResult:
      | {
          delivered: boolean;
          path: string;
          error?: string;
          disposition?: string;
        }
      | undefined;
    agentSpy.mockResolvedValueOnce({
      status: "error",
      error: "prompt lock failed after visible send",
      disposition: "ambiguous",
    });

    const didAnnounce = await runAnnounceFlow({
      startedAt: 10,
      endedAt: 20,
      childSessionKey: "agent:main:subagent:slack",
      childRunId: "run-terminal-direct-failure",
      requesterOrigin: {
        channel: "slack",
        to: "C123",
      },
      task: "deliver completion",
      roundOneReply: "done",
      expectsCompletionMessage: true,
      onDeliveryResult: (delivery) => {
        deliveryResult = delivery;
      },
    });

    expect(didAnnounce).toBe("ambiguous");
    expect(deliveryResult).toMatchObject({
      delivered: false,
      path: "direct",
      error: "prompt lock failed after visible send",
      disposition: "ambiguous",
    });
  });
});
