// Telegram helper module supports draft stream helpers behavior.
import { vi } from "vitest";
import type { TelegramDraftPreview } from "./draft-stream-message.js";
import type { TelegramDraftStream } from "./draft-stream.js";

type TelegramDraftMessageSnapshot = NonNullable<
  ReturnType<TelegramDraftStream["currentMessageSnapshot"]>
>;

type TestDraftStream = {
  update: ReturnType<typeof vi.fn<(text: string) => void>>;
  updateLazy: ReturnType<typeof vi.fn<(resolveText: () => string | undefined) => void>>;
  updatePreview: ReturnType<typeof vi.fn<(preview: TelegramDraftPreview) => void>>;
  flush: ReturnType<typeof vi.fn<() => Promise<void>>>;
  waitForInFlight: ReturnType<typeof vi.fn<() => Promise<void>>>;
  messageId: ReturnType<typeof vi.fn<() => number | undefined>>;
  lastDeliveredText: ReturnType<typeof vi.fn<() => string>>;
  isStopped: ReturnType<typeof vi.fn<() => boolean>>;
  currentMessageSnapshot: ReturnType<typeof vi.fn<() => TelegramDraftMessageSnapshot | undefined>>;
  clear: ReturnType<typeof vi.fn<() => Promise<void>>>;
  stop: ReturnType<typeof vi.fn<() => Promise<void>>>;
  discard: ReturnType<typeof vi.fn<() => Promise<void>>>;
  forceNewMessage: ReturnType<typeof vi.fn<() => void>>;
  rotateToNewMessageDeferringDelete: ReturnType<typeof vi.fn<() => void>>;
  sendMayHaveLanded: ReturnType<typeof vi.fn<() => boolean>>;
  remainingFinalContent: ReturnType<typeof vi.fn<() => TelegramDraftMessageSnapshot | undefined>>;
  hasConsumedReplyTarget: ReturnType<typeof vi.fn<() => boolean>>;
  setMessageId: (value: number | undefined) => void;
};

export function createTestDraftStream(params?: { messageId?: number }): TestDraftStream {
  let messageId = params?.messageId;
  let lastDeliveredText = "";
  const update = vi.fn().mockImplementation((text: string) => {
    lastDeliveredText = text.trimEnd();
  });
  return {
    update,
    updateLazy: vi.fn().mockImplementation((resolveText: () => string | undefined) => {
      const text = resolveText();
      if (text !== undefined) {
        update(text);
      }
    }),
    updatePreview: vi.fn().mockImplementation((preview: TelegramDraftPreview) => {
      lastDeliveredText = preview.text.trimEnd();
    }),
    flush: vi.fn().mockResolvedValue(undefined),
    waitForInFlight: vi.fn().mockResolvedValue(undefined),
    messageId: vi.fn().mockImplementation(() => messageId),
    lastDeliveredText: vi.fn().mockImplementation(() => lastDeliveredText),
    isStopped: vi.fn().mockReturnValue(false),
    currentMessageSnapshot: vi
      .fn()
      .mockImplementation(() =>
        messageId != null && lastDeliveredText
          ? { text: lastDeliveredText, sourceText: lastDeliveredText }
          : undefined,
      ),
    clear: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    discard: vi.fn().mockResolvedValue(undefined),
    forceNewMessage: vi.fn(),
    rotateToNewMessageDeferringDelete: vi.fn(),
    sendMayHaveLanded: vi.fn().mockReturnValue(false),
    remainingFinalContent: vi.fn().mockReturnValue(undefined),
    hasConsumedReplyTarget: vi.fn().mockReturnValue(false),
    setMessageId: (value: number | undefined) => {
      messageId = value;
    },
  };
}
