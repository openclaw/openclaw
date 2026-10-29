import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
const respond = vi.fn<Parameters<typeof deliverSlackSlashReplies>[0]["respond"]>();
vi.mock("../send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../send.js")>()),
  sendMessageSlack: (...args: unknown[]) => sendMock(...args),
}));

const triggerInternalHook = vi.hoisted(() => vi.fn(async () => {}));
const messageHookRunner = vi.hoisted(() => ({
  hasHooks: vi.fn<(name: string) => boolean>(() => false),
  runMessageSent: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/hook-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/hook-runtime")>()),
  triggerInternalHook,
}));
vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>()),
  getGlobalHookRunner: () => messageHookRunner,
}));

import { prepareSlackReply } from "../reply-blocks.js";
import {
  createSlackReplyDeliveryPlan,
  deliverReplies,
  deliverSlackSlashReplies,
  sanitizeSlackMonitorReplyPayload,
} from "./replies.js";

const SLACK_TEST_CFG = { channels: { slack: { botToken: "xoxb-test" } } };
const revenueSegments = [
  { label: "Product", value: 60 },
  { label: "Services", value: 40 },
];
const revenueChart = {
  type: "chart" as const,
  chartType: "pie" as const,
  title: "Revenue mix",
  segments: revenueSegments,
};
const nativeRevenueChart = {
  type: "data_visualization",
  title: "Revenue mix",
  chart: { type: "pie", segments: revenueSegments },
};
const refreshAction = {
  type: "actions",
  elements: [
    {
      type: "button",
      action_id: "openclaw:reply_button",
      text: { type: "plain_text", text: "Refresh" },
      value: "refresh",
    },
  ],
};
const revenueText = "Revenue mix (pie chart)\n- Product: 60\n- Services: 40";
function nativeTable(caption: string) {
  return {
    type: "data_table",
    caption,
    rows: [[{ type: "raw_text", text: "Account" }], [{ type: "raw_text", text: "Acme" }]],
  };
}
const tableText = (caption: string) => `${caption} (table)\nAccount\nAcme`;
const blockTypes = (message: SlashTestMessage | undefined) =>
  message?.blocks?.map((block) => block.type);
const joinedText = (messages: SlashTestMessage[]) => messages.map(({ text }) => text).join("");
function buttons(label: string, value: string, style?: "primary") {
  return { type: "buttons" as const, buttons: [{ label, value, ...(style ? { style } : {}) }] };
}
const sentEvent = () =>
  messageHookRunner.runMessageSent.mock.calls[0]?.[0] as Record<string, unknown>;
const enableSentHook = () =>
  messageHookRunner.hasHooks.mockImplementation((name: string) => name === "message_sent");
type SlashParams = Parameters<typeof deliverSlackSlashReplies>[0];
function deliverSlash(
  replies: SlashParams["replies"],
  options: Partial<Omit<SlashParams, "respond" | "replies">> = {},
) {
  return deliverSlackSlashReplies({
    ephemeral: true,
    textLimit: 8000,
    respond,
    replies,
    ...options,
  });
}

beforeEach(() => {
  sendMock.mockReset();
  respond.mockReset().mockResolvedValue(undefined);
  messageHookRunner.hasHooks.mockReset().mockReturnValue(false);
  messageHookRunner.runMessageSent.mockReset();
  triggerInternalHook.mockReset();
});

describe("sanitizeSlackMonitorReplyPayload", () => {
  const channelData = { slack: { blocks: [{ type: "divider" }] } };
  it.each([
    { name: "drops reasoning", payload: { text: "private", isReasoning: true }, expected: null },
    { name: "drops internal-only text", payload: { text: "⚠️ 🛠️ Exec failed: " }, expected: null },
    {
      name: "preserves structured content when internal text is removed",
      payload: { text: "⚠️ 🛠️ Exec failed: ", channelData },
      expected: { text: undefined, channelData },
    },
  ])("$name", ({ payload, expected }) => {
    expect(sanitizeSlackMonitorReplyPayload(payload)).toEqual(expected);
  });
});
function baseParams({ replies, ...overrides }: { replies: TestReply[] } & Record<string, unknown>) {
  return {
    cfg: SLACK_TEST_CFG,
    target: "C123",
    token: "xoxb-test",
    runtime: { log: () => {}, error: () => {}, exit: () => {} },
    textLimit: 4000,
    replyToMode: "off" as const,
    ...overrides,
    replies: replies.map((reply) => prepareSlackReply(reply)),
  };
}
type TestReply = Parameters<typeof prepareSlackReply>[0];
function deliverPrepared(reply: TestReply | TestReply[], overrides?: Record<string, unknown>) {
  return deliverReplies(
    baseParams({ ...overrides, replies: Array.isArray(reply) ? reply : [reply] }),
  );
}
type Transport = "web" | "slash";
const deliverVia = (transport: Transport, replies: TestReply[]) =>
  transport === "web"
    ? deliverPrepared(replies)
    : deliverSlash(replies, { messageSentHookTarget: "user:U1" });
function expectTextDelivery(transport: Transport, text: string) {
  expect(transport === "web" ? sendMock : respond).toHaveBeenCalledOnce();
  expect(transport === "web" ? requireSendCall()[1] : requireSlashMessage().text).toBe(text);
}

describe.each(["web", "slash"] as const)("%s reply payloads", (transport) => {
  it("delivers prepared NO_REPLY text literally", async () => {
    await deliverVia(transport, [{ text: "NO_REPLY" }]);
    expectTextDelivery(transport, "NO_REPLY");
  });
  it("suppresses reasoning and delivers only the visible answer", async () => {
    await deliverVia(transport, [{ text: "private", isReasoning: true }, { text: "visible" }]);
    expectTextDelivery(transport, "visible");
  });
  it("reports spoken text for media-only TTS replies", async () => {
    enableSentHook();
    sendMock.mockResolvedValue({ messageId: "tts-1", channelId: "C123" });
    const spokenText = "Spoken answer";
    const mediaUrl = "https://example.com/tts.mp3";
    await deliverVia(transport, [
      {
        mediaUrl,
        spokenText,
        ...(transport === "web" ? { ttsSupplement: { spokenText } } : { audioAsVoice: true }),
      },
    ]);
    expectMediaHook(spokenText);
    if (transport === "slash") {
      expect(respond).toHaveBeenCalledWith({ text: mediaUrl, response_type: "ephemeral" });
    }
  });
});
function largePortableTablePresentation(rowLength = 110) {
  return {
    blocks: [
      {
        type: "table" as const,
        caption: "Large pipeline",
        headers: ["Account"],
        rows: Array.from({ length: 100 }, (_entry, index) => [
          index === 0 ? "<@U123>" : `account-${String(index)} ${"x".repeat(rowLength)}`,
        ]),
      },
    ],
  };
}
function requireSendCall(index = 0) {
  const call = sendMock.mock.calls[index] as [string, string, Record<string, unknown>] | undefined;
  if (!call) {
    throw new Error(`sendMessageSlack call ${index} missing`);
  }
  return call;
}
function acceptedSlackSendResult(messageId: string, kind: "media" | "text" | "card" = "media") {
  return {
    messageId,
    channelId: "C123",
    receipt: createMessageReceiptFromOutboundResults({
      results: [{ channel: "slack", messageId, channelId: "C123" }],
      kind,
    }),
  };
}
function acceptSend(result: ReturnType<typeof acceptedSlackSendResult>) {
  sendMock.mockImplementationOnce(async (_target, _text, options) => {
    await options.onDeliveryResult?.(result);
    return result;
  });
}
const noSendFailure = (message: string) =>
  new PlatformMessageNotDispatchedError(message, {
    cause: new Error("upload connection refused"),
  });
type SlashTestMessage = {
  text: string;
  blocks?: Array<Record<string, unknown>>;
  mrkdwn?: false;
  response_type?: "ephemeral" | "in_channel";
};
function requireSlashMessage(index = 0): SlashTestMessage {
  const message = respond.mock.calls[index]?.[0] as SlashTestMessage | undefined;
  if (!message) {
    throw new Error(`Slack response call ${String(index)} missing`);
  }
  return message;
}
function slashMessages(count: number, start = 0) {
  expect(respond).toHaveBeenCalledTimes(count);
  return Array.from({ length: count - start }, (_, index) => requireSlashMessage(index + start));
}
function expectPlainChunks(messages: SlashTestMessage[], limit: number, text: string) {
  for (const message of messages) {
    expect(message.blocks).toBeUndefined();
    expect(message.text.length).toBeLessThanOrEqual(limit);
  }
  expect(joinedText(messages)).toBe(text);
}
function expectMediaHook(content: string) {
  expect(messageHookRunner.runMessageSent).toHaveBeenCalledOnce();
  expect(sentEvent()).toMatchObject({ content, success: true });
  expect(sentEvent()).not.toHaveProperty("messageId");
}
function rejectNativeBlocks() {
  respond.mockRejectedValueOnce({
    response: { data: { error: "invalid_blocks" } },
  });
}
function readPlainSectionTexts(message: SlashTestMessage): string[] {
  return (message.blocks ?? []).flatMap((block) => {
    const text = block.text as { type?: unknown; text?: unknown } | undefined;
    return text?.type === "plain_text" && typeof text.text === "string" ? [text.text] : [];
  });
}
function blockReply(blocks: NonNullable<SlashTestMessage["blocks"]>, text?: string) {
  return { ...(text === undefined ? {} : { text }), channelData: { slack: { blocks } } };
}

describe("deliverReplies identity passthrough", () => {
  it("synchronizes the caller's reply reference when marking delivery sent", () => {
    const hasRepliedRef = { value: false };
    const plan = createSlackReplyDeliveryPlan({
      replyToMode: "first",
      messageTs: "root",
      incomingThreadTs: undefined,
      hasRepliedRef,
      isThreadReply: false,
    });
    plan.markSent();
    expect(hasRepliedRef.value).toBe(true);
  });
  it("sends nothing when the producer supplies no payload", async () => {
    await deliverPrepared([]);
    expect(sendMock).not.toHaveBeenCalled();
  });
  it("routes current reply without mistaking a child for its thread root", async () => {
    await deliverPrepared(
      {
        text: "Thread reply",
        replyToId: "1800000000.000002",
        replyToCurrent: true,
      },
      {
        replyThreadTs: "1800000000.000001",
        replyToMode: "all",
      },
    );
    expect(requireSendCall()[2].threadTs).toBe("1800000000.000001");
  });
  it("delivers complete literal table text within the hard limit (450)", async () => {
    const textCalls = 2;
    await deliverPrepared(
      {
        presentation: largePortableTablePresentation(450),
        interactive: { blocks: [buttons("Refresh", "refresh", "primary")] },
      },
      { textLimit: 8000 },
    );
    expect(sendMock).toHaveBeenCalledTimes(textCalls + 1);
    const textSends = Array.from({ length: textCalls }, (_entry, index) => requireSendCall(index));
    const text = textSends.map((call) => call[1]).join("");
    expect(text).toContain("- Account: <@U123>");
    expect(text).toContain("- Account: account-99");
    expect(text.length).toBeGreaterThan(8000);
    for (const [_target, chunk, options] of textSends) {
      expect(chunk.length).toBeLessThanOrEqual(40_000);
      expect(options.textIsSlackPlainText).toBe(true);
      expect(options.blocks).toBeUndefined();
    }
    const [_blockTarget, blockText, blockOptions] = requireSendCall(textCalls);
    expect(blockText).toBe("");
    expect(blockOptions.blocks).toMatchObject([
      {
        type: "actions",
        elements: [
          {
            type: "button",
            value: "refresh",
            style: "primary",
            action_id: "openclaw:reply_button:1:1",
          },
        ],
      },
    ]);
  });
  it("delivers media before native chart blocks with the same reply context", async () => {
    enableSentHook();
    sendMock
      .mockResolvedValueOnce({ messageId: "media-ts", channelId: "C123" })
      .mockResolvedValueOnce({ messageId: "chart-ts", channelId: "C123" });
    const context = {
      cfg: { channels: { slack: {} } },
      accountId: "work",
      identity: { username: "Bot", iconEmoji: ":chart_with_upwards_trend:" },
      metadata: { event_type: "openclaw_test", event_payload: { source: "chart" } },
      eventScope: { teamId: "T1", client: { chat: { postMessage: vi.fn() } } as never },
      mediaMaxBytes: 1024,
    };
    const params = baseParams({
      ...context,
      replyThreadTs: "thread-ts",
      replies: [
        {
          text: "Revenue summary",
          mediaUrl: "https://example.com/report.png",
          presentation: { blocks: [revenueChart] },
        },
      ],
    });
    // Preview materialization must not consume the media caption or add it to the chart message.
    params.replies[0]?.resolvePreview();
    const result = await deliverReplies(params);
    expect(sendMock).toHaveBeenCalledTimes(2);
    const commonOptions = {
      ...context,
      token: "xoxb-test",
      threadTs: "thread-ts",
      onDeliveryResult: expect.any(Function),
      textLimit: 4000,
    };
    expect(sendMock).toHaveBeenNthCalledWith(1, "C123", "Revenue summary", {
      ...commonOptions,
      mediaUrl: "https://example.com/report.png",
    });
    expect(sendMock).toHaveBeenNthCalledWith(2, "C123", "", {
      ...commonOptions,
      blocks: [nativeRevenueChart],
      authoredTextPlacement: "none",
    });
    expect(result).toEqual({ messageId: "chart-ts", channelId: "C123" });
    expectMediaHook(`Revenue summary\n\n${revenueText}`);
    expect(sentEvent().to).toBe("C123");
  });
});

describe("deliverSlackSlashReplies chunking", () => {
  it("keeps a 4205-character reply in a single slash response by default", async () => {
    const text = "a".repeat(4205);
    await deliverSlash([{ text }]);
    expect(respond).toHaveBeenCalledExactlyOnceWith({ text, response_type: "ephemeral" });
  });
  it("delivers a valid field-rich section in one slash response", async () => {
    const fields = ["Alpha", "Beta", "Gamma"].map((label) => ({
      type: "plain_text",
      text: label.padEnd(1_500, "."),
    }));
    const blocks = [{ type: "section", fields }];
    await deliverSlash([blockReply(blocks)]);
    expect(respond).toHaveBeenCalledExactlyOnceWith({
      blocks,
      text: fields.map((field) => field.text).join("\n"),
      mrkdwn: false,
      response_type: "ephemeral",
    });
  });
  it("replaces rejected native data in place without duplicating authored text", async () => {
    rejectNativeBlocks();
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: "Overview" } },
      nativeRevenueChart,
      refreshAction,
      nativeTable("Pipeline report"),
    ];
    await deliverSlash([blockReply(blocks, "Overview")]);
    expect(respond).toHaveBeenCalledTimes(2);
    const native = requireSlashMessage(0);
    const fallback = requireSlashMessage(1);
    expect(blockTypes(native)).toEqual(["section", "data_visualization", "actions", "data_table"]);
    expect(blockTypes(fallback)).toEqual(["section", "section", "actions", "section"]);
    expect(readPlainSectionTexts(fallback)).toEqual([revenueText, tableText("Pipeline report")]);
    expect(fallback.text).toBe(
      ["Overview", revenueText, "Refresh", tableText("Pipeline report")].join("\n\n"),
    );
    expect(fallback.mrkdwn).toBe(false);
  });
  it("does not repeat a response_url mutation when body inspection stalls", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(async () => undefined);
      const response = {
        status: 200,
        body: {
          getReader: () => ({
            read: async () => await new Promise<never>(() => {}),
            cancel,
            releaseLock: () => {},
          }),
        },
      };
      respond.mockResolvedValue(response);
      const delivery = deliverSlash([
        blockReply([
          { ...nativeRevenueChart, chart: { type: "pie", segments: [revenueSegments[0]] } },
        ]),
      ]);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(delivery).resolves.toBeUndefined();
      expect(respond).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("uses complete 40k blockless chunks for oversized native-only fallback", async () => {
    const caption = "c".repeat(41_000);
    const blocks = [nativeTable(caption)] as never;
    await deliverSlash([blockReply(blocks)]);
    const messages = slashMessages(2);
    expectPlainChunks(messages, 40_000, tableText(caption));
    expect(messages.every((message) => message.mrkdwn === false)).toBe(true);
  });
  it("keeps 4k native fallback chunks for uncapped Web API delivery", async () => {
    rejectNativeBlocks();
    const caption = "c".repeat(9_000);
    const blocks = [nativeTable(caption)] as never;
    await deliverSlash([blockReply(blocks)], {
      responseBudget: { respond, remaining: () => undefined },
    });
    const fallback = slashMessages(4, 1);
    expectPlainChunks(fallback, 4_000, tableText(caption));
  });
  it("batches in-place native fallback at 50 blocks without losing content", async () => {
    rejectNativeBlocks();
    const caption = "c".repeat(9_000);
    const blocks = [
      ...Array.from({ length: 48 }, () => ({ type: "divider" })),
      refreshAction,
      nativeTable(caption),
    ] as never;
    await deliverSlash([blockReply(blocks)]);
    const fallback = slashMessages(3, 1);
    expect(fallback.every((message) => (message.blocks?.length ?? 0) <= 50)).toBe(true);
    expect(fallback.every((message) => message.text.length <= 40_000)).toBe(true);
    expect(fallback.every((message) => message.mrkdwn === false)).toBe(true);
    expect(fallback[0]?.blocks?.[48]?.type).toBe("actions");
    expect(fallback.flatMap(readPlainSectionTexts).join("")).toBe(tableText(caption));
    expect(fallback.map((message) => message.text).join("\n")).toContain("Refresh");
  });
  it("preserves chart, unrenderable table, control, and media order", async () => {
    await deliverSlash([
      {
        presentation: {
          blocks: [
            revenueChart,
            ...largePortableTablePresentation().blocks,
            buttons("Refresh", "secret-refresh-token"),
          ],
        },
        mediaUrls: ["https://example.com/report.png"],
      },
    ]);
    const messages = slashMessages(4);
    expect(blockTypes(messages[0])).toEqual(["data_visualization"]);
    expect(messages[0]?.text).toContain("Revenue mix (pie chart)");
    expect(messages[1]?.blocks).toBeUndefined();
    expect(messages[1]?.text).toContain("Large pipeline (table)");
    expect(messages[1]?.text).toContain("- Account: <@U123>");
    expect(messages[1]?.text).toContain("- Account: account-99");
    expect(blockTypes(messages[2])).toEqual(["actions"]);
    expect(messages[2]?.text).toBe("Refresh");
    expect(messages[3]).toMatchObject({
      text: "https://example.com/report.png",
      mrkdwn: false,
    });
    expect(messages.map((message) => message.text).join("\n")).not.toContain(
      "secret-refresh-token",
    );
  });
  it("fails before content when the real response_url five-call budget is exceeded", async () => {
    await expect(
      deliverSlash(
        Array.from({ length: 6 }, (_entry, index) => ({
          text: `reply-${String(index)}`,
        })),
        { ephemeral: false },
      ),
    ).rejects.toThrow("response_url delivery budget");
    expect(respond).toHaveBeenCalledExactlyOnceWith({
      text: "This Slack response is too large to deliver within the remaining response window.",
      response_type: "ephemeral",
    });
  });
  it.each([false, true])("emits one terminal slash hook (failed=%s)", async (failed) => {
    enableSentHook();
    if (failed) {
      respond
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("response_url_expired"));
    }
    const text = failed ? "first\nsecond" : "final answer";
    const delivery = deliverSlash([{ text }], {
      ephemeral: false,
      messageSentHookTarget: "user:U1",
      accountId: "default",
      sessionKeyForInternalHooks: "agent:main:slack:slash:u1",
      ...(failed ? { textLimit: 8, chunkMode: "newline" as const } : {}),
    });
    if (failed) {
      await expect(delivery).rejects.toThrow(/response_url_expired/);
      expect(String(sentEvent().error)).toMatch(/response_url_expired/);
    } else {
      await delivery;
      expect(respond).toHaveBeenCalledExactlyOnceWith({ text, response_type: "in_channel" });
    }
    expect(messageHookRunner.runMessageSent).toHaveBeenCalledOnce();
    expect(sentEvent()).toMatchObject({
      to: "user:U1",
      content: text,
      success: !failed,
      sessionKey: "agent:main:slack:slash:u1",
    });
    expect(messageHookRunner.runMessageSent.mock.calls[0]?.[1]).toMatchObject({
      conversationId: "user:U1",
      sessionKey: "agent:main:slack:slash:u1",
    });
    expect(triggerInternalHook).toHaveBeenCalledOnce();
  });
});

describe("deliverReplies message_sent hook", () => {
  it("defers both success and failure hooks for caller-owned terminal delivery", async () => {
    enableSentHook();
    const options = { sessionKeyForInternalHooks: "slack:C123:U1", deferMessageSentHooks: true };
    sendMock.mockResolvedValueOnce({ messageId: "ts", channelId: "C123" });
    await deliverPrepared({ text: "deferred success" }, options);
    sendMock.mockRejectedValueOnce(new Error("deferred failure"));
    await expect(deliverPrepared({ text: "deferred failure" }, options)).rejects.toThrow(
      /deferred failure/,
    );
    expect(messageHookRunner.runMessageSent).not.toHaveBeenCalled();
    expect(triggerInternalHook).not.toHaveBeenCalled();
  });
  it("preserves accepted media and blocks when a later block projection fails", async () => {
    enableSentHook();
    const failure = new Error("later block projection failed");
    const params = baseParams({
      replies: [
        {
          text: "Caption",
          mediaUrl: "https://example.com/report.png",
          channelData: {
            slack: { blocks: Array.from({ length: 50 }, () => ({ type: "divider" })) },
          },
          presentation: { title: "Later block", blocks: [] },
        },
      ],
    });
    const lastSegment = params.replies[0]?.resolveDelivery().segments.at(-1);
    expect(lastSegment?.kind).toBe("blocks");
    if (lastSegment?.kind !== "blocks" || !lastSegment.blocks[0]) {
      throw new Error("expected the later block segment");
    }
    Object.defineProperty(lastSegment.blocks[0], "text", {
      get() {
        throw failure;
      },
    });
    for (const accepted of [
      acceptedSlackSendResult("media-1"),
      acceptedSlackSendResult("card-1", "card"),
    ]) {
      acceptSend(accepted);
    }
    const error = await deliverReplies(params).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      cause: failure,
      deliveryResult: {
        messageIds: ["media-1", "card-1"],
        receipt: { platformMessageIds: ["media-1", "card-1"] },
        visibleReplySent: true,
      },
    });
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(messageHookRunner.runMessageSent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        content: "Caption\n\nShared a Block Kit message",
        success: false,
        error: failure.message,
      }),
      expect.anything(),
    );
  });
  it("does not carry accepted receipts into the next logical reply", async () => {
    const failure = noSendFailure("next_reply_failed");
    acceptSend(acceptedSlackSendResult("reply-1", "text"));
    sendMock.mockRejectedValueOnce(failure);
    await expect(deliverPrepared([{ text: "accepted" }, { text: "never sent" }])).rejects.toBe(
      failure,
    );
    expect(sendMock).toHaveBeenCalledTimes(2);
  });
  it("settles real Slack transport chunks as visible failure without replaying the turn", async () => {
    const failure = noSendFailure("third_chunk_failed");
    const postMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, ts: "chunk-1", channel: "C123" })
      .mockResolvedValueOnce({ ok: true, ts: "chunk-2", channel: "C123" })
      .mockRejectedValueOnce(failure);
    const { sendMessageSlack } = await vi.importActual<typeof import("../send.js")>("../send.js");
    sendMock.mockImplementationOnce(sendMessageSlack);
    const onError = vi.fn();
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) =>
        await deliverPrepared(payload, {
          eventScope: { teamId: "T123", client: {}, writeClient: { chat: { postMessage } } },
        }),
      onError,
      propagateRetryableNoSendFailure: true,
    });
    expect(dispatcher.sendFinalReply({ text: "a".repeat(9_000) })).toBe(true);
    dispatcher.markComplete();
    expect(await dispatcher.waitForIdle()).toMatchObject({
      counts: { final: { failedBeforeSend: 0, failedAfterSend: 1 } },
      anyVisibleDelivered: true,
    });
    expect(onError).toHaveBeenCalledOnce();
    const deliveryError = onError.mock.calls[0]?.[0] as Error;
    expect(deliveryError).toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        messageIds: ["chunk-1", "chunk-2"],
        receipt: {
          primaryPlatformMessageId: "chunk-1",
          platformMessageIds: ["chunk-1", "chunk-2"],
          parts: [
            { platformMessageId: "chunk-1", kind: "text" },
            { platformMessageId: "chunk-2", kind: "text" },
          ],
        },
      },
    });
    expect(deliveryError.cause).toBe(failure);
    expect(sendMock).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledTimes(3);
  });
});
