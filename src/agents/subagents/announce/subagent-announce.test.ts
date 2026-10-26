import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import * as announceDelivery from "./subagent-announce-delivery.js";
import { privateRequesterRouteCases } from "./subagent-announce-fixtures.test-support.js";

type Runtime = typeof import("./subagent-announce.runtime.js");
type SessionEntry = Awaited<ReturnType<Runtime["readSubagentSessionEntry"]>>;
type AgentCallRequest = { method?: string; params?: Record<string, unknown> };
type DeliveryParams = Parameters<typeof announceDelivery.deliverSubagentAnnouncement>[0];
type AgentCallResponse = {
  runId?: string;
  status: string;
  error?: string;
  disposition?: "ambiguous";
};

const agentSpy = vi.fn(async (_params: DeliveryParams): Promise<AgentCallResponse> => ({
  runId: "run-main",
  status: "ok",
}));
const sessionsDeleteSpy = vi.fn((_req: AgentCallRequest) => undefined);
const callGatewayMock = vi.fn(async (_request: unknown) => ({}));
const loadSessionStoreMock = vi.fn((_storePath: string) => ({}));
const mockConfig: ReturnType<Runtime["getRuntimeConfig"]> = {
  session: { mainKey: "main", scope: "per-sender" },
};

const subagentRegistryRuntimeMock = vi.hoisted(() => ({
  shouldIgnorePostCompletionAnnounceForSession: vi.fn(() => false),
  isSubagentSessionRunActive: vi.fn(() => true),
  countPendingDescendantRuns: vi.fn(() => 0),
  getLatestSubagentRunByChildSessionKey: vi.fn(() => undefined),
  listSubagentRunsForRequester: vi.fn<() => SubagentRunRecord[]>(() => []),
  replaceSubagentRunAfterSteerCore: vi.fn(() => true),
  resolveRequesterForChildSession: vi.fn(() => null),
}));

vi.mock("./subagent-announce-delivery.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./subagent-announce-delivery.runtime.js")>()),
  getGlobalHookRunner: () => ({ hasHooks: () => false }),
  resolveBoundDeliveryDestination: async () => null,
  resolveConversationIdFromTargets: () => "",
}));

// mock-isolation: Announce orchestration uses scripted delivery outcomes and requester records instead of the delivery runtime.
vi.mock("./subagent-announce-delivery.js", () => ({
  deliverSubagentAnnouncement: async (params: DeliveryParams) => {
    if (params.isSourceSessionEffectsAllowed?.() === false) {
      return {
        delivered: false,
        path: "none",
        reason: "source_owner_changed",
        terminal: true,
        disposition: "intentional_non_delivery",
      };
    }
    const response = await agentSpy(params);
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
  loadRequesterSessionEntry: (sessionKey: string) => ({
    entry: readEntry("/tmp/sessions.json", sessionKey),
    cfg: mockConfig,
    canonicalKey: sessionKey,
    agentId: "main",
    storePath: "/tmp/sessions.json",
  }),
  loadSessionEntryByKey: (sessionKey: string) =>
    readEntry("/tmp/sessions.json", sessionKey) ?? { sessionId: sessionKey },
}));

vi.mock("../registry/subagent-registry-read.js", () => subagentRegistryRuntimeMock);
vi.mock("../registry/subagent-registry.js", () => subagentRegistryRuntimeMock);
import { testing as outputTesting } from "./subagent-announce-output.test-support.js";
import { runSubagentAnnounceFlow } from "./subagent-announce.js";

function readEntry(storePath: string, sessionKey: string) {
  return (loadSessionStoreMock(storePath) as Record<string, SessionEntry>)?.[sessionKey];
}

const childIdentity = {
  sessionId: "child-session-id",
  lifecycleRevision: "child-lifecycle-revision",
};

function expectChildDeleted(
  emitLifecycleHooks: boolean,
  key = "agent:main:subagent:test",
  agentId = "main",
  identity = childIdentity,
) {
  expect(sessionsDeleteSpy).toHaveBeenCalledExactlyOnceWith({
    method: "sessions.delete",
    params: {
      key,
      agentId,
      deleteTranscript: true,
      emitLifecycleHooks,
      expectedSessionId: identity.sessionId,
      expectedLifecycleRevision: identity.lifecycleRevision,
    },
    timeoutMs: 10_000,
    prepareDispatchCurrent: expect.any(Function),
    assertDispatchCurrent: expect.any(Function),
  });
}

function runAnnounceFlow(overrides: Partial<Parameters<typeof runSubagentAnnounceFlow>[0]>) {
  return runSubagentAnnounceFlow({
    childSessionKey: "agent:main:subagent:test",
    childRunId: "run-test",
    requesterSessionKey: "agent:main:main",
    task: "do thing",
    timeoutMs: 10,
    cleanup: "keep",
    outcome: { status: "ok" },
    ...overrides,
  });
}

function terminalResult(text: string) {
  return { roundOneReply: text, terminalReply: { disposition: "visible" as const, text } };
}

function retiredResult() {
  return {
    childSessionKey: "agent:main:subagent:retired",
    task: "recover interrupted work",
    outcome: { status: "error" as const, error: "interrupted by restart" },
    ...terminalResult("frozen terminal result"),
  };
}

describe("subagent announce seam flow", () => {
  beforeEach(() => {
    agentSpy.mockClear();
    sessionsDeleteSpy.mockClear();
    callGatewayMock.mockReset().mockImplementation(async (req: unknown) => {
      const typed = req as AgentCallRequest;
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
    outputTesting.setDepsForTest({
      callGateway: callGatewayMock as Runtime["callSubagentLifecycleGateway"],
      getRuntimeConfig: () => mockConfig,
      readSubagentSessionEntry: readEntry,
      readSessionMessagesAsync: async () => [],
      resolveSessionStorePathCore: () => "/tmp/sessions.json",
    });
  });

  afterEach(() => outputTesting.setDepsForTest());

  it.each([
    { roundOneReply: "  child result  ", spawnMode: undefined },
    { roundOneReply: "completed", spawnMode: "session" as const },
  ])(
    "delivers the result and deletes the encoded child owner: %j",
    async ({ roundOneReply, spawnMode }) => {
      loadSessionStoreMock.mockReturnValue({ "agent:main:subagent:test": childIdentity });
      const didAnnounce = await runAnnounceFlow({
        startedAt: 10,
        endedAt: 20,
        childAgentId: "main",
        childSessionIdentity: childIdentity,
        cleanup: "delete",
        spawnMode,
        ...(spawnMode === "session"
          ? { expectsCompletionMessage: true }
          : terminalResult(roundOneReply.trim())),
        roundOneReply,
        fallbackReply: spawnMode === "session" ? undefined : "stale result",
      });
      expect(didAnnounce).toBe("delivered");
      expect(agentSpy).toHaveBeenCalledTimes(1);
      expect(agentSpy.mock.calls[0]?.[0].triggerMessage).toContain(roundOneReply.trim());
      expectChildDeleted(spawnMode === "session");
    },
  );

  it("skips delete cleanup when the lifecycle owner invalidates the attempt", async () => {
    const didAnnounce = await runAnnounceFlow({
      childSessionIdentity: childIdentity,
      cleanup: "delete",
      roundOneReply: "child result",
      onBeforeDeleteChildSession: () => false,
    });

    expect(didAnnounce).toBe("delivered");
    expect(sessionsDeleteSpy).not.toHaveBeenCalled();
  });

  it("carries a raw child's recorded owner from metadata selection into delete cleanup", async () => {
    const identity = (agentId: string) => ({
      sessionId: `${agentId}-child`,
      lifecycleRevision: `${agentId}-revision`,
      updatedAt: 1,
    });
    const entries = new Map(["main", "research"].map((agentId) => [agentId, identity(agentId)]));
    const load = announceDelivery.loadSessionEntryByKey;
    using _ = vi
      .spyOn(announceDelivery, "loadSessionEntryByKey")
      .mockImplementation(async (key, agentId) =>
        key === "global" ? entries.get(agentId ?? "main") : load(key, agentId),
      );

    expect(
      await runAnnounceFlow({
        childSessionKey: "global",
        childAgentId: "research",
        childSessionIdentity: identity("research"),
        cleanup: "delete",
        ...terminalResult("Research result"),
      }),
    ).toBe("delivered");
    expectChildDeleted(false, "global", "research", identity("research"));
  });

  it.each(["explicit", "host", "currency"] as const)(
    "delivers frozen terminal facts while %s suppresses child-session effects",
    async (reason) => {
      loadSessionStoreMock.mockReturnValue({
        "agent:main:subagent:retired": {
          sessionId: "retired-session",
          lifecycleRevision: "retired-lifecycle",
        },
      });
      const didAnnounce = await runAnnounceFlow({
        ...retiredResult(),
        cleanup: "delete",
        suppressChildSessionEffects: reason === "explicit",
        isChildSessionEffectsAllowed: () => reason !== "host",
        prepareChildSessionEffects: async () => reason !== "currency",
        isCompletionDeliveryAllowed: () => true,
      });

      expect(didAnnounce).toBe("delivered");
      expect(agentSpy).toHaveBeenCalledTimes(1);
      expect(agentSpy.mock.calls[0]?.[0].triggerMessage).toContain("frozen terminal result");
      expect(sessionsDeleteSpy).not.toHaveBeenCalled();
    },
  );

  it("drops requester delivery after the cleanup owner changes", async () => {
    const didAnnounce = await runAnnounceFlow({
      ...retiredResult(),
      suppressChildSessionEffects: true,
      isCompletionDeliveryAllowed: () => false,
    });

    expect(didAnnounce).toBe("intentional_non_delivery");
    expect(agentSpy).not.toHaveBeenCalled();
  });

  it.each(privateRequesterRouteCases())(
    "guides private $name completions according to the requester route",
    async ({ origin, canDeliver }) => {
      expect(
        await runAnnounceFlow({
          completionTarget: "parent",
          requesterOrigin: origin,
          ...terminalResult("private child result"),
        }),
      ).toBe("delivered");
      const trigger = agentSpy.mock.calls[0]?.[0].triggerMessage;
      if (canDeliver) {
        expect(trigger).toContain("send it through an available, permitted messaging tool");
      } else {
        expect(trigger).not.toContain("messaging tool");
        expect(trigger).toContain("Your final reply is recorded in this session for the requester");
        expect(trigger).toContain("no messaging send is needed");
      }
    },
  );

  it("keeps private retry input stable when late usage arrives after failure", async () => {
    let usage: Record<string, number> = {};
    loadSessionStoreMock.mockImplementation(() => ({
      "agent:main:main": { sessionId: "private-parent" },
      "agent:main:subagent:private": { sessionId: "private-child", ...usage },
    }));
    agentSpy.mockResolvedValueOnce({ status: "error" }).mockResolvedValueOnce({ status: "ok" });
    const params: Parameters<typeof runAnnounceFlow>[0] = {
      childSessionKey: "agent:main:subagent:private",
      childRunId: "private-stable-run",
      completionTarget: "parent",
      completionRequesterSessionId: "private-parent",
      ...terminalResult("private child result"),
      expectsCompletionMessage: true,
      startedAt: 10,
      endedAt: 20,
    };
    await runAnnounceFlow(params);
    usage = { inputTokens: 100, outputTokens: 20 };
    await runAnnounceFlow(params);
    expect(agentSpy).toHaveBeenCalledTimes(2);
    const first = agentSpy.mock.calls[0]?.[0].triggerMessage;
    expect(first).toContain("private child result");
    expect(first).not.toContain("Stats:");
    expect(agentSpy.mock.calls[1]?.[0].triggerMessage).toBe(first);
  });

  it.each([
    { error: "requester lookup unavailable", disposition: "retryable" },
    {
      error: "Session transcript keyed user is outside the current turn: old-input",
      disposition: "permanent_failure",
    },
  ] as const)(
    "reports thrown announce failures to the delivery owner ($disposition)",
    async ({ error, disposition }) => {
      vi.spyOn(announceDelivery, "deliverSubagentAnnouncement").mockRejectedValueOnce(
        new Error(error),
      );
      const onDeliveryResult = vi.fn();

      expect(
        await runAnnounceFlow({
          roundOneReply: "finished result",
          expectsCompletionMessage: true,
          onDeliveryResult,
        }),
      ).toBe(disposition);
      expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith({
        delivered: false,
        path: "none",
        error,
        disposition,
      });
    },
  );

  it("does not replace a confirmed delivery when its receipt callback throws", async () => {
    const onDeliveryResult = vi
      .fn()
      .mockRejectedValue(new Error("receipt persistence unavailable"));
    expect(
      await runAnnounceFlow({
        roundOneReply: "finished result",
        expectsCompletionMessage: true,
        onDeliveryResult,
      }),
    ).toBe("delivered");
    expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ delivered: true }),
    );
  });

  it("does not treat ambiguous direct completion failures as announced", async () => {
    const onDeliveryResult = vi.fn();
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
      onDeliveryResult,
    });

    expect(didAnnounce).toBe("ambiguous");
    expect(onDeliveryResult.mock.lastCall?.[0]).toMatchObject({
      delivered: false,
      path: "direct",
      error: "prompt lock failed after visible send",
      disposition: "ambiguous",
    });
  });
});
