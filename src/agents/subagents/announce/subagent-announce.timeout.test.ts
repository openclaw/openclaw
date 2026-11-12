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

  it("gives a provisional wait-expiry wake a distinct delivery identity", async () => {
    await timeout("run-phased-delivery", {
      outcome: { status: "timeout", disposition: "still-running" },
      deliveryPhase: "wait-expiry",
    });
    const provisionalKey = deliver.mock.calls[0]?.[0].directIdempotencyKey;

    deliver.mockClear();
    await timeout("run-phased-delivery");
    const terminalKey = deliver.mock.calls[0]?.[0].directIdempotencyKey;

    expect(provisionalKey).toBe(
      "announce:v1:agent:main:subagent:worker:run-phased-delivery:wait-expiry",
    );
    expect(terminalKey).toBe("announce:v1:agent:main:subagent:worker:run-phased-delivery");
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

// A wait that expires while the child keeps working produced an event reading
// `status: timed out` / `(no output)` / `tokens 0`: three independent signals
// all saying the child died. A parent acted on it and spawned a successor into
// the live child's git worktree. Every one of those signals is pinned here.
describe("subagent announce still-running disposition", () => {
  beforeEach(() => {
    callGateway.mockClear();
    deliver.mockClear();
    chatHistoryMessages = [];
    // Token counters exist but are mid-turn zeros, exactly as observed: the
    // child had not flushed usage because it had not finished.
    sessionStore = {
      "agent:main:subagent:worker": { sessionId: "child-session", inputTokens: 0, outputTokens: 0 },
    };
    isActive.mockReset().mockReturnValue(false);
    waitForEnd.mockReset().mockResolvedValue(true);
  });

  const waitExpiry = (
    childRunId: string,
    disposition?: "still-running",
    error?: string,
  ): ReturnType<typeof runSubagentAnnounceFlow> =>
    timeout(childRunId, {
      outcome: {
        status: "timeout",
        ...(error ? { error } : {}),
        ...(disposition ? { disposition } : {}),
      },
      startedAt: 1_000,
      endedAt: 5_401_000,
    });

  // The rendered prompt is what a parent actually reads, so assert there too.
  const triggerMessage = () => deliver.mock.calls[0]?.[0].triggerMessage ?? "";

  it("reports a live child as still running instead of timed out", async () => {
    await waitExpiry("run-wait-expiry-live", "still-running");

    expect(completionEvent()).toMatchObject({
      disposition: "still-running",
      statusLabel: "still running; the wait for it expired, it did not",
      result: "(no result yet; child still running)",
      statsLine: "Stats: waited 1h30m • child tokens not yet reported",
    });
    expect(triggerMessage()).toContain(
      "status: still running; the wait for it expired, it did not",
    );
    expect(triggerMessage()).toContain("disposition: still-running");
    expect(triggerMessage()).not.toContain("timed out");
    expect(triggerMessage()).not.toContain("(no output)");
    expect(triggerMessage()).not.toContain("tokens 0");
  });

  it("tells the parent not to replace a child that has not stopped", async () => {
    await waitExpiry("run-wait-expiry-instruction", "still-running");

    expect(triggerMessage()).toContain("has NOT finished");
    expect(triggerMessage()).toContain("do not start a replacement");
  });

  it("preserves the last retry-grace error while reporting the child as live", async () => {
    await waitExpiry(
      "run-wait-expiry-error-grace",
      "still-running",
      "model returned an unrecoverable tool-call sequence",
    );

    expect(completionEvent()).toMatchObject({
      statusLabel:
        "still running; last error while retrying: model returned an unrecoverable tool-call sequence",
    });
    expect(triggerMessage()).toContain("last error while retrying");
    expect(triggerMessage()).toContain("model returned an unrecoverable tool-call sequence");
  });

  it("still reports a genuinely stopped child as timed out", async () => {
    await waitExpiry("run-wait-expiry-exited");

    expect(completionEvent()).toMatchObject({
      disposition: "exited",
      statusLabel: "timed out",
      result: "(no output)",
      statsLine: "Stats: runtime 1h30m • tokens 0 (in 0 / out 0)",
    });
    expect(triggerMessage()).toContain("status: timed out");
    expect(triggerMessage()).toContain("disposition: exited");
  });

  it("never submits delete cleanup for a session the live child still owns", async () => {
    // onBeforeDeleteChildSession is the delete-submission fence; reaching it at
    // all means the flow was about to remove a running child's session.
    const onBeforeDeleteChildSession = vi.fn(() => true);

    await timeout("run-wait-expiry-no-delete", {
      outcome: { status: "timeout", disposition: "still-running" },
      cleanup: "delete",
      onBeforeDeleteChildSession,
    });

    expect(onBeforeDeleteChildSession).not.toHaveBeenCalled();
  });

  it("keeps a terminal timeout exited when the embedded active map lags", async () => {
    isActive.mockReset().mockReturnValue(true);
    waitForEnd.mockReset().mockResolvedValue(false);

    await timeout("run-wait-expiry-embedded-active", { cleanup: "keep" });

    expect(completionEvent()).toMatchObject({ disposition: "exited" });
  });
});
