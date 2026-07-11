// Telegram helper module supports draft stream helpers behavior.
import { vi } from "vitest";
import type { TelegramDraftPreview } from "./draft-stream.js";

type TestDraftStream = {
  update: ReturnType<typeof vi.fn<(text: string) => void>>;
  updatePreview: ReturnType<typeof vi.fn<(preview: TelegramDraftPreview) => void>>;
  flush: ReturnType<typeof vi.fn<() => Promise<void>>>;
  messageId: ReturnType<typeof vi.fn<() => number | undefined>>;
  visibleSinceMs: ReturnType<typeof vi.fn<() => number | undefined>>;
  previewRevision: ReturnType<typeof vi.fn<() => number>>;
  lastDeliveredText: ReturnType<typeof vi.fn<() => string>>;
  clear: ReturnType<typeof vi.fn<() => Promise<void>>>;
  stop: ReturnType<typeof vi.fn<() => Promise<void>>>;
  discard: ReturnType<typeof vi.fn<() => Promise<void>>>;
  materialize: ReturnType<typeof vi.fn<() => Promise<number | undefined>>>;
  finalizeToPreview: ReturnType<
    typeof vi.fn<(preview: TelegramDraftPreview) => Promise<number | undefined>>
  >;
  forceNewMessage: ReturnType<typeof vi.fn<() => void>>;
  rotateToNewMessageDeferringDelete: ReturnType<typeof vi.fn<() => number | undefined>>;
  sendMayHaveLanded: ReturnType<typeof vi.fn<() => boolean>>;
  setMessageId: (value: number | undefined) => void;
};

export function createTestDraftStream(params?: {
  messageId?: number;
  onUpdate?: (text: string) => void;
  onStop?: () => void | Promise<void>;
  onDiscard?: () => void | Promise<void>;
  clearMessageIdOnForceNew?: boolean;
  stopUpdatesOnDiscard?: boolean;
  visibleSinceMs?: number;
}): TestDraftStream {
  let messageId = params?.messageId;
  let visibleSinceMs = params?.visibleSinceMs;
  let previewRevision = 0;
  let lastDeliveredText = "";
  let stopped = false;
  return {
    update: vi.fn().mockImplementation((text: string) => {
      if (stopped) {
        return;
      }
      previewRevision += 1;
      lastDeliveredText = text.trimEnd();
      params?.onUpdate?.(text);
    }),
    updatePreview: vi.fn().mockImplementation((preview: TelegramDraftPreview) => {
      if (stopped) {
        return;
      }
      previewRevision += 1;
      lastDeliveredText = preview.text.trimEnd();
      params?.onUpdate?.(preview.text);
    }),
    flush: vi.fn().mockResolvedValue(undefined),
    messageId: vi.fn().mockImplementation(() => messageId),
    visibleSinceMs: vi.fn().mockImplementation(() => visibleSinceMs),
    previewRevision: vi.fn().mockImplementation(() => previewRevision),
    lastDeliveredText: vi.fn().mockImplementation(() => lastDeliveredText),
    clear: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockImplementation(async () => {
      await params?.onStop?.();
    }),
    discard: vi.fn().mockImplementation(async () => {
      if (params?.stopUpdatesOnDiscard) {
        stopped = true;
      }
      await params?.onDiscard?.();
    }),
    materialize: vi.fn().mockImplementation(async () => messageId),
    finalizeToPreview: vi.fn().mockImplementation(async (preview: TelegramDraftPreview) => {
      if (messageId == null) {
        return undefined;
      }
      previewRevision += 1;
      lastDeliveredText = preview.text.trimEnd();
      stopped = true;
      return messageId;
    }),
    forceNewMessage: vi.fn().mockImplementation(() => {
      stopped = false;
      if (params?.clearMessageIdOnForceNew) {
        messageId = undefined;
      }
      visibleSinceMs = undefined;
    }),
    rotateToNewMessageDeferringDelete: vi.fn().mockImplementation(() => {
      // Mirror forceNewMessage's message-id handling (a sequenced harness swaps
      // ids on the next send; the fixed harness keeps its id unless configured
      // otherwise) so the rewind semantics match; return the superseded id.
      const superseded = messageId;
      stopped = false;
      if (params?.clearMessageIdOnForceNew) {
        messageId = undefined;
      }
      visibleSinceMs = undefined;
      return superseded;
    }),
    sendMayHaveLanded: vi.fn().mockReturnValue(false),
    setMessageId: (value: number | undefined) => {
      messageId = value;
      visibleSinceMs = value == null ? undefined : Date.now();
    },
  };
}

export function createSequencedTestDraftStream(startMessageId = 1001): TestDraftStream {
  let activeMessageId: number | undefined;
  let visibleSinceMs: number | undefined;
  let nextMessageId = startMessageId;
  let previewRevision = 0;
  let lastDeliveredText = "";
  return {
    update: vi.fn().mockImplementation((text: string) => {
      if (activeMessageId == null) {
        activeMessageId = nextMessageId++;
        visibleSinceMs = Date.now();
      }
      previewRevision += 1;
      lastDeliveredText = text.trimEnd();
    }),
    updatePreview: vi.fn().mockImplementation((preview: TelegramDraftPreview) => {
      if (activeMessageId == null) {
        activeMessageId = nextMessageId++;
        visibleSinceMs = Date.now();
      }
      previewRevision += 1;
      lastDeliveredText = preview.text.trimEnd();
    }),
    flush: vi.fn().mockResolvedValue(undefined),
    messageId: vi.fn().mockImplementation(() => activeMessageId),
    visibleSinceMs: vi.fn().mockImplementation(() => visibleSinceMs),
    previewRevision: vi.fn().mockImplementation(() => previewRevision),
    lastDeliveredText: vi.fn().mockImplementation(() => lastDeliveredText),
    clear: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    discard: vi.fn().mockResolvedValue(undefined),
    materialize: vi.fn().mockImplementation(async () => activeMessageId),
    finalizeToPreview: vi.fn().mockImplementation(async (preview: TelegramDraftPreview) => {
      if (activeMessageId == null) {
        return undefined;
      }
      previewRevision += 1;
      lastDeliveredText = preview.text.trimEnd();
      return activeMessageId;
    }),
    forceNewMessage: vi.fn().mockImplementation(() => {
      activeMessageId = undefined;
      visibleSinceMs = undefined;
    }),
    rotateToNewMessageDeferringDelete: vi.fn().mockImplementation(() => {
      const superseded = activeMessageId;
      activeMessageId = undefined;
      visibleSinceMs = undefined;
      return superseded;
    }),
    sendMayHaveLanded: vi.fn().mockReturnValue(false),
    setMessageId: (value: number | undefined) => {
      activeMessageId = value;
      visibleSinceMs = value == null ? undefined : Date.now();
    },
  };
}
