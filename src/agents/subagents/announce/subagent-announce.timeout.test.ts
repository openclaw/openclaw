import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { deliverSubagentAnnouncement } from "./subagent-announce-delivery.js";
import {
  captureSubagentCompletionReply,
  readLatestSubagentOutputWithRetry,
} from "./subagent-announce-output.js";
import * as announceRuntime from "./subagent-announce.runtime.js";
import { createSubagentAnnounceDeliveryRuntimeMock } from "./subagent-announce.test-support.js";

type GatewayCall = {
  method?: string;
  timeoutMs?: number;
  expectFinal?: boolean;
  params?: Record<string, unknown>;
};

const gatewayCalls: GatewayCall[] = [];
let sessionStore: Record<string, Record<string, unknown>> = {};
const configOverride = { session: { mainKey: "main", scope: "per-sender" } } as const;
const isEmbeddedAgentRunActiveMock = vi.fn((_sessionId: string) => false);
const waitForEmbeddedAgentRunEndMock = vi.fn(
  async (_sessionId: string, _timeoutMs?: number) => true,
);
let chatHistoryMessages: Array<Record<string, unknown>> = [];

async function callGateway(request: GatewayCall) {
  gatewayCalls.push(request);
  return request.method === "chat.history" ? { messages: chatHistoryMessages } : {};
}

function createGatewayCallModuleMock() {
  return { callGateway: vi.fn(callGateway) };
}

function createSubagentDepthModuleMock() {
  return {
    getSubagentDepthFromSessionStore: () => 0,
    getSubagentDepthFromSessionStoreInWorker: async () => 0,
  };
}

function createTimeoutHistoryWithNoReply() {
  return [
    { role: "user", content: "do something" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Still working through the files." },
        { type: "toolCall", id: "call1", name: "read", arguments: {} },
      ],
    },
    { role: "toolResult", toolCallId: "call1", content: [{ type: "text", text: "data" }] },
    textAssistant("NO_REPLY"),
  ];
}

vi.mock("../../../gateway/call.js", createGatewayCallModuleMock);
vi.mock("../../../sessions/session-controller.queries.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../sessions/session-controller.queries.js")>()),
  isSessionRunActive: (sessionId: string) => isEmbeddedAgentRunActiveMock(sessionId),
}));
vi.mock("../../../sessions/session-controller.native-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../sessions/session-controller.native-runtime.js")
  >()),
  waitForSessionRunEnd: (sessionId: string, timeoutMs?: number) =>
    waitForEmbeddedAgentRunEndMock(sessionId, timeoutMs),
}));
// mock-isolation: Timeout scenarios supply requester depth directly without opening a session database.
vi.mock("../spawn/subagent-depth.js", createSubagentDepthModuleMock);
// mock-isolation: timeout tests replace the complete transport runtime with deterministic adapters.
vi.mock("./subagent-announce-delivery.runtime.js", () =>
  createSubagentAnnounceDeliveryRuntimeMock({
    callGateway: async (request: unknown) => callGateway(request as GatewayCall),
    getRuntimeConfig: () => configOverride,
    loadSessionStore: () => sessionStore,
    resolveMainSessionKey: () => "agent:main:main",
    resolveSessionStorePathCore: () => "/tmp/sessions-main.json",
    isSessionRunActive: (sessionId: string) => isEmbeddedAgentRunActiveMock(sessionId),
  }),
);
// mock-isolation: The fixture controls delivery deadlines and requester records without starting transport or session-store work.
vi.mock("./subagent-announce-delivery.js", () => ({
  deliverSubagentAnnouncement: async (
    params: Parameters<typeof deliverSubagentAnnouncement>[0],
  ) => {
    const request = {
      method: "agent",
      expectFinal: true,
      params: {
        sessionKey: params.targetRequesterSessionKey,
        message: params.triggerMessage,
        deliver: !params.requesterIsSubagent,
        bestEffortDeliver: params.bestEffortDeliver,
        internalEvents: params.internalEvents,
        ...(params.requesterIsSubagent
          ? {}
          : {
              channel: params.completionDirectOrigin?.channel,
              to: params.completionDirectOrigin?.to,
              accountId: params.completionDirectOrigin?.accountId,
              threadId: params.completionDirectOrigin?.threadId,
            }),
      },
    };
    await callGateway(request);
    return { delivered: true, path: "direct" };
  },
  loadRequesterSessionEntry: (sessionKey: string) => ({
    cfg: configOverride,
    canonicalKey: sessionKey,
    agentId: "main",
    storePath: "/synthetic/announce-timeout.sqlite",
    entry: sessionStore[sessionKey],
  }),
  loadSessionEntryByKey: (sessionKey: string) => sessionStore[sessionKey],
}));
vi.mock("./subagent-announce.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./subagent-announce.runtime.js")>()),
  callSubagentLifecycleGateway: createGatewayCallModuleMock().callGateway,
  dispatchGatewayMethodInProcess: async (
    method: string,
    params: Record<string, unknown>,
    options?: { expectFinal?: boolean; timeoutMs?: number },
  ) => {
    return callGateway({
      method,
      params,
      expectFinal: options?.expectFinal,
      timeoutMs: options?.timeoutMs,
    });
  },
  getRuntimeConfig: () => configOverride,
  loadSessionStore: vi.fn(() => sessionStore),
  readSessionMessagesAsync: vi.fn(async () => []),
  readSubagentSessionEntry: (_storePath: string, sessionKey: string) => sessionStore[sessionKey],
  resolveSessionStorePathCore: () => "/tmp/sessions-main.json",
  resolveMainSessionKey: () => "agent:main:main",
  isSessionRunActive: (sessionId: string) => isEmbeddedAgentRunActiveMock(sessionId),
  waitForSessionRunEnd: (sessionId: string, timeoutMs?: number) =>
    waitForEmbeddedAgentRunEndMock(sessionId, timeoutMs),
}));
vi.mock("../registry/subagent-registry-read.js", () => ({
  countPendingDescendantRuns: () => 0,
  getLatestSubagentRunByChildSessionKey: () => undefined,
  listSubagentRunsForRequester: () => [],
  isSubagentSessionRunActive: () => true,
  shouldIgnorePostCompletionAnnounceForSession: () => false,
  resolveRequesterForChildSession: () => null,
}));
vi.mock("../registry/subagent-registry.js", () => ({
  replaceSubagentRunAfterSteerCore: () => true,
}));
import { textAssistant } from "../../test-helpers/sparse-transcript.test-support.js";
import { runSubagentAnnounceFlow } from "./subagent-announce.js";
type AnnounceFlowParams = Parameters<typeof runSubagentAnnounceFlow>[0];

async function runAnnounceFlowForTest(
  childRunId: string,
  overrides: Partial<AnnounceFlowParams> = {},
): ReturnType<typeof runSubagentAnnounceFlow> {
  return await runSubagentAnnounceFlow({
    childSessionKey: "agent:main:subagent:worker",
    requesterSessionKey: "agent:main:main",
    task: "do thing",
    timeoutMs: 1_000,
    cleanup: "keep",
    roundOneReply: "done",
    outcome: { status: "ok" },
    childRunId,
    ...overrides,
  });
}

function runTimeoutFlow(childRunId: string, overrides: Partial<AnnounceFlowParams> = {}) {
  return runAnnounceFlowForTest(childRunId, {
    outcome: { status: "timeout" },
    roundOneReply: undefined,
    ...overrides,
  });
}

function findFinalDirectAgentCall(): GatewayCall | undefined {
  return gatewayCalls.find((call) => call.method === "agent" && call.expectFinal === true);
}

function completionEvent() {
  return (
    findFinalDirectAgentCall()?.params?.internalEvents as Array<{
      result?: string;
      status?: string;
      statusLabel?: string;
      noVisibleResult?: boolean;
    }>
  )?.[0];
}

describe("subagent announce timeout config", () => {
  beforeEach(() => {
    gatewayCalls.length = 0;
    chatHistoryMessages = [];
    sessionStore = {};
    isEmbeddedAgentRunActiveMock.mockReset().mockReturnValue(false);
    waitForEmbeddedAgentRunEndMock.mockReset().mockResolvedValue(true);
  });

  it("regression, keeps child announce internal when requester is a cron run session", async () => {
    const cronSessionKey = "agent:main:cron:daily-check:run:run-123";

    await runAnnounceFlowForTest("run-cron-internal", {
      requesterSessionKey: cronSessionKey,
      requesterOrigin: { channel: "discord", to: "channel:cron-results", accountId: "acct-1" },
    });

    const { sessionKey, deliver, channel, to, accountId } =
      findFinalDirectAgentCall()?.params ?? {};
    expect({ sessionKey, deliver, channel, to, accountId }).toEqual({
      sessionKey: cronSessionKey,
      deliver: false,
      channel: undefined,
      to: undefined,
      accountId: undefined,
    });
  });

  it("uses timeout progress without replacing an authoritative empty terminal fact", async () => {
    chatHistoryMessages = [
      { role: "user", content: "do a complex task" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
      },
      { role: "toolResult", toolCallId: "call-1", content: "private tool output" },
    ];

    await runTimeoutFlow("run-timeout-empty-terminal-progress", {
      terminalReply: { disposition: "empty" },
    });

    expect(completionEvent()?.result).toBe("1 tool call(s) made without visible output.");
    expect(completionEvent()?.result).not.toContain("private tool output");
  });

  it("keeps authoritative silence on timeout without transcript inference", async () => {
    chatHistoryMessages = [textAssistant("stale transcript output")];

    await runTimeoutFlow("run-timeout-silent-terminal", {
      terminalReply: { disposition: "silent" },
    });

    expect(findFinalDirectAgentCall()).toBeUndefined();
    expect(gatewayCalls.some((call) => call.method === "chat.history")).toBe(false);
  });

  it("keeps authoritative empty success intentional without transcript inference", async () => {
    chatHistoryMessages = [textAssistant("stale transcript output")];

    await runAnnounceFlowForTest("run-ok-empty-terminal", {
      outcome: { status: "ok" },
      roundOneReply: undefined,
      terminalReply: { disposition: "empty" },
    });

    expect(completionEvent()).toMatchObject({ result: "(no output)", noVisibleResult: true });
    expect(gatewayCalls.some((call) => call.method === "chat.history")).toBe(false);
  });

  it("keeps delete-mode timeout retryable while the embedded child request is still active", async () => {
    sessionStore["agent:main:subagent:worker"] = {
      sessionId: "child-session",
    };
    isEmbeddedAgentRunActiveMock.mockReturnValue(true);
    waitForEmbeddedAgentRunEndMock.mockResolvedValue(false);

    const didAnnounce = await runTimeoutFlow("run-timeout-delete-still-active", {
      cleanup: "delete",
    });

    expect(didAnnounce).toBe("retryable");
    expect(findFinalDirectAgentCall()).toBeUndefined();
  });

  it("does not announce cached reply text when the child run terminally failed", async () => {
    chatHistoryMessages = [
      textAssistant("stale history output"),
      { role: "toolResult", content: [{ type: "text", text: "stale tool output" }] },
    ];

    await runAnnounceFlowForTest("run-terminal-error-no-stale-output", {
      outcome: { status: "error", error: "All models failed (2): timeout" },
      roundOneReply: "stale frozen output",
      fallbackReply: "older fallback output",
    });

    const directAgentCall = findFinalDirectAgentCall();
    expect(completionEvent()).toMatchObject({
      status: "error",
      statusLabel: expect.stringContaining("All models failed"),
      result: "(no output)",
      noVisibleResult: true,
    });
    expect(directAgentCall?.params?.message).not.toContain("stale");
    expect(directAgentCall?.params?.message).not.toContain("older fallback");
  });

  it.each([
    [
      "reports tool progress when a later tool invalidates timeout silence",
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call2", name: "exec", arguments: {} }],
      },
      "2 tool call(s) made without visible output.",
    ],
    [
      "prefers later visible assistant progress over an earlier NO_REPLY marker",
      textAssistant("A longer partial summary that should stay silent."),
      expect.stringContaining("A longer partial summary that should stay silent."),
    ],
  ] as const)("%s", async (_name, latest, expected) => {
    chatHistoryMessages = [...createTimeoutHistoryWithNoReply(), latest];
    await runTimeoutFlow("run-timeout-latest-progress", {
      terminalReply: { disposition: "empty" },
    });
    expect(completionEvent()?.result).toEqual(expected);
  });
});

describe("captureSubagentCompletionReply", () => {
  const sessionKey = "agent:main:subagent:child";
  const sessionTarget = {
    agentId: "main",
    sessionKey,
    sessionId: "child",
    storePath: "/tmp/sessions-main.json",
  };
  const readMessages = vi.mocked(announceRuntime.readSessionMessagesAsync);
  const capture = () => captureSubagentCompletionReply(sessionKey, { sessionTarget });

  beforeEach(() => {
    vi.useFakeTimers();
    readMessages.mockReset().mockResolvedValue([]);
  });
  afterEach(() => vi.useRealTimers());

  it("returns immediate assistant output without polling", async () => {
    readMessages.mockResolvedValue([textAssistant("Immediate completion")]);
    await expect(capture()).resolves.toBe("Immediate completion");
    expect(readMessages).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("captures the final assistant reply at the deadline", async () => {
    const startedAt = performance.now();
    readMessages.mockImplementation(async () =>
      performance.now() - startedAt >= 50 ? [textAssistant("Requester-visible final result")] : [],
    );
    const pending = capture();
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe("Requester-visible final result");
    expect(performance.now() - startedAt).toBe(50);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("charges slow output reads against the bounded retry deadline", async () => {
    const startedAt = performance.now();
    readMessages.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 30);
      });
      return [];
    });
    const pending = capture();
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBeUndefined();
    expect(readMessages).toHaveBeenCalledTimes(3);
    expect(performance.now() - startedAt).toBe(98);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not poll when waiting is disabled", async () => {
    await expect(
      captureSubagentCompletionReply(sessionKey, { sessionTarget, waitForReply: false }),
    ).resolves.toBeUndefined();
    expect(readMessages).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not read output with an exhausted retry budget", async () => {
    const readHistory = vi.mocked(announceRuntime.callSubagentLifecycleGateway).mockClear();
    await expect(
      readLatestSubagentOutputWithRetry({ sessionKey, maxWaitMs: 0 }),
    ).resolves.toBeUndefined();
    expect(readHistory).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
