import path from "node:path";
import { projectAgentToolActivity } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { GetReplyOptions, ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import {
  testing as sessionBindingTesting,
  registerSessionBindingAdapter,
} from "openclaw/plugin-sdk/session-binding-runtime";
import {
  deliveryContextFromSession,
  getSessionEntry,
  normalizeSessionDeliveryState,
  sessionDeliveryOrigin,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
// Matrix tests cover handler plugin behavior.
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { peekSystemEventEntries } from "openclaw/plugin-sdk/system-event-runtime";
import { createRequireRecord, resetSystemEventsForTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import { MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY } from "../send/types.js";
import { registerMatrixPreviewDeliveryTests } from "./handler.preview-delivery.test-support.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixReactionEvent,
  createMatrixReactionTestHarness,
  createMatrixRoomMessageEvent,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";

// Core owns the shared gate (DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS); plugins
// cannot import it, so mirror the value here for start-boundary assertions.
const PROGRESS_DRAFT_START_DELAY_MS = 1_500;

const sendMessageMatrixMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ messageId: "evt", roomId: "!room" })),
);
const sendSingleTextMessageMatrixMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ messageId: "$draft1", roomId: "!room" })),
);
const editMessageMatrixMock = vi.hoisted(() => vi.fn(async () => "$edited"));
const sendTypingMatrixMock = vi.hoisted(() => vi.fn(async () => {}));
const prepareMatrixSingleTextMock = vi.hoisted(() =>
  vi.fn((text: string) => {
    const trimmedText = text.trim();
    return {
      trimmedText,
      convertedText: trimmedText,
      singleEventLimit: 4000,
      fitsInSingleEvent: true,
    };
  }),
);
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
  return {
    ...actual,
    getGlobalHookRunner: getGlobalHookRunnerMock,
  };
});

vi.mock("../send.js", () => ({
  editMessageMatrix: editMessageMatrixMock,
  prepareMatrixSingleText: prepareMatrixSingleTextMock,
  reactMatrixMessage: vi.fn(async () => {}),
  resolveMatrixMentionsForBody: resolveMatrixMentionsForBodyMock,
  sendMessageMatrix: sendMessageMatrixMock,
  sendSingleTextMessageMatrix: sendSingleTextMessageMatrixMock,
  sendReadReceiptMatrix: vi.fn(async () => {}),
  sendTypingMatrix: sendTypingMatrixMock,
}));

const deliverMatrixRepliesMock = vi.hoisted(() => vi.fn());

vi.mock("./replies.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./replies.js")>()),
  deliverMatrixReplies: deliverMatrixRepliesMock,
}));

function receiveText(
  handler: ReturnType<typeof createMatrixHandlerTestHarness>["handler"],
  event: Parameters<typeof createMatrixTextMessageEvent>[0],
) {
  return handler("!room:example.org", createMatrixTextMessageEvent(event));
}

function waitForMatrixState<T>(
  assertion: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
): Promise<T> {
  return vi.waitFor(assertion, { interval: 1, ...options });
}

async function writeMatrixSessionMeta(
  storePath: string,
  sessionKey: string,
  origin: {
    chatType: "direct" | "group";
    from: string;
    to: string;
    nativeChannelId?: string;
    nativeDirectUserId?: string;
  },
): Promise<void> {
  const existing = getSessionEntry({ storePath, sessionKey }) ?? {
    sessionId: `sess-${sessionKey}`,
    updatedAt: Date.now(),
  };
  const existingOrigin = sessionDeliveryOrigin(existing) ?? {};
  await upsertSessionEntry({
    storePath,
    sessionKey,
    entry: {
      ...existing,
      delivery: normalizeSessionDeliveryState({
        context: deliveryContextFromSession(existing),
        origin: {
          ...existingOrigin,
          provider: "matrix",
          surface: "matrix",
          accountId: "ops",
          ...origin,
        },
      }),
    },
  });
}

beforeEach(() => {
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  installMatrixMonitorTestRuntime();
  getGlobalHookRunnerMock.mockReset().mockReturnValue(null);
  prepareMatrixSingleTextMock.mockReset().mockImplementation((text: string) => {
    const trimmedText = text.trim();
    return {
      trimmedText,
      convertedText: trimmedText,
      singleEventLimit: 4000,
      fitsInSingleEvent: true,
    };
  });
  resolveMatrixMentionsForBodyMock.mockClear();
  sendMessageMatrixMock.mockReset().mockResolvedValue({ messageId: "evt", roomId: "!room" });
  sendTypingMatrixMock.mockReset().mockResolvedValue(undefined);
  deliverMatrixRepliesMock.mockReset().mockResolvedValue(createMockMatrixDeliveryResult());
});

afterEach(() => {
  resetSystemEventsForTest();
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  vi.useRealTimers();
});

const requireRecord = createRequireRecord("object", "expected-label");

function requireArray(value: unknown, label: string): Array<unknown> {
  expect(Array.isArray(value), label).toBe(true);
  return value as Array<unknown>;
}

function mockCalls(mock: unknown, label: string): Array<Array<unknown>> {
  const mockState = (mock as { mock?: { calls?: Array<Array<unknown>> } }).mock;
  if (!mockState) {
    throw new Error(`${label}.mock was missing`);
  }
  const calls = mockState.calls;
  if (!Array.isArray(calls)) {
    throw new Error(`${label}.mock.calls was not an array`);
  }
  return calls;
}

function callArg(mock: unknown, callIndex: number, argIndex: number, label: string) {
  const call = mockCalls(mock, label).at(callIndex);
  if (!call) {
    throw new Error(`${label} call ${callIndex} was missing`);
  }
  return call[argIndex];
}

function lastCallArg(mock: unknown, argIndex: number, label: string) {
  const calls = mockCalls(mock, label);
  return callArg(mock, calls.length - 1, argIndex, label);
}

function singleTextMessageBody(callIndex = 0) {
  return callArg(sendSingleTextMessageMatrixMock, callIndex, 1, "single text message body");
}

function expectMockCallWithFields(mock: unknown, fields: Record<string, unknown>) {
  const matched = mockCalls(mock, "mock calls").some(([value]) => {
    if (!value || typeof value !== "object") {
      return false;
    }
    const record = value as Record<string, unknown>;
    return Object.entries(fields).every(([key, expected]) => Object.is(record[key], expected));
  });
  expect(matched).toBe(true);
}

function expectNoticeSent(mock: unknown) {
  const message = requireRecord(callArg(mock, 0, 1, "notice content"), "notice content");
  expect(message.msgtype).toBe("m.notice");
  expect(String(message.body)).toContain("channels.matrix.dm.sessionScope");
}

function expectRuntimeErrorContaining(mock: unknown, text: string) {
  const matched = mockCalls(mock, "runtime error").some(([message]) =>
    String(message).includes(text),
  );
  expect(matched).toBe(true);
}

function findMockCall(mock: unknown, label: string, predicate: (call: Array<unknown>) => boolean) {
  const call = mockCalls(mock, label).find(predicate);
  if (!call) {
    throw new Error(`${label} was missing`);
  }
  return call;
}

function expectMatrixEdit(roomId: string, eventId: string, body: string) {
  const call = findMockCall(
    editMessageMatrixMock,
    `edit call for ${eventId}`,
    ([room, editedEventId, editedBody]) =>
      room === roomId && editedEventId === eventId && editedBody === body,
  );
  requireRecord(call[3], "edit options");
}

function expectFinalizedPreviewEdit(eventId: string, text: string) {
  const call = findMockCall(
    editMessageMatrixMock,
    `edit call for ${eventId}`,
    ([room, editedEventId, body]) =>
      room === "!room:example.org" && editedEventId === eventId && body === text,
  );
  const options = requireRecord(call[3], "edit options");
  expect(options.extraContent).toEqual({ [MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY]: true });
}

function expectEditLiveFlag(eventId: string, text: string, expected: boolean | undefined) {
  const call = findMockCall(
    editMessageMatrixMock,
    `edit live flag call for ${eventId}`,
    ([room, editedEventId, body]) =>
      room === "!room:example.org" && editedEventId === eventId && body === text,
  );
  const options = requireRecord(call[3], "edit options");
  if (expected === undefined) {
    expect(Object.hasOwn(options, "live")).toBe(false);
  } else {
    expect(options.live).toBe(expected);
  }
}

function expectDeliveredMediaReply() {
  const payload = requireRecord(
    lastCallArg(deliverMatrixRepliesMock, 0, "deliver replies payload"),
    "deliver replies payload",
  );
  const replies = requireArray(payload.replies, "deliver replies");
  const reply = requireRecord(replies[0], "media reply");
  expect(reply.mediaUrl).toBe("https://example.com/image.png");
  expect(reply.text).toBeUndefined();
}

function createMockMatrixDeliveryResult(messageId = "$reply1", content = "delivered") {
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

type HarnessOptions = NonNullable<Parameters<typeof createMatrixHandlerTestHarness>[0]>;
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
            metadata: { boundBy: "user-1" },
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
    origin?: Parameters<typeof writeMatrixSessionMeta>[2] | null;
    sendNotice?: ReturnType<typeof vi.fn<() => Promise<string>>>;
  } = {},
) {
  const storePath = path.join(noticeDirs.make(), "sessions.json");
  const sessionKey = params.sessionKey ?? "agent:ops:main";
  if (params.origin === null) {
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: {
        sessionId: "sess-main",
        updatedAt: Date.now(),
        delivery: normalizeSessionDeliveryState({
          context: {
            channel: "matrix",
            to: "room:!other:example.org",
            accountId: "ops",
          },
        }),
      },
    });
  } else {
    await writeMatrixSessionMeta(
      storePath,
      sessionKey,
      params.origin ?? {
        chatType: "direct",
        from: "matrix:@user:example.org",
        to: "room:!other:example.org",
        nativeChannelId: "!other:example.org",
      },
    );
  }
  const sendNotice = params.sendNotice ?? vi.fn(async () => "$notice");
  const harness = createMatrixHandlerTestHarness({
    isDirectMessage: true,
    ...options,
    resolveStorePath: () => storePath,
    client: { ...options.client, sendMessage: sendNotice },
  });
  const receive = (
    eventId: string,
    relatesTo?: Parameters<typeof createMatrixTextMessageEvent>[0]["relatesTo"],
  ) =>
    harness.handler(
      "!dm:example.org",
      createMatrixTextMessageEvent({ eventId, body: "follow up", relatesTo }),
    );
  return { ...harness, storePath, sendNotice, receive };
}

function createReplayClaim() {
  const commit = vi.fn(async () => true);
  const release = vi.fn();
  const inboundDeduper = {
    claim: vi.fn(async () => ({
      kind: "claimed" as const,
      handle: { keys: ["test"] as const, commit, release },
    })),
  };
  return { commit, release, inboundDeduper };
}
describe("matrix monitor handler pairing account scope", () => {
  it("keeps image-only thread roots visible via attachment markers", async () => {
    const { handler, runPrepared } = createMatrixHandlerTestHarness({
      client: {
        getEvent: async () =>
          createMatrixRoomMessageEvent({
            eventId: "$thread-root",
            sender: "@gum:example.org",
            content: { msgtype: "m.image", body: "photo.jpg" },
          }),
      },
    });
    await receiveText(handler, {
      eventId: "$reply",
      body: "replying",
      relatesTo: { rel_type: "m.thread", event_id: "$thread-root" },
    });
    expect(runPrepared).toHaveBeenCalledOnce();
    expect(runPrepared.mock.calls[0]?.[0].ctxPayload.Body).toContain("replying");
    expect(runPrepared.mock.calls[0]?.[0].ctxPayload.ThreadStarterBody).toContain(
      "[matrix image attachment]",
    );
  });
  it("keeps inbound log previews UTF-16 well-formed at the limit", async () => {
    const logVerboseMessage = vi.fn();
    const { handler } = createMatrixHandlerTestHarness({ logVerboseMessage });

    await receiveText(handler, {
      eventId: "$event-preview",
      body: `${"x".repeat(199)}🚀tail`,
    });

    expect(logVerboseMessage).toHaveBeenCalledWith(
      `matrix inbound: room=!room:example.org from=@user:example.org preview="${"x".repeat(199)}"`,
    );
  });

  it.each(["main", "per-channel-peer"])(
    "pins the configured DM owner only when live dmScope is %s",
    async (dmScope) => {
      const channels = { matrix: { dm: { allowFrom: ["@owner:example.org"] } } };
      const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
        cfg: dmScope === "main" ? { channels } : { session: { dmScope: "main" }, channels },
        ...(dmScope === "main" ? {} : { liveCfg: { session: { dmScope }, channels } }),
        dmPolicy: "allowlist",
        allowFrom: ["@owner:example.org"],
        allowFromResolvedEntries: [{ input: "@owner:example.org", id: "@owner:example.org" }],
        isDirectMessage: true,
      });
      await handler(
        "!dm:example.org",
        createMatrixTextMessageEvent({
          eventId: "$owner-dm",
          sender: "@owner:example.org",
          body: "hello",
        }),
      );
      expect(recordInboundSession).toHaveBeenCalledTimes(1);
      const inbound = requireRecord(
        callArg(recordInboundSession, 0, 0, "record inbound session"),
        "record inbound session",
      );
      const route = requireRecord(inbound.updateLastRoute, "last route update");
      expect(route.channel).toBe("matrix");
      expect(route.to).toBe("room:!dm:example.org");
      if (dmScope === "main") {
        const ownerPin = requireRecord(route.mainDmOwnerPin, "main DM owner pin");
        expect(ownerPin.ownerRecipient).toBe("@owner:example.org");
        expect(ownerPin.senderRecipient).toBe("@owner:example.org");
      } else {
        expect(route.mainDmOwnerPin).toBeUndefined();
      }
    },
  );

  it("accepts room messages from configured Matrix bot accounts when allowBots is true", async () => {
    const { handler, recordInboundSession, runPrepared } = createMatrixHandlerTestHarness({
      isDirectMessage: false,
      accountAllowBots: true,
      accountConfig: { botLoopProtection: { windowSeconds: 120, cooldownSeconds: 240 } },
      configuredBotUserIds: new Set(["@ops:example.org"]),
      roomsConfig: {
        "!room:example.org": {
          requireMention: false,
          botLoopProtection: { maxEventsPerWindow: 3 },
        },
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
      conversationId: "!room:example.org",
      senderId: "@ops:example.org",
      receiverId: "@bot:example.org",
      config: { maxEventsPerWindow: 3, windowSeconds: 120, cooldownSeconds: 240 },
      defaultsConfig: undefined,
      defaultEnabled: true,
      nowMs: 123_456,
    });
  });

  it.each([
    {
      name: "room override",
      accountAllowBots: true,
      roomAllowBots: false,
      body: "hello",
      accepted: false,
    },
    {
      name: "missing mention",
      accountAllowBots: "mentions",
      roomAllowBots: undefined,
      body: "hello",
      accepted: false,
    },
    {
      name: "visible mention",
      accountAllowBots: "mentions",
      roomAllowBots: undefined,
      body: "hello @bot",
      accepted: true,
    },
  ] as const)("gates configured bot senders: $name", async (scenario) => {
    const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
      isDirectMessage: false,
      accountAllowBots: scenario.accountAllowBots,
      configuredBotUserIds: new Set(["@ops:example.org"]),
      roomsConfig: {
        "!room:example.org": { requireMention: false, allowBots: scenario.roomAllowBots },
      },
      mentionRegexes: [/@bot/i],
    });
    await receiveText(handler, {
      eventId: "$bot-gate",
      sender: "@ops:example.org",
      body: scenario.body,
    });
    expect(recordInboundSession).toHaveBeenCalledTimes(scenario.accepted ? 1 : 0);
  });

  it.each(["paired", "configured"])(
    "blocks room control commands from %s DM-only senders",
    async (source) => {
      const configured = source === "configured";
      const readAllowFromStore = vi.fn(async () => ["@user:example.org"]);
      const hasControlCommand = vi.fn((text?: string) => !configured || text === "/new");
      const { handler, finalizeInboundContext, recordInboundSession } =
        createMatrixHandlerTestHarness({
          isDirectMessage: false,
          readAllowFromStore,
          roomsConfig: { "!room:example.org": { requireMention: false } },
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
      expect(recordInboundSession).not.toHaveBeenCalled();
      expect(finalizeInboundContext).not.toHaveBeenCalled();
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

  it.each([{ body: "/new", isControlCommand: true, expectedDispatches: 1 }])(
    "keeps require-mention decision for unmentioned room text $body",
    async ({ body, isControlCommand, expectedDispatches }) => {
      const { handler, finalizeInboundContext } = createMatrixHandlerTestHarness({
        cfg: { channels: { matrix: { groupAllowFrom: ["@user:example.org"] } } },
        isDirectMessage: false,
        groupAllowFrom: ["@user:example.org"],
        mentionRegexes: [],
        shouldHandleTextCommands: () => true,
        hasControlCommand: (text?: string) => isControlCommand && text === body,
        getMemberDisplayName: async () => "sender",
      });

      await receiveText(handler, {
        eventId: `$unmentioned-${isControlCommand ? "command" : "text"}`,
        body,
      });

      expect(finalizeInboundContext).toHaveBeenCalledTimes(expectedDispatches);
    },
  );

  it.each([
    {
      name: "full Matrix user ID",
      body: "hello @bot:example.org",
      accepted: true,
      formatted: false,
      metadataOnly: false,
    },
    {
      name: "another homeserver",
      body: "hello @bot:evil.example",
      accepted: false,
      formatted: false,
      metadataOnly: false,
    },
    {
      name: "Unicode display name",
      body: "@欢欢 please reply",
      accepted: true,
      formatted: true,
      metadataOnly: false,
    },
    {
      name: "forged metadata only",
      body: "hello there",
      accepted: false,
      formatted: false,
      metadataOnly: true,
    },
  ])("validates native mentions: $name", async ({ body, accepted, formatted, metadataOnly }) => {
    const getMemberDisplayName = vi.fn(async () => (formatted ? "欢欢" : "sender"));
    const { handler, recordInboundSession, runPrepared, resolveAgentRoute } =
      createMatrixHandlerTestHarness({
        isDirectMessage: false,
        mentionRegexes: metadataOnly ? [/@bot/i] : [],
        getMemberDisplayName,
      });
    await handler(
      "!room:example.org",
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
      if (!formatted) {
        expect(runPrepared.mock.calls[0]?.[0].ctxPayload).toMatchObject({
          AccountId: "ops",
          WasMentioned: true,
        });
        expect(getMemberDisplayName).not.toHaveBeenCalledWith(
          "!room:example.org",
          "@bot:example.org",
        );
      }
    } else {
      expect(recordInboundSession).not.toHaveBeenCalled();
    }
    if (metadataOnly) {
      expect(resolveAgentRoute).toHaveBeenCalledTimes(1);
    }
  });

  it("drops root events that carry a bundled replacement relation", async () => {
    const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
      isDirectMessage: false,
      mentionRegexes: [/@bot/i],
      getMemberDisplayName: async () => "sender",
    });

    await receiveText(handler, {
      eventId: "$edited-root",
      body: "@bot please reply",
      mentions: { user_ids: ["@bot:example.org"] },
      unsigned: {
        "m.relations": {
          "m.replace": {
            event_id: "$edit",
          },
        },
      },
    });

    expect(recordInboundSession).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "records thread context with flat DM routing=%s",
    async (isDirectMessage) => {
      const getEvent = vi.fn(async (_roomId: string, eventId: string) =>
        eventId === "$root"
          ? createMatrixTextMessageEvent({
              eventId: "$root",
              sender: "@alice:example.org",
              body: "Root topic",
            })
          : createMatrixTextMessageEvent({ eventId, sender: "@bot:example.org", body: "" }),
      );
      const { handler, finalizeInboundContext, recordInboundSession } =
        createMatrixHandlerTestHarness({
          client: { getEvent },
          isDirectMessage,
          ...(isDirectMessage ? { threadReplies: "always", dmThreadReplies: "off" } : {}),
          getMemberDisplayName: async (_roomId, userId) =>
            userId === "@alice:example.org" ? "Alice" : "sender",
        });
      await handler(
        isDirectMessage ? "!dm:example.org" : "!room:example.org",
        createMatrixTextMessageEvent({
          eventId: "$reply1",
          body: isDirectMessage ? "follow up" : "@room follow up",
          relatesTo: {
            rel_type: "m.thread",
            event_id: "$root",
            "m.in_reply_to": { event_id: "$root" },
          },
          ...(isDirectMessage ? {} : { mentions: { room: true } }),
        }),
      );
      const context = requireRecord(
        callArg(finalizeInboundContext, 0, 0, "finalized context"),
        "finalized context",
      );
      expect(context.ThreadStarterBody).toBe("Matrix thread root $root from Alice:\nRoot topic");
      if (isDirectMessage) {
        expect(context.MessageThreadId).toBeUndefined();
        expect(context.ReplyToId).toBe("$root");
        expectMockCallWithFields(recordInboundSession, { sessionKey: "agent:ops:main" });
      } else {
        expect(getEvent).toHaveBeenCalledOnce();
        expect(context.ReplyToBody).toBe("Root topic");
        expect(context.ReplyToSender).toBe("Alice");
        expect(context.MessageThreadId).toBe("$root");
        expect(context.ParentSessionKey).toBe("agent:ops:main");
        expectMockCallWithFields(recordInboundSession, {
          sessionKey: "agent:ops:main:thread:$root",
        });
      }
    },
  );

  it("waits for a shared-session notice before dispatch and sends it only once", async () => {
    const entered = createDeferred<void>();
    const notice = createDeferred<string>();
    const sendNotice = vi.fn(() => {
      entered.resolve();
      return notice.promise;
    });
    const dispatchInboundMessage = vi.fn(async () => ({
      queuedFinal: false,
      counts: { final: 0, block: 0, tool: 0 },
    }));
    const sessionKey = "agent:ops:matrix:direct:@user:example.org";
    const { receive } = await createDmNoticeHarness(
      {
        dispatchInboundMessage,
        resolveAgentRoute: () => ({
          agentId: "ops",
          channel: "matrix",
          accountId: "ops",
          sessionKey,
          mainSessionKey: "agent:ops:main",
          matchedBy: "binding.account",
        }),
      },
      { sessionKey, sendNotice },
    );
    const handled = receive("$dm1");
    try {
      await entered.promise;
      expect(dispatchInboundMessage).not.toHaveBeenCalled();
      expect(callArg(sendNotice, 0, 0, "send notice")).toBe("!dm:example.org");
      expectNoticeSent(sendNotice);
    } finally {
      notice.resolve("$notice");
      await handled;
    }
    expect(dispatchInboundMessage).toHaveBeenCalledTimes(1);
    await receive("$dm2");
    expect(sendNotice).toHaveBeenCalledTimes(1);
  });

  it.each(["threaded", "outbound metadata", "prior group", "per-room", "bound"])(
    "resolves shared DM collision notices for %s sessions",
    async (scenario) => {
      const touch = scenario === "bound" ? registerTestBinding("!dm:example.org") : undefined;
      const { receive, sendNotice, storePath, recordInboundSession } = await createDmNoticeHarness(
        scenario === "threaded"
          ? {
              threadReplies: "always",
              client: {
                getEvent: async (_roomId, eventId) =>
                  createMatrixTextMessageEvent({
                    eventId,
                    sender: eventId === "$root" ? "@alice:example.org" : "@bot:example.org",
                    body: "Root topic",
                  }),
              },
              getMemberDisplayName: async (_roomId, userId) =>
                userId === "@alice:example.org" ? "Alice" : "sender",
            }
          : scenario === "per-room"
            ? { dmSessionScope: "per-room" }
            : {},
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
      if (scenario === "outbound metadata") {
        await writeMatrixSessionMeta(storePath, "agent:ops:main", {
          chatType: "direct",
          from: "matrix:@other:example.org",
          to: "room:@other:example.org",
          nativeDirectUserId: "@user:example.org",
        });
      }
      await receive(
        "$dm1",
        scenario === "threaded"
          ? {
              rel_type: "m.thread",
              event_id: "$root",
              "m.in_reply_to": { event_id: "$root" },
            }
          : undefined,
      );
      if (scenario === "threaded" || scenario === "outbound metadata") {
        expect(callArg(sendNotice, 0, 0, "send notice")).toBe("!dm:example.org");
        expectNoticeSent(sendNotice);
      } else {
        expect(sendNotice).not.toHaveBeenCalled();
      }
      if (scenario === "per-room") {
        expectMockCallWithFields(recordInboundSession, {
          sessionKey: "agent:ops:matrix:channel:!dm:example.org",
        });
      }
      if (touch) {
        expect(touch).toHaveBeenCalledOnce();
      }
    },
  );

  it("keeps stable room ids as routing metadata without using them as the display channel", async () => {
    const { handler, finalizeInboundContext } = createMatrixHandlerTestHarness({
      isDirectMessage: false,
      getRoomInfo: async () => ({
        name: "Ops Room",
        canonicalAlias: "#spoofed:example.org",
        altAliases: ["#alt:example.org"],
      }),
      getMemberDisplayName: async () => "sender",
      dispatchInboundMessage: async () => ({
        queuedFinal: false,
        counts: { final: 0, block: 0, tool: 0 },
      }),
    });

    await receiveText(handler, {
      eventId: "$group1",
      body: "@room hello",
      mentions: { room: true },
    });

    const finalized = requireRecord(
      lastCallArg(finalizeInboundContext, 0, "finalized context"),
      "finalized context",
    );
    expect(finalized.ChatId).toBe("!room:example.org");
    expect(finalized.NativeChannelId).toBe("!room:example.org");
    expect(finalized.GroupChannel).toBeUndefined();
    expect(finalized.GroupSubject).toBe("Ops Room");
    expect(finalized.GroupId).toBe("!room:example.org");
  });

  it("does not refresh bound Matrix thread bindings for room messages dropped before routing", async () => {
    const touch = registerTestBinding("$root", "!room:example");
    const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
      client: {
        getEvent: async () =>
          createMatrixTextMessageEvent({
            eventId: "$root",
            sender: "@alice:example.org",
            body: "Root topic",
          }),
      },
      isDirectMessage: false,
      getMemberDisplayName: async () => "sender",
    });

    await handler(
      "!room:example",
      createMatrixTextMessageEvent({
        eventId: "$reply-no-mention",
        body: "follow up without mention",
        relatesTo: {
          rel_type: "m.thread",
          event_id: "$root",
          "m.in_reply_to": { event_id: "$root" },
        },
      }),
    );

    expect(recordInboundSession).not.toHaveBeenCalled();
    expect(touch).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "bound thread",
      bound: true,
      targetEventId: "$reply1",
      key: "🎯",
      sessionKey: "agent:bound:session-1",
    },
    {
      name: "thread root",
      bound: false,
      targetEventId: "$root",
      key: "🧵",
      sessionKey: "agent:ops:main:thread:$root",
    },
  ])(
    "routes $name reactions to their session",
    async ({ bound, targetEventId, key, sessionKey }) => {
      if (bound) {
        registerTestBinding("$root", "!room:example.org");
      }
      const options: HarnessOptions = {
        isDirectMessage: false,
        client: {
          getEvent: async () =>
            createMatrixTextMessageEvent({
              eventId: targetEventId,
              sender: "@bot:example.org",
              body: bound ? "follow up" : "start thread",
              ...(bound
                ? {
                    relatesTo: {
                      rel_type: "m.thread",
                      event_id: "$root",
                      "m.in_reply_to": { event_id: "$root" },
                    },
                  }
                : {}),
            }),
        },
      };
      const { handler } = bound
        ? createMatrixHandlerTestHarness(options)
        : createMatrixReactionTestHarness({
            ...options,
            cfg: { channels: { matrix: { threadReplies: "always" } } },
          });
      await handler(
        "!room:example.org",
        createMatrixReactionEvent({ eventId: "$reaction", targetEventId, key }),
      );
      expect(peekSystemEventEntries(sessionKey)).toEqual([
        expect.objectContaining({
          text: `Matrix reaction added: ${key} by sender on msg ${targetEventId}`,
          contextKey: `matrix:reaction:add:!room:example.org:${targetEventId}:@user:example.org:${key}`,
        }),
      ]);
    },
  );

  it.each(["other author", "unauthorized DM", "account disabled"])(
    "ignores reactions for %s",
    async (scenario) => {
      const { handler, resolveAgentRoute, upsertPairingRequest } = createMatrixReactionTestHarness({
        ...(scenario === "other author" ? { targetSender: "@other:example.org" } : {}),
        ...(scenario === "unauthorized DM" ? { dmPolicy: "pairing" } : {}),
        ...(scenario === "account disabled"
          ? {
              cfg: {
                channels: {
                  matrix: {
                    reactionNotifications: "own",
                    accounts: { ops: { reactionNotifications: "off" } },
                  },
                },
              },
            }
          : {}),
      });
      await handler(
        "!room:example.org",
        createMatrixReactionEvent({ eventId: "$reaction", targetEventId: "$msg", key: "👀" }),
      );
      expect(peekSystemEventEntries("agent:ops:main")).toEqual([]);
      if (scenario === "other author") {
        expect(resolveAgentRoute).not.toHaveBeenCalled();
      }
      if (scenario === "unauthorized DM") {
        expect(upsertPairingRequest).not.toHaveBeenCalled();
      }
    },
  );

  it("drops pre-startup dm messages on cold start", async () => {
    const resolveAgentRoute = vi.fn(() => ({
      agentId: "ops",
      channel: "matrix",
      accountId: "ops",
      sessionKey: "agent:ops:main",
      mainSessionKey: "agent:ops:main",
      matchedBy: "binding.account" as const,
    }));
    const { handler } = createMatrixHandlerTestHarness({
      resolveAgentRoute,
      isDirectMessage: true,
      startupMs: 1_000,
      startupGraceMs: 0,
      dropPreStartupMessages: true,
    });

    await receiveText(handler, {
      eventId: "$old-cold-start",
      body: "hello",
      originServerTs: 999,
    });

    expect(resolveAgentRoute).not.toHaveBeenCalled();
  });
});

describe("matrix monitor handler live allowlist reload", () => {
  it.each(["wildcard", "account override", "startup name", "name matching disabled", "group"])(
    "revokes live sender access after changing %s configuration",
    async (scenario) => {
      const group = scenario === "group";
      const names = scenario === "startup name" || scenario === "name matching disabled";
      const matrix: import("../../types.js").MatrixConfig = group
        ? { groupAllowFrom: ["@alice:example.org", "@bob:example.org"] }
        : scenario === "account override"
          ? {
              dm: { allowFrom: ["@base:example.org"] },
              accounts: { ops: { dm: { allowFrom: ["@alice:example.org"] } } },
            }
          : {
              ...(names ? { dangerouslyAllowNameMatching: true } : {}),
              dm: { allowFrom: names ? ["Alice"] : ["*"] },
            };
      const cfg = { channels: { matrix } };
      const dispatchInboundMessage = vi.fn(async () => ({
        queuedFinal: false,
        counts: { final: 0, block: 0, tool: 0 },
      }));
      const resolveLiveUserAllowlist = vi.fn(
        async (params: { cfg: unknown; entries?: ReadonlyArray<string | number> }) => {
          const current = params.cfg as {
            channels?: { matrix?: { dangerouslyAllowNameMatching?: boolean } };
          };
          return current.channels?.matrix?.dangerouslyAllowNameMatching === true
            ? ["@alice:example.org"]
            : [];
        },
      );
      const { handler } = createMatrixHandlerTestHarness({
        cfg,
        isDirectMessage: !group,
        dispatchInboundMessage,
        ...(group
          ? {
              groupPolicy: "allowlist",
              roomsConfig: { "*": {} },
              groupAllowFrom: ["@alice:example.org", "@bob:example.org"],
              groupAllowFromResolvedEntries: [
                { input: "@alice:example.org", id: "@alice:example.org" },
                { input: "@bob:example.org", id: "@bob:example.org" },
              ],
            }
          : {
              dmPolicy: "allowlist",
              allowFrom:
                scenario === "wildcard"
                  ? ["*"]
                  : scenario === "name matching disabled"
                    ? []
                    : ["@alice:example.org"],
              allowFromResolvedEntries:
                scenario === "account override"
                  ? [{ input: "@alice:example.org", id: "@alice:example.org" }]
                  : scenario === "startup name"
                    ? [{ input: "Alice", id: "@alice:example.org" }]
                    : [],
            }),
        ...(scenario === "name matching disabled" ? { resolveLiveUserAllowlist } : {}),
      });
      const receive = (eventId: string, again: boolean) =>
        handler(
          group ? "!room:example.org" : "!dm:example.org",
          createMatrixTextMessageEvent({
            eventId,
            sender: "@alice:example.org",
            body: `${group ? "@room " : ""}hello${again ? " again" : ""}`,
            ...(group ? { mentions: { room: true } } : {}),
          }),
        );
      await receive("$before", false);
      expect(dispatchInboundMessage).toHaveBeenCalledTimes(1);
      if (group) {
        matrix.groupAllowFrom = ["@bob:example.org"];
      } else if (scenario === "name matching disabled") {
        matrix.dangerouslyAllowNameMatching = false;
      } else if (matrix.accounts?.ops?.dm) {
        matrix.accounts.ops.dm.allowFrom = [];
      } else if (matrix.dm) {
        matrix.dm.allowFrom = [];
      }
      await receive("$after", true);
      expect(dispatchInboundMessage).toHaveBeenCalledTimes(1);
      if (scenario === "name matching disabled") {
        expect(
          resolveLiveUserAllowlist.mock.calls.filter(
            ([params]) =>
              JSON.stringify((params.entries ?? []).map(String)) === JSON.stringify(["Alice"]),
          ),
        ).toHaveLength(2);
      }
    },
  );
});

describe("matrix monitor handler durable inbound dedupe", () => {
  it("skips replayed inbound events before session recording", async () => {
    const inboundDeduper = {
      claim: vi.fn(async () => ({ kind: "duplicate" as const })),
    };
    const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
      inboundDeduper,
      dispatchInboundMessage: vi.fn(async () => ({
        queuedFinal: true,
        counts: { final: 1, block: 0, tool: 0 },
      })),
    });

    await receiveText(handler, {
      eventId: "$dup",
      body: "hello",
    });

    expect(inboundDeduper.claim).toHaveBeenCalledWith({
      roomId: "!room:example.org",
      eventId: "$dup",
    });
    expect(recordInboundSession).not.toHaveBeenCalled();
  });

  it("commits a claimed event when bot loop protection suppresses dispatch", async () => {
    const { commit, release, inboundDeduper } = createReplayClaim();
    const runPrepared = vi.fn(
      async (turn: { ctxPayload: Record<string, unknown>; routeSessionKey: string }) => ({
        admission: { kind: "drop" as const, reason: "bot-loop-protection" as const },
        dispatched: false as const,
        ctxPayload: turn.ctxPayload,
        routeSessionKey: turn.routeSessionKey,
      }),
    );
    const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
      accountAllowBots: true,
      configuredBotUserIds: new Set(["@ops:example.org"]),
      inboundDeduper,
      isDirectMessage: false,
      roomsConfig: {
        "!room:example.org": { requireMention: false },
      },
      runPrepared,
    });

    await receiveText(handler, {
      eventId: "$bot-loop-drop",
      sender: "@ops:example.org",
      body: "hello from bot",
    });

    expect(recordInboundSession).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
  });

  it("releases a claimed event when reply dispatch fails before completion", async () => {
    const { commit, release, inboundDeduper } = createReplayClaim();
    const runtime = {
      error: vi.fn(),
    };
    const { handler } = createMatrixHandlerTestHarness({
      inboundDeduper,
      runtime: runtime as never,
      recordInboundSession: vi.fn(async () => {
        throw new Error("disk failed");
      }),
      dispatchInboundMessage: vi.fn(async () => ({
        queuedFinal: true,
        counts: { final: 1, block: 0, tool: 0 },
      })),
    });

    await receiveText(handler, {
      eventId: "$release-on-error",
      body: "hello",
    });

    expect(commit).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expectRuntimeErrorContaining(runtime.error, "matrix handler failed");
  });

  it("sends one durable threaded notice and commits replay after restart tombstone rejection", async () => {
    const callOrder: string[] = [];
    const commit = vi.fn(async () => {
      callOrder.push("commit");
      return true;
    });
    const release = vi.fn();
    const inboundDeduper = {
      claim: vi.fn(async () => {
        callOrder.push("claim");
        return {
          kind: "claimed" as const,
          handle: { keys: ["test"] as const, commit, release },
        };
      }),
    };
    const runtime = { error: vi.fn() };
    const dispatchInboundMessage = vi.fn(async () => {
      callOrder.push("dispatch");
      throw Object.assign(new Error("session ended during restart recovery"), {
        code: "SESSION_RESTART_RECOVERY_TOMBSTONE",
      });
    });
    sendMessageMatrixMock.mockImplementationOnce(async () => {
      callOrder.push("notice");
      return { messageId: "$notice", roomId: "!room:example.org" };
    });
    const { handler } = createMatrixHandlerTestHarness({
      inboundDeduper,
      runtime: runtime as never,
      recordInboundSession: vi.fn(async () => {
        callOrder.push("record");
      }),
      isDirectMessage: false,
      roomsConfig: { "!room:example.org": { requireMention: false } },
      client: {
        getEvent: async () =>
          createMatrixTextMessageEvent({
            eventId: "$thread-root",
            sender: "@alice:example.org",
            body: "Thread root",
          }),
      },
      dispatchInboundMessage,
    });

    await receiveText(handler, {
      eventId: "$tombstone-event",
      body: "continue",
      relatesTo: {
        rel_type: "m.thread",
        event_id: "$thread-root",
        "m.in_reply_to": { event_id: "$thread-root" },
      },
    });

    expect(dispatchInboundMessage).toHaveBeenCalledOnce();
    expect(sendMessageMatrixMock).toHaveBeenCalledOnce();
    expect(callArg(sendMessageMatrixMock, 0, 0, "notice room")).toBe("!room:example.org");
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
    expect(commit).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(callOrder).toEqual(["claim", "record", "dispatch", "notice", "commit"]);
  });

  it("releases replay for retry when the restart tombstone notice cannot be sent", async () => {
    const { commit, release, inboundDeduper } = createReplayClaim();
    const runtime = { error: vi.fn() };
    sendMessageMatrixMock.mockRejectedValueOnce(new Error("homeserver unavailable"));
    const { handler } = createMatrixHandlerTestHarness({
      inboundDeduper,
      runtime: runtime as never,
      dispatchInboundMessage: vi.fn(async () => {
        throw Object.assign(new Error("session ended during restart recovery"), {
          code: "SESSION_RESTART_RECOVERY_TOMBSTONE",
        });
      }),
    });

    await receiveText(handler, {
      eventId: "$tombstone-notice-failed",
      body: "continue",
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expectRuntimeErrorContaining(
      runtime.error,
      "failed completing restart-recovery tombstone notice",
    );
  });

  it.each(["final", "block"] as const)(
    "keeps replay committed when queued %s delivery fails after a generic error",
    async (kind) => {
      const { commit, release, inboundDeduper } = createReplayClaim();
      const runtime = { error: vi.fn() };
      const { handler } = createMatrixHandlerTestHarness({
        inboundDeduper,
        runtime: runtime as never,
        dispatchInboundMessage: vi.fn(async () => ({
          queuedFinal: kind === "final",
          counts: { final: kind === "final" ? 1 : 0, block: kind === "block" ? 1 : 0, tool: 0 },
        })),
        createReplyDispatcherWithTyping: (params) => ({
          dispatcher: {
            markComplete: () => {},
            waitForIdle: async () => {
              params?.onError?.(new Error("send failed"), { kind });
            },
          },
          replyOptions: {},
          markDispatchIdle: () => {},
          markRunComplete: () => {},
        }),
      });
      await receiveText(handler, { eventId: `$release-on-${kind}-delivery-error`, body: "hello" });
      expect(commit).toHaveBeenCalledOnce();
      expect(release).not.toHaveBeenCalled();
      expectRuntimeErrorContaining(runtime.error, `matrix ${kind} reply failed`);
    },
  );

  it("commits a claimed event when dispatch completes without a final reply", async () => {
    const callOrder: string[] = [];
    const commit = vi.fn(async () => {
      callOrder.push("commit");
      return true;
    });
    const release = vi.fn(() => {
      callOrder.push("release");
    });
    const inboundDeduper = {
      claim: vi.fn(async () => {
        callOrder.push("claim");
        return {
          kind: "claimed" as const,
          handle: { keys: ["test"] as const, commit, release },
        };
      }),
    };
    const { handler } = createMatrixHandlerTestHarness({
      inboundDeduper,
      recordInboundSession: vi.fn(async () => {
        callOrder.push("record");
      }),
      dispatchInboundMessage: vi.fn(async () => {
        callOrder.push("dispatch");
        return {
          queuedFinal: false,
          counts: { final: 0, block: 0, tool: 0 },
        };
      }),
    });

    await receiveText(handler, {
      eventId: "$no-final",
      body: "hello",
    });

    expect(callOrder).toEqual(["claim", "record", "dispatch", "commit"]);
    expect(release).not.toHaveBeenCalled();
  });
});

describe("matrix monitor handler draft streaming", () => {
  type DeliverFn = (payload: ReplyPayload, info: { kind: string }) => Promise<unknown>;

  async function sendPreview(opts: GetReplyOptions, text: string, expectedSends = 1) {
    await opts.onPartialReply?.({ text });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(expectedSends);
    });
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
    sendSingleTextMessageMatrixMock
      .mockReset()
      .mockResolvedValue({ messageId: "$draft1", roomId: "!room" });
    editMessageMatrixMock.mockReset().mockResolvedValue("$edited");
    deliverMatrixRepliesMock.mockReset().mockResolvedValue(createMockMatrixDeliveryResult());

    const redactEventMock = vi.fn(async () => "$redacted");
    const logVerboseMessage = vi.fn();

    const { handler } = createMatrixHandlerTestHarness({
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
        return {
          dispatcher: {
            markComplete: () => {},
            waitForIdle: async () => {},
          },
          replyOptions: {},
          markDispatchIdle: () => {},
          markRunComplete: () => {},
        };
      },
      dispatchInboundMessage: vi.fn(async (args: { replyOptions?: GetReplyOptions }) => {
        capturedReplyOpts = args?.replyOptions;
        notifyCaptured();
        // Block until the test is done exercising callbacks.
        await runGate;
        return { queuedFinal: true, counts: { final: 1, block: 0, tool: 0 } };
      }) as never,
    });

    const dispatch = async () => {
      // Start handler without awaiting — it blocks on runGate.
      const handlerDone = handler(
        "!room:example.org",
        createMatrixTextMessageEvent({ eventId: "$msg1", body: "hello" }),
      );
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

  it("records a failed block typing restart without replaying the accepted delivery", async () => {
    const acceptedDelivery = createMockMatrixDeliveryResult("$accepted", "Already delivered block");
    const { dispatch, logVerboseMessage, redactEventMock } = createStreamingHarness({
      streaming: "off",
    });
    deliverMatrixRepliesMock.mockResolvedValueOnce(acceptedDelivery);
    sendTypingMatrixMock.mockRejectedValueOnce(new Error("typing unavailable"));
    const { deliver, finish } = await dispatch();

    await expect(
      deliver({ text: "Already delivered block" }, { kind: "block" }),
    ).resolves.toMatchObject(acceptedDelivery);

    expect(deliverMatrixRepliesMock).toHaveBeenCalledOnce();
    expect(sendTypingMatrixMock).toHaveBeenCalledExactlyOnceWith("!room:example.org", true, {
      client: expect.objectContaining({ redactEvent: redactEventMock }),
    });
    const expectedDiagnostic =
      "matrix typing action=start failed target=!room:example.org: Error: typing unavailable";
    await waitForMatrixState(() =>
      expect(
        logVerboseMessage.mock.calls.filter(([message]) => message === expectedDiagnostic),
      ).toHaveLength(1),
    );

    await finish();
  });

  it("settles finalized previews with provider-prepared content", async () => {
    prepareMatrixSingleTextMock.mockImplementation((text: string) => ({
      trimmedText: text.trim(),
      convertedText: `prepared:${text.trim()}`,
      singleEventLimit: 4000,
      fitsInSingleEvent: true,
    }));
    const { dispatch } = createStreamingHarness({ streaming: "quiet" });
    const { deliver, opts, finish } = await dispatch();

    await sendPreview(opts, "Raw preview");

    const result = await deliver({ text: "Raw final" }, { kind: "final" });

    expect(result).toMatchObject({
      messageIds: ["$draft1"],
      content: "prepared:Raw final",
    });
    await finish();
  });

  it.each([
    { label: "reply_payload_sending", hooks: ["reply_payload_sending"] },
    { label: "message_sending", hooks: ["message_sending"] },
  ])("suppresses provider previews when $label is registered", async ({ hooks }) => {
    const registered = new Set(hooks);
    getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn((hookName: string) => registered.has(hookName)),
    });
    const { dispatch } = createStreamingHarness({
      previewToolProgressEnabled: true,
      streaming: "progress",
    });
    const { deliver, opts, finish } = await dispatch();

    expect(opts.onPartialReply).toBeUndefined();
    expect(opts.onToolStart).toBeUndefined();
    expect(opts.suppressDefaultToolProgressMessages).toBeUndefined();
    await deliver({ text: "Durable final" }, { kind: "final" });

    expect(sendSingleTextMessageMatrixMock).not.toHaveBeenCalled();
    expect(editMessageMatrixMock).not.toHaveBeenCalled();
    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    await finish();
  });

  it.each(["progress"] as const)(
    "replaces, clears, and resumes Matrix plan snapshots in %s mode",
    async (mode) => {
      vi.useFakeTimers();
      let finish: (() => Promise<void>) | undefined;
      try {
        const { dispatch, redactEventMock } = createStreamingHarness({
          streaming: mode,
          previewToolProgressEnabled: true,
          accountConfig: {
            streaming: { mode, progress: { toolProgress: true, label: false } },
          } as never,
        });
        const streaming = await dispatch();
        const { opts } = streaming;
        finish = streaming.finish;

        await opts.onPlanUpdate?.({ phase: "update", steps: [] });
        expect(sendSingleTextMessageMatrixMock).not.toHaveBeenCalled();
        expect(redactEventMock).not.toHaveBeenCalled();

        await opts.onPlanUpdate?.({
          phase: "update",
          explanation: "Initial plan",
          steps: [{ step: "Inspect", status: "in_progress" }],
        });
        await waitForMatrixState(() => {
          expect(singleTextMessageBody()).toBe("`Initial plan`\n\n`▸ Inspect`");
        });

        await opts.onPlanUpdate?.({
          phase: "update",
          explanation: "Revised plan",
          steps: [
            { step: "Inspect", status: "completed" },
            { step: "Patch", status: "in_progress" },
          ],
        });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(editMessageMatrixMock).toHaveBeenCalled();
        expect(lastCallArg(editMessageMatrixMock, 2, "Matrix plan edit body")).toBe(
          "`Revised plan`\n\n`✅ Inspect`\n`▸ Patch`",
        );

        await opts.onPlanUpdate?.({ phase: "update", steps: [] });
        expect(redactEventMock).toHaveBeenCalledExactlyOnceWith("!room:example.org", "$draft1");
        await opts.onPlanUpdate?.({
          phase: "update",
          steps: [{ step: "Resume", status: "in_progress" }],
        });
        await waitForMatrixState(() => {
          expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(2);
        });
        expect(lastCallArg(sendSingleTextMessageMatrixMock, 1, "Matrix resumed plan body")).toBe(
          "`▸ Resume`",
        );
      } finally {
        try {
          await finish?.();
        } finally {
          vi.useRealTimers();
        }
      }
    },
  );

  it("keeps truncated Matrix tool progress UTF-16 safe", async () => {
    vi.useFakeTimers();
    const { dispatch } = createStreamingHarness({
      streaming: "progress",
      previewToolProgressEnabled: true,
      accountConfig: {
        streaming: {
          mode: "progress",
          progress: { toolProgress: true, label: false, maxLineChars: 500 },
        },
      } as never,
    });
    const { opts, finish } = await dispatch();
    const progressPrefix = "x".repeat(298);

    const progressText = `${progressPrefix}🎉tail`;
    await opts.onItemEvent?.({ progressText });
    await opts.onItemEvent?.({ progressText });
    expect(sendSingleTextMessageMatrixMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(singleTextMessageBody()).toBe(`- \`${progressPrefix}...\``);
    await finish();
    vi.useRealTimers();
  });

  it("keeps Matrix tool progress mentions inside code formatting", async () => {
    const { dispatch } = createStreamingHarness({
      previewToolProgressEnabled: true,
      streaming: "partial",
    });
    const { opts, finish } = await dispatch();

    await opts.onItemEvent?.({
      progressText: "@room ping @alice:example.org [label](https://example.org)",
    });

    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });
    expect(singleTextMessageBody()).toMatch(
      /\n- `@room ping @alice:example\.org \[label\]\(https:\/\/example\.org\)`$/,
    );
    await finish();
  });

  it.each([false])(
    "keeps quiet Matrix status, plans, and approvals with toolProgress=%s",
    async (toolProgress) => {
      vi.useFakeTimers();
      let finish: (() => Promise<void>) | undefined;
      try {
        const { dispatch } = createStreamingHarness({
          streaming: "progress",
          previewToolProgressEnabled: false,
          accountConfig: {
            streaming: { mode: "progress", progress: { label: "Working", toolProgress } },
          },
        });
        const streaming = await dispatch();
        const { opts } = streaming;
        finish = streaming.finish;

        expect(opts.suppressDefaultToolProgressMessages).toBe(true);
        await opts.onItemEvent?.(
          projectAgentToolActivity({ toolCallId: "read-1", name: "read_file", phase: "start" }),
        );
        await opts.onToolStart?.({ toolCallId: "read-1", name: "read_file", phase: "start" });
        expect(sendSingleTextMessageMatrixMock).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1_500);
        expect(singleTextMessageBody()).toBe("Working");

        await opts.onPlanUpdate?.({
          phase: "update",
          steps: [{ step: "Inspect", status: "in_progress" }],
        });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(lastCallArg(editMessageMatrixMock, 2, "Matrix plan edit body")).toContain(
          "▸ Inspect",
        );

        await opts.onApprovalEvent?.({ phase: "requested", command: "confirm-operation" });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(lastCallArg(editMessageMatrixMock, 2, "Matrix approval edit body")).toContain(
          "confirm-operation",
        );

        const quietProgress = lastCallArg(editMessageMatrixMock, 2, "Matrix quiet progress body");
        expect(quietProgress).toContain("Working");
        expect(quietProgress).toContain("▸ Inspect");
        expect(quietProgress).toContain("confirm-operation");
        expect(quietProgress).not.toContain("Read File");
      } finally {
        try {
          await finish?.();
        } finally {
          vi.useRealTimers();
        }
      }
    },
  );

  it.each([{ name: "blank-only media", payload: { text: "Single block", mediaUrls: ["   "] } }])(
    "finalizes unchanged partial drafts for $name",
    async ({ payload }) => {
      const { dispatch, redactEventMock } = createStreamingHarness({
        blockStreamingEnabled: true,
        streaming: "partial",
      });
      const { deliver, opts, finish } = await dispatch();

      await sendPreview(opts, "Single block");

      const draftOptions = requireRecord(
        callArg(sendSingleTextMessageMatrixMock, 0, 2, "draft options"),
        "draft options",
      );
      expect(draftOptions.msgtype).not.toBe("m.notice");
      expect(draftOptions.includeMentions).toBe(false);

      await deliver(payload, { kind: "final" });

      // MSC4357: even when text is unchanged, a finalize edit is sent to clear
      // the live marker so supporting clients stop the streaming animation.
      expect(editMessageMatrixMock).toHaveBeenCalledTimes(1);
      expectEditLiveFlag("$draft1", "Single block", false);
      expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
      expect(redactEventMock).not.toHaveBeenCalled();
      await finish();
    },
  );

  it("preserves a finalized draft receipt when the following media send fails", async () => {
    const { dispatch } = createStreamingHarness({
      blockStreamingEnabled: true,
      streaming: "partial",
    });
    const { deliver, opts, finish } = await dispatch();

    await sendPreview(opts, "Spoken answer");
    deliverMatrixRepliesMock.mockRejectedValueOnce(new Error("media send failed"));

    const error = await deliver(
      {
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        spokenText: "Spoken answer",
        ttsSupplement: { spokenText: "Spoken answer" },
      },
      { kind: "final" },
    ).catch((caught: unknown) => caught);

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
    const { dispatch, redactEventMock } = createStreamingHarness({
      blockStreamingEnabled: true,
      streaming: "partial",
    });
    const { deliver, opts, finish } = await dispatch();

    await sendPreview(opts, "Spoken answer");

    editMessageMatrixMock.mockRejectedValueOnce(new Error("rate limited"));
    await deliver(
      {
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        spokenText: "Spoken answer",
        ttsSupplement: { spokenText: "Spoken answer" },
      },
      { kind: "final" },
    );

    expect(redactEventMock).toHaveBeenCalledWith("!room:example.org", "$draft1");
    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    expect(
      requireRecord(
        callArg(deliverMatrixRepliesMock, 0, 0, "deliver replies params"),
        "deliver replies params",
      ).replies,
    ).toEqual([
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
    createMockMatrixDeliveryResult,
    sendSingleTextMessageMatrixMock,
    editMessageMatrixMock,
    deliverMatrixRepliesMock,
    waitForMatrixState,
    mockCalls,
  });

  it("keeps delayed same-message block boundaries at the emitted block length", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ blockStreamingEnabled: true });
    const { deliver, opts, finish } = await dispatch();

    await opts.onPartialReply?.({ text: "Alpha" });
    await waitForMatrixState(
      () => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      },
      { interval: 1 },
    );

    await opts.onPartialReply?.({ text: "AlphaBeta" });
    await waitForMatrixState(
      () => {
        expectMatrixEdit("!room:example.org", "$draft1", "AlphaBeta");
      },
      { interval: 1 },
    );

    await opts.onBlockReplyQueued?.({ text: "Alpha" });

    sendSingleTextMessageMatrixMock.mockClear();
    editMessageMatrixMock.mockClear();
    sendSingleTextMessageMatrixMock.mockResolvedValueOnce({
      messageId: "$draft2",
      roomId: "!room",
    });
    await deliver({ text: "Alpha" }, { kind: "block" });

    await waitForMatrixState(
      () => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      },
      { interval: 1 },
    );
    expect(singleTextMessageBody()).toBe("Beta");
    expectMatrixEdit("!room:example.org", "$draft1", "Alpha");
    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();
    await finish();
  });

  it("starts fresh progress drafts for queued followups after the primary final", async () => {
    vi.useFakeTimers();
    try {
      const { dispatch } = createStreamingHarness({
        streaming: "progress",
        accountConfig: { streaming: { mode: "progress", progress: { toolProgress: true } } },
        previewToolProgressEnabled: true,
      });
      const { deliver, opts, finish } = await dispatch();

      await opts.onItemEvent?.(
        projectAgentToolActivity({ toolCallId: "read-1", name: "read_file", phase: "start" }),
      );
      await opts.onToolStart?.({ toolCallId: "read-1", name: "read_file", phase: "start" });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);

      await deliver({ text: "Primary answer" }, { kind: "final" });

      sendSingleTextMessageMatrixMock.mockClear();
      sendSingleTextMessageMatrixMock.mockResolvedValue({ messageId: "$draft2", roomId: "!room" });

      await opts.onQueuedFollowupAdmitted?.();
      await opts.onItemEvent?.(
        projectAgentToolActivity({ toolCallId: "exec-followup", name: "exec", phase: "start" }),
      );
      await opts.onToolStart?.({ toolCallId: "exec-followup", name: "exec", phase: "start" });
      // Mirrors DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS: the followup draft must
      // wait out a fresh gate instead of inheriting the primary turn's timer.
      await vi.advanceTimersByTimeAsync(PROGRESS_DRAFT_START_DELAY_MS - 1);
      expect(sendSingleTextMessageMatrixMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      expect(singleTextMessageBody()).toMatch(/`🛠️ Exec: running`$/);
      await finish();
    } finally {
      vi.useRealTimers();
    }
  });

  it("queues late block boundaries against the source assistant message", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { dispatch, redactEventMock } = createStreamingHarness({ blockStreamingEnabled: true });
    const { deliver, opts, finish } = await dispatch();

    try {
      await opts.onAssistantMessageStart?.();
      await sendPreview(opts, "Alpha");

      await opts.onAssistantMessageStart?.();
      await opts.onBlockReplyQueued?.({ text: "Alpha" }, { assistantMessageIndex: 1 });
      await opts.onPartialReply?.({ text: "Beta" });

      // Drive the draft throttle before checking queued-block ordering.
      await vi.advanceTimersByTimeAsync(1_000);
      expectMatrixEdit("!room:example.org", "$draft1", "Beta");

      sendSingleTextMessageMatrixMock.mockClear();
      editMessageMatrixMock.mockClear();
      sendSingleTextMessageMatrixMock.mockResolvedValueOnce({
        messageId: "$draft2",
        roomId: "!room",
      });
      await deliver({ text: "Alpha" }, { kind: "block" });

      expectMatrixEdit("!room:example.org", "$draft1", "Alpha");
      expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
      expect(redactEventMock).not.toHaveBeenCalled();
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });
      expect(singleTextMessageBody()).toBe("Beta");

      await deliver({ text: "Beta" }, { kind: "final" });

      expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
      expect(redactEventMock).not.toHaveBeenCalled();
    } finally {
      await finish();
    }
  });

  it("keeps queued block boundaries ordered while Matrix deliveries drain", async () => {
    const { dispatch } = createStreamingHarness({ blockStreamingEnabled: true });
    const { deliver, opts, finish } = await dispatch();

    await sendPreview(opts, "Alpha");
    expect(singleTextMessageBody()).toBe("Alpha");

    await opts.onBlockReplyQueued?.({ text: "Alpha" });
    await opts.onPartialReply?.({ text: "AlphaBeta" });
    await opts.onBlockReplyQueued?.({ text: "Beta" });
    await opts.onPartialReply?.({ text: "AlphaBetaGamma" });

    expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(editMessageMatrixMock).not.toHaveBeenCalled();

    sendSingleTextMessageMatrixMock.mockClear();
    editMessageMatrixMock.mockClear();
    sendSingleTextMessageMatrixMock.mockResolvedValueOnce({
      messageId: "$draft2",
      roomId: "!room",
    });
    await deliver({ text: "Alpha" }, { kind: "block" });

    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });
    expect(singleTextMessageBody()).toBe("Beta");
    expectFinalizedPreviewEdit("$draft1", "Alpha");

    sendSingleTextMessageMatrixMock.mockClear();
    editMessageMatrixMock.mockClear();
    sendSingleTextMessageMatrixMock.mockResolvedValueOnce({
      messageId: "$draft3",
      roomId: "!room",
    });
    await deliver({ text: "Beta" }, { kind: "block" });

    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });
    expect(singleTextMessageBody()).toBe("Gamma");
    expectFinalizedPreviewEdit("$draft2", "Beta");

    await finish();
  });

  it("stops quiet draft stream on handler error and cleans a draft accepted during shutdown", async () => {
    vi.useFakeTimers();
    try {
      let resolveDraftSend: ((value: { messageId: string; roomId: string }) => void) | undefined;
      sendSingleTextMessageMatrixMock.mockReset().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveDraftSend = resolve;
          }),
      );
      editMessageMatrixMock.mockReset().mockResolvedValue("$edited");
      deliverMatrixRepliesMock.mockReset().mockResolvedValue(createMockMatrixDeliveryResult());
      const redactEventMock = vi.fn(async () => "$redacted");

      let capturedReplyOpts: GetReplyOptions | undefined;

      const { handler } = createMatrixHandlerTestHarness({
        streaming: "quiet",
        client: { redactEvent: redactEventMock },
        createReplyDispatcherWithTyping: () => ({
          dispatcher: { markComplete: () => {}, waitForIdle: async () => {} },
          replyOptions: {},
          markDispatchIdle: () => {},
          markRunComplete: () => {},
        }),
        dispatchInboundMessage: vi.fn(async (args: { replyOptions?: GetReplyOptions }) => {
          capturedReplyOpts = args?.replyOptions;
          // Simulate streaming then model error.
          await capturedReplyOpts?.onPartialReply?.({ text: "partial" });
          throw new Error("model timeout");
        }) as never,
      });

      // Handler should not throw (outer catch absorbs it).
      const handlerPromise = handler(
        "!room:example.org",
        createMatrixTextMessageEvent({ eventId: "$msg1", body: "hello" }),
      );
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });
      resolveDraftSend?.({ messageId: "$draft1", roomId: "!room" });
      await handlerPromise;

      expect(redactEventMock).toHaveBeenCalledWith("!room:example.org", "$draft1");

      // After handler exits, draft stream timer must not fire.
      sendSingleTextMessageMatrixMock.mockClear();
      editMessageMatrixMock.mockClear();
      await vi.advanceTimersByTimeAsync(50);
      expect(sendSingleTextMessageMatrixMock).not.toHaveBeenCalled();
      expect(editMessageMatrixMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains visible live drafts when generation aborts mid-stream", async () => {
    sendSingleTextMessageMatrixMock
      .mockReset()
      .mockResolvedValue({ messageId: "$draft1", roomId: "!room" });
    editMessageMatrixMock.mockReset().mockResolvedValue("$edited");
    deliverMatrixRepliesMock.mockReset().mockResolvedValue(createMockMatrixDeliveryResult());

    const redactEventMock = vi.fn(async () => "$redacted");
    let capturedReplyOpts: GetReplyOptions | undefined;

    const { handler } = createMatrixHandlerTestHarness({
      streaming: "partial",
      client: { redactEvent: redactEventMock },
      createReplyDispatcherWithTyping: () => ({
        dispatcher: { markComplete: () => {}, waitForIdle: async () => {} },
        replyOptions: {},
        markDispatchIdle: () => {},
        markRunComplete: () => {},
      }),
      dispatchInboundMessage: vi.fn(async (args: { replyOptions?: GetReplyOptions }) => {
        capturedReplyOpts = args?.replyOptions;
        await capturedReplyOpts?.onPartialReply?.({ text: "partial" });
        await waitForMatrixState(() => {
          expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
        });
        throw new Error("model timeout");
      }) as never,
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({ eventId: "$msg1", body: "hello" }),
    );

    expect(redactEventMock).not.toHaveBeenCalled();
  });

  it.each([{ name: "blank-only media", payload: { mediaUrls: ["   "] } }])(
    "cleans up empty final drafts with $name",
    async ({ payload }) => {
      const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
      const { deliver, opts, finish } = await dispatch();

      await sendPreview(opts, "Partial reply");

      deliverMatrixRepliesMock.mockClear();
      deliverMatrixRepliesMock.mockResolvedValue({
        visibleReplySent: false,
        suppression: { reason: "no_visible_result" },
      });
      await deliver(payload, { kind: "final" });

      expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
      expect(redactEventMock).not.toHaveBeenCalled();

      await finish();

      expect(redactEventMock).toHaveBeenCalledWith("!room:example.org", "$draft1");
    },
  );

  it("skips compaction notices in draft finalization", async () => {
    const { dispatch } = createStreamingHarness();
    const { deliver, opts, finish } = await dispatch();

    await sendPreview(opts, "Streaming");

    // Compaction notice should bypass draft path and go to normal delivery.
    deliverMatrixRepliesMock.mockClear();
    await deliver({ text: "Compacting...", isCompactionNotice: true }, { kind: "block" });

    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    // Edit should NOT have been called for the compaction notice.
    expect(editMessageMatrixMock).not.toHaveBeenCalled();
    await finish();
  });

  it.each([
    {
      name: "different implicit target",
      replyToMode: "first",
      threadReplies: undefined,
      consumeFirst: false,
      mismatch: true,
      payload: { text: "Final text", replyToId: "$different_msg" },
    },
    {
      name: "explicit target inside thread",
      replyToMode: "off",
      threadReplies: "always",
      consumeFirst: false,
      mismatch: true,
      payload: { text: "Final text", replyToId: "$different_msg", replyToTag: true },
    },
    {
      name: "implicit reply with mode off",
      replyToMode: "off",
      threadReplies: undefined,
      consumeFirst: false,
      mismatch: false,
      payload: { text: "Final text", replyToId: "$suppressed_implicit" },
    },
    {
      name: "implicit thread fallback",
      replyToMode: "first",
      threadReplies: "always",
      consumeFirst: false,
      mismatch: false,
      payload: { text: "Final text", replyToId: "$suppressed_implicit" },
    },
    {
      name: "consumed first reply slot",
      replyToMode: "first",
      threadReplies: undefined,
      consumeFirst: true,
      mismatch: true,
      payload: { text: "Final text" },
    },
  ] as const)(
    "settles draft reply routing for $name",
    async ({ replyToMode, threadReplies, consumeFirst, mismatch, payload }) => {
      const { dispatch, redactEventMock } = createStreamingHarness({ replyToMode, threadReplies });
      const { deliver, opts, finish } = await dispatch();
      if (consumeFirst) {
        await deliver({ text: "tool result", replyToId: "$msg1" }, { kind: "tool" });
        await opts.onAssistantMessageStart?.();
      }
      await sendPreview(opts, "Partial reply");
      if (threadReplies && !mismatch) {
        expect(
          callArg(sendSingleTextMessageMatrixMock, 0, 2, "thread preview options"),
        ).toMatchObject({
          threadId: "$msg1",
          replyToId: undefined,
        });
      }
      deliverMatrixRepliesMock.mockClear();
      await deliver(payload, { kind: "final" });
      if (mismatch) {
        expect(editMessageMatrixMock).not.toHaveBeenCalled();
        expect(redactEventMock).toHaveBeenCalledWith("!room:example.org", "$draft1");
        expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
      } else {
        expect(editMessageMatrixMock).toHaveBeenCalledOnce();
        expect(redactEventMock).not.toHaveBeenCalled();
        expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
      }
      await finish();
    },
  );

  it.each([{ name: "a singular fallback after blank plural entries", mediaUrls: ["   "] }])(
    "reuses partial-draft captions for $name",
    async ({ mediaUrls }) => {
      const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
      const { deliver, opts, finish } = await dispatch();

      await sendPreview(opts, "screenshot ready");

      deliverMatrixRepliesMock.mockClear();
      await deliver(
        {
          text: "screenshot ready",
          mediaUrl: "https://example.com/image.png",
          mediaUrls,
        },
        { kind: "final" },
      );

      expect(editMessageMatrixMock).toHaveBeenCalledTimes(1);
      expectEditLiveFlag("$draft1", "screenshot ready", false);
      expect(redactEventMock).not.toHaveBeenCalled();
      expectDeliveredMediaReply();
      await finish();
    },
  );

  it.each([false, true])("delivers final Matrix mentions normally with media=%s", async (media) => {
    const { dispatch, redactEventMock } = createStreamingHarness({
      streaming: "partial",
      ...(media ? {} : { blockStreamingEnabled: true }),
    });
    const { deliver, opts, finish } = await dispatch();
    const preview = media ? "@room screenshot ready" : "hello @alice:example.org";
    const finalText = media ? preview : `${preview}!`;
    await sendPreview(opts, preview);
    deliverMatrixRepliesMock.mockClear();
    await deliver(
      { text: finalText, ...(media ? { mediaUrl: "https://example.com/image.png" } : {}) },
      { kind: "final" },
    );
    expect(editMessageMatrixMock).not.toHaveBeenCalled();
    expect(redactEventMock).toHaveBeenCalledWith("!room:example.org", "$draft1");
    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    const deliverParams = requireRecord(
      callArg(deliverMatrixRepliesMock, 0, 0, "deliver replies params"),
      "deliver replies params",
    );
    const replies = requireArray(deliverParams.replies, "delivered replies");
    const reply = requireRecord(replies[0], "delivered reply");
    expect(reply.text).toBe(finalText);
    if (media) {
      expect(reply.mediaUrl).toBe("https://example.com/image.png");
    }
    await finish();
  });

  it("redacts stale draft and sends the final once when a later preview exceeds the event limit", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness();
    const { deliver, opts, finish } = await dispatch();

    await sendPreview(opts, "1234");

    prepareMatrixSingleTextMock.mockImplementation((text: string) => {
      const trimmedText = text.trim();
      return {
        trimmedText,
        convertedText: trimmedText,
        singleEventLimit: 5,
        fitsInSingleEvent: trimmedText.length <= 5,
      };
    });

    await opts.onPartialReply?.({ text: "123456" });
    await deliver({ text: "123456" }, { kind: "final" });

    expect(editMessageMatrixMock).not.toHaveBeenCalled();
    expect(redactEventMock).toHaveBeenCalledWith("!room:example.org", "$draft1");
    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    await finish();
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
