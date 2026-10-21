import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
vi.mock("../send.js", () => ({
  sendMessageSlack: (...args: unknown[]) => sendMock(...args),
}));

const triggerInternalHook = vi.hoisted(() => vi.fn(async () => {}));
const messageHookRunner = vi.hoisted(() => ({
  hasHooks: vi.fn<(name: string) => boolean>(() => false),
  runMessageSent: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/hook-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/hook-runtime")>();
  return {
    ...actual,
    triggerInternalHook,
  };
});

vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>();
  return {
    ...actual,
    getGlobalHookRunner: () => messageHookRunner,
  };
});

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

type SlashParams = Parameters<typeof deliverSlackSlashReplies>[0];
function deliverSlash(
  respond: SlashParams["respond"],
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
  messageHookRunner.hasHooks.mockReset();
  messageHookRunner.hasHooks.mockReturnValue(false);
  messageHookRunner.runMessageSent.mockReset();
  triggerInternalHook.mockReset();
});

describe("sanitizeSlackMonitorReplyPayload", () => {
  it.each([
    { name: "drops reasoning", payload: { text: "private", isReasoning: true }, expected: null },
    { name: "drops internal-only text", payload: { text: "⚠️ 🛠️ Exec failed: " }, expected: null },
    {
      name: "preserves structured content when internal text is removed",
      payload: {
        text: "⚠️ 🛠️ Exec failed: ",
        channelData: { slack: { blocks: [{ type: "divider" }] } },
      },
      expected: {
        text: undefined,
        channelData: { slack: { blocks: [{ type: "divider" }] } },
      },
    },
  ])("$name", ({ payload, expected }) => {
    expect(sanitizeSlackMonitorReplyPayload(payload)).toEqual(expected);
  });
});

function baseParams(overrides?: Record<string, unknown>) {
  const params = {
    cfg: SLACK_TEST_CFG,
    replies: [{ text: "hello" }],
    target: "C123",
    token: "xoxb-test",
    runtime: { log: () => {}, error: () => {}, exit: () => {} },
    textLimit: 4000,
    replyToMode: "off" as const,
    ...overrides,
  };
  return { ...params, replies: params.replies.map(prepareSlackReply) };
}

type TestReply = Parameters<typeof prepareSlackReply>[0];
function deliverPrepared(reply: TestReply | TestReply[], overrides?: Record<string, unknown>) {
  return deliverReplies(
    baseParams({ ...overrides, replies: Array.isArray(reply) ? reply : [reply] }),
  );
}

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

type SlashTestMessage = {
  text: string;
  blocks?: Array<Record<string, unknown>>;
  mrkdwn?: false;
  response_type?: "ephemeral" | "in_channel";
};

function requireSlashMessage(respond: ReturnType<typeof vi.fn>, index = 0): SlashTestMessage {
  const message = respond.mock.calls[index]?.[0] as SlashTestMessage | undefined;
  if (!message) {
    throw new Error(`Slack response call ${String(index)} missing`);
  }
  return message;
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
  it.each(["NO_REPLY", '{"text":"NO_REPLY"}', "No response is needed."])(
    "delivers prepared text literally: %s",
    async (text) => {
      sendMock.mockResolvedValue({ messageId: "literal-ts", channelId: "C123" });
      await deliverPrepared({ text });
      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(requireSendCall()[1]).toBe(text);
    },
  );

  it("sends nothing when the producer supplies no payload", async () => {
    await deliverPrepared([]);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("routes current reply without mistaking a child for its thread root", async () => {
    sendMock.mockResolvedValue({ messageId: "1800000000.000003", channelId: "C123" });
    await deliverPrepared(
      {
        text: "Thread reply",
        replyToId: "1800000000.000002",
        replyToCurrent: true,
        isCompactionNotice: false,
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
    sendMock.mockResolvedValue({ messageId: "table-ts", channelId: "C123" });
    await deliverPrepared(
      {
        presentation: largePortableTablePresentation(450),
        interactive: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Refresh", value: "refresh" }],
            },
          ],
        },
      },
      {
        textLimit: 8000,
      },
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
    expect(blockOptions.blocks).toEqual([
      expect.objectContaining({
        type: "actions",
        elements: [expect.objectContaining({ type: "button", value: "refresh" })],
      }),
    ]);
  });

  it("delivers media before native chart blocks with the same reply context", async () => {
    messageHookRunner.hasHooks.mockImplementation((name: string) => name === "message_sent");
    sendMock
      .mockResolvedValueOnce({ messageId: "media-ts", channelId: "C123" })
      .mockResolvedValueOnce({ messageId: "chart-ts", channelId: "C123" });
    const identity = { username: "Bot", iconEmoji: ":chart_with_upwards_trend:" };
    const metadata = { event_type: "openclaw_test", event_payload: { source: "chart" } };
    const listenerClient = { chat: { postMessage: vi.fn() } } as never;
    const eventScope = { teamId: "T1", client: listenerClient };
    const enterpriseCfg = { channels: { slack: {} } };
    const params = baseParams({
      cfg: enterpriseCfg,
      accountId: "work",
      identity,
      metadata,
      eventScope,
      mediaMaxBytes: 1024,
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
      cfg: enterpriseCfg,
      token: "xoxb-test",
      threadTs: "thread-ts",
      accountId: "work",
      onDeliveryResult: expect.any(Function),
      eventScope,
      textLimit: 4000,
      mediaMaxBytes: 1024,
      identity,
      metadata,
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
    expect(messageHookRunner.runMessageSent).toHaveBeenCalledOnce();
    const event = messageHookRunner.runMessageSent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(event).toMatchObject({
      to: "C123",
      content: "Revenue summary\n\nRevenue mix (pie chart)\n- Product: 60\n- Services: 40",
      success: true,
    });
    expect(event).not.toHaveProperty("messageId");
  });

  it("renders interactive replies into Slack blocks during delivery", async () => {
    sendMock.mockResolvedValue(undefined);
    await deliverPrepared({
      text: "Choose",
      interactive: {
        blocks: [
          { type: "text", text: "Choose" },
          {
            type: "buttons",
            buttons: [{ label: "Approve", value: "approve", style: "primary" }],
          },
        ],
      },
    });
    expect(sendMock).toHaveBeenCalledOnce();
    expect(requireSendCall()[2].blocks).toEqual([
      expect.objectContaining({ type: "section" }),
      expect.objectContaining({
        type: "actions",
        elements: [
          expect.objectContaining({
            action_id: "openclaw:reply_button:1:1",
            style: "primary",
            value: "approve",
          }),
        ],
      }),
    ]);
  });
});

describe("createSlackReplyDeliveryPlan", () => {
  it("lets draft previews inspect first thread targets without consuming them", () => {
    const hasRepliedRef = { value: false };
    const plan = createSlackReplyDeliveryPlan({
      replyToMode: "first",
      incomingThreadTs: undefined,
      messageTs: "9999999999.999999",
      hasRepliedRef,
      isThreadReply: false,
    });
    expect(plan.peekThreadTs()).toBe("9999999999.999999");
    expect(plan.peekThreadTs()).toBe("9999999999.999999");
    expect(hasRepliedRef.value).toBe(false);
    plan.markSent();
    expect(hasRepliedRef.value).toBe(true);
    expect(plan.peekThreadTs()).toBeUndefined();
    expect(plan.nextThreadTs()).toBeUndefined();
  });
});

describe("deliverSlackSlashReplies chunking", () => {
  it.each(["NO_REPLY", '{"text":"NO_REPLY"}', "No response is needed."])(
    "delivers prepared slash text literally: %s",
    async (text) => {
      const respond = vi.fn(async () => undefined);
      await deliverSlash(respond, [{ text }], { textLimit: 4000 });
      expect(respond).toHaveBeenCalledTimes(1);
      expect(requireSlashMessage(respond).text).toBe(text);
    },
  );

  it("keeps a 4205-character reply in a single slash response by default", async () => {
    const respond = vi.fn(async () => undefined);
    const text = "a".repeat(4205);
    await deliverSlash(respond, [{ text }]);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith({ text, response_type: "ephemeral" });
  });

  it("sends block-only slash replies instead of dropping them", async () => {
    const respond = vi.fn(async () => undefined);
    const blocks = [{ type: "divider" }];
    await deliverSlash(respond, [blockReply(blocks)], { ephemeral: false });
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith({
      text: "Shared a Block Kit message",
      blocks,
      mrkdwn: false,
      response_type: "in_channel",
    });
  });

  it("delivers a valid field-rich section in one slash response", async () => {
    const respond = vi.fn(async () => undefined);
    const fields = ["Alpha", "Beta", "Gamma"].map((label) => ({
      type: "plain_text",
      text: label.padEnd(1_500, "."),
    }));
    const blocks = [{ type: "section", fields }];
    await deliverSlash(respond, [blockReply(blocks)]);
    expect(respond).toHaveBeenCalledExactlyOnceWith({
      blocks,
      text: fields.map((field) => field.text).join("\n"),
      mrkdwn: false,
      response_type: "ephemeral",
    });
  });

  it("replaces rejected native data in place without duplicating authored text", async () => {
    const respond = vi
      .fn(async () => undefined)
      .mockRejectedValueOnce({ response: { data: { error: "invalid_blocks" } } });
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: "Overview" } },
      nativeRevenueChart,
      refreshAction,
      {
        type: "data_table",
        caption: "Pipeline report",
        rows: [
          [
            { type: "raw_text", text: "Account" },
            { type: "raw_text", text: "ARR" },
          ],
          [
            { type: "raw_text", text: "Acme" },
            { type: "raw_number", value: 125000, text: "$125k" },
          ],
        ],
      },
    ];
    await deliverSlash(respond, [blockReply(blocks, "Overview")]);
    expect(respond).toHaveBeenCalledTimes(2);
    const native = requireSlashMessage(respond, 0);
    const fallback = requireSlashMessage(respond, 1);
    expect(native.blocks?.map((block) => block.type)).toEqual([
      "section",
      "data_visualization",
      "actions",
      "data_table",
    ]);
    expect(fallback.blocks?.map((block) => block.type)).toEqual([
      "section",
      "section",
      "actions",
      "section",
    ]);
    expect(readPlainSectionTexts(fallback)).toEqual([
      revenueText,
      "Pipeline report (table)\nAccount\tARR\nAcme\t$125k",
    ]);
    expect(fallback.text).toBe(
      [
        "Overview",
        revenueText,
        "Refresh",
        "Pipeline report (table)\nAccount\tARR\nAcme\t$125k",
      ].join("\n\n"),
    );
    expect(fallback.text.match(/Overview/gu)).toHaveLength(1);
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
      const respond = vi.fn(async () => response);
      const delivery = deliverSlash(respond, [
        blockReply([
          {
            ...nativeRevenueChart,
            chart: { type: "pie", segments: [revenueSegments[0]] },
          },
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
    const respond = vi.fn(async () => undefined);
    const caption = "c".repeat(41_000);
    const blocks = [nativeTable(caption)] as never;
    await deliverSlash(respond, [blockReply(blocks)]);
    expect(respond).toHaveBeenCalledTimes(2);
    const messages = respond.mock.calls.map((_call, index) => requireSlashMessage(respond, index));
    expect(messages.every((message) => message.blocks === undefined)).toBe(true);
    expect(messages.every((message) => message.mrkdwn === false)).toBe(true);
    expect(messages.every((message) => message.text.length <= 40_000)).toBe(true);
    expect(messages.map((message) => message.text).join("")).toBe(
      `${caption} (table)\nAccount\nAcme`,
    );
  });

  it("keeps 4k native fallback chunks for uncapped Web API delivery", async () => {
    const respond = vi
      .fn(async () => undefined)
      .mockRejectedValueOnce({ response: { data: { error: "invalid_blocks" } } });
    const caption = "c".repeat(9_000);
    const blocks = [nativeTable(caption)] as never;
    await deliverSlash(respond, [blockReply(blocks)], {
      responseBudget: {
        respond,
        remaining: () => undefined,
      },
    });
    expect(respond).toHaveBeenCalledTimes(4);
    const fallback = [1, 2, 3].map((index) => requireSlashMessage(respond, index));
    expect(fallback.every((message) => message.blocks === undefined)).toBe(true);
    expect(fallback.every((message) => message.text.length <= 4_000)).toBe(true);
    expect(fallback.map((message) => message.text).join("")).toBe(
      `${caption} (table)\nAccount\nAcme`,
    );
  });

  it("batches in-place native fallback at 50 blocks without losing content", async () => {
    const respond = vi
      .fn(async () => undefined)
      .mockRejectedValueOnce({ response: { data: { error: "invalid_blocks" } } });
    const caption = "c".repeat(9_000);
    const blocks = [
      ...Array.from({ length: 48 }, () => ({ type: "divider" })),
      refreshAction,
      nativeTable(caption),
    ] as never;
    await deliverSlash(respond, [blockReply(blocks)]);
    expect(respond).toHaveBeenCalledTimes(3);
    const fallback = [requireSlashMessage(respond, 1), requireSlashMessage(respond, 2)];
    expect(fallback.every((message) => (message.blocks?.length ?? 0) <= 50)).toBe(true);
    expect(fallback.every((message) => message.text.length <= 40_000)).toBe(true);
    expect(fallback.every((message) => message.mrkdwn === false)).toBe(true);
    expect(fallback[0]?.blocks?.[48]?.type).toBe("actions");
    expect(fallback.flatMap(readPlainSectionTexts).join("")).toBe(
      `${caption} (table)\nAccount\nAcme`,
    );
    expect(fallback.map((message) => message.text).join("\n")).toContain("Refresh");
  });

  it("preserves chart, unrenderable table, control, and media order", async () => {
    const respond = vi.fn(async () => undefined);
    await deliverSlash(respond, [
      {
        presentation: {
          blocks: [
            revenueChart,
            ...largePortableTablePresentation().blocks,
            {
              type: "buttons",
              buttons: [{ label: "Refresh", value: "secret-refresh-token" }],
            },
          ],
        },
        mediaUrls: ["https://example.com/report.png"],
      },
    ]);
    expect(respond).toHaveBeenCalledTimes(4);
    const messages = respond.mock.calls.map((_call, index) => requireSlashMessage(respond, index));
    expect(messages[0]?.blocks?.map((block) => block.type)).toEqual(["data_visualization"]);
    expect(messages[0]?.text).toContain("Revenue mix (pie chart)");
    expect(messages[1]?.blocks).toBeUndefined();
    expect(messages[1]?.text).toContain("Large pipeline (table)");
    expect(messages[1]?.text).toContain("- Account: <@U123>");
    expect(messages[1]?.text).toContain("- Account: account-99");
    expect(messages[2]?.blocks?.map((block) => block.type)).toEqual(["actions"]);
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
    const respond = vi.fn(async () => undefined);
    await expect(
      deliverSlash(
        respond,
        Array.from({ length: 6 }, (_entry, index) => ({
          text: `reply-${String(index)}`,
        })),
        { ephemeral: false },
      ),
    ).rejects.toThrow("response_url delivery budget");
    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith({
      text: "This Slack response is too large to deliver within the remaining response window.",
      response_type: "ephemeral",
    });
  });

  it("suppresses reasoning payloads in slash replies", async () => {
    const respond = vi.fn(async () => undefined);
    await deliverSlash(
      respond,
      [{ text: "Let me think...", isReasoning: true }, { text: "final answer" }],
      { ephemeral: false },
    );
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith({ text: "final answer", response_type: "in_channel" });
  });

  it("emits terminal hooks for successful slash responses", async () => {
    const respond = vi.fn(async () => undefined);
    messageHookRunner.hasHooks.mockImplementation((name: string) => name === "message_sent");
    await deliverSlash(respond, [{ text: "final answer" }], {
      ephemeral: false,
      messageSentHookTarget: "user:U1",
      accountId: "default",
      sessionKeyForInternalHooks: "agent:main:slack:slash:u1",
    });
    const event = messageHookRunner.runMessageSent.mock.calls[0]?.[0] as Record<string, unknown>;
    const context = messageHookRunner.runMessageSent.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(event).toMatchObject({
      to: "user:U1",
      content: "final answer",
      success: true,
      sessionKey: "agent:main:slack:slash:u1",
    });
    expect(context).toMatchObject({
      conversationId: "user:U1",
      sessionKey: "agent:main:slack:slash:u1",
    });
    expect(triggerInternalHook).toHaveBeenCalledOnce();
  });

  it("emits only failure when a later slash response chunk throws", async () => {
    const respond = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("response_url_expired"));
    messageHookRunner.hasHooks.mockImplementation((name: string) => name === "message_sent");
    await expect(
      deliverSlash(respond, [{ text: "first\nsecond" }], {
        textLimit: 8,
        chunkMode: "newline",
        messageSentHookTarget: "user:U1",
      }),
    ).rejects.toThrow(/response_url_expired/);
    expect(messageHookRunner.runMessageSent).toHaveBeenCalledOnce();
    const event = messageHookRunner.runMessageSent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(event).toMatchObject({ to: "user:U1", content: "first\nsecond", success: false });
    expect(String(event.error)).toMatch(/response_url_expired/);
  });

  it("reports spoken text for media-only TTS slash replies", async () => {
    const respond = vi.fn(async () => undefined);
    messageHookRunner.hasHooks.mockImplementation((name: string) => name === "message_sent");
    await deliverSlash(
      respond,
      [
        {
          mediaUrl: "https://example.com/tts.mp3",
          audioAsVoice: true,
          spokenText: "Spoken slash answer",
        },
      ],
      { messageSentHookTarget: "user:U1" },
    );
    expect(respond).toHaveBeenCalledWith({
      text: "https://example.com/tts.mp3",
      response_type: "ephemeral",
    });
    const event = messageHookRunner.runMessageSent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(event).toMatchObject({ content: "Spoken slash answer", success: true });
  });
});

describe("deliverReplies reasoning suppression", () => {
  it("suppresses reasoning payloads and delivers only non-reasoning replies", async () => {
    sendMock.mockResolvedValue(undefined);
    await deliverPrepared([
      { text: "Reasoning:\n_hidden_", isReasoning: true },
      { text: "visible answer" },
    ]);
    expect(sendMock).toHaveBeenCalledOnce();
    const [, text] = requireSendCall();
    expect(text).toBe("visible answer");
  });
});

describe("deliverReplies message_sent hook", () => {
  it("defers both success and failure hooks for caller-owned terminal delivery", async () => {
    messageHookRunner.hasHooks.mockImplementation((name: string) => name === "message_sent");
    sendMock.mockResolvedValueOnce({ messageId: "ts", channelId: "C123" });
    await deliverPrepared(
      { text: "deferred success" },
      {
        sessionKeyForInternalHooks: "slack:C123:U1",
        deferMessageSentHooks: true,
      },
    );
    sendMock.mockRejectedValueOnce(new Error("deferred failure"));
    await expect(
      deliverPrepared(
        { text: "deferred failure" },
        {
          sessionKeyForInternalHooks: "slack:C123:U1",
          deferMessageSentHooks: true,
        },
      ),
    ).rejects.toThrow(/deferred failure/);
    expect(messageHookRunner.runMessageSent).not.toHaveBeenCalled();
    expect(triggerInternalHook).not.toHaveBeenCalled();
  });

  it("emits one message_sent event after a multi-media reply succeeds", async () => {
    messageHookRunner.hasHooks.mockImplementation((name: string) => name === "message_sent");
    const first = acceptedSlackSendResult("media-1");
    const second = acceptedSlackSendResult("media-2");
    acceptSend(first);
    acceptSend(second);
    const result = await deliverPrepared({
      text: "two attachments",
      mediaUrls: ["https://example.com/one.png", "https://example.com/two.png"],
    });
    expect(result).toBe(second);
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(messageHookRunner.runMessageSent).toHaveBeenCalledTimes(1);
    const event = messageHookRunner.runMessageSent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(event).toMatchObject({ content: "two attachments", success: true });
    expect(event).not.toHaveProperty("messageId");
  });

  it("reports spoken text for media-only TTS supplements", async () => {
    messageHookRunner.hasHooks.mockImplementation((name: string) => name === "message_sent");
    sendMock.mockResolvedValue({ messageId: "tts-1", channelId: "C123" });
    await deliverPrepared({
      mediaUrl: "https://example.com/tts.mp3",
      spokenText: "Spoken answer",
      ttsSupplement: { spokenText: "Spoken answer" },
    });
    expect(messageHookRunner.runMessageSent).toHaveBeenCalledOnce();
    const event = messageHookRunner.runMessageSent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(event).toMatchObject({ content: "Spoken answer", success: true });
    expect(event).not.toHaveProperty("messageId");
  });

  it("preserves accepted media and blocks when a later block projection fails", async () => {
    messageHookRunner.hasHooks.mockImplementation((name: string) => name === "message_sent");
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
    const accepted = acceptedSlackSendResult("reply-1", "text");
    const failure = new PlatformMessageNotDispatchedError("next_reply_failed", {
      cause: new Error("upload connection refused"),
    });
    acceptSend(accepted);
    sendMock.mockRejectedValueOnce(failure);
    await expect(deliverPrepared([{ text: "accepted" }, { text: "never sent" }])).rejects.toBe(
      failure,
    );
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("settles real Slack transport chunks as visible failure without replaying the turn", async () => {
    const failure = new PlatformMessageNotDispatchedError("third_chunk_failed", {
      cause: new Error("upload connection refused"),
    });
    const postMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, ts: "chunk-1", channel: "C123" })
      .mockResolvedValueOnce({ ok: true, ts: "chunk-2", channel: "C123" })
      .mockRejectedValueOnce(failure);
    const { sendMessageSlack } = await vi.importActual<typeof import("../send.js")>("../send.js");
    sendMock.mockImplementationOnce(async (target, text, options) => {
      return await sendMessageSlack(target, text, options);
    });
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
    const receipt = await dispatcher.waitForIdle();
    expect(receipt).toMatchObject({
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
