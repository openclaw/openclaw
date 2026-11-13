import { beforeEach, describe, expect, it, vi } from "vitest";
import type { deliverSubagentAnnouncement } from "./subagent-announce-delivery.js";
import { createSubagentAnnounceDeliveryRuntimeMock } from "./subagent-announce.test-support.js";

let sessionStore: Record<string, Record<string, unknown>> = {};
const configOverride = { session: { mainKey: "main", scope: "per-sender" } } as const;
const isActive = vi.fn((_sessionId: string) => false);
const waitForEnd = vi.fn(async (_sessionId: string, _timeoutMs?: number) => true);
let chatHistoryMessages: Array<Record<string, unknown>> = [];

const callGateway = vi.fn(async (request: unknown) =>
  request && typeof request === "object" && "method" in request && request.method === "chat.history"
    ? { messages: chatHistoryMessages }
    : {},
);
const deliver = vi.fn<typeof deliverSubagentAnnouncement>(async () => ({
  delivered: true,
  path: "direct",
}));

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

// mock-isolation: Timeout fixtures supply Gateway history and delivery replies without a live Gateway.
vi.mock("../../../gateway/call.js", () => ({
  callGateway: (request: unknown) => callGateway(request),
}));
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
// mock-isolation: timeout tests replace the complete transport runtime with deterministic adapters.
vi.mock("./subagent-announce-delivery.runtime.js", () =>
  createSubagentAnnounceDeliveryRuntimeMock({
    callGateway: (request) => callGateway(request),
    getRuntimeConfig: () => configOverride,
    loadSessionStore: () => sessionStore,
    resolveMainSessionKey: () => "agent:main:main",
    resolveSessionStorePathCore: () => "/tmp/sessions-main.json",
    isSessionRunActive: (sessionId: string) => isActive(sessionId),
  }),
);
// mock-isolation: The fixture controls delivery deadlines and requester records without starting transport or session-store work.
vi.mock("./subagent-announce-delivery.js", () => ({
  deliverSubagentAnnouncement: (...args: Parameters<typeof deliverSubagentAnnouncement>) =>
    deliver(...args),
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
  callSubagentLifecycleGateway: (request: unknown) => callGateway(request),
  getRuntimeConfig: () => configOverride,
  readSessionMessagesAsync: vi.fn(async () => []),
  readSubagentSessionEntry: (_storePath: string, sessionKey: string) => sessionStore[sessionKey],
  resolveSessionStorePathCore: () => "/tmp/sessions-main.json",
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

const completionEvent = () => deliver.mock.calls[0]?.[0].internalEvents?.[0];

describe("subagent announce timeout config", () => {
  beforeEach(() => {
    callGateway.mockClear();
    deliver.mockClear();
    chatHistoryMessages = [];
    sessionStore = {};
    isActive.mockReset().mockReturnValue(false);
    waitForEnd.mockReset().mockResolvedValue(true);
  });

  it("regression, keeps child announce internal when requester is a cron run session", async () => {
    const cronSessionKey = "agent:main:cron:daily-check:run:run-123";

    await announce("cron-internal", {
      requesterSessionKey: cronSessionKey,
      requesterOrigin: { channel: "discord", to: "channel:cron-results", accountId: "acct-1" },
    });

    expect(deliver.mock.calls[0]?.[0]).toMatchObject({
      targetRequesterSessionKey: cronSessionKey,
      requesterIsSubagent: true,
    });
  });

  it("keeps authoritative silence on timeout without transcript inference", async () => {
    chatHistoryMessages = [textAssistant("stale transcript output")];

    await timeout("silent", { terminalReply: { disposition: "silent" } });

    expect(deliver).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("keeps authoritative empty success intentional without transcript inference", async () => {
    chatHistoryMessages = [textAssistant("stale transcript output")];

    await announce("empty", {
      roundOneReply: undefined,
      terminalReply: { disposition: "empty" },
    });

    expect(completionEvent()).toMatchObject({ result: "(no output)", noVisibleResult: true });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("keeps delete-mode timeout retryable while the embedded child request is still active", async () => {
    sessionStore["agent:main:subagent:worker"] = { sessionId: "child-session" };
    isActive.mockReturnValue(true);
    waitForEnd.mockResolvedValue(false);

    const didAnnounce = await timeout("active-delete", { cleanup: "delete" });

    expect(didAnnounce).toBe("retryable");
    expect(deliver).not.toHaveBeenCalled();
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

    expect(completionEvent()).toMatchObject({
      status: "error",
      statusLabel: expect.stringContaining("All models failed"),
      result: "(no output)",
      noVisibleResult: true,
    });
    expect(deliver.mock.calls[0]?.[0].triggerMessage).not.toContain("stale");
    expect(deliver.mock.calls[0]?.[0].triggerMessage).not.toContain("older fallback");
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
    expect(completionEvent()).toMatchObject({ result: expected });
    expect(completionEvent()).not.toMatchObject({
      result: expect.stringContaining("private tool output"),
    });
  });
});
