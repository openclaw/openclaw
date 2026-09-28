// Subagent announce timeout tests cover retry timing and fallback requester
// resolution when completion delivery cannot finish immediately.
import { clampTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSubagentAnnounceDeliveryRuntimeMock } from "./subagent-announce.test-support.js";

type GatewayCall = {
  method?: string;
  timeoutMs?: number;
  expectFinal?: boolean;
  params?: Record<string, unknown>;
};

const gatewayCalls: GatewayCall[] = [];
let callGatewayImpl: (request: GatewayCall) => Promise<unknown> = async (request) => {
  if (request.method === "chat.history") {
    return { messages: [] };
  }
  return {};
};
let sessionStore: Record<string, Record<string, unknown>> = {};
let configOverride: ReturnType<(typeof import("../../../config/config.js"))["getRuntimeConfig"]> = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
};
let requesterDepthResolver: (sessionKey?: string) => number = () => 0;
let subagentSessionRunActive = true;
let shouldIgnorePostCompletion = false;
let pendingDescendantRuns = 0;
const isEmbeddedAgentRunActiveMock = vi.fn((_sessionId: string) => false);
const waitForEmbeddedAgentRunEndMock = vi.fn(
  async (_sessionId: string, _timeoutMs?: number) => true,
);
let fallbackRequesterResolution: {
  requesterSessionKey: string;
  requesterOrigin?: { channel?: string; to?: string; accountId?: string };
} | null = null;
let chatHistoryMessages: Array<Record<string, unknown>> = [];

function createGatewayCallModuleMock() {
  return {
    callGateway: vi.fn(async (request: GatewayCall) => {
      gatewayCalls.push(request);
      if (request.method === "chat.history") {
        return { messages: chatHistoryMessages };
      }
      return await callGatewayImpl(request);
    }),
  };
}

function createSubagentDepthModuleMock() {
  return {
    getSubagentDepthFromSessionStore: (sessionKey?: string) => requesterDepthResolver(sessionKey),
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
vi.mock("../spawn/subagent-depth.js", createSubagentDepthModuleMock);
vi.mock("./subagent-announce-delivery.runtime.js", () =>
  createSubagentAnnounceDeliveryRuntimeMock({
    callGateway: async (request: unknown) => {
      const typed = request as GatewayCall;
      gatewayCalls.push(typed);
      if (typed.method === "chat.history") {
        return { messages: chatHistoryMessages };
      }
      return await callGatewayImpl(typed);
    },
    getRuntimeConfig: () => configOverride,
    loadSessionStore: () => sessionStore,
    resolveAgentIdFromSessionKey: () => "main",
    resolveMainSessionKey: () => "agent:main:main",
    resolveSessionStorePathCore: () => "/tmp/sessions-main.json",
    isEmbeddedAgentRunActive: (sessionId: string) => isEmbeddedAgentRunActiveMock(sessionId),
    queueEmbeddedAgentMessageWithOutcome: (sessionId: string) => ({
      queued: false,
      sessionId,
      reason: "not_streaming",
      gatewayHealth: "live",
    }),
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
    requesterSessionOrigin?: { provider?: string; channel?: string };
    bestEffortDeliver?: boolean;
    directIdempotencyKey?: string;
    internalEvents?: unknown;
  }) => {
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
    gatewayCalls.push(request);
    await callGatewayImpl(request);
    return { delivered: true, path: "direct" };
  },
  loadRequesterSessionEntry: (sessionKey: string) => ({
    cfg: configOverride,
    canonicalKey: sessionKey,
    entry: sessionStore[sessionKey],
  }),
  loadSessionEntryByKey: (sessionKey: string) => sessionStore[sessionKey],
  resolveAnnounceOrigin: (entry: { origin?: unknown } | undefined, requesterOrigin?: unknown) =>
    requesterOrigin ?? entry?.origin,
  resolveSubagentCompletionOrigin: async (params: { requesterOrigin?: unknown }) =>
    params.requesterOrigin,
  resolveSubagentAnnounceTimeoutMs: (cfg: typeof configOverride) => {
    const configured = cfg.agents?.defaults?.subagents?.announceTimeoutMs;
    return clampTimerTimeoutMs(configured) ?? 120_000;
  },
  runAnnounceDeliveryWithRetry: async <T>(params: { run: () => Promise<T> }) => await params.run(),
}));
vi.mock("./subagent-announce.runtime.js", () => ({
  callSubagentLifecycleGateway: createGatewayCallModuleMock().callGateway,
  dispatchGatewayMethodInProcess: async (
    method: string,
    params: Record<string, unknown>,
    options?: { expectFinal?: boolean; timeoutMs?: number },
  ) => {
    const request = {
      method,
      params,
      expectFinal: options?.expectFinal,
      timeoutMs: options?.timeoutMs,
    };
    gatewayCalls.push(request);
    return await callGatewayImpl(request);
  },
  getRuntimeConfig: () => configOverride,
  loadSessionStore: vi.fn(() => sessionStore),
  readSessionMessagesAsync: vi.fn(async () => []),
  readSubagentSessionEntry: (_storePath: string, sessionKey: string) => sessionStore[sessionKey],
  resolveAgentIdFromSessionKey: () => "main",
  resolveSessionStorePathCore: () => "/tmp/sessions-main.json",
  resolveMainSessionKey: () => "agent:main:main",
  isEmbeddedAgentRunActive: (sessionId: string) => isEmbeddedAgentRunActiveMock(sessionId),
  waitForEmbeddedAgentRunEnd: (sessionId: string, timeoutMs?: number) =>
    waitForEmbeddedAgentRunEndMock(sessionId, timeoutMs),
}));
vi.mock("../registry/subagent-registry-read.js", () => ({
  countActiveDescendantRuns: () => 0,
  countPendingDescendantRuns: () => pendingDescendantRuns,
  hasDescendantRunAwaitingSettle: () => false,
  getLatestSubagentRunByChildSessionKey: () => undefined,
  listSubagentRunsForRequester: () => [],
  isSubagentSessionRunActive: () => subagentSessionRunActive,
  shouldIgnorePostCompletionAnnounceForSession: () => shouldIgnorePostCompletion,
  resolveRequesterForChildSession: () => fallbackRequesterResolution,
}));
vi.mock("../registry/subagent-registry-runtime.js", () => ({
  replaceSubagentRunAfterSteer: () => true,
}));
import { textAssistant } from "../../test-helpers/sparse-transcript.test-support.js";
import { runSubagentAnnounceFlow } from "./subagent-announce.js";
type AnnounceFlowParams = Parameters<
  typeof import("./subagent-announce.js").runSubagentAnnounceFlow
>[0];

const defaultSessionConfig = {
  mainKey: "main",
  scope: "per-sender",
} as const;

const baseAnnounceFlowParams = {
  childSessionKey: "agent:main:subagent:worker",
  requesterSessionKey: "agent:main:main",
  requesterDisplayKey: "main",
  task: "do thing",
  timeoutMs: 1_000,
  cleanup: "keep",
  roundOneReply: "done",
  waitForCompletion: false,
  outcome: { status: "ok" as const },
} satisfies Omit<AnnounceFlowParams, "childRunId">;

async function runAnnounceFlowForTest(
  childRunId: string,
  overrides: Partial<AnnounceFlowParams> = {},
): ReturnType<typeof runSubagentAnnounceFlow> {
  return await runSubagentAnnounceFlow({
    ...baseAnnounceFlowParams,
    childRunId,
    ...overrides,
  });
}

function findGatewayCall(predicate: (call: GatewayCall) => boolean): GatewayCall | undefined {
  return gatewayCalls.find(predicate);
}

function findFinalDirectAgentCall(): GatewayCall | undefined {
  return findGatewayCall((call) => call.method === "agent" && call.expectFinal === true);
}

function setupParentSessionFallback(parentSessionKey: string): void {
  requesterDepthResolver = (sessionKey?: string) =>
    sessionKey === parentSessionKey ? 1 : sessionKey?.includes(":subagent:") ? 1 : 0;
  subagentSessionRunActive = false;
  shouldIgnorePostCompletion = false;
  fallbackRequesterResolution = {
    requesterSessionKey: "agent:main:main",
    requesterOrigin: { channel: "discord", to: "chan-main", accountId: "acct-main" },
  };
}

describe("subagent announce timeout config", () => {
  beforeEach(() => {
    gatewayCalls.length = 0;
    chatHistoryMessages = [];
    callGatewayImpl = async (request) => {
      if (request.method === "chat.history") {
        return { messages: [] };
      }
      return {};
    };
    sessionStore = {};
    configOverride = {
      session: defaultSessionConfig,
    };
    requesterDepthResolver = () => 0;
    subagentSessionRunActive = true;
    shouldIgnorePostCompletion = false;
    pendingDescendantRuns = 0;
    isEmbeddedAgentRunActiveMock.mockReset().mockReturnValue(false);
    waitForEmbeddedAgentRunEndMock.mockReset().mockResolvedValue(true);
    fallbackRequesterResolution = null;
  });

  it("regression, skips parent announce while descendants are still pending", async () => {
    requesterDepthResolver = () => 1;
    pendingDescendantRuns = 2;

    const didAnnounce = await runAnnounceFlowForTest("run-pending-descendants", {
      requesterSessionKey: "agent:main:subagent:parent",
      requesterDisplayKey: "agent:main:subagent:parent",
    });

    expect(didAnnounce).toBe("retryable");
    expect(
      findGatewayCall((call) => call.method === "agent" && call.expectFinal === true),
    ).toBeUndefined();
  });

  it("regression, supports cron announceType without declaration order errors", async () => {
    const didAnnounce = await runAnnounceFlowForTest("run-announce-type", {
      announceType: "cron job",
      expectsCompletionMessage: true,
      requesterOrigin: { channel: "discord", to: "channel:cron" },
    });

    expect(didAnnounce).toBe("delivered");
    const directAgentCall = findGatewayCall(
      (call) => call.method === "agent" && call.expectFinal === true,
    );
    const internalEvents =
      (directAgentCall?.params?.internalEvents as Array<{ announceType?: string }>) ?? [];
    expect(internalEvents[0]?.announceType).toBe("cron job");
  });

  it("regression, keeps child announce internal when requester is a cron run session", async () => {
    const cronSessionKey = "agent:main:cron:daily-check:run:run-123";

    await runAnnounceFlowForTest("run-cron-internal", {
      requesterSessionKey: cronSessionKey,
      requesterDisplayKey: cronSessionKey,
      requesterOrigin: { channel: "discord", to: "channel:cron-results", accountId: "acct-1" },
    });

    const directAgentCall = findFinalDirectAgentCall();
    expect(directAgentCall?.params?.sessionKey).toBe(cronSessionKey);
    expect(directAgentCall?.params?.deliver).toBe(false);
    expect(directAgentCall?.params?.channel).toBeUndefined();
    expect(directAgentCall?.params?.to).toBeUndefined();
    expect(directAgentCall?.params?.accountId).toBeUndefined();
  });

  it("regression, routes child announce to parent session instead of grandparent when parent session still exists", async () => {
    const parentSessionKey = "agent:main:subagent:parent";
    setupParentSessionFallback(parentSessionKey);
    sessionStore[parentSessionKey] = { updatedAt: Date.now() };

    await runAnnounceFlowForTest("run-parent-route", {
      requesterSessionKey: parentSessionKey,
      requesterDisplayKey: parentSessionKey,
      childSessionKey: `${parentSessionKey}:subagent:child`,
    });

    const directAgentCall = findFinalDirectAgentCall();
    expect(directAgentCall?.params?.sessionKey).toBe(parentSessionKey);
    expect(directAgentCall?.params?.deliver).toBe(false);
  });

  it("regression, falls back to grandparent only when parent subagent session is missing", async () => {
    const parentSessionKey = "agent:main:subagent:parent-missing";
    setupParentSessionFallback(parentSessionKey);

    await runAnnounceFlowForTest("run-parent-fallback", {
      requesterSessionKey: parentSessionKey,
      requesterDisplayKey: parentSessionKey,
      childSessionKey: `${parentSessionKey}:subagent:child`,
    });

    const directAgentCall = findFinalDirectAgentCall();
    expect(directAgentCall?.params?.sessionKey).toBe("agent:main:main");
    expect(directAgentCall?.params?.deliver).toBe(true);
    expect(directAgentCall?.params?.channel).toBe("discord");
    expect(directAgentCall?.params?.to).toBe("chan-main");
    expect(directAgentCall?.params?.accountId).toBe("acct-main");
  });

  it("uses partial progress on timeout when the child only made tool calls", async () => {
    chatHistoryMessages = [
      { role: "user", content: "do a complex task" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
      },
      { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "data" }] },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-2", name: "exec", arguments: {} }],
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-3", name: "search", arguments: {} }],
      },
    ];

    await runAnnounceFlowForTest("run-timeout-partial-progress", {
      outcome: { status: "timeout" },
      roundOneReply: undefined,
    });

    const directAgentCall = findFinalDirectAgentCall();
    const internalEvents =
      (directAgentCall?.params?.internalEvents as Array<{ result?: string }>) ?? [];
    expect(internalEvents[0]?.result).toContain("3 tool call(s)");
    expect(internalEvents[0]?.result).not.toContain("data");
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

    await runAnnounceFlowForTest("run-timeout-empty-terminal-progress", {
      outcome: { status: "timeout" },
      roundOneReply: undefined,
      terminalReply: { disposition: "empty" },
    });

    const directAgentCall = findFinalDirectAgentCall();
    const internalEvents =
      (directAgentCall?.params?.internalEvents as Array<{ result?: string }>) ?? [];
    expect(internalEvents[0]?.result).toBe("1 tool call(s) made without visible output.");
    expect(internalEvents[0]?.result).not.toContain("private tool output");
  });

  it.each(["authoritative progress", "(no output)"])(
    "keeps authoritative visible timeout output %s without transcript inference",
    async (text) => {
      chatHistoryMessages = [
        { role: "assistant", content: [{ type: "text", text: "stale transcript output" }] },
      ];

      await runAnnounceFlowForTest("run-timeout-visible-terminal", {
        outcome: { status: "timeout" },
        roundOneReply: undefined,
        terminalReply: { disposition: "visible", text },
      });

      const directAgentCall = findFinalDirectAgentCall();
      const internalEvents =
        (directAgentCall?.params?.internalEvents as Array<{
          result?: string;
          noVisibleResult?: boolean;
        }>) ?? [];
      expect(internalEvents[0]?.result).toBe(text);
      expect(internalEvents[0]?.noVisibleResult).toBeUndefined();
      expect(gatewayCalls.some((call) => call.method === "chat.history")).toBe(false);
    },
  );

  it("keeps authoritative silence on timeout without transcript inference", async () => {
    chatHistoryMessages = [
      { role: "assistant", content: [{ type: "text", text: "stale transcript output" }] },
    ];

    await runAnnounceFlowForTest("run-timeout-silent-terminal", {
      outcome: { status: "timeout" },
      roundOneReply: undefined,
      terminalReply: { disposition: "silent" },
    });

    expect(findFinalDirectAgentCall()).toBeUndefined();
    expect(gatewayCalls.some((call) => call.method === "chat.history")).toBe(false);
  });

  it("keeps authoritative empty success intentional without transcript inference", async () => {
    chatHistoryMessages = [
      { role: "assistant", content: [{ type: "text", text: "stale transcript output" }] },
    ];

    await runAnnounceFlowForTest("run-ok-empty-terminal", {
      outcome: { status: "ok" },
      roundOneReply: undefined,
      terminalReply: { disposition: "empty" },
    });

    const directAgentCall = findFinalDirectAgentCall();
    const internalEvents =
      (directAgentCall?.params?.internalEvents as Array<{
        result?: string;
        noVisibleResult?: boolean;
      }>) ?? [];
    expect(internalEvents[0]?.result).toBe("(no output)");
    expect(internalEvents[0]?.noVisibleResult).toBe(true);
    expect(gatewayCalls.some((call) => call.method === "chat.history")).toBe(false);
  });

  it("keeps delete-mode timeout retryable while the embedded child request is still active", async () => {
    sessionStore["agent:main:subagent:worker"] = {
      sessionId: "child-session",
    };
    isEmbeddedAgentRunActiveMock.mockReturnValue(true);
    waitForEmbeddedAgentRunEndMock.mockResolvedValue(false);

    const didAnnounce = await runAnnounceFlowForTest("run-timeout-delete-still-active", {
      cleanup: "delete",
      outcome: { status: "timeout" },
      roundOneReply: undefined,
    });

    expect(didAnnounce).toBe("retryable");
    expect(findFinalDirectAgentCall()).toBeUndefined();
  });

  it("does not announce cached reply text when the child run terminally failed", async () => {
    chatHistoryMessages = [
      { role: "assistant", content: [{ type: "text", text: "stale history output" }] },
      { role: "toolResult", content: [{ type: "text", text: "stale tool output" }] },
    ];

    await runAnnounceFlowForTest("run-terminal-error-no-stale-output", {
      outcome: { status: "error", error: "All models failed (2): timeout" },
      roundOneReply: "stale frozen output",
      fallbackReply: "older fallback output",
    });

    const directAgentCall = findFinalDirectAgentCall();
    const internalEvents =
      (directAgentCall?.params?.internalEvents as Array<{
        result?: string;
        status?: string;
        statusLabel?: string;
        noVisibleResult?: boolean;
      }>) ?? [];
    expect(internalEvents[0]?.status).toBe("error");
    expect(internalEvents[0]?.statusLabel).toContain("All models failed");
    expect(internalEvents[0]?.result).toBe("(no output)");
    expect(internalEvents[0]?.noVisibleResult).toBe(true);
    expect(directAgentCall?.params?.message).not.toContain("stale");
    expect(directAgentCall?.params?.message).not.toContain("older fallback");
  });

  it("prefers visible assistant progress over a later raw tool result", async () => {
    chatHistoryMessages = [
      textAssistant("Read 12 files. Narrowing the search now."),
      {
        role: "toolResult",
        content: [{ type: "text", text: "grep output" }],
      },
    ];

    await runAnnounceFlowForTest("run-timeout-visible-assistant", {
      outcome: { status: "timeout" },
      roundOneReply: undefined,
    });

    const directAgentCall = findFinalDirectAgentCall();
    const internalEvents =
      (directAgentCall?.params?.internalEvents as Array<{ result?: string }>) ?? [];
    expect(internalEvents[0]?.result).toContain("Read 12 files");
    expect(internalEvents[0]?.result).not.toContain("grep output");
  });

  it("reports tool progress when a later tool invalidates timeout silence", async () => {
    chatHistoryMessages = [
      ...createTimeoutHistoryWithNoReply(),
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call2", name: "exec", arguments: {} }],
      },
    ];

    await runAnnounceFlowForTest("run-timeout-mixed-no-reply", {
      outcome: { status: "timeout" },
      roundOneReply: undefined,
    });

    const directAgentCall = findGatewayCall(
      (call) => call.method === "agent" && call.expectFinal === true,
    );
    const internalEvents =
      (directAgentCall?.params?.internalEvents as Array<{ result?: string }>) ?? [];
    expect(internalEvents[0]?.result).toBe("2 tool call(s) made without visible output.");
  });

  it("prefers later visible assistant progress over an earlier NO_REPLY marker", async () => {
    chatHistoryMessages = [
      ...createTimeoutHistoryWithNoReply(),
      textAssistant("A longer partial summary that should stay silent."),
    ];

    await runAnnounceFlowForTest("run-timeout-no-reply-overrides-latest-text", {
      outcome: { status: "timeout" },
      roundOneReply: undefined,
    });

    const directAgentCall = findFinalDirectAgentCall();
    const internalEvents =
      (directAgentCall?.params?.internalEvents as Array<{ result?: string }>) ?? [];
    expect(internalEvents[0]?.result).toContain(
      "A longer partial summary that should stay silent.",
    );
  });
});
