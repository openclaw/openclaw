import type { Bot } from "grammy";
import { vi } from "vitest";
import { createTelegramDraftStream } from "./draft-stream.js";
import type { TelegramInputRichMessage } from "./rich-message.js";

type TelegramDraftStreamParams = Parameters<typeof createTelegramDraftStream>[0];
export type MockSentMessage = { message_id: number; message_thread_id?: number };
type MockSendMessage = (
  chatId: string | number,
  text: string,
  params?: Record<string, unknown>,
) => Promise<MockSentMessage>;
type MockSendRichMessage = (params: {
  rich_message?: TelegramInputRichMessage;
}) => Promise<MockSentMessage>;

export function createMockDraftApi(sendMessageImpl?: () => Promise<MockSentMessage>) {
  const resolveSend = sendMessageImpl ?? (async () => ({ message_id: 17 }));
  const sendRichMessage = vi.fn<MockSendRichMessage>(async () => await resolveSend());
  const editRichMessageText = vi.fn().mockResolvedValue(true);
  return {
    sendMessage: vi.fn<MockSendMessage>(async () => await resolveSend()),
    editMessageText: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
    raw: {
      sendRichMessage,
      editMessageText: editRichMessageText,
    },
  };
}

export function createDraftStream(
  api: ReturnType<typeof createMockDraftApi>,
  overrides: Omit<Partial<TelegramDraftStreamParams>, "api" | "chatId"> = {},
) {
  return createTelegramDraftStream({
    api: api as unknown as Bot["api"],
    chatId: 123,
    ...overrides,
  });
}
