import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { projectAgentToolActivity } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { GetReplyOptions, ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import {
  testing as sessionBindingTesting,
  registerSessionBindingAdapter,
} from "openclaw/plugin-sdk/session-binding-runtime";
import {
  normalizeSessionDeliveryState,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { peekSystemEventEntries } from "openclaw/plugin-sdk/system-event-runtime";
import { createRequireRecord, resetSystemEventsForTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import type { MatrixStreamingConfig } from "../../types.js";
import { MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY } from "../send/types.js";
import { registerMatrixLiveAllowlistTests } from "./handler.live-allowlist.test-support.js";
import { registerMatrixPreviewDeliveryTests } from "./handler.preview-delivery.test-support.js";
import {
  createMatrixHandlerTestHarness as createHarness,
  createMatrixReactionEvent,
  createMatrixReactionTestHarness,
  createMatrixRoomMessageEvent,
  createMatrixTextMessageEvent as textEvent,
} from "./handler.test-helpers.js";
import { stripMatrixMentionPrefix } from "./mentions.js";

// Core owns the shared gate (DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS); plugins
// cannot import it, so mirror the value here for start-boundary assertions.
const PROGRESS_DRAFT_START_DELAY_MS = 1_500;
const ROOM = "!room:example.org";

const sendMessageMatrixMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ messageId: "evt", roomId: "!room" })),
);
const sendDraftMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ messageId: "$draft1", roomId: "!room" })),
);
const editMock = vi.hoisted(() => vi.fn(async () => "$edited"));
const sendTypingMatrixMock = vi.hoisted(() => vi.fn(async () => {}));
const { prepareMatrixSingleTextMock, prepareSingleText } = vi.hoisted(() => {
  const prepare = (text: string) => {
    const trimmedText = text.trim();
    return {
      trimmedText,
      convertedText: trimmedText,
      singleEventLimit: 4000,
      fitsInSingleEvent: true,
    };
  };
  return { prepareMatrixSingleTextMock: vi.fn(prepare), prepareSingleText: prepare };
});
const resolveMatrixMentionsForBodyMock = vi.hoisted(() =>
  vi.fn(async ({ body }: { body: string }) => {
    const userIds = Array.from(body.matchAll(/@[A-Za-z0-9._=/-]+:[^\s`<]+/g), (match) => match[0]);
    return {
      ...(body.includes("@room") ? { room: true } : {}),
      ...(userIds.length > 0 ? { user_ids: userIds } : {}),
    };
  }),
);
const getGlobalHookRunnerMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>();
  return { ...actual, getGlobalHookRunner: getGlobalHookRunnerMock };
});

// mock-isolation: Keep Matrix network sends inert while testing monitor routing and delivery decisions.
vi.mock("../send.js", () => ({
  editMessageMatrix: editMock,
  prepareMatrixSingleText: prepareMatrixSingleTextMock,
  reactMatrixMessage: vi.fn(async () => {}),
  resolveMatrixMentionsForBody: resolveMatrixMentionsForBodyMock,
  sendMessageMatrix: sendMessageMatrixMock,
  sendSingleTextMessageMatrix: sendDraftMock,
  sendReadReceiptMatrix: vi.fn(async () => {}),
  sendTypingMatrix: sendTypingMatrixMock,
}));

const deliverRepliesMock = vi.hoisted(() => vi.fn());

vi.mock("./replies.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./replies.js")>()),
  deliverMatrixReplies: deliverRepliesMock,
}));

function receiveText(
  handler: ReturnType<typeof createHarness>["handler"],
  event: Parameters<typeof textEvent>[0],
  roomId = ROOM,
) {
  return handler(roomId, textEvent(event));
}

function waitForState<T>(
  assertion: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
): Promise<T> {
  return vi.waitFor(assertion, { interval: 1, ...options });
}

type SessionOrigin = {
  chatType: "direct" | "group";
  from: string;
  to: string;
  nativeChannelId?: string;
};

function threadRoot(eventId = "$root", body = "Root topic") {
  return textEvent({ eventId, sender: "@alice:example.org", body });
}

function agentRoute(sessionKey = "agent:ops:main") {
  return {
    agentId: "ops",
    channel: "matrix",
    accountId: "ops",
    sessionKey,
    mainSessionKey: "agent:ops:main",
    matchedBy: "binding.account" as const,
  };
}

function threadRelation(root = "$root") {
  return { rel_type: "m.thread", event_id: root, "m.in_reply_to": { event_id: root } };
}

function dispatchResult(final = 0, block = 0) {
  return { queuedFinal: final > 0, counts: { final, block, tool: 0 } };
}

function replyDispatcher(waitForIdle = async () => {}) {
  return {
    dispatcher: { markComplete: () => {}, waitForIdle },
    replyOptions: {},
    markDispatchIdle: () => {},
    markRunComplete: () => {},
  };
}

beforeEach(() => {
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  installMatrixMonitorTestRuntime();
  getGlobalHookRunnerMock.mockReset().mockReturnValue(null);
  prepareMatrixSingleTextMock.mockReset().mockImplementation(prepareSingleText);
  resolveMatrixMentionsForBodyMock.mockClear();
  sendMessageMatrixMock.mockReset().mockResolvedValue({ messageId: "evt", roomId: "!room" });
  sendTypingMatrixMock.mockReset().mockResolvedValue(undefined);
  deliverRepliesMock.mockReset().mockResolvedValue(deliveryResult());
});

afterEach(() => {
  resetSystemEventsForTest();
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const requireRecord = createRequireRecord("object", "expected-label");

function requireArray(value: unknown, label: string): Array<unknown> {
  expect(Array.isArray(value), label).toBe(true);
  return value as Array<unknown>;
}

function mockCalls(mock: unknown, label: string): unknown[][] {
  if (!vi.isMockFunction(mock)) {
    throw new Error(`${label} was not a mock`);
  }
  return mock.mock.calls;
}

function callArg(mock: unknown, callIndex: number, argIndex: number, label: string) {
  return expectDefined(mockCalls(mock, label).at(callIndex), label)[argIndex];
}

function recordArg(mock: unknown, callIndex: number, argIndex: number, label: string) {
  return requireRecord(callArg(mock, callIndex, argIndex, label), label);
}

function lastCallArg(mock: unknown, argIndex: number, label: string) {
  return callArg(mock, -1, argIndex, label);
}

function draftBody(callIndex = 0) {
  return callArg(sendDraftMock, callIndex, 1, "single text message body");
}

function expectNoCalls(...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

function expectRuntimeErrorContaining(mock: unknown, text: string) {
  const matched = mockCalls(mock, "runtime error").some(([message]) =>
    String(message).includes(text),
  );
  expect(matched).toBe(true);
}

function findMockCall(mock: unknown, label: string, predicate: (call: unknown[]) => boolean) {
  return expectDefined(mockCalls(mock, label).find(predicate), label);
}

function matrixEditOptions(eventId: string, body: string, roomId = ROOM) {
  const call = findMockCall(
    editMock,
    `edit call for ${eventId}`,
    ([room, id, text]) => room === roomId && id === eventId && text === body,
  );
  return requireRecord(call[3], "edit options");
}

function expectFinalizedPreviewEdit(eventId: string, text: string) {
  expect(matrixEditOptions(eventId, text).extraContent).toEqual({
    [MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY]: true,
  });
}

function expectDeliveredMediaReply() {
  const payload = requireRecord(
    lastCallArg(deliverRepliesMock, 0, "deliver replies payload"),
    "deliver replies payload",
  );
  const replies = requireArray(payload.replies, "deliver replies");
  const reply = requireRecord(replies[0], "media reply");
  expect(reply.mediaUrl).toBe("https://example.com/image.png");
  expect(reply.text).toBeUndefined();
}

function deliveryResult(messageId = "$reply1", content = "delivered") {
  return {
    messageIds: [messageId],
    receipt: {
      primaryPlatformMessageId: messageId,
      platformMessageIds: [messageId],
      parts: [{ platformMessageId: messageId, kind: "text" as const, index: 0 }],
      sentAt: 1,
    },
    visibleReplySent: true,
    content,
  };
}

type HarnessOptions = NonNullable<Parameters<typeof createHarness>[0]>;
const noticeDirs = useSessionStoreTempDirs(afterAll, "matrix-dm-notice-");

function registerTestBinding(conversationId: string, parentConversationId?: string) {
  const touch = vi.fn();
  registerSessionBindingAdapter({
    channel: "matrix",
    accountId: "ops",
    listBySession: () => [],
    resolveByConversation: (ref) =>
      ref.conversationId === conversationId
        ? {
            bindingId: `ops:${parentConversationId ?? ""}:${conversationId}`,
            targetSessionKey: "agent:bound:session-1",
            targetKind: "session",
            conversation: {
              channel: "matrix",
              accountId: "ops",
              conversationId,
              parentConversationId,
            },
            status: "active",
            boundAt: Date.now(),
          }
        : null,
    touch,
  });
  return touch;
}

async function createDmNoticeHarness(
  options: HarnessOptions = {},
  params: {
    sessionKey?: string;
    origin?: SessionOrigin | null;
    sendNotice?: ReturnType<typeof vi.fn<() => Promise<string>>>;
  } = {},
) {
  const storePath = path.join(noticeDirs.make(), "sessions.json");
  const sessionKey = params.sessionKey ?? "agent:ops:main";
  const priorDm: SessionOrigin = {
    chatType: "direct",
    from: "matrix:@user:example.org",
    to: "room:!other:example.org",
    nativeChannelId: "!other:example.org",
  };
  const delivery =
    params.origin === null
      ? { context: { channel: "matrix", to: "room:!other:example.org", accountId: "ops" } }
      : {
          origin: {
            provider: "matrix",
            surface: "matrix",
            accountId: "ops",
            ...(params.origin ?? priorDm),
          },
        };
  await upsertSessionEntry({
    storePath,
    sessionKey,
    entry: {
      sessionId: `sess-${sessionKey}`,
      updatedAt: Date.now(),
      delivery: normalizeSessionDeliveryState(delivery),
    },
  });
  const sendNotice = params.sendNotice ?? vi.fn(async () => "$notice");
  const harness = createHarness({
    isDirectMessage: true,
    ...options,
    cfg: {
      session: { store: storePath },
      channels: { matrix: { dm: { allowFrom: options.allowFrom ?? ["*"] } } },
    },
    client: { ...options.client, sendMessage: sendNotice },
  });
  const receive = (eventId: string) =>
    receiveText(harness.handler, { eventId, body: "follow up" }, "!dm:example.org");
  return { ...harness, storePath, sendNotice, receive };
}

describe("matrix monitor handler pairing account scope", () => {
  it("logs inbound UTF-16 length without a message preview", async () => {
    const logVerboseMessage = vi.fn();
    const { handler } = createHarness({ logVerboseMessage });
    await receiveText(handler, { eventId: "$event-preview", body: `${"x".repeat(199)}🚀tail` });
    expect(logVerboseMessage).toHaveBeenCalledWith(
      "matrix inbound: room=!room:example.org from=@user:example.org chars=205",
    );
    expect(logVerboseMessage).not.toHaveBeenCalledWith(expect.stringContaining("x".repeat(199)));
  });

  it.each(["main", "per-channel-peer"])(
    "pins the configured DM owner only when live dmScope is %s",
    async (dmScope) => {
      const channels = { matrix: { dm: { allowFrom: ["@owner:example.org"] } } };
      const { handler, recordInboundSession } = createHarness({
        cfg: dmScope === "main" ? { channels } : { session: { dmScope: "main" }, channels },
        ...(dmScope === "main" ? {} : { liveCfg: { session: { dmScope }, channels } }),
        dmPolicy: "allowlist",
        allowFrom: ["@owner:example.org"],
        allowFromResolvedEntries: [{ input: "@owner:example.org", id: "@owner:example.org" }],
        isDirectMessage: true,
      });
      await receiveText(
        handler,
        { eventId: "$owner-dm", sender: "@owner:example.org", body: "hello" },
        "!dm:example.org",
      );
      expect(recordInboundSession).toHaveBeenCalledTimes(1);
      const inbound = recordArg(recordInboundSession, 0, 0, "record inbound session");
      const route = requireRecord(inbound.updateLastRoute, "last route update");
      expect(route).toMatchObject({ channel: "matrix", to: "room:!dm:example.org" });
      if (dmScope === "main") {
        const ownerPin = requireRecord(route.mainDmOwnerPin, "main DM owner pin");
        expect(ownerPin).toMatchObject({
          ownerRecipient: "@owner:example.org",
          senderRecipient: "@owner:example.org",
        });
      } else {
        expect(route.mainDmOwnerPin).toBeUndefined();
      }
    },
  );

  it("accepts room messages from configured Matrix bot accounts when allowBots is true", async () => {
    const { handler, recordInboundSession, runPrepared } = createHarness({
      isDirectMessage: false,
      accountAllowBots: true,
      accountConfig: { botLoopProtection: { windowSeconds: 120, cooldownSeconds: 240 } },
      configuredBotUserIds: new Set(["@ops:example.org"]),
      roomsConfig: {
        [ROOM]: { requireMention: false, botLoopProtection: { maxEventsPerWindow: 3 } },
      },
      getMemberDisplayName: async () => "ops-bot",
    });
    await receiveText(handler, {
      eventId: "$bot-on",
      sender: "@ops:example.org",
      body: "hello from bot",
      originServerTs: 123_456,
    });
    expect(recordInboundSession).toHaveBeenCalled();
    expect(runPrepared.mock.calls[0]?.[0].ctxPayload.GroupRequireMention).toBe(false);
    expect(runPrepared.mock.calls[0]?.[0].botLoopProtection).toEqual({
      scopeId: "ops",
      conversationId: ROOM,
      senderId: "@ops:example.org",
      receiverId: "@bot:example.org",
      config: { maxEventsPerWindow: 3, windowSeconds: 120, cooldownSeconds: 240 },
      defaultsConfig: undefined,
      defaultEnabled: true,
      nowMs: 123_456,
    });
  });

  it.each([
    { name: "room override", accountAllowBots: true, roomAllowBots: false },
    { name: "missing mention", accountAllowBots: "mentions", roomAllowBots: undefined },
  ] as const)("gates configured bot senders: $name", async (scenario) => {
    const { handler, recordInboundSession } = createHarness({
      isDirectMessage: false,
      accountAllowBots: scenario.accountAllowBots,
      configuredBotUserIds: new Set(["@ops:example.org"]),
      roomsConfig: { [ROOM]: { requireMention: false, allowBots: scenario.roomAllowBots } },
      mentionRegexes: [/@bot/i],
    });
    await receiveText(handler, { eventId: "$bot-gate", sender: "@ops:example.org", body: "hello" });
    expect(recordInboundSession).not.toHaveBeenCalled();
  });

  it.each(["paired", "configured"])(
    "blocks room control commands from %s DM-only senders",
    async (source) => {
      const configured = source === "configured";
      const readAllowFromStore = vi.fn(async () => ["@user:example.org"]);
      const hasControlCommand = vi.fn((text?: string) => !configured || text === "/new");
      const { handler, finalizeInboundContext, recordInboundSession } = createHarness({
        isDirectMessage: false,
        readAllowFromStore,
        roomsConfig: { [ROOM]: { requireMention: false } },
        shouldHandleTextCommands: () => true,
        hasControlCommand,
        cfg: {
          commands: { useAccessGroups: true },
          ...(configured
            ? {
                channels: {
                  matrix: {
                    dm: { allowFrom: ["@observer:example.org"] },
                    groupAllowFrom: ["@driver:example.org"],
                  },
                },
              }
            : {}),
        },
        groupPolicy: "open",
        getMemberDisplayName: async () => (configured ? "observer" : "sender"),
      });
      await receiveText(handler, {
        eventId: "$dm-only-room-command",
        sender: configured ? "@observer:example.org" : "@user:example.org",
        body: configured ? "@bot:example.org /new" : "/config",
      });
      expectNoCalls(recordInboundSession, finalizeInboundContext);
      if (configured) {
        expect(callArg(hasControlCommand, 0, 0, "control command")).toBe("/new");
        requireRecord(
          callArg(hasControlCommand, 0, 1, "control command"),
          "control command context",
        );
      } else {
        expect(readAllowFromStore).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps require-mention decision for unmentioned room command", async () => {
    const body = "/new";
    const { handler, finalizeInboundContext } = createHarness({
      cfg: { channels: { matrix: { groupAllowFrom: ["@user:example.org"] } } },
      isDirectMessage: false,
      groupAllowFrom: ["@user:example.org"],
      mentionRegexes: [],
      shouldHandleTextCommands: () => true,
      hasControlCommand: (text?: string) => text === body,
      getMemberDisplayName: async () => "sender",
    });
    await receiveText(handler, { eventId: "$unmentioned-command", body });
    expect(finalizeInboundContext).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["another homeserver", "hello @bot:evil.example", false, false, false],
    ["Unicode display name", "@欢欢 please reply", true, false, true],
    ["forged metadata only", "hello there", false, true, false],
  ] as const)(
    "validates native mentions: %s",
    async (_name, body, formatted, metadataOnly, accepted) => {
      const getMemberDisplayName = vi.fn(async () => (formatted ? "欢欢" : "sender"));
      const { handler, recordInboundSession, resolveAgentRoute } = createHarness({
        isDirectMessage: false,
        mentionRegexes: metadataOnly ? [/@bot/i] : [],
        getMemberDisplayName,
      });
      await handler(
        ROOM,
        createMatrixRoomMessageEvent({
          eventId: "$native-mention",
          content: {
            msgtype: "m.text",
            body,
            ...(formatted
              ? {
                  formatted_body:
                    '<a href="https://matrix.to/#/@bot:example.org">@欢欢</a> please reply',
                }
              : {}),
            "m.mentions": { user_ids: ["@bot:example.org"] },
          },
        }),
      );
      if (accepted) {
        expect(recordInboundSession).toHaveBeenCalledOnce();
      } else {
        expect(recordInboundSession).not.toHaveBeenCalled();
      }
      if (metadataOnly) {
        expect(resolveAgentRoute).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("drops root events that carry a bundled replacement relation", async () => {
    const { handler, recordInboundSession } = createHarness({
      isDirectMessage: false,
      mentionRegexes: [/@bot/i],
      getMemberDisplayName: async () => "sender",
    });
    await receiveText(handler, {
      eventId: "$edited-root",
      body: "@bot please reply",
      mentions: { user_ids: ["@bot:example.org"] },
      unsigned: { "m.relations": { "m.replace": { event_id: "$edit" } } },
    });
    expect(recordInboundSession).not.toHaveBeenCalled();
  });

  it("records thread context with flat DM routing", async () => {
    const getEvent = vi.fn(async (_roomId: string, eventId: string) =>
      eventId === "$root"
        ? threadRoot("$root", "Root topic")
        : textEvent({ eventId, sender: "@bot:example.org", body: "" }),
    );
    const { handler, finalizeInboundContext, recordInboundSession } = createHarness({
      client: { getEvent },
      isDirectMessage: true,
      threadReplies: "always",
      dmThreadReplies: "off",
      getMemberDisplayName: async (_roomId, userId) =>
        userId === "@alice:example.org" ? "Alice" : "sender",
    });
    await receiveText(
      handler,
      { eventId: "$reply1", body: "follow up", relatesTo: threadRelation("$root") },
      "!dm:example.org",
    );
    const context = recordArg(finalizeInboundContext, 0, 0, "finalized context");
    expect(context.ThreadStarterBody).toBe("Matrix thread root $root from Alice:\nRoot topic");
    expect(context.MessageThreadId).toBeUndefined();
    expect(context.ReplyToId).toBe("$root");
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "agent:ops:main" }),
    );
  });

  it("waits for a shared-session notice before dispatch and sends it only once", async () => {
    const entered = createDeferred<void>();
    const notice = createDeferred<string>();
    const sendNotice = vi.fn(() => {
      entered.resolve();
      return notice.promise;
    });
    const dispatchInboundMessage = vi.fn(async () => dispatchResult(0, 0));
    const sessionKey = "agent:ops:matrix:direct:@user:example.org";
    const { receive } = await createDmNoticeHarness(
      {
        dispatchInboundMessage,
        resolveAgentRoute: () => agentRoute(sessionKey),
      },
      { sessionKey, sendNotice },
    );
    const handled = receive("$dm1");
    try {
      await entered.promise;
      expect(dispatchInboundMessage).not.toHaveBeenCalled();
      expect(callArg(sendNotice, 0, 0, "send notice")).toBe("!dm:example.org");
      const noticeContent = recordArg(sendNotice, 0, 1, "notice content");
      expect(noticeContent.msgtype).toBe("m.notice");
      expect(String(noticeContent.body)).toContain("channels.matrix.dm.sessionScope");
    } finally {
      notice.resolve("$notice");
      await handled;
    }
    expect(dispatchInboundMessage).toHaveBeenCalledTimes(1);
    await receive("$dm2");
    expect(sendNotice).toHaveBeenCalledTimes(1);
  });

  it.each(["prior group", "per-room", "bound"])(
    "resolves shared DM collision notices for %s sessions",
    async (scenario) => {
      const touch = scenario === "bound" ? registerTestBinding("!dm:example.org") : undefined;
      const { receive, sendNotice, recordInboundSession } = await createDmNoticeHarness(
        scenario === "per-room" ? { dmSessionScope: "per-room" } : {},
        scenario === "prior group"
          ? {
              origin: {
                chatType: "group",
                from: "matrix:channel:!group:example.org",
                to: "room:!group:example.org",
                nativeChannelId: "!group:example.org",
              },
            }
          : scenario === "bound"
            ? { sessionKey: "agent:bound:session-1", origin: null }
            : scenario === "per-room"
              ? { origin: null }
              : {},
      );
      await receive("$dm1");
      expect(sendNotice).not.toHaveBeenCalled();
      if (scenario === "per-room") {
        expect(recordInboundSession).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionKey: "agent:ops:matrix:channel:!dm:example.org",
          }),
        );
      }
      if (touch) {
        expect(touch).toHaveBeenCalledOnce();
      }
    },
  );

  it("does not refresh bound Matrix thread bindings for room messages dropped before routing", async () => {
    const touch = registerTestBinding("$root", "!room:example");
    const { handler, recordInboundSession } = createHarness({
      client: {
        getEvent: async () => threadRoot("$root", "Root topic"),
      },
      isDirectMessage: false,
      getMemberDisplayName: async () => "sender",
    });
    await receiveText(
      handler,
      {
        eventId: "$reply-no-mention",
        body: "follow up without mention",
        relatesTo: threadRelation("$root"),
      },
      "!room:example",
    );
    expectNoCalls(recordInboundSession, touch);
  });

  it.each(["other author", "unauthorized DM"])("ignores reactions for %s", async (scenario) => {
    const { handler, resolveAgentRoute, upsertPairingRequest } = createMatrixReactionTestHarness({
      ...(scenario === "other author" ? { targetSender: "@other:example.org" } : {}),
      ...(scenario === "unauthorized DM" ? { dmPolicy: "pairing" } : {}),
    });
    await handler(
      ROOM,
      createMatrixReactionEvent({ eventId: "$reaction", targetEventId: "$msg", key: "👀" }),
    );
    expect(peekSystemEventEntries("agent:ops:main")).toEqual([]);
    if (scenario === "other author") {
      expect(resolveAgentRoute).not.toHaveBeenCalled();
    }
    if (scenario === "unauthorized DM") {
      expect(upsertPairingRequest).not.toHaveBeenCalled();
    }
  });
});

registerMatrixLiveAllowlistTests();

describe("matrix monitor handler failure handling", () => {
  it("sends a durable threaded notice after restart tombstone rejection", async () => {
    const callOrder: string[] = [];
    const runtime = { error: vi.fn() };
    const dispatchInboundMessage = vi.fn(async () => {
      callOrder.push("dispatch");
      throw Object.assign(new Error("session ended during restart recovery"), {
        code: "SESSION_RESTART_RECOVERY_TOMBSTONE",
      });
    });
    sendMessageMatrixMock.mockImplementationOnce(async () => {
      callOrder.push("notice");
      return { messageId: "$notice", roomId: ROOM };
    });
    const { handler } = createHarness({
      runtime: runtime as never,
      recordInboundSession: vi.fn(async () => {
        callOrder.push("record");
      }),
      isDirectMessage: false,
      roomsConfig: { [ROOM]: { requireMention: false } },
      client: {
        getEvent: async () => threadRoot("$thread-root", "Thread root"),
      },
      dispatchInboundMessage,
    });
    await receiveText(handler, {
      eventId: "$tombstone-event",
      body: "continue",
      relatesTo: threadRelation("$thread-root"),
    });
    expect(dispatchInboundMessage).toHaveBeenCalledOnce();
    expect(sendMessageMatrixMock).toHaveBeenCalledOnce();
    expect(callArg(sendMessageMatrixMock, 0, 0, "notice room")).toBe(ROOM);
    expect(String(callArg(sendMessageMatrixMock, 0, 1, "notice body"))).toContain(
      "Send /new or /reset",
    );
    expect(callArg(sendMessageMatrixMock, 0, 2, "notice options")).toMatchObject({
      accountId: "ops",
      replyToId: undefined,
      fallbackReplyToId: "$thread-root",
      threadId: "$thread-root",
      deliveryQueueId: "matrix:restart-recovery-tombstone:ops:!room:example.org:$tombstone-event",
      deliveryPartIndex: 0,
      deliveryPartCount: 1,
      extraContent: { msgtype: "m.notice" },
    });
    expect(runtime.error).not.toHaveBeenCalled();
    expect(callOrder).toEqual(["record", "dispatch", "notice"]);
  });

  it("propagates a failed restart tombstone notice for ingress retry", async () => {
    const runtime = { error: vi.fn() };
    sendMessageMatrixMock.mockRejectedValueOnce(new Error("homeserver unavailable"));
    const { handler } = createHarness({
      runtime: runtime as never,
      dispatchInboundMessage: vi.fn(async () => {
        throw Object.assign(new Error("session ended during restart recovery"), {
          code: "SESSION_RESTART_RECOVERY_TOMBSTONE",
        });
      }),
    });
    await expect(
      receiveText(handler, { eventId: "$tombstone-notice-failed", body: "continue" }),
    ).rejects.toThrow("homeserver unavailable");
    expect(sendMessageMatrixMock).toHaveBeenCalledOnce();
    expectRuntimeErrorContaining(
      runtime.error,
      "failed completing restart-recovery tombstone notice",
    );
  });

  it("reports a queued block delivery failure after dispatch", async () => {
    const kind = "block";
    const runtime = { error: vi.fn() };
    const { handler } = createHarness({
      runtime: runtime as never,
      dispatchInboundMessage: vi.fn(async () => dispatchResult(0, 1)),
      createReplyDispatcherWithTyping: (params) =>
        replyDispatcher(async () => {
          params?.onError?.(new Error("send failed"), { kind });
        }),
    });
    await receiveText(handler, { eventId: `$release-on-${kind}-delivery-error`, body: "hello" });
    expectRuntimeErrorContaining(runtime.error, `matrix ${kind} reply failed`);
  });
});

describe("matrix monitor handler draft streaming", () => {
  type DeliverFn = (payload: ReplyPayload, info: { kind: string }) => Promise<unknown>;

  const waitForDrafts = (count = 1) =>
    waitForState(() => expect(sendDraftMock).toHaveBeenCalledTimes(count));

  function nextDraft(messageId: string) {
    sendDraftMock.mockClear();
    editMock.mockClear();
    sendDraftMock.mockResolvedValueOnce({ messageId, roomId: "!room" });
  }

  async function toolStarted(opts: GetReplyOptions, toolCallId: string, name: string) {
    const activity = { toolCallId, name, phase: "start" as const };
    await opts.onItemEvent?.(projectAgentToolActivity(activity));
    await opts.onToolStart?.(activity);
  }

  async function sendPreview(opts: GetReplyOptions, text: string, expectedSends = 1) {
    await opts.onPartialReply?.({ text });
    await waitForDrafts(expectedSends);
  }

  function createStreamingHarness(opts?: {
    replyToMode?: "off" | "first" | "all" | "batched";
    threadReplies?: "inbound" | "always";
    blockStreamingEnabled?: boolean;
    streaming?: "partial" | "quiet" | "progress" | "off";
    previewToolProgressEnabled?: boolean;
    accountConfig?: import("../../types.js").MatrixConfig;
  }) {
    let capturedDeliver: DeliverFn | undefined;
    let capturedOnError: ((error: unknown, info: { kind: string }) => void) | undefined;
    let capturedReplyOpts: GetReplyOptions | undefined;
    const { promise: captured, resolve: resolveCaptured } = createDeferred<void>();
    const notifyCaptured = () => {
      if (capturedDeliver && capturedReplyOpts) {
        resolveCaptured();
      }
    };
    // Gate that keeps the handler's model run alive until the test releases it.
    const { promise: runGate, resolve: resolveRunGate } = createDeferred<void>();

    sendMessageMatrixMock.mockReset().mockResolvedValue({ messageId: "$draft1", roomId: "!room" });
    sendDraftMock.mockReset().mockResolvedValue({ messageId: "$draft1", roomId: "!room" });
    editMock.mockReset().mockResolvedValue("$edited");
    deliverRepliesMock.mockReset().mockResolvedValue(deliveryResult());

    const redactEventMock = vi.fn(async () => "$redacted");
    const logVerboseMessage = vi.fn();

    const { handler } = createHarness({
      streaming: opts?.streaming ?? "quiet",
      accountConfig: opts?.accountConfig,
      previewToolProgressEnabled: opts?.previewToolProgressEnabled ?? false,
      blockStreamingEnabled: opts?.blockStreamingEnabled ?? false,
      replyToMode: opts?.replyToMode ?? "off",
      threadReplies: opts?.threadReplies,
      client: { redactEvent: redactEventMock },
      logVerboseMessage,
      createReplyDispatcherWithTyping: (params: Record<string, unknown> | undefined) => {
        capturedDeliver = params?.deliver as DeliverFn | undefined;
        capturedOnError = params?.onError as typeof capturedOnError;
        notifyCaptured();
        return replyDispatcher();
      },
      dispatchInboundMessage: vi.fn(async (args: { replyOptions?: GetReplyOptions }) => {
        capturedReplyOpts = args?.replyOptions;
        notifyCaptured();

        await runGate;
        return { queuedFinal: true, counts: { final: 1, block: 0, tool: 0 } };
      }) as never,
    });

    const dispatch = async () => {
      const handlerDone = receiveText(handler, { eventId: "$msg1", body: "hello" });
      await captured;
      return {
        deliver: capturedDeliver!,
        onError: capturedOnError!,
        opts: capturedReplyOpts!,
        // Release the run gate and wait for the handler to finish
        // (including the finally block that stops the draft stream).
        finish: async () => {
          resolveRunGate();
          await handlerDone;
        },
      };
    };

    return { dispatch, redactEventMock, logVerboseMessage };
  }

  async function startStreaming(options?: Parameters<typeof createStreamingHarness>[0]) {
    const { dispatch, ...harness } = createStreamingHarness(options);
    return { ...harness, ...(await dispatch()) };
  }

  function progressHarness(progress: NonNullable<MatrixStreamingConfig["progress"]>) {
    return startStreaming({
      streaming: "progress",
      previewToolProgressEnabled: progress.toolProgress ?? false,
      accountConfig: { streaming: { mode: "progress", progress } },
    });
  }

  it("records a failed block typing restart without replaying the accepted delivery", async () => {
    const acceptedDelivery = deliveryResult("$accepted", "Already delivered block");
    const { dispatch, logVerboseMessage, redactEventMock } = createStreamingHarness({
      streaming: "off",
    });
    deliverRepliesMock.mockResolvedValueOnce(acceptedDelivery);
    sendTypingMatrixMock.mockRejectedValueOnce(new Error("typing unavailable"));
    const { deliver, finish } = await dispatch();

    await expect(
      deliver({ text: "Already delivered block" }, { kind: "block" }),
    ).resolves.toMatchObject(acceptedDelivery);
    expect(deliverRepliesMock).toHaveBeenCalledOnce();
    expect(sendTypingMatrixMock).toHaveBeenCalledExactlyOnceWith(ROOM, true, {
      client: expect.objectContaining({ redactEvent: redactEventMock }),
    });
    const expectedDiagnostic =
      "matrix typing action=start failed target=!room:example.org: Error: typing unavailable";
    await waitForState(() =>
      expect(
        logVerboseMessage.mock.calls.filter(([message]) => message === expectedDiagnostic),
      ).toHaveLength(1),
    );
    await finish();
  });

  it("settles finalized previews with provider-prepared content", async () => {
    prepareMatrixSingleTextMock.mockImplementation((text: string) => ({
      ...prepareSingleText(text),
      convertedText: `prepared:${text.trim()}`,
    }));
    const { deliver, opts, finish } = await startStreaming({ streaming: "quiet" });
    await sendPreview(opts, "Raw preview");
    const result = await deliver({ text: "Raw final" }, { kind: "final" });
    expect(result).toMatchObject({ messageIds: ["$draft1"], content: "prepared:Raw final" });
    await finish();
  });

  it.each(["reply_payload_sending", "message_sending"])(
    "suppresses provider previews when %s is registered",
    async (hook) => {
      getGlobalHookRunnerMock.mockReturnValue({
        hasHooks: vi.fn((hookName: string) => hook === hookName),
      });
      const { deliver, opts, finish } = await startStreaming({
        previewToolProgressEnabled: true,
        streaming: "progress",
      });
      expect(opts.onPartialReply).toBeUndefined();
      expect(opts.onToolStart).toBeUndefined();
      expect(opts.suppressDefaultToolProgressMessages).toBeUndefined();
      await deliver({ text: "Durable final" }, { kind: "final" });
      expectNoCalls(sendDraftMock, editMock);
      expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
      await finish();
    },
  );

  it("replaces, clears, and resumes Matrix plan snapshots in progress mode", async () => {
    vi.useFakeTimers();
    const { opts, finish, redactEventMock } = await progressHarness({
      toolProgress: true,
      label: false,
    });
    try {
      await opts.onPlanUpdate?.({ phase: "update", steps: [] });
      expectNoCalls(sendDraftMock, redactEventMock);

      await opts.onPlanUpdate?.({
        phase: "update",
        explanation: "Initial plan",
        steps: [{ step: "Inspect", status: "in_progress" }],
      });
      await waitForState(() => expect(draftBody()).toBe("`Initial plan`\n\n`▸ Inspect`"));
      await opts.onPlanUpdate?.({
        phase: "update",
        explanation: "Revised plan",
        steps: [
          { step: "Inspect", status: "completed" },
          { step: "Patch", status: "in_progress" },
        ],
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(editMock).toHaveBeenCalled();
      expect(lastCallArg(editMock, 2, "Matrix plan edit body")).toBe(
        "`Revised plan`\n\n`✅ Inspect`\n`▸ Patch`",
      );

      await opts.onPlanUpdate?.({ phase: "update", steps: [] });
      expect(redactEventMock).toHaveBeenCalledExactlyOnceWith(ROOM, "$draft1");
      await opts.onPlanUpdate?.({
        phase: "update",
        steps: [{ step: "Resume", status: "in_progress" }],
      });
      await waitForDrafts(2);
      expect(lastCallArg(sendDraftMock, 1, "Matrix resumed plan body")).toBe("`▸ Resume`");
    } finally {
      await finish();
    }
  });

  it("keeps truncated Matrix tool progress UTF-16 safe", async () => {
    vi.useFakeTimers();
    const { opts, finish } = await progressHarness({
      toolProgress: true,
      label: false,
      maxLineChars: 500,
    });
    const progressPrefix = "x".repeat(298);
    const progressText = `${progressPrefix}🎉tail`;
    await opts.onItemEvent?.({ progressText });
    await opts.onItemEvent?.({ progressText });
    expect(sendDraftMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sendDraftMock).toHaveBeenCalledTimes(1);
    expect(draftBody()).toBe(`- \`${progressPrefix}...\``);
    await finish();
    vi.useRealTimers();
  });

  it("keeps quiet Matrix status, plans, and approvals with tool progress disabled", async () => {
    vi.useFakeTimers();
    const { opts, finish } = await progressHarness({ toolProgress: false, label: "Working" });
    try {
      expect(opts.suppressDefaultToolProgressMessages).toBe(true);
      await toolStarted(opts, "read-1", "read_file");
      expect(sendDraftMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(draftBody()).toBe("Working");

      await opts.onPlanUpdate?.({
        phase: "update",
        steps: [{ step: "Inspect", status: "in_progress" }],
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(lastCallArg(editMock, 2, "Matrix plan edit body")).toContain("▸ Inspect");

      await opts.onApprovalEvent?.({ phase: "requested", command: "confirm-operation" });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(lastCallArg(editMock, 2, "Matrix approval edit body")).toContain("confirm-operation");

      const quietProgress = lastCallArg(editMock, 2, "Matrix quiet progress body");
      expect(quietProgress).toContain("Working");
      expect(quietProgress).toContain("▸ Inspect");
      expect(quietProgress).toContain("confirm-operation");
      expect(quietProgress).not.toContain("Read File");
    } finally {
      await finish();
    }
  });

  const spokenPayload = () => ({
    mediaUrl: "https://example.com/tts.mp3",
    audioAsVoice: true,
    spokenText: "Spoken answer",
    ttsSupplement: { spokenText: "Spoken answer" },
  });

  it("preserves a finalized draft receipt when the following media send fails", async () => {
    const { deliver, opts, finish } = await startStreaming({
      blockStreamingEnabled: true,
      streaming: "partial",
    });
    await sendPreview(opts, "Spoken answer");
    deliverRepliesMock.mockRejectedValueOnce(new Error("media send failed"));
    const error = await deliver(spokenPayload(), { kind: "final" }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        messageIds: ["$draft1"],
        visibleReplySent: true,
        content: "Spoken answer",
        receipt: { primaryPlatformMessageId: "$draft1" },
      },
    });
    await finish();
  });

  it("falls back with visible text when TTS supplement live finalization fails", async () => {
    const { redactEventMock, deliver, opts, finish } = await startStreaming({
      blockStreamingEnabled: true,
      streaming: "partial",
    });
    await sendPreview(opts, "Spoken answer");
    editMock.mockRejectedValueOnce(new Error("rate limited"));
    await deliver(spokenPayload(), { kind: "final" });
    expect(redactEventMock).toHaveBeenCalledWith(ROOM, "$draft1");
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expect(recordArg(deliverRepliesMock, 0, 0, "deliver replies params").replies).toEqual([
      {
        text: "Spoken answer",
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        spokenText: "Spoken answer",
        ttsSupplement: { spokenText: "Spoken answer" },
      },
    ]);
    await finish();
  });

  registerMatrixPreviewDeliveryTests({
    createStreamingHarness,
    createMockMatrixDeliveryResult: deliveryResult,
    sendSingleTextMessageMatrixMock: sendDraftMock,
    editMessageMatrixMock: editMock,
    deliverMatrixRepliesMock: deliverRepliesMock,
    waitForMatrixState: waitForState,
    mockCalls,
  });

  it("keeps delayed same-message block boundaries at the emitted block length", async () => {
    const { redactEventMock, deliver, opts, finish } = await startStreaming({
      blockStreamingEnabled: true,
    });
    await opts.onPartialReply?.({ text: "Alpha" });
    await waitForDrafts(1);
    await opts.onPartialReply?.({ text: "AlphaBeta" });
    await waitForState(() => matrixEditOptions("$draft1", "AlphaBeta"));
    await opts.onBlockReplyQueued?.({ text: "Alpha" });
    nextDraft("$draft2");
    await deliver({ text: "Alpha" }, { kind: "block" });
    await waitForDrafts(1);
    expect(draftBody()).toBe("Beta");
    matrixEditOptions("$draft1", "Alpha");
    expectNoCalls(deliverRepliesMock, redactEventMock);
    await finish();
  });

  it("starts fresh progress drafts for queued followups after the primary final", async () => {
    vi.useFakeTimers();
    const { deliver, opts, finish } = await progressHarness({ toolProgress: true });
    await toolStarted(opts, "read-1", "read_file");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sendDraftMock).toHaveBeenCalledTimes(1);

    await deliver({ text: "Primary answer" }, { kind: "final" });
    sendDraftMock.mockClear();
    sendDraftMock.mockResolvedValue({ messageId: "$draft2", roomId: "!room" });
    await opts.onQueuedFollowupAdmitted?.();
    await toolStarted(opts, "exec-followup", "exec");
    // Mirrors DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS: the followup draft must
    // wait out a fresh gate instead of inheriting the primary turn's timer.
    await vi.advanceTimersByTimeAsync(PROGRESS_DRAFT_START_DELAY_MS - 1);
    expect(sendDraftMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(sendDraftMock).toHaveBeenCalledTimes(1);
    expect(draftBody()).toMatch(/`Exec: running`$/);
    await finish();
  });

  it("queues late block boundaries against the source assistant message", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { redactEventMock, deliver, opts, finish } = await startStreaming({
      blockStreamingEnabled: true,
    });
    try {
      await opts.onAssistantMessageStart?.();
      await sendPreview(opts, "Alpha");
      await opts.onAssistantMessageStart?.();
      await opts.onBlockReplyQueued?.({ text: "Alpha" }, { assistantMessageIndex: 1 });
      await opts.onPartialReply?.({ text: "Beta" });

      // Drive the draft throttle before checking queued-block ordering.
      await vi.advanceTimersByTimeAsync(1_000);
      matrixEditOptions("$draft1", "Beta");

      nextDraft("$draft2");
      await deliver({ text: "Alpha" }, { kind: "block" });

      matrixEditOptions("$draft1", "Alpha");
      expectNoCalls(deliverRepliesMock, redactEventMock);
      await waitForDrafts(1);
      expect(draftBody()).toBe("Beta");

      await deliver({ text: "Beta" }, { kind: "final" });
      expectNoCalls(deliverRepliesMock, redactEventMock);
    } finally {
      await finish();
    }
  });

  it("keeps queued block boundaries ordered while Matrix deliveries drain", async () => {
    const { deliver, opts, finish } = await startStreaming({ blockStreamingEnabled: true });
    await sendPreview(opts, "Alpha");
    expect(draftBody()).toBe("Alpha");

    await opts.onBlockReplyQueued?.({ text: "Alpha" });
    await opts.onPartialReply?.({ text: "AlphaBeta" });
    await opts.onBlockReplyQueued?.({ text: "Beta" });
    await opts.onPartialReply?.({ text: "AlphaBetaGamma" });
    expect(sendDraftMock).toHaveBeenCalledTimes(1);
    expect(editMock).not.toHaveBeenCalled();

    nextDraft("$draft2");
    await deliver({ text: "Alpha" }, { kind: "block" });
    await waitForDrafts(1);
    expect(draftBody()).toBe("Beta");
    expectFinalizedPreviewEdit("$draft1", "Alpha");

    nextDraft("$draft3");
    await deliver({ text: "Beta" }, { kind: "block" });
    await waitForDrafts(1);
    expect(draftBody()).toBe("Gamma");
    expectFinalizedPreviewEdit("$draft2", "Beta");
    await finish();
  });

  it.each(["quiet", "partial"] as const)(
    "settles aborted %s draft visibility",
    async (streaming) => {
      if (streaming === "quiet") {
        vi.useFakeTimers();
      }
      const pendingDraft = createDeferred<{ messageId: string; roomId: string }>();
      sendDraftMock
        .mockReset()
        .mockImplementation(() =>
          streaming === "quiet"
            ? pendingDraft.promise
            : Promise.resolve({ messageId: "$draft1", roomId: "!room" }),
        );
      editMock.mockReset().mockResolvedValue("$edited");
      deliverRepliesMock.mockReset().mockResolvedValue(deliveryResult());
      const redactEventMock = vi.fn(async () => "$redacted");
      const { handler } = createHarness({
        streaming,
        client: { redactEvent: redactEventMock },
        createReplyDispatcherWithTyping: () => replyDispatcher(),
        dispatchInboundMessage: vi.fn(async (args: { replyOptions?: GetReplyOptions }) => {
          await args.replyOptions?.onPartialReply?.({ text: "partial" });
          if (streaming === "partial") {
            await waitForDrafts();
          }
          throw new Error("model timeout");
        }) as never,
      });
      const handlerDone = expect(
        receiveText(handler, { eventId: "$msg1", body: "hello" }),
      ).rejects.toThrow("model timeout");
      if (streaming === "quiet") {
        await waitForDrafts();
        pendingDraft.resolve({ messageId: "$draft1", roomId: "!room" });
      }
      await handlerDone;
      if (streaming === "partial") {
        expect(redactEventMock).not.toHaveBeenCalled();
      } else {
        expect(redactEventMock).toHaveBeenCalledWith(ROOM, "$draft1");
        sendDraftMock.mockClear();
        editMock.mockClear();
        await vi.advanceTimersByTimeAsync(50);
        expectNoCalls(sendDraftMock, editMock);
      }
    },
  );

  it("cleans up empty final drafts with blank-only media", async () => {
    const payload = { mediaUrls: ["   "] };
    const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
    const { deliver, opts, finish } = await dispatch();
    await sendPreview(opts, "Partial reply");
    deliverRepliesMock.mockClear();
    deliverRepliesMock.mockResolvedValue({
      visibleReplySent: false,
      suppression: { reason: "no_visible_result" },
    });
    await deliver(payload, { kind: "final" });
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expect(redactEventMock).not.toHaveBeenCalled();
    await finish();
    expect(redactEventMock).toHaveBeenCalledWith(ROOM, "$draft1");
  });

  it("skips compaction notices in draft finalization", async () => {
    const { deliver, opts, finish } = await startStreaming();
    await sendPreview(opts, "Streaming");
    deliverRepliesMock.mockClear();
    await deliver({ text: "Compacting...", isCompactionNotice: true }, { kind: "block" });
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expect(editMock).not.toHaveBeenCalled();
    await finish();
  });

  it.each([false, true])(
    "settles draft routing with first reply slot consumed=%s",
    async (consumeFirst) => {
      const threadReplies = consumeFirst ? undefined : "always";
      const payload = {
        text: "Final text",
        ...(!consumeFirst ? { replyToId: "$suppressed_implicit" } : {}),
      };
      const { redactEventMock, deliver, opts, finish } = await startStreaming({
        replyToMode: "first",
        threadReplies,
      });
      if (consumeFirst) {
        await deliver({ text: "tool result", replyToId: "$msg1" }, { kind: "tool" });
        await opts.onAssistantMessageStart?.();
      }
      await sendPreview(opts, "Partial reply");
      if (threadReplies && !consumeFirst) {
        expect(callArg(sendDraftMock, 0, 2, "thread preview options")).toMatchObject({
          threadId: "$msg1",
          replyToId: undefined,
        });
      }
      deliverRepliesMock.mockClear();
      await deliver(payload, { kind: "final" });
      if (consumeFirst) {
        expect(editMock).not.toHaveBeenCalled();
        expect(redactEventMock).toHaveBeenCalledWith(ROOM, "$draft1");
        expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
      } else {
        expect(editMock).toHaveBeenCalledOnce();
        expectNoCalls(redactEventMock, deliverRepliesMock);
      }
      await finish();
    },
  );

  it("reuses partial-draft captions for a singular fallback after blank plural entries", async () => {
    const mediaUrls = ["   "];
    const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
    const { deliver, opts, finish } = await dispatch();
    await sendPreview(opts, "screenshot ready");
    deliverRepliesMock.mockClear();
    await deliver(
      { text: "screenshot ready", mediaUrl: "https://example.com/image.png", mediaUrls },
      { kind: "final" },
    );
    expect(editMock).toHaveBeenCalledTimes(1);
    expect(matrixEditOptions("$draft1", "screenshot ready").live).toBe(false);
    expect(redactEventMock).not.toHaveBeenCalled();
    expectDeliveredMediaReply();
    await finish();
  });

  it("delivers final Matrix mentions normally without media", async () => {
    const { redactEventMock, deliver, opts, finish } = await startStreaming({
      streaming: "partial",
      blockStreamingEnabled: true,
    });
    const preview = "hello @alice:example.org";
    const finalText = `${preview}!`;
    await sendPreview(opts, preview);
    deliverRepliesMock.mockClear();
    await deliver({ text: finalText }, { kind: "final" });
    expect(editMock).not.toHaveBeenCalled();
    expect(redactEventMock).toHaveBeenCalledWith(ROOM, "$draft1");
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    const deliverParams = recordArg(deliverRepliesMock, 0, 0, "deliver replies params");
    const replies = requireArray(deliverParams.replies, "delivered replies");
    const reply = requireRecord(replies[0], "delivered reply");
    expect(reply.text).toBe(finalText);
    await finish();
  });

  it("redacts stale draft and sends the final once when a later preview exceeds the event limit", async () => {
    const { redactEventMock, deliver, opts, finish } = await startStreaming();
    await sendPreview(opts, "1234");
    prepareMatrixSingleTextMock.mockImplementation((text: string) => ({
      ...prepareSingleText(text),
      singleEventLimit: 5,
      fitsInSingleEvent: text.trim().length <= 5,
    }));
    await opts.onPartialReply?.({ text: "123456" });
    await deliver({ text: "123456" }, { kind: "final" });
    expect(editMock).not.toHaveBeenCalled();
    expect(redactEventMock).toHaveBeenCalledWith(ROOM, "$draft1");
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expect(sendDraftMock).toHaveBeenCalledTimes(1);
    await finish();
  });
});

it.each([
  { text: "@[OpenClaw Bot] /model", displayName: "OpenClaw Bot", expected: "/model" },
  {
    text: "Hello @bot:server how are you",
    userId: "@bot:server",
    expected: "Hello @bot:server how are you",
  },
])("strips only a leading mention from $text", ({ expected, ...params }) => {
  expect(stripMatrixMentionPrefix(params)).toBe(expected);
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
