import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import { formatSignalMediaText } from "../media-text.js";
import { resetSignalReplyAuthorsForTests } from "../reply-authors.test-helpers.js";
import type { SignalDataMessage, SignalEventHandlerDeps } from "./event-handler.types.js";

const hooks = vi.hoisted(() => ({
  trigger: vi.fn(async () => undefined),
}));
const signalRpcRequest = vi.hoisted(() => vi.fn());
vi.mock("../client-adapter.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../client-adapter.js")>()),
  signalRpcRequest,
}));
vi.mock("openclaw/plugin-sdk/hook-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/hook-runtime")>();
  return {
    ...actual,
    triggerInternalHook: hooks.trigger,
  };
});

let capturedCtx: MsgContext | undefined;
const groupHistories: SignalEventHandlerDeps["groupHistories"] = new Map();
const getCapturedCtx = () => expectDefined(capturedCtx, "Signal MsgContext");

// mock-isolation: Shared helper preserves real exports while isolating worker-backed dispatch.
vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const { signalInboundTestModule } =
    await import("./event-handler.inbound-context.test-support.js");
  return signalInboundTestModule(
    await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>(),
    async () => {},
    async (resolved) => {
      capturedCtx = resolved.ctxPayload;
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    },
    false,
  );
});

const [
  { createBaseSignalEventHandlerDeps, createSignalReceiveEvent },
  { createSignalEventHandler },
  { registerSignalReplyContext, resolveSignalReplyContextWithPersistence },
  { sendMessageSignal },
] = await Promise.all([
  import("./event-handler.test-harness.js"),
  import("./event-handler.js"),
  import("../reply-authors.js"),
  import("../send.js"),
]);

function groupEvent(
  message: string,
  data: Partial<SignalDataMessage> = {},
  envelope: Record<string, unknown> = {},
) {
  return createSignalReceiveEvent({
    dataMessage: {
      message,
      attachments: [],
      groupInfo: { groupId: "g1", groupName: "Test Group" },
      ...data,
    },
    ...envelope,
  });
}
function createMentionHandler(
  deps: Partial<SignalEventHandlerDeps> = {},
  mentionPatterns = ["@bot"],
  groups: NonNullable<NonNullable<OpenClawConfig["channels"]>["signal"]>["groups"] = {
    "*": { requireMention: true },
  },
) {
  return createSignalEventHandler(
    createBaseSignalEventHandlerDeps({
      cfg: {
        messages: { inbound: { debounceMs: 0 }, groupChat: { mentionPatterns } },
        channels: {
          signal: { groups, groupPolicy: deps.groupPolicy, groupAllowFrom: deps.groupAllowFrom },
        },
      },
      groupHistories,
      ...deps,
    }),
  );
}
const storedReply = (replyToId: string) =>
  resolveSignalReplyContextWithPersistence({
    accountId: "default",
    to: "group:g1",
    replyToId,
  });

async function expectSkippedGroupHistory(
  event: ReturnType<typeof groupEvent>,
  expectedBody: string,
  expectedMediaText = "",
  mentionOptions: Partial<SignalEventHandlerDeps> = {},
  patterns = ["@bot"],
) {
  const handler = createMentionHandler(mentionOptions, patterns);
  await handler(event);
  expect(capturedCtx).toBeUndefined();
  const entries = groupHistories.get("g1");
  expect(entries).toHaveLength(1);
  expect(entries?.[0]?.body).toBe(expectedBody);
  expect(formatSignalMediaText(entries?.[0]?.media ?? [])).toBe(expectedMediaText);
}

beforeEach(() => {
  resetSignalReplyAuthorsForTests();
  capturedCtx = undefined;
  groupHistories.clear();
});

it("logs identity-derived mention drops once per account and group while preserving history", async () => {
  const log = vi.fn();
  const createHandler = (accountId: string) =>
    createMentionHandler({
      accountId,
      runtime: { log, error: vi.fn(), exit: vi.fn() },
      groupHistories,
      cfg: { agents: { entries: { main: { identity: { name: "Claw" } } } } },
    });
  const event = (groupId: string) => groupEvent("What up", { groupInfo: { groupId } });
  const handler = createHandler("mention-primary");

  await handler(event("mention-g1"));
  await handler(event("mention-g1"));
  await handler(event("mention-g2"));
  await createHandler("mention-secondary")(event("mention-g1"));

  expect(capturedCtx).toBeUndefined();
  expect(groupHistories.get("mention-g1")).toHaveLength(3);
  expect(log).toHaveBeenCalledTimes(3);
  expect(log.mock.calls[0]?.[0]).toContain("mention-g1");
  expect(log.mock.calls[1]?.[0]).toContain("mention-g2");
  expect(log.mock.calls.flat().join(" ")).not.toMatch(/What up|\+15550001111/);
});

it("allows explicitly configured Signal groups by group id without a mention", async () => {
  const handler = createMentionHandler(
    {
      groupPolicy: "allowlist",
      groupAllowFrom: ["group:g1"],
    },
    ["@bot"],
    { g1: {} },
  );

  await handler(groupEvent("hello everyone"));
  expect(getCapturedCtx().WasMentioned).toBe(false);
});

it("records edited target reply authors for skipped group messages", async () => {
  const handler = createMentionHandler();

  await handler(
    createSignalReceiveEvent({
      timestamp: 1700000000999,
      editMessage: {
        targetSentTimestamp: 1700000000000,
        dataMessage: {
          timestamp: 1700000000999,
          message: "edited without mention",
          groupInfo: { groupId: "g1" },
        },
      },
    }),
  );

  expect(capturedCtx).toBeUndefined();
  await expect(storedReply("1700000000000")).resolves.toEqual({
    author: "+15550001111",
    body: "edited without mention",
  });
});

it("records a structured fact for skipped attachment-only group messages", async () => {
  await expectSkippedGroupHistory(
    groupEvent("", { attachments: [{ id: "a1" }] }, { timestamp: 1700000000123 }),
    "",
    "<media:attachment>",
  );
  await expect(storedReply("1700000000123")).resolves.toEqual({
    author: "+15550001111",
    media: [{ contentType: undefined, kind: "unknown" }],
  });
});

it("passes an unquoted image from another group member in an opted-in group", async () => {
  const fetchAttachment = vi.fn(async () => ({ path: "/tmp/group-image.jpg" }));
  const handler = createMentionHandler(
    { historyLimit: 2, ignoreAttachments: false, fetchAttachment },
    ["@bot"],
    {
      "*": { requireMention: true },
      g1: { requireMention: true, includeOtherMembersHistoryImages: true },
    },
  );
  const sendPhoto = (id: string, timestamp: number, groupId = "g1") =>
    handler(
      groupEvent(
        id,
        { groupInfo: { groupId }, attachments: [{ id, contentType: "image/jpeg" }] },
        { timestamp },
      ),
    );
  await sendPhoto("outside-window", 1700000000000);
  await sendPhoto("other-group", 1700000000001, "g2");
  await sendPhoto("recent-image", 1700000000002);
  await handler(groupEvent("intervening message", {}, { timestamp: 1700000000003 }));
  expect(fetchAttachment).not.toHaveBeenCalled();
  expect(capturedCtx).toBeUndefined();

  await handler(
    groupEvent(
      "@bot what is in the photo above?",
      {},
      {
        sourceNumber: "+15550002222",
        sourceName: "Bob",
        timestamp: 1700000000004,
      },
    ),
  );

  expect(fetchAttachment).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      groupId: "g1",
      attachment: { id: "recent-image", contentType: "image/jpeg" },
    }),
  );
  expect(getCapturedCtx().InboundHistory).toEqual([
    {
      sender: "Alice",
      body: "recent-image",
      timestamp: 1700000000002,
      messageId: "1700000000002",
      media: [{ kind: "image", contentType: "image/jpeg" }],
    },
    {
      sender: "Alice",
      body: "intervening message",
      timestamp: 1700000000003,
      messageId: "1700000000003",
    },
  ]);
  expect(getCapturedCtx().media).toEqual([
    expect.objectContaining({
      kind: "image",
      contentType: "image/jpeg",
      path: "/tmp/group-image.jpg",
      messageId: "1700000000002",
    }),
  ]);
});

it.each([
  { name: "own photos", quote: undefined, expected: ["own"], groupId: "g1" },
  {
    name: "a reply to another member's photo",
    quote: { id: 1700000000001, authorUuid: "alice-uuid" },
    expected: ["own", "other"],
    groupId: "g1",
  },
  {
    name: "a reply to an older photo still in the pending window",
    quote: { id: 1700000000001, authorUuid: "alice-uuid" },
    expected: ["other"],
    groupId: "g1",
    ageMs: 31 * 60_000,
  },
  {
    name: "a quote with a mismatched author",
    quote: { id: 1700000000001, authorNumber: "+15550003333" },
    expected: ["own"],
    groupId: "g1",
  },
  {
    name: "a group with only wildcard configuration",
    quote: undefined,
    expected: ["own"],
    groupId: "g2",
  },
])("limits group history images for $name", async ({ quote, expected, groupId, ageMs = 0 }) => {
  const fetchAttachment = vi.fn<SignalEventHandlerDeps["fetchAttachment"]>(
    async ({ attachment }) => ({ path: `/tmp/${attachment.id}.jpg` }),
  );
  const handler = createMentionHandler(
    { historyLimit: 5, ignoreAttachments: false, fetchAttachment },
    ["@bot"],
    {
      "*": { requireMention: true, includeOtherMembersHistoryImages: true },
      g1: { requireMention: true },
    },
  );
  const groupInfo = { groupId };
  const bob = { sourceUuid: "bob-uuid", sourceNumber: null };
  await handler(
    groupEvent(
      "",
      { groupInfo, attachments: [{ id: "own", contentType: "image/jpeg" }] },
      { ...bob, sourceNumber: "+15550002222" },
    ),
  );
  await handler(
    groupEvent(
      "",
      { groupInfo, attachments: [{ id: "other", contentType: "image/jpeg" }] },
      { sourceUuid: "alice-uuid", timestamp: 1700000000001 },
    ),
  );
  await handler(
    groupEvent(
      "",
      { groupInfo, attachments: [{ id: "unrelated", contentType: "image/jpeg" }] },
      { sourceNumber: "+15550003333", timestamp: 1700000000002 },
    ),
  );
  expect(fetchAttachment).not.toHaveBeenCalled();
  expect(capturedCtx).toBeUndefined();

  await handler(
    groupEvent(
      "@bot what are the photos?",
      { groupInfo, quote },
      { ...bob, timestamp: 1700000000003 + ageMs },
    ),
  );

  expect(fetchAttachment.mock.calls.map(([{ attachment }]) => attachment.id)).toEqual(expected);
  expect(getCapturedCtx().media?.map(({ path }) => path)).toEqual(
    expected.map((id) => `/tmp/${id}.jpg`),
  );
});

it("keeps deleted, disappearing, view-once, and missing images out of model inputs", async () => {
  const fetchAttachment = vi.fn(async () => null);
  const handler = createMentionHandler({
    historyLimit: 10,
    ignoreAttachments: false,
    fetchAttachment,
  });
  const photoAuthor = "11111111-2222-4333-8444-555555555555";
  const images = [
    { id: "view-once", viewOnce: true },
    { id: "disappearing", expiresInSeconds: 60 },
    { id: "deleted" },
    { id: "deleted-by-admin" },
    { id: "missing" },
  ];
  for (const [index, { id, ...options }] of images.entries()) {
    await handler(
      groupEvent(
        "",
        { ...options, attachments: [{ id, contentType: "image/jpeg" }] },
        {
          timestamp: 1700000000000 + index,
          ...(id === "deleted" ? { sourceNumber: null, sourceUuid: photoAuthor } : {}),
        },
      ),
    );
  }
  await handler(
    groupEvent(
      "",
      { remoteDelete: { targetTimestamp: 1700000000002 } },
      { timestamp: 1700000000005, sourceUuid: photoAuthor },
    ),
  );
  expect(
    groupHistories.get("g1")?.find((entry) => entry.messageId === "1700000000002")?.imageSource,
  ).toBeUndefined();
  await handler(
    groupEvent(
      "",
      { adminDelete: { targetTimestamp: 1700000000003 } },
      { timestamp: 1700000000006 },
    ),
  );
  await handler(groupEvent("@bot what was the photo?", {}, { timestamp: 1700000000007 }));
  expect(fetchAttachment).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ attachment: { id: "missing", contentType: "image/jpeg" } }),
  );
  expect(getCapturedCtx().InboundHistory?.flatMap((entry) => entry.media ?? [])).toEqual(
    images.map(() => ({ kind: "image", contentType: "image/jpeg" })),
  );
  expect(getCapturedCtx().media ?? []).toEqual([]);
});

it("keeps a photo deleted by signal-cli 0.14.8 out of a later mention", async () => {
  const fetchAttachment = vi.fn<SignalEventHandlerDeps["fetchAttachment"]>(
    async ({ attachment }) => ({ path: `/tmp/${attachment.id}.jpg` }),
  );
  const handler = createMentionHandler({
    historyLimit: 5,
    ignoreAttachments: false,
    fetchAttachment,
  });
  const deletedTimestamp = 1700000000000;
  for (const [id, timestamp] of [
    ["deleted", deletedTimestamp],
    ["kept", deletedTimestamp + 1],
  ] as const) {
    await handler(
      groupEvent("", { attachments: [{ id, contentType: "image/jpeg" }] }, { timestamp }),
    );
  }
  await handler(
    groupEvent(
      "",
      { remoteDelete: { timestamp: deletedTimestamp } },
      { timestamp: deletedTimestamp + 2 },
    ),
  );
  await handler(groupEvent("@bot what are my photos?", {}, { timestamp: deletedTimestamp + 3 }));

  expect(fetchAttachment.mock.calls.map(([{ attachment }]) => attachment.id)).toEqual(["kept"]);
  expect(getCapturedCtx().media?.map(({ path }) => path)).toEqual(["/tmp/kept.jpg"]);
});

it("filters history senders and bounds Signal image fetches before reading bytes", async () => {
  const fetchAttachment = vi.fn<SignalEventHandlerDeps["fetchAttachment"]>(
    async ({ attachment }) => ({
      path: `/tmp/${attachment.id}.jpg`,
    }),
  );
  const groupAllowFrom = ["group:g1", "+15550002222"];
  const handler = createMentionHandler({
    historyLimit: 10,
    ignoreAttachments: false,
    fetchAttachment,
    groupPolicy: "allowlist",
    groupAllowFrom,
    cfg: {
      messages: { inbound: { debounceMs: 0 }, groupChat: { mentionPatterns: ["@bot"] } },
      channels: {
        signal: {
          contextVisibility: "allowlist",
          groupPolicy: "allowlist",
          groupAllowFrom,
          groups: { g1: { requireMention: true, includeOtherMembersHistoryImages: true } },
        },
      },
    },
  });
  const photo = (id: string) => ({ id, contentType: "image/jpeg" });
  const bob = { sourceNumber: "+15550002222", sourceName: "Bob" };
  await handler(
    groupEvent("", { attachments: [photo("stale")] }, { ...bob, timestamp: 1699990000000 }),
  );
  await handler(
    groupEvent(
      "",
      { attachments: Array.from({ length: 5 }, (_, index) => photo(`visible-${index}`)) },
      {
        ...bob,
        timestamp: 1700000000000,
      },
    ),
  );
  await handler(groupEvent("", { attachments: [photo("hidden")] }, { timestamp: 1700000000001 }));
  await handler(groupEvent("@bot any photos?", {}, { ...bob, timestamp: 1700000000002 }));

  expect(fetchAttachment.mock.calls.map(([{ attachment }]) => attachment.id)).toEqual([
    "visible-1",
    "visible-2",
    "visible-3",
    "visible-4",
  ]);
  expect(getCapturedCtx().media?.map(({ path }) => path)).toEqual([
    "/tmp/visible-1.jpg",
    "/tmp/visible-2.jpg",
    "/tmp/visible-3.jpg",
    "/tmp/visible-4.jpg",
  ]);
});

it("summarizes multiple skipped attachments with stable file count wording", async () => {
  await expectSkippedGroupHistory(
    groupEvent("", { attachments: [{ id: "a1" }, { id: "a2" }] }),
    "",
    "[2 files attached]",
  );
});

it("records quote text in pending history for skipped quote-only group messages", async () => {
  await expectSkippedGroupHistory(
    groupEvent("", { quote: { text: "quoted context" } }),
    "quoted context",
  );
});

const sentQuoteId = 1700000002000;
const humanQuoteId = 1700000003000;

it("includes only the sender's recent photo when a verified bot quote triggers a reply", async () => {
  const account = "+15550002222";
  const cfg: OpenClawConfig = {
    messages: { inbound: { debounceMs: 0 }, groupChat: { mentionPatterns: ["@bot"] } },
    channels: {
      signal: {
        account,
        implicitMentions: { quotedBot: true },
        groups: { g1: { requireMention: true } },
      },
    },
  };
  const fetchAttachment = vi.fn(async () => ({ path: "/tmp/own.jpg" }));
  const handler = createMentionHandler({
    cfg,
    account,
    historyLimit: 5,
    ignoreAttachments: false,
    fetchAttachment,
  });
  const otherPhotoId = 1700000000001;
  const otherSender = "+15550003333";
  await handler(groupEvent("", { attachments: [{ id: "own", contentType: "image/jpeg" }] }));
  await handler(
    groupEvent(
      "",
      { attachments: [{ id: "other", contentType: "image/jpeg" }] },
      { sourceNumber: otherSender, sourceUuid: null, timestamp: otherPhotoId },
    ),
  );
  await handler(
    groupEvent(
      "What is this?",
      { quote: { id: otherPhotoId, authorNumber: otherSender } },
      { timestamp: otherPhotoId + 1 },
    ),
  );
  expect(capturedCtx).toBeUndefined();
  expect(fetchAttachment).not.toHaveBeenCalled();

  signalRpcRequest.mockResolvedValueOnce({
    timestamp: sentQuoteId,
    results: [{ type: "success" }],
  });
  await sendMessageSignal("group:g1", "Earlier answer", { cfg, baseUrl: "http://localhost" });
  await handler(
    groupEvent(
      "What is in my photo?",
      { quote: { id: sentQuoteId, authorNumber: account, text: "Earlier answer" } },
      { timestamp: sentQuoteId + 1 },
    ),
  );

  expect(fetchAttachment).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ attachment: { id: "own", contentType: "image/jpeg" } }),
  );
  expect(getCapturedCtx()).toMatchObject({
    WasMentioned: true,
    media: [{ kind: "image", path: "/tmp/own.jpg" }],
  });
});

it.each([
  { name: "own quote without opt-in", authorUuid: "bot-uuid", dispatched: false },
  { name: "bot UUID", authorUuid: "bot-uuid", quotedBot: true, dispatched: true },
  { name: "bot phone", authorNumber: "+15550002222", quotedBot: true, dispatched: true },
  { name: "legacy bot phone", author: "+15550002222", quotedBot: true, dispatched: true },
  { name: "another author", authorUuid: "other-user", quotedBot: true, dispatched: false },
  {
    name: "human message from the same account",
    authorNumber: "+15550002222",
    quoteId: humanQuoteId,
    quotedBot: true,
    dispatched: false,
  },
  {
    name: "same account without a quote ID",
    authorUuid: "bot-uuid",
    quoteId: null,
    quotedBot: true,
    dispatched: false,
  },
  {
    name: "message sent to a different group",
    authorUuid: "bot-uuid",
    sentTo: "group:g2",
    quotedBot: true,
    dispatched: false,
  },
  {
    name: "message sent from a different account",
    authorUuid: "bot-uuid",
    sentFrom: "work",
    quotedBot: true,
    dispatched: false,
  },
  {
    name: "failed group send",
    authorUuid: "bot-uuid",
    deliveryFailed: true,
    quotedBot: true,
    dispatched: false,
  },
  {
    name: "explicit mention with a human quote",
    authorNumber: "+15550002222",
    quoteId: humanQuoteId,
    quotedBot: true,
    explicit: true,
    dispatched: true,
  },
  {
    name: "disabled quote activation",
    authorUuid: "bot-uuid",
    quotedBot: false,
    dispatched: false,
  },
  {
    name: "shared default is not an account opt-in",
    authorUuid: "bot-uuid",
    defaultQuotedBot: true,
    dispatched: false,
  },
  {
    name: "shared disable takes precedence over account opt-in",
    authorUuid: "bot-uuid",
    quotedBot: true,
    defaultQuotedBot: false,
    dispatched: false,
  },
  {
    name: "named account opt-in",
    authorUuid: "bot-uuid",
    accountId: "work",
    workQuotedBot: true,
    dispatched: true,
  },
  {
    name: "default and other accounts cannot opt in a named account",
    authorUuid: "bot-uuid",
    accountId: "personal",
    quotedBot: true,
    workQuotedBot: true,
    dispatched: false,
  },
  {
    name: "denied sender",
    authorUuid: "bot-uuid",
    quotedBot: true,
    senderAllowed: false,
    dispatched: false,
  },
])("applies Signal quote activation rules: $name", async (testCase) => {
  const groupAllowFrom = testCase.senderAllowed === false ? ["+15550003333"] : ["group:g1"];
  const account = "+15550002222";
  const accountId = testCase.accountId ?? "default";
  const cfg: OpenClawConfig = {
    messages: { inbound: { debounceMs: 0 }, groupChat: { mentionPatterns: ["@bot"] } },
    channels: {
      defaults: { implicitMentions: { quotedBot: testCase.defaultQuotedBot } },
      signal: {
        account,
        implicitMentions: { quotedBot: testCase.quotedBot },
        accounts: { work: { account, implicitMentions: { quotedBot: testCase.workQuotedBot } } },
        groups: { g1: { requireMention: true } },
        groupPolicy: "allowlist",
        groupAllowFrom,
      },
    },
  };
  const handler = createMentionHandler({
    account,
    accountUuid: "bot-uuid",
    accountId,
    groupPolicy: "allowlist",
    groupAllowFrom,
    cfg,
  });
  const quoteId = testCase.quoteId === null ? undefined : (testCase.quoteId ?? sentQuoteId);
  if (quoteId === humanQuoteId) {
    await registerSignalReplyContext({
      accountId,
      to: "group:g1",
      replyToId: String(quoteId),
      author: account,
      body: "Earlier answer",
    });
  } else {
    const sendId = sentQuoteId;
    signalRpcRequest.mockResolvedValueOnce({
      timestamp: sendId,
      results: [{ type: testCase.deliveryFailed ? "network_failure" : "success" }],
    });
    const send = sendMessageSignal(testCase.sentTo ?? "group:g1", "Earlier answer", {
      cfg,
      baseUrl: "http://localhost",
      accountId: testCase.sentFrom ?? accountId,
    });
    if (testCase.deliveryFailed) {
      await expect(send).rejects.toThrow("Signal send failed");
    } else {
      await expect(send).resolves.toMatchObject({ messageId: String(sendId) });
    }
  }
  await handler(
    groupEvent(testCase.explicit ? "@bot, a follow-up" : "A follow-up", {
      quote: {
        id: quoteId,
        author: testCase.author,
        authorNumber: testCase.authorNumber,
        authorUuid: testCase.authorUuid,
        text: "Earlier answer",
      },
    }),
  );
  if (testCase.dispatched) {
    expect(getCapturedCtx()).toMatchObject({ WasMentioned: true, ReplyToBody: "Earlier answer" });
  } else {
    expect(capturedCtx).toBeUndefined();
  }
});

it.each([
  [{ accountUuid: "bot-uuid" }, "Hi X!", { uuid: "bot-uuid", start: 3, length: 1 }, "Hi X!"],
  [
    { account: "+15550002222" },
    "please \uFFFC",
    { number: "1 (555) 000-2222", start: 7, length: 1 },
    "please @1 (555) 000-2222",
  ],
] as const)("allows native bot mentions: %j", async (account, message, mention, body) => {
  const handler = createMentionHandler(account, []);
  await handler(
    groupEvent(message, {
      mentions: [{ name: "ignored" }, mention, { number: "+1555", start: 999, length: 1 }],
    }),
  );
  expect(getCapturedCtx()).toMatchObject({
    Body: expect.stringContaining(body),
    CommandBody: body,
    WasMentioned: true,
  });
});

it.each([
  ["/help \uFFFC", { uuid: "other-user", start: 6, length: 1 }, "/help @other-user"],
  ["plain ping", { uuid: "bot-uuid", start: 99, length: 1 }, "plain ping"],
] as const)(
  "rejects a non-bot or malformed native mention: %s",
  async (message, mention, expected) => {
    await expectSkippedGroupHistory(
      groupEvent(message, { mentions: [mention] }),
      expected,
      "",
      {
        accountUuid: "bot-uuid",
      },
      [],
    );
  },
);
it.each([false, true])("mention-skip ingest honors group override=%s", async (overrideGroup) => {
  hooks.trigger.mockClear();
  const handler = createMentionHandler({}, ["@bot"], {
    "*": { requireMention: true, ingest: true },
    ...(overrideGroup ? { "group-123": { requireMention: true, ingest: false } } : {}),
  });
  await handler(
    groupEvent("hello without mention", {
      groupInfo: { groupId: "group-123", groupName: "Ops" },
    }),
  );
  if (overrideGroup) {
    expect(hooks.trigger).not.toHaveBeenCalled();
  } else {
    expect(hooks.trigger).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: "message",
        action: "received",
        sessionKey: expect.stringContaining("signal"),
        context: expect.objectContaining({
          content: "hello without mention",
          channelId: "signal",
          conversationId: "group:group-123",
        }),
      }),
    );
  }
});
