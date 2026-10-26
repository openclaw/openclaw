import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import * as announceDelivery from "./subagent-announce-delivery.js";

type Runtime = typeof import("./subagent-announce.runtime.js");
type SessionEntry = Awaited<ReturnType<Runtime["readSubagentSessionEntry"]>>;
type AgentCallRequest = { method?: string; params?: Record<string, unknown> };
type DeliveryParams = Parameters<typeof announceDelivery.deliverSubagentAnnouncement>[0];
const agentSpy = vi.fn<typeof announceDelivery.deliverSubagentAnnouncement>(async () => ({
  delivered: true,
  path: "direct",
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
    return agentSpy(params);
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

function expectChildDeleted(emitLifecycleHooks: boolean, key: string, agentId: string) {
  expect(sessionsDeleteSpy).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      params: {
        key,
        agentId,
        deleteTranscript: true,
        emitLifecycleHooks,
        expectedSessionId: childIdentity.sessionId,
        expectedLifecycleRevision: childIdentity.lifecycleRevision,
      },
    }),
  );
}

type FlowParams = Partial<Parameters<typeof runSubagentAnnounceFlow>[0]>;
function runAnnounceFlow(overrides: FlowParams) {
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

async function expectFlow(overrides: FlowParams, outcome = "delivered") {
  expect(await runAnnounceFlow(overrides)).toBe(outcome);
}

function expectMessage(text: string) {
  expect(agentSpy).toHaveBeenCalledTimes(1);
  expect(agentSpy.mock.calls[0]?.[0].triggerMessage).toContain(text);
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

  it.each(["run", "session", "invalidated", "raw owner"] as const)("cleans up %s", async (mode) => {
    const raw = mode === "raw owner";
    const key = raw ? "global" : "agent:main:subagent:test";
    const agentId = raw ? "research" : "main";
    loadSessionStoreMock.mockReturnValue({ [key]: childIdentity });
    const load = announceDelivery.loadSessionEntryByKey;
    const read = vi
      .spyOn(announceDelivery, "loadSessionEntryByKey")
      .mockImplementation(async (sessionKey, owner) =>
        sessionKey === "global"
          ? owner === "research"
            ? childIdentity
            : { sessionId: "wrong-owner" }
          : load(sessionKey, owner),
      );
    try {
      await expectFlow({
        childSessionKey: key,
        childAgentId: agentId,
        childSessionIdentity: childIdentity,
        cleanup: "delete",
        spawnMode: mode === "session" ? "session" : undefined,
        ...(mode === "session"
          ? { expectsCompletionMessage: true }
          : terminalResult("child result")),
        roundOneReply: "  child result  ",
        fallbackReply: mode === "session" ? undefined : "stale result",
        onBeforeDeleteChildSession: () => mode !== "invalidated",
      });
      expectMessage("child result");
      if (mode === "invalidated") {
        expect(sessionsDeleteSpy).not.toHaveBeenCalled();
      } else {
        expectChildDeleted(mode === "session", key, agentId);
      }
    } finally {
      read.mockRestore();
    }
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
      await expectFlow({
        ...retiredResult(),
        cleanup: "delete",
        suppressChildSessionEffects: reason === "explicit",
        isChildSessionEffectsAllowed: () => reason !== "host",
        prepareChildSessionEffects: async () => reason !== "currency",
        isCompletionDeliveryAllowed: () => true,
      });
      expectMessage("frozen terminal result");
      expect(sessionsDeleteSpy).not.toHaveBeenCalled();
    },
  );

  it("drops requester delivery after the cleanup owner changes", async () => {
    await expectFlow(
      {
        ...retiredResult(),
        suppressChildSessionEffects: true,
        isCompletionDeliveryAllowed: () => false,
      },
      "intentional_non_delivery",
    );
    expect(agentSpy).not.toHaveBeenCalled();
  });

  it("keeps private retry input stable when late usage arrives after failure", async () => {
    let usage: Record<string, number> = {};
    loadSessionStoreMock.mockImplementation(() => ({
      "agent:main:main": { sessionId: "private-parent" },
      "agent:main:subagent:private": { sessionId: "private-child", ...usage },
    }));
    agentSpy.mockResolvedValueOnce({ delivered: false, path: "direct", error: "delivery failed" });
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
    expect(first).toContain("Your final reply is recorded in this session for the requester");
    expect(first).not.toContain("Stats:");
    expect(agentSpy.mock.calls[1]?.[0].triggerMessage).toBe(first);
  });

  it.each([
    ["retryable", "requester lookup unavailable", "none"],
    [
      "permanent_failure",
      "Session transcript keyed user is outside the current turn: old-input",
      "none",
    ],
    ["ambiguous", "prompt lock failed after visible send", "direct"],
    ["delivered", "receipt persistence unavailable", "direct"],
  ] as const)(
    "preserves %s through delivery and receipt failures",
    async (disposition, error, path) => {
      const onDeliveryResult = vi.fn();
      if (disposition === "delivered") {
        onDeliveryResult.mockRejectedValue(new Error(error));
      } else if (path === "none") {
        agentSpy.mockRejectedValueOnce(new Error(error));
      } else {
        agentSpy.mockResolvedValueOnce({ delivered: false, path, error, disposition });
      }
      await expectFlow(
        {
          requesterOrigin: { channel: "slack", to: "C123" },
          roundOneReply: "finished result",
          expectsCompletionMessage: true,
          onDeliveryResult,
        },
        disposition,
      );
      expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith(
        disposition === "delivered"
          ? expect.objectContaining({ delivered: true })
          : { delivered: false, path, error, disposition },
      );
    },
  );
});
