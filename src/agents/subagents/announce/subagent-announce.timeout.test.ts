import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { deliverSubagentAnnouncement } from "./subagent-announce-delivery.js";
import {
  announceTesting,
  outputTesting,
  setSubagentAnnounceDeliveryDepsForTest,
} from "./subagent-announce-overrides.test-support.js";

type GatewayCall = {
  method?: string;
  timeoutMs?: number;
  expectFinal?: boolean;
  params?: Record<string, unknown>;
};

const gatewayCalls: GatewayCall[] = [];
let sessionStore: Record<string, SessionEntry | undefined> = {};
const storePath = "/tmp/sessions-main.json";
const configOverride = {
  session: { mainKey: "main", scope: "per-sender", store: storePath },
} as const;
const isActive = vi.fn((_sessionId: string) => false);
const waitForEnd = vi.fn(async (_sessionId: string, _timeoutMs?: number) => true);
let chatHistoryMessages: Array<Record<string, unknown>> = [];

async function callGateway(request: GatewayCall) {
  gatewayCalls.push(request);
  return request.method === "chat.history" ? { messages: chatHistoryMessages } : {};
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

vi.mock("../../../sessions/session-controller.queries.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../sessions/session-controller.queries.js")>()),
  isSessionRunActive: (sessionId: string) => isActive(sessionId),
}));
vi.mock("../../../sessions/session-controller.native-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../sessions/session-controller.native-runtime.js")
  >()),
  waitForSessionRunEnd: (sessionId: string, timeoutMs?: number) => waitForEnd(sessionId, timeoutMs),
}));
// mock-isolation: Timeout scenarios supply requester depth directly without opening a session database.
vi.mock("../spawn/subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: () => 0,
  getSubagentDepthFromSessionStoreInWorker: async () => 0,
}));
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
        internalEvents: params.internalEvents,
        ...(params.requesterIsSubagent
          ? {}
          : {
              channel: params.completionDirectOrigin?.channel,
              to: params.completionDirectOrigin?.to,
              accountId: params.completionDirectOrigin?.accountId,
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
// mock-isolation: Timeout scenarios use synthetic requester state instead of the live subagent registry.
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

async function announce(
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

function timeout(childRunId: string, overrides: Partial<AnnounceFlowParams> = {}) {
  return announce(childRunId, {
    outcome: { status: "timeout" },
    roundOneReply: undefined,
    ...overrides,
  });
}

function directCall(): GatewayCall | undefined {
  return gatewayCalls.find((call) => call.method === "agent" && call.expectFinal === true);
}

function completionEvent() {
  return (
    directCall()?.params?.internalEvents as Array<{
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
    isActive.mockReset().mockReturnValue(false);
    waitForEnd.mockReset().mockResolvedValue(true);
    const gatewayDeps = { callGateway, getRuntimeConfig: () => configOverride };
    announceTesting.setDepsForTest(gatewayDeps);
    outputTesting.setDepsForTest({
      ...gatewayDeps,
      readSessionMessagesAsync: async () => [],
      readSubagentSessionEntry: (_storePath, sessionKey) => sessionStore[sessionKey],
      resolveSessionStorePathCore: () => storePath,
    });
    setSubagentAnnounceDeliveryDepsForTest({
      ...gatewayDeps,
      loadSessionEntry: (scope) => sessionStore[scope.sessionKey],
    });
  });
  afterEach(() => {
    setSubagentAnnounceDeliveryDepsForTest();
    outputTesting.setDepsForTest();
    announceTesting.setDepsForTest();
  });

  it("regression, keeps child announce internal when requester is a cron run session", async () => {
    const cronSessionKey = "agent:main:cron:daily-check:run:run-123";

    await announce("cron-internal", {
      requesterSessionKey: cronSessionKey,
      requesterOrigin: { channel: "discord", to: "channel:cron-results", accountId: "acct-1" },
    });

    const { sessionKey, deliver, channel, to, accountId } = directCall()?.params ?? {};
    expect({ sessionKey, deliver, channel, to, accountId }).toEqual({
      sessionKey: cronSessionKey,
      deliver: false,
      channel: undefined,
      to: undefined,
      accountId: undefined,
    });
  });

  it("keeps authoritative silence on timeout without transcript inference", async () => {
    chatHistoryMessages = [textAssistant("stale transcript output")];

    await timeout("silent", { terminalReply: { disposition: "silent" } });

    expect(directCall()).toBeUndefined();
    expect(gatewayCalls.some((call) => call.method === "chat.history")).toBe(false);
  });

  it("keeps authoritative empty success intentional without transcript inference", async () => {
    chatHistoryMessages = [textAssistant("stale transcript output")];

    await announce("empty", {
      roundOneReply: undefined,
      terminalReply: { disposition: "empty" },
    });

    expect(completionEvent()).toMatchObject({ result: "(no output)", noVisibleResult: true });
    expect(gatewayCalls.some((call) => call.method === "chat.history")).toBe(false);
  });

  it("keeps delete-mode timeout retryable while the embedded child request is still active", async () => {
    sessionStore["agent:main:subagent:worker"] = { sessionId: "child-session", updatedAt: 1 };
    isActive.mockReturnValue(true);
    waitForEnd.mockResolvedValue(false);

    const didAnnounce = await timeout("active-delete", { cleanup: "delete" });

    expect(didAnnounce).toBe("retryable");
    expect(directCall()).toBeUndefined();
  });

  it("does not announce cached reply text when the child run terminally failed", async () => {
    chatHistoryMessages = [
      textAssistant("stale history output"),
      { role: "toolResult", content: [{ type: "text", text: "stale tool output" }] },
    ];

    await announce("failed", {
      outcome: { status: "error", error: "All models failed (2): timeout" },
      roundOneReply: "stale frozen output",
      fallbackReply: "older fallback output",
    });

    const directAgentCall = directCall();
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
      "uses timeout progress without replacing an authoritative empty terminal fact",
      [
        { role: "user", content: "do a complex task" },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
        },
        { role: "toolResult", toolCallId: "call-1", content: "private tool output" },
      ],
      "1 tool call(s) made without visible output.",
    ],
    [
      "reports tool progress when a later tool invalidates timeout silence",
      [
        ...createTimeoutHistoryWithNoReply(),
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call2", name: "exec", arguments: {} }],
        },
      ],
      "2 tool call(s) made without visible output.",
    ],
    [
      "prefers later visible assistant progress over an earlier NO_REPLY marker",
      [
        ...createTimeoutHistoryWithNoReply(),
        textAssistant("A longer partial summary that should stay silent."),
      ],
      expect.stringContaining("A longer partial summary that should stay silent."),
    ],
  ] as const)("%s", async (_name, history, expected) => {
    chatHistoryMessages = [...history];
    await timeout("progress", { terminalReply: { disposition: "empty" } });
    expect(completionEvent()?.result).toEqual(expected);
    expect(completionEvent()?.result).not.toContain("private tool output");
  });
});
