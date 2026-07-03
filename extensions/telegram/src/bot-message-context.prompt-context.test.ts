import { describe, expect, it } from "vitest";
import { buildInboundUserContextPrefix } from "../../../src/auto-reply/reply/inbound-meta.js";
import { buildReplyPromptEnvelopeBase } from "../../../src/auto-reply/reply/prompt-prelude.js";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";
import type { TelegramPromptContextEntry } from "./bot-message-context.types.js";

type RoomEventPromptContext = Parameters<typeof buildInboundUserContextPrefix>[0] &
  Parameters<typeof buildReplyPromptEnvelopeBase>[0]["ctx"];

function renderRoomEventPromptText(ctx: RoomEventPromptContext): string {
  const inboundUserContext = buildInboundUserContextPrefix(ctx);
  return (
    buildReplyPromptEnvelopeBase({
      ctx,
      sessionCtx: ctx,
      baseBody: ctx.BodyForAgent ?? ctx.Body ?? ctx.RawBody ?? "",
      hasUserBody: true,
      inboundUserContext,
      isBareSessionReset: false,
      startupAction: "new",
      inboundEventKind: "room_event",
      sourceReplyDeliveryMode: "message_tool_only",
    }).currentInboundContext?.text ?? ""
  );
}

const telegramChatWindowContext: TelegramPromptContextEntry = {
  label: "Conversation context",
  source: "telegram",
  type: "chat_window",
  payload: {
    order: "chronological",
    relation: "selected_for_current_message",
    messages: [
      {
        message_id: "10",
        sender: "Pat",
        timestamp_ms: 1_700_000_000_000,
        body: "Earlier DM turn already in the transcript",
      },
    ],
  },
};

describe("buildTelegramMessageContext prompt context", () => {
  it("omits Telegram chat-window context for existing unthreaded private DM sessions", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: 1234, type: "private", first_name: "Pat" },
        from: { id: 1234, first_name: "Pat" },
        text: "continue",
      },
      promptContext: [telegramChatWindowContext],
      sessionRuntime: {
        readSessionUpdatedAt: ({ sessionKey }) =>
          sessionKey === "agent:main:main" ? 1_700_000_000_000 : undefined,
      },
    });

    expect(ctx?.ctxPayload.SessionKey).toBe("agent:main:main");
    expect(ctx?.ctxPayload.UntrustedStructuredContext).toBeUndefined();
  });

  it("keeps Telegram chat-window context for fresh private DM sessions", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: 1234, type: "private", first_name: "Pat" },
        from: { id: 1234, first_name: "Pat" },
        text: "start",
      },
      promptContext: [telegramChatWindowContext],
    });

    expect(ctx?.ctxPayload.UntrustedStructuredContext).toEqual([telegramChatWindowContext]);
  });

  it("keeps Telegram chat-window context for existing private DM replies", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: 1234, type: "private", first_name: "Pat" },
        from: { id: 1234, first_name: "Pat" },
        text: "replying with context",
        reply_to_message: {
          chat: { id: 1234, type: "private", first_name: "Pat" },
          from: { id: 1234, first_name: "Pat" },
          text: "older referenced turn",
          date: 1_700_000_000,
          message_id: 10,
        },
      },
      promptContext: [telegramChatWindowContext],
      sessionRuntime: {
        readSessionUpdatedAt: ({ sessionKey }) =>
          sessionKey === "agent:main:main" ? 1_700_000_000_000 : undefined,
      },
    });

    expect(ctx?.ctxPayload.UntrustedStructuredContext).toEqual([telegramChatWindowContext]);
  });

  it("preserves richer chat-window fields when merging duplicate group history", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 11,
        chat: { id: -1001234567890, type: "supergroup", title: "Forum", is_forum: true },
        from: { id: 1234, first_name: "Pat" },
        text: "@bot continue",
        entities: [{ type: "mention", offset: 0, length: 4 }],
        message_thread_id: 99,
      },
      historyLimit: 10,
      groupHistories: new Map([
        [
          "-1001234567890:topic:99",
          [
            {
              messageId: "10",
              sender: "Pat",
              timestamp: 1_700_000_000_000,
              body: "Earlier with media",
            },
          ],
        ],
      ]),
      promptContext: [
        {
          label: "Conversation context",
          source: "telegram",
          type: "chat_window",
          payload: {
            order: "chronological",
            relation: "selected_for_current_message",
            messages: [
              {
                message_id: "10",
                sender: "Pat",
                timestamp_ms: 1_700_000_000_000,
                body: "Earlier with media",
                is_reply_target: true,
                media_type: "image/png",
                media_path: "media://inbound/screenshot.png",
              },
            ],
          },
        },
      ],
    });

    expect(ctx?.ctxPayload.UntrustedStructuredContext).toEqual([
      expect.objectContaining({
        type: "chat_window",
        payload: expect.objectContaining({
          messages: [
            expect.objectContaining({
              message_id: "10",
              is_reply_target: true,
              media_type: "image/png",
              media_path: "media://inbound/screenshot.png",
            }),
          ],
        }),
      }),
    ]);
  });

  it("excludes ambient transcript rows from the group history window", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 13,
        chat: { id: -1001234567890, type: "supergroup", title: "Forum" },
        from: { id: 1234, first_name: "Pat" },
        text: "@bot what happened?",
        entities: [{ type: "mention", offset: 0, length: 4 }],
      },
      historyLimit: 10,
      groupHistories: new Map([
        [
          "-1001234567890",
          [
            {
              messageId: "10",
              sender: "Sam",
              timestamp: 1_700_000_000_000,
              body: "persisted ambient one",
            },
            {
              messageId: "11",
              sender: "Lee",
              timestamp: 1_700_000_001_000,
              body: "persisted ambient two",
            },
            {
              messageId: "12",
              sender: "Mira",
              timestamp: 1_700_000_002_000,
              body: "unpersisted gap",
            },
          ],
        ],
      ]),
      sessionRuntime: {
        readAmbientTranscriptWatermark: ({ key }) =>
          key === '["telegram","default","-1001234567890",""]'
            ? {
                messageId: "11",
                timestampMs: 1_700_000_001_000,
                updatedAt: 1_700_000_003_000,
              }
            : undefined,
      },
    });

    expect(ctx?.ctxPayload.UntrustedStructuredContext).toEqual([
      expect.objectContaining({
        type: "chat_window",
        payload: expect.objectContaining({
          messages: [
            expect.objectContaining({
              message_id: "12",
              body: "unpersisted gap",
            }),
          ],
        }),
      }),
    ]);
    expect(JSON.stringify(ctx?.ctxPayload.UntrustedStructuredContext)).not.toContain(
      "persisted ambient",
    );
  });

  it("omits transcript-owned ambient rows from steady-state room-event prompt text", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 12,
        chat: { id: -1001234567890, type: "supergroup", title: "Forum" },
        from: { id: 1234, first_name: "Pat" },
        text: "current ambient",
        date: 1_700_000_002,
      },
      cfg: {
        messages: { groupChat: { unmentionedInbound: "room_event", mentionPatterns: [] } },
        channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
      },
      historyLimit: 10,
      groupHistories: new Map([
        [
          "-1001234567890",
          [
            {
              messageId: "10",
              sender: "Sam",
              timestamp: 1_700_000_000_000,
              body: "persisted ambient one",
            },
            {
              messageId: "11",
              sender: "Lee",
              timestamp: 1_700_000_001_000,
              body: "persisted ambient two",
            },
          ],
        ],
      ]),
      sessionRuntime: {
        readAmbientTranscriptWatermark: ({ key }) =>
          key === '["telegram","default","-1001234567890",""]'
            ? {
                messageId: "11",
                timestampMs: 1_700_000_001_000,
                updatedAt: 1_700_000_003_000,
              }
            : undefined,
      },
    });

    if (!ctx) {
      throw new Error("Expected room-event context");
    }
    const promptText = renderRoomEventPromptText(ctx.ctxPayload as RoomEventPromptContext);
    expect(promptText).toContain("[OpenClaw room event]");
    expect(promptText).toContain("Current event:\n#12 Pat: current ambient");
    expect(promptText).not.toContain("persisted ambient");
    expect(promptText).not.toContain("Chat history since last reply");
    expect(ctx.ctxPayload.InboundHistory).toBeUndefined();
  });
});
