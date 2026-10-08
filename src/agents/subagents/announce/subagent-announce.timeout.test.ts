// Subagent announce timeout tests cover retry timing and fallback requester
// resolution when completion delivery cannot finish immediately.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    completionTarget?: "parent";
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
        completionTarget: params.completionTarget,
        internalEvents: params.internalEvents,
        idempotencyKey: params.directIdempotencyKey,
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
  countPendingDescendantRuns: () => pendingDescendantRuns,
  getLatestSubagentRunByChildSessionKey: () => undefined,
  listSubagentRunsForRequester: () => [],
  isSubagentSessionRunActive: () => subagentSessionRunActive,
  shouldIgnorePostCompletionAnnounceForSession: () => shouldIgnorePostCompletion,
  resolveRequesterForChildSession: () => fallbackRequesterResolution,
}));
vi.mock("../registry/subagent-registry.js", () => ({
  replaceSubagentRunAfterSteerCore: () => true,
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
  task: "do thing",
  timeoutMs: 1_000,
  cleanup: "keep",
  roundOneReply: "done",
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

  it("gives a provisional wait-expiry wake a distinct delivery identity", async () => {
    await runAnnounceFlowForTest("run-phased-delivery", {
      outcome: { status: "timeout", disposition: "still-running" },
      deliveryPhase: "wait-expiry",
    });
    const provisionalKey = findFinalDirectAgentCall()?.params?.idempotencyKey;

    gatewayCalls.length = 0;
    await runAnnounceFlowForTest("run-phased-delivery");
    const terminalKey = findFinalDirectAgentCall()?.params?.idempotencyKey;

    expect(provisionalKey).toBe(
      "announce:v1:agent:main:subagent:worker:run-phased-delivery:wait-expiry",
    );
    expect(terminalKey).toBe("announce:v1:agent:main:subagent:worker:run-phased-delivery");
  });

  it("regression, keeps child announce internal when requester is a cron run session", async () => {
    const cronSessionKey = "agent:main:cron:daily-check:run:run-123";

    await runAnnounceFlowForTest("run-cron-internal", {
      requesterSessionKey: cronSessionKey,
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
      childSessionKey: `${parentSessionKey}:subagent:child`,
    });

    const directAgentCall = findFinalDirectAgentCall();
    expect(directAgentCall?.params?.sessionKey).toBe(parentSessionKey);
    expect(directAgentCall?.params?.deliver).toBe(false);
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

  it.each(["(no output)"])(
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

  // Regression: openclaw-kkv1. A wait that expired without observing the child
  // stop was announced identically to a child that really died ("timed out",
  // "(no output)"), so a parent read it as death and spawned a successor into
  // the still-live child's git worktree. These pin the two apart.
  it("announces an unobserved child stop as an expired wait, not as a death", async () => {
    await runAnnounceFlowForTest("run-timeout-wait-expiry", {
      outcome: { status: "timeout", timeoutDisposition: "child-unconfirmed" },
      roundOneReply: undefined,
    });

    const directAgentCall = findFinalDirectAgentCall();
    const internalEvents =
      (directAgentCall?.params?.internalEvents as Array<{
        status?: string;
        statusLabel?: string;
        result?: string;
        replyInstruction?: string;
      }>) ?? [];
    const event = internalEvents[0];
    expect(event?.status).toBe("timeout");
    expect(event?.statusLabel).toContain("wait expired");
    expect(event?.statusLabel).toContain("may still be running");
    // The old wording is what read as death; it must not survive here.
    expect(event?.statusLabel).not.toBe("timed out");
    expect(event?.result).not.toBe("(no output)");
    expect(event?.result).toContain("may still be working");
    // The successor-spawn is the damaging move, so the instruction says so.
    expect(event?.replyInstruction).toContain("successor");
    expect(event?.replyInstruction).not.toContain("A completed");
  });

  it("still announces an observed child run timeout as terminal", async () => {
    await runAnnounceFlowForTest("run-timeout-child-stopped", {
      outcome: { status: "timeout", timeoutDisposition: "child-stopped" },
      roundOneReply: undefined,
    });

    const directAgentCall = findFinalDirectAgentCall();
    const internalEvents =
      (directAgentCall?.params?.internalEvents as Array<{
        status?: string;
        statusLabel?: string;
        result?: string;
        replyInstruction?: string;
      }>) ?? [];
    const event = internalEvents[0];
    expect(event?.status).toBe("timeout");
    expect(event?.statusLabel).toBe("timed out");
    expect(event?.result).toBe("(no output)");
    expect(event?.replyInstruction).not.toContain("successor");
  });

  it("keeps a real child reply as the result when only the wait expired", async () => {
    await runAnnounceFlowForTest("run-timeout-wait-expiry-with-output", {
      outcome: { status: "timeout", timeoutDisposition: "child-unconfirmed" },
      roundOneReply: "partial progress so far",
    });

    const directAgentCall = findFinalDirectAgentCall();
    const internalEvents =
      (directAgentCall?.params?.internalEvents as Array<{
        statusLabel?: string;
        result?: string;
      }>) ?? [];
    expect(internalEvents[0]?.result).toBe("partial progress so far");
    expect(internalEvents[0]?.statusLabel).toContain("wait expired");
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
    // The absence of child output is a fact on the event, not just display copy.
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

// A wait that expires while the child keeps working produced an event reading
// `status: timed out` / `(no output)` / `tokens 0`: three independent signals
// all saying the child died. A parent acted on it and spawned a successor into
// the live child's git worktree. Every one of those signals is pinned here.
describe("subagent announce still-running disposition", () => {
  beforeEach(() => {
    gatewayCalls.length = 0;
    chatHistoryMessages = [];
    callGatewayImpl = async (request) => {
      if (request.method === "chat.history") {
        return { messages: [] };
      }
      return {};
    };
    // Token counters exist but are mid-turn zeros, exactly as observed: the
    // child had not flushed usage because it had not finished.
    sessionStore = {
      "agent:main:subagent:worker": { sessionId: "child-session", inputTokens: 0, outputTokens: 0 },
    };
    configOverride = { session: defaultSessionConfig };
    requesterDepthResolver = () => 0;
    subagentSessionRunActive = true;
    shouldIgnorePostCompletion = false;
    pendingDescendantRuns = 0;
    isEmbeddedAgentRunActiveMock.mockReset().mockReturnValue(false);
    waitForEmbeddedAgentRunEndMock.mockReset().mockResolvedValue(true);
    fallbackRequesterResolution = null;
  });

  const runWaitExpiryAnnounce = async (
    runId: string,
    disposition?: "still-running",
    error?: string,
  ) =>
    await runAnnounceFlowForTest(runId, {
      outcome: {
        status: "timeout",
        ...(error ? { error } : {}),
        ...(disposition ? { disposition } : {}),
      },
      roundOneReply: undefined,
      startedAt: 1_000,
      endedAt: 5_401_000,
    });

  const readAnnouncedEvent = () => {
    const directAgentCall = findFinalDirectAgentCall();
    const [event] =
      (directAgentCall?.params?.internalEvents as Array<{
        statusLabel?: string;
        disposition?: string;
        result?: string;
        statsLine?: string;
      }>) ?? [];
    const message = directAgentCall?.params?.message;
    return { event, message: typeof message === "string" ? message : "" };
  };

  it("reports a live child as still running instead of timed out", async () => {
    await runWaitExpiryAnnounce("run-wait-expiry-live", "still-running");

    const { event, message } = readAnnouncedEvent();
    expect(event?.disposition).toBe("still-running");
    expect(event?.statusLabel).toBe(
      "wait expired; child stop NOT observed — it may still be running",
    );
    expect(event?.result).toBe(
      "(no output observed before this wait expired; the child may still be working — re-check before acting on this)",
    );
    expect(event?.statsLine).toBe("Stats: waited 1h30m • child tokens not yet reported");
    // The rendered prompt is what a parent actually reads, so assert there too:
    // no "timed out", no "(no output)", no zeroed token total.
    expect(message).toContain(
      "status: wait expired; child stop NOT observed — it may still be running",
    );
    expect(message).toContain("disposition: still-running");
    expect(message).not.toContain("timed out");
    expect(message).not.toContain("(no output)");
    expect(message).not.toContain("tokens 0");
  });

  it("tells the parent not to replace a child that has not stopped", async () => {
    await runWaitExpiryAnnounce("run-wait-expiry-instruction", "still-running");

    const { message } = readAnnouncedEvent();
    expect(message).toContain("is NOT known to have finished");
    expect(message).toContain("do not start a replacement");
  });

  it("keeps a private child's provisional wake parent-only", async () => {
    await runAnnounceFlowForTest("run-wait-expiry-private", {
      outcome: { status: "timeout", disposition: "still-running" },
      roundOneReply: undefined,
      expectsCompletionMessage: true,
      completionTarget: "parent",
      completionRequesterSessionId: "private-parent",
      requesterOrigin: { channel: "discord", to: "chan-main", accountId: "acct-main" },
      suppressChildSessionEffects: true,
      startedAt: 1_000,
      endedAt: 5_401_000,
    });

    // Delivery decides the external target from this field alone; the
    // provisional wake must hand it over exactly like a terminal announce.
    expect(findFinalDirectAgentCall()?.params?.completionTarget).toBe("parent");
    const { message } = readAnnouncedEvent();
    expect(message).toContain("is NOT known to have finished");
    expect(message).toContain("Your final reply stays internal; no external response is required.");
    expect(message).not.toContain("to the user");
  });

  it("preserves the last retry-grace error while reporting the child as live", async () => {
    await runWaitExpiryAnnounce(
      "run-wait-expiry-error-grace",
      "still-running",
      "model returned an unrecoverable tool-call sequence",
    );

    const { event, message } = readAnnouncedEvent();
    expect(event?.statusLabel).toBe(
      "wait expired; child stop NOT observed — it may still be running (last error while retrying: model returned an unrecoverable tool-call sequence)",
    );
    expect(message).toContain("last error while retrying");
    expect(message).toContain("model returned an unrecoverable tool-call sequence");
  });

  it("still reports a genuinely stopped child as timed out", async () => {
    await runWaitExpiryAnnounce("run-wait-expiry-exited");

    const { event, message } = readAnnouncedEvent();
    expect(event?.disposition).toBe("exited");
    expect(event?.statusLabel).toBe("timed out");
    expect(event?.result).toBe("(no output)");
    expect(event?.statsLine).toBe("Stats: runtime 1h30m • tokens 0 (in 0 / out 0)");
    expect(message).toContain("status: timed out");
    expect(message).toContain("disposition: exited");
  });

  it("never submits delete cleanup for a session the live child still owns", async () => {
    // onBeforeDeleteChildSession is the delete-submission fence; reaching it at
    // all means the flow was about to remove a running child's session.
    const onBeforeDeleteChildSession = vi.fn(() => true);

    await runAnnounceFlowForTest("run-wait-expiry-no-delete", {
      outcome: { status: "timeout", disposition: "still-running" },
      roundOneReply: undefined,
      cleanup: "delete",
      onBeforeDeleteChildSession,
    });

    expect(onBeforeDeleteChildSession).not.toHaveBeenCalled();
  });

  it("keeps a terminal timeout exited when the embedded active map lags", async () => {
    isEmbeddedAgentRunActiveMock.mockReset().mockReturnValue(true);
    waitForEmbeddedAgentRunEndMock.mockReset().mockResolvedValue(false);

    await runAnnounceFlowForTest("run-wait-expiry-embedded-active", {
      outcome: { status: "timeout" },
      roundOneReply: undefined,
      cleanup: "keep",
    });

    const { event } = readAnnouncedEvent();
    expect(event?.disposition).toBe("exited");
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
