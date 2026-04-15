import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDispatchInboundCaptureMock } from "../../../../src/channels/plugins/contracts/inbound-testkit.js";

type SignalMsgContext = Pick<MsgContext, "Body" | "WasMentioned"> & {
  Body?: string;
  WasMentioned?: boolean;
};

let capturedCtx: SignalMsgContext | undefined;

function getCapturedCtx() {
  return capturedCtx as SignalMsgContext;
}

vi.mock("openclaw/plugin-sdk/reply-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-runtime")>(
    "openclaw/plugin-sdk/reply-runtime",
  );
  return buildDispatchInboundCaptureMock(actual, (ctx) => {
    capturedCtx = ctx as SignalMsgContext;
  });
});

const [
  { createBaseSignalEventHandlerDeps, createSignalReceiveEvent },
  { createSignalEventHandler },
  { doesSignalMentionTargetBot, renderSignalMentions },
] = await Promise.all([
  import("./event-handler.test-harness.js"),
  import("./event-handler.js"),
  import("./mentions.js"),
]);

type GroupEventOpts = {
  message?: string;
  attachments?: unknown[];
  quoteText?: string;
  mentions?: Array<{
    uuid?: string;
    number?: string;
    start?: number;
    length?: number;
  }> | null;
};

function makeGroupEvent(opts: GroupEventOpts) {
  return createSignalReceiveEvent({
    dataMessage: {
      message: opts.message ?? "",
      attachments: opts.attachments ?? [],
      quote: opts.quoteText ? { text: opts.quoteText } : undefined,
      mentions: opts.mentions ?? undefined,
      groupInfo: { groupId: "g1", groupName: "Test Group" },
    },
  });
}

function createMentionHandler(params: {
  requireMention: boolean;
  mentionPattern?: string;
  historyLimit?: number;
  groupHistories?: ReturnType<typeof createBaseSignalEventHandlerDeps>["groupHistories"];
}) {
  return createSignalEventHandler(
    createBaseSignalEventHandlerDeps({
      cfg: createSignalConfig({
        requireMention: params.requireMention,
        mentionPattern: params.mentionPattern,
      }),
      ...(typeof params.historyLimit === "number" ? { historyLimit: params.historyLimit } : {}),
      ...(params.groupHistories ? { groupHistories: params.groupHistories } : {}),
    }),
  );
}

function createMentionGatedHistoryHandler() {
  const groupHistories = new Map();
  const handler = createMentionHandler({ requireMention: true, historyLimit: 5, groupHistories });
  return { handler, groupHistories };
}

function createSignalConfig(params: { requireMention: boolean; mentionPattern?: string }) {
  return {
    messages: {
      inbound: { debounceMs: 0 },
      groupChat: { mentionPatterns: [params.mentionPattern ?? "@bot"] },
    },
    channels: {
      signal: {
        groups: { "*": { requireMention: params.requireMention } },
      },
    },
  } as unknown as OpenClawConfig;
}

async function expectSkippedGroupHistory(opts: GroupEventOpts, expectedBody: string) {
  capturedCtx = undefined;
  const { handler, groupHistories } = createMentionGatedHistoryHandler();
  await handler(makeGroupEvent(opts));
  expect(capturedCtx).toBeUndefined();
  const entries = groupHistories.get("g1");
  expect(entries).toBeTruthy();
  expect(entries).toHaveLength(1);
  expect(entries[0].body).toBe(expectedBody);
}

describe("signal mention gating", () => {
  beforeEach(() => {
    capturedCtx = undefined;
  });

  it("drops group messages without mention when requireMention is configured", async () => {
    const handler = createMentionHandler({ requireMention: true });

    await handler(makeGroupEvent({ message: "hello everyone" }));
    expect(capturedCtx).toBeUndefined();
  });

  it("allows group messages with mention when requireMention is configured", async () => {
    const handler = createMentionHandler({ requireMention: true });

    await handler(makeGroupEvent({ message: "hey @bot what's up" }));
    expect(capturedCtx).toBeTruthy();
    expect(getCapturedCtx()?.WasMentioned).toBe(true);
  });

  it("sets WasMentioned=false for group messages without mention when requireMention is off", async () => {
    const handler = createMentionHandler({ requireMention: false });

    await handler(makeGroupEvent({ message: "hello everyone" }));
    expect(capturedCtx).toBeTruthy();
    expect(getCapturedCtx()?.WasMentioned).toBe(false);
  });

  it("records pending history for skipped group messages", async () => {
    const { handler, groupHistories } = createMentionGatedHistoryHandler();
    await handler(makeGroupEvent({ message: "hello from alice" }));
    expect(capturedCtx).toBeUndefined();
    const entries = groupHistories.get("g1");
    expect(entries).toHaveLength(1);
    expect(entries[0].sender).toBe("Alice");
    expect(entries[0].body).toBe("hello from alice");
  });

  it("records attachment placeholder in pending history for skipped attachment-only group messages", async () => {
    await expectSkippedGroupHistory(
      { message: "", attachments: [{ id: "a1" }] },
      "<media:attachment>",
    );
  });

  it("normalizes mixed-case parameterized attachment MIME in skipped pending history", async () => {
    const groupHistories = new Map();
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: createSignalConfig({ requireMention: true }),
        historyLimit: 5,
        groupHistories,
        ignoreAttachments: false,
      }),
    );

    await handler(
      makeGroupEvent({
        message: "",
        attachments: [{ contentType: " Audio/Ogg; codecs=opus " }],
      }),
    );

    expect(capturedCtx).toBeUndefined();
    const entries = groupHistories.get("g1");
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toBe("<media:audio>");
  });

  it("summarizes multiple skipped attachments with stable file count wording", async () => {
    const groupHistories = new Map();
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: createSignalConfig({ requireMention: true }),
        historyLimit: 5,
        groupHistories,
        ignoreAttachments: false,
        fetchAttachment: async ({ attachment }) => ({
          path: `/tmp/${String(attachment.id)}.bin`,
        }),
      }),
    );

    await handler(
      makeGroupEvent({
        message: "",
        attachments: [{ id: "a1" }, { id: "a2" }],
      }),
    );

    expect(capturedCtx).toBeUndefined();
    const entries = groupHistories.get("g1");
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toBe("[2 files attached]");
  });

  it("records quote text in pending history for skipped quote-only group messages", async () => {
    await expectSkippedGroupHistory({ message: "", quoteText: "quoted context" }, "quoted context");
  });

  it("bypasses mention gating for authorized control commands", async () => {
    const handler = createMentionHandler({ requireMention: true });

    await handler(makeGroupEvent({ message: "/help" }));
    expect(capturedCtx).toBeTruthy();
  });

  it("hydrates mention placeholders before trimming so offsets stay aligned", async () => {
    const handler = createMentionHandler({ requireMention: false });

    const placeholder = "\uFFFC";
    const message = `\n${placeholder} hi ${placeholder}`;
    const firstStart = message.indexOf(placeholder);
    const secondStart = message.indexOf(placeholder, firstStart + 1);

    await handler(
      makeGroupEvent({
        message,
        mentions: [
          { uuid: "123e4567", start: firstStart, length: placeholder.length },
          { number: "+15550002222", start: secondStart, length: placeholder.length },
        ],
      }),
    );

    expect(capturedCtx).toBeTruthy();
    const body = String(getCapturedCtx()?.Body ?? "");
    expect(body).toContain("@123e4567 hi @+15550002222");
    expect(body).not.toContain(placeholder);
  });

  it("treats native @mention of the bot's own uuid as a mention under requireMention", async () => {
    const botUuid = "bot-uuid-aaaa";
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: createSignalConfig({ requireMention: true, mentionPattern: "@caio" }),
        account: "+15559990000",
        accountUuid: botUuid,
      }),
    );

    const placeholder = "\uFFFC";
    const message = `${placeholder} ping`;

    await handler(
      makeGroupEvent({
        message,
        mentions: [{ uuid: botUuid, start: 0, length: placeholder.length }],
      }),
    );

    expect(capturedCtx).toBeTruthy();
    expect(getCapturedCtx()?.WasMentioned).toBe(true);
  });

  it("treats native @mention of the bot's own phone as a mention under requireMention", async () => {
    const botPhone = "+15559990000";
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: createSignalConfig({ requireMention: true, mentionPattern: "@caio" }),
        account: botPhone,
      }),
    );

    const placeholder = "\uFFFC";
    const message = `${placeholder} ping`;

    await handler(
      makeGroupEvent({
        message,
        mentions: [{ number: botPhone, start: 0, length: placeholder.length }],
      }),
    );

    expect(capturedCtx).toBeTruthy();
    expect(getCapturedCtx()?.WasMentioned).toBe(true);
  });

  it("does not treat @mentions of other participants as bot mentions", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: createSignalConfig({ requireMention: true, mentionPattern: "@caio" }),
        account: "+15559990000",
        accountUuid: "bot-uuid-aaaa",
      }),
    );

    const placeholder = "\uFFFC";
    const message = `${placeholder} hi`;

    await handler(
      makeGroupEvent({
        message,
        mentions: [{ uuid: "someone-else-uuid", start: 0, length: placeholder.length }],
      }),
    );

    expect(capturedCtx).toBeUndefined();
  });

  it("counts mention metadata replacements toward requireMention gating", async () => {
    const handler = createMentionHandler({
      requireMention: true,
      mentionPattern: "@123e4567",
    });

    const placeholder = "\uFFFC";
    const message = ` ${placeholder} ping`;
    const start = message.indexOf(placeholder);

    await handler(
      makeGroupEvent({
        message,
        mentions: [{ uuid: "123e4567", start, length: placeholder.length }],
      }),
    );

    expect(capturedCtx).toBeTruthy();
    expect(String(getCapturedCtx()?.Body ?? "")).toContain("@123e4567");
    expect(getCapturedCtx()?.WasMentioned).toBe(true);
  });
});

describe("renderSignalMentions", () => {
  const PLACEHOLDER = "\uFFFC";

  it("returns the original message when no mentions are provided", () => {
    const message = `${PLACEHOLDER} ping`;
    expect(renderSignalMentions(message, null)).toBe(message);
    expect(renderSignalMentions(message, [])).toBe(message);
  });

  it("replaces placeholder code points using mention metadata", () => {
    const message = `${PLACEHOLDER} hi ${PLACEHOLDER}!`;
    const normalized = renderSignalMentions(message, [
      { uuid: "abc-123", start: 0, length: 1 },
      { number: "+15550005555", start: message.lastIndexOf(PLACEHOLDER), length: 1 },
    ]);

    expect(normalized).toBe("@abc-123 hi @+15550005555!");
  });

  it("skips mentions that lack identifiers or out-of-bounds spans", () => {
    const message = `${PLACEHOLDER} hi`;
    const normalized = renderSignalMentions(message, [
      { name: "ignored" },
      { uuid: "valid", start: 0, length: 1 },
      { number: "+1555", start: 999, length: 1 },
    ]);

    expect(normalized).toBe("@valid hi");
  });

  it("clamps and truncates fractional mention offsets", () => {
    const message = `${PLACEHOLDER} ping`;
    const normalized = renderSignalMentions(message, [{ uuid: "valid", start: -0.7, length: 1.9 }]);

    expect(normalized).toBe("@valid ping");
  });
});

describe("doesSignalMentionTargetBot", () => {
  it("returns false when no mentions are supplied", () => {
    expect(doesSignalMentionTargetBot(undefined, { uuid: "u" })).toBe(false);
    expect(doesSignalMentionTargetBot(null, { uuid: "u" })).toBe(false);
    expect(doesSignalMentionTargetBot([], { uuid: "u" })).toBe(false);
  });

  it("returns false when the bot has no identity", () => {
    expect(doesSignalMentionTargetBot([{ uuid: "u" }], {})).toBe(false);
    expect(doesSignalMentionTargetBot([{ uuid: "u" }], { uuid: "", phone: "" })).toBe(false);
  });

  it("matches by bot uuid", () => {
    expect(doesSignalMentionTargetBot([{ uuid: "bot-u" }], { uuid: "bot-u" })).toBe(true);
    expect(doesSignalMentionTargetBot([{ uuid: "other" }], { uuid: "bot-u" })).toBe(false);
  });

  it("matches by bot phone with E.164 normalization", () => {
    expect(
      doesSignalMentionTargetBot([{ number: "15551234567" }], { phone: "+1 (555) 123-4567" }),
    ).toBe(true);
    expect(
      doesSignalMentionTargetBot([{ number: "+15550009999" }], { phone: "+15551234567" }),
    ).toBe(false);
  });

  it("matches when any of several mentions targets the bot", () => {
    expect(
      doesSignalMentionTargetBot(
        [{ uuid: "someone" }, { uuid: "bot-u" }, { number: "+15550001111" }],
        { uuid: "bot-u" },
      ),
    ).toBe(true);
  });
});
