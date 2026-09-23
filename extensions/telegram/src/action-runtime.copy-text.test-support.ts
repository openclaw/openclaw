import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleTelegramAction as handleTelegramActionRuntime,
  telegramActionRuntime,
} from "./action-runtime.js";

vi.mock("openclaw/plugin-sdk/channel-outbound", () => ({
  buildOutboundSessionContext: () => undefined,
  sendDurableMessageBatch: vi.fn(),
}));

vi.mock("./account-owner.js", () => ({
  resolveTelegramAccountOwnerAgentId: () => "default",
}));

vi.mock("./accounts.js", () => ({
  createTelegramActionGate: () => () => true,
  listTelegramAccountIds: () => [],
  mergeTelegramAccountConfig: (cfg: OpenClawConfig) => cfg.channels?.telegram ?? {},
  resolveDefaultTelegramAccountId: () => "default",
  resolveTelegramAccountConfig: () => undefined,
  resolveTelegramPollActionGateState: () => ({
    pollEnabled: true,
    sendMessageEnabled: true,
  }),
}));

vi.mock("./inbound-event-delivery.js", () => ({
  telegramInboundEventDelivery: { notify: vi.fn() },
}));

vi.mock("./message-topic-binding.js", () => ({
  resolveTelegramConversationReadChatId: ({ chatId }: { chatId: string | number }) => chatId,
  resolveTelegramMessageMutationChatId: async ({ chatId }: { chatId: string | number }) => chatId,
}));

vi.mock("./send.js", () => ({
  createForumTopicTelegram: vi.fn(),
  deleteMessageTelegram: vi.fn(),
  editForumTopicTelegram: vi.fn(),
  editMessageReplyMarkupTelegram: vi.fn(),
  editMessageTelegram: vi.fn(),
  getTelegramAllowedReactions: vi.fn(),
  pinMessageTelegram: vi.fn(),
  reactMessageTelegram: vi.fn(),
  sendMessageTelegram: vi.fn(),
  sendPollTelegram: vi.fn(),
  sendStickerTelegram: vi.fn(),
}));

vi.mock("./sticker-cache.js", () => ({
  getCacheStats: vi.fn(),
  searchStickers: vi.fn(),
}));

vi.mock("./topic-name-cache.js", () => ({
  resolveTopicNameCacheScope: () => "default",
  updateTopicName: vi.fn(),
}));

const originalTelegramActionRuntime = { ...telegramActionRuntime };
const sendMessageTelegram = vi.fn(
  async (_to: string, _text: string, _options?: Record<string, unknown>) => ({
    messageId: "789",
    chatId: "123",
  }),
);
const editMessageTelegram = vi.fn(async () => ({
  ok: true,
  messageId: "456",
  chatId: "123",
}));
const editMessageReplyMarkupTelegram = vi.fn(async () => ({
  ok: true,
  messageId: "456",
  chatId: "123",
}));
const sendDurableMessageBatch = vi.fn(async (params: Record<string, any>) => {
  const payload = params.payloads[0] ?? {};
  const buttons = payload.channelData?.telegram?.buttons;
  const result = await sendMessageTelegram(params.to, payload.text ?? "", {
    cfg: params.cfg,
    token: "tok",
    ...(buttons ? { buttons } : {}),
  });
  return {
    status: "sent",
    results: [
      {
        channel: "telegram",
        messageId: result.messageId,
        target: { kind: "chat", id: result.chatId },
      },
    ],
    receipt: {
      primaryPlatformMessageId: result.messageId,
      platformMessageIds: [result.messageId],
      parts: [{ platformMessageId: result.messageId, kind: "text", index: 0 }],
      sentAt: Date.now(),
    },
  } as const;
});

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label}`);
  }
  // SAFETY: The object and non-array guards narrow the value to a record shape.
  return value as Record<string, unknown>;
}

function handleTelegramAction(params: Record<string, unknown>, cfg: OpenClawConfig) {
  return handleTelegramActionRuntime(params, cfg, {
    conversationReadOrigin: "direct-operator",
  });
}

function telegramConfig(): OpenClawConfig {
  return {
    channels: {
      telegram: {
        botToken: "tok",
        capabilities: { inlineButtons: "all" },
      },
    },
  } as OpenClawConfig;
}

function resultDetails(result: Awaited<ReturnType<typeof handleTelegramAction>>) {
  return requireRecord(result.details, "Telegram action details");
}

function mockCall(source: ReturnType<typeof vi.fn>, label: string) {
  const call = source.mock.calls[0];
  if (!call) {
    throw new Error(`Expected Telegram mock call: ${label}`);
  }
  return call;
}

describe("Telegram action runtime copy-text delivery", () => {
  beforeEach(() => {
    Object.assign(telegramActionRuntime, originalTelegramActionRuntime, {
      sendDurableMessageBatch,
      sendMessageTelegram,
      editMessageTelegram,
      editMessageReplyMarkupTelegram,
    });
    sendDurableMessageBatch.mockClear();
    sendMessageTelegram.mockClear();
    editMessageTelegram.mockClear();
    editMessageReplyMarkupTelegram.mockClear();
  });

  it("does not expose a native copy value in a presentation-only message body", async () => {
    await handleTelegramAction(
      {
        action: "sendMessage",
        to: "123456",
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                {
                  label: "Copy token",
                  action: { type: "copy-text", text: "TOKEN-7319" },
                },
              ],
            },
          ],
        },
      },
      telegramConfig(),
    );

    const call = mockCall(sendMessageTelegram, "copy-only native send");
    expect(call[1]).toBe("Choose an option.");
    expect(call[1]).not.toContain("TOKEN-7319");
    expect(requireRecord(call[2], "copy-only native send options").buttons).toEqual([
      [{ text: "Copy token", copy_text: { text: "TOKEN-7319" } }],
    ]);
  });

  it("retains presentation text when a presentation-only copy action needs fallback", async () => {
    const copyValue = "x".repeat(257);
    const result = await handleTelegramAction(
      {
        action: "sendMessage",
        to: "123456",
        presentation: {
          blocks: [
            { type: "text", text: "Keep this context" },
            {
              type: "buttons",
              buttons: [{ label: "Copy token", action: { type: "copy-text", text: copyValue } }],
            },
          ],
        },
      },
      telegramConfig(),
    );

    const call = mockCall(sendMessageTelegram, "presentation-only degraded copy send");
    expect(call[1]).toBe(`Keep this context\n\n- Copy token: \`${copyValue}\``);
    expect(requireRecord(call[2], "degraded copy options").buttons).toBeUndefined();
    expect(resultDetails(result)).toMatchObject({
      ok: true,
      degradedDelivery: {
        droppedControls: 1,
        fallback: "text",
        reasons: ["copy_text_invalid"],
      },
    });
  });

  it("edits reply markup with a native copy-text button", async () => {
    await handleTelegramAction(
      {
        action: "editMessage",
        chatId: "123456",
        messageId: 321,
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                {
                  label: "Copy token",
                  action: { type: "copy-text", text: "TOKEN-7319" },
                },
              ],
            },
          ],
        },
      },
      telegramConfig(),
    );

    expect(editMessageTelegram).not.toHaveBeenCalled();
    const call = mockCall(editMessageReplyMarkupTelegram, "native copy reply markup edit");
    expect(call[2]).toEqual([[{ text: "Copy token", copy_text: { text: "TOKEN-7319" } }]]);
  });

  it("renders presentation text in mixed copy-text edits without explicit content", async () => {
    await handleTelegramAction(
      {
        action: "editMessage",
        chatId: "123456",
        messageId: 321,
        presentation: {
          title: "Updated status",
          blocks: [
            { type: "text", text: "Build completed" },
            {
              type: "buttons",
              buttons: [
                {
                  label: "Copy token",
                  action: { type: "copy-text", text: "TOKEN-7319" },
                },
              ],
            },
          ],
        },
      },
      telegramConfig(),
    );

    expect(editMessageReplyMarkupTelegram).not.toHaveBeenCalled();
    const call = mockCall(editMessageTelegram, "mixed presentation edit");
    expect(call[2]).toBe("Updated status\n\nBuild completed");
    expect(requireRecord(call[3], "mixed presentation edit options").buttons).toEqual([
      [{ text: "Copy token", copy_text: { text: "TOKEN-7319" } }],
    ]);
  });

  it("preserves an explicit empty caption while editing native presentation buttons", async () => {
    await handleTelegramAction(
      {
        action: "editMessage",
        chatId: "123456",
        messageId: 321,
        caption: "",
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                {
                  label: "Copy token",
                  action: { type: "copy-text", text: "TOKEN-7319" },
                },
              ],
            },
          ],
        },
      },
      telegramConfig(),
    );

    expect(editMessageReplyMarkupTelegram).not.toHaveBeenCalled();
    const call = mockCall(editMessageTelegram, "empty caption presentation edit");
    expect(call[2]).toBe("");
    expect(requireRecord(call[3], "empty caption presentation edit options")).toMatchObject({
      editMode: "caption",
      buttons: [[{ text: "Copy token", copy_text: { text: "TOKEN-7319" } }]],
    });
  });

  it("preserves callback-only partial success when one edited control is unencodable", async () => {
    const result = await handleTelegramAction(
      {
        action: "editMessage",
        chatId: "123456",
        messageId: 321,
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                { label: "Open", value: "open" },
                { label: "Too long", value: "x".repeat(65) },
              ],
            },
          ],
        },
      },
      telegramConfig(),
    );

    expect(editMessageTelegram).not.toHaveBeenCalled();
    const call = mockCall(editMessageReplyMarkupTelegram, "partial reply markup edit");
    expect(call[2]).toEqual([[{ text: "Open", callback_data: "open" }]]);
    expect(resultDetails(result)).toMatchObject({
      ok: true,
      degradedDelivery: {
        droppedControls: 1,
        fallback: "not_delivered",
        reasons: ["callback_data_too_long"],
      },
    });
  });

  it("requires explicit content when legacy controls displace a portable copy action", async () => {
    const result = await handleTelegramAction(
      {
        action: "editMessage",
        chatId: "123456",
        messageId: 321,
        interactive: {
          blocks: [{ type: "buttons", buttons: [{ label: "Legacy", value: "legacy" }] }],
        },
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Copy token", action: { type: "copy-text", text: "TOKEN-7319" } }],
            },
          ],
        },
      },
      telegramConfig(),
    );

    expect(editMessageTelegram).not.toHaveBeenCalled();
    expect(editMessageReplyMarkupTelegram).not.toHaveBeenCalled();
    expect(resultDetails(result)).toMatchObject({
      ok: false,
      degradedDelivery: {
        droppedControls: 1,
        fallback: "not_delivered",
        reasons: ["presentation_keyboard_precedence"],
        guidance: expect.stringContaining("explicit content or caption"),
      },
    });
  });

  it.each([
    {
      name: "invalid copy fallback",
      presentation: {
        blocks: [
          {
            type: "buttons" as const,
            buttons: [
              { label: "Open", value: "open" },
              { label: "Copy token", action: { type: "copy-text" as const, text: "TOKEN\r7319" } },
            ],
          },
        ],
      },
      reason: "copy_text_invalid",
    },
    {
      name: "action budget overflow",
      presentation: {
        blocks: [
          {
            type: "buttons" as const,
            buttons: [
              ...Array.from({ length: 100 }, (_, index) => ({
                label: `Action ${String(index)}`,
                value: `act:${String(index)}`,
              })),
              {
                label: "Copy token",
                action: { type: "copy-text" as const, text: "TOKEN-7319" },
              },
            ],
          },
        ],
      },
      reason: "presentation_action_budget_exceeded",
    },
  ])("does not replace the message body for $name without explicit content", async (scenario) => {
    const result = await handleTelegramAction(
      {
        action: "editMessage",
        chatId: "123456",
        messageId: 321,
        presentation: scenario.presentation,
      },
      telegramConfig(),
    );

    expect(editMessageTelegram).not.toHaveBeenCalled();
    expect(editMessageReplyMarkupTelegram).not.toHaveBeenCalled();
    expect(resultDetails(result)).toMatchObject({
      ok: false,
      degradedDelivery: {
        droppedControls: 1,
        fallback: "not_delivered",
        reasons: [scenario.reason],
        guidance: expect.stringContaining("explicit content or caption"),
      },
    });
  });

  it.each([
    { description: "text", field: "content", editMode: "auto" },
    { description: "caption", field: "caption", editMode: "caption" },
  ])("keeps a rejected copy value readable in $description edits", async ({ field, editMode }) => {
    const result = await handleTelegramAction(
      {
        action: "editMessage",
        chatId: "123456",
        messageId: 321,
        [field]: "Updated body",
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                { label: "Open", value: "open" },
                { label: "Copy token", action: { type: "copy-text", text: "TOKEN\r7319" } },
              ],
            },
          ],
        },
      },
      telegramConfig(),
    );

    const call = mockCall(editMessageTelegram, `${field} edit`);
    expect(call[2]).toBe("Updated body\n\n- Copy token: `TOKEN\\r7319`");
    const opts = requireRecord(call[3], `${field} edit options`);
    expect(opts.editMode).toBe(editMode);
    expect(opts.buttons).toEqual([[{ text: "Open", callback_data: "open" }]]);
    expect(resultDetails(result)).toMatchObject({
      ok: true,
      warning: "Telegram delivered 1 unencodable control as readable text.",
      degradedDelivery: { droppedControls: 1, fallback: "text" },
    });
  });
});
