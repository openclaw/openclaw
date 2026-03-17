import { vi } from "vitest";
function createTestDraftStream(params) {
  let messageId = params?.messageId;
  let previewRevision = 0;
  let lastDeliveredText = "";
  return {
    update: vi.fn().mockImplementation((text) => {
      previewRevision += 1;
      lastDeliveredText = text.trimEnd();
      params?.onUpdate?.(text);
    }),
    flush: vi.fn().mockResolvedValue(void 0),
    messageId: vi.fn().mockImplementation(() => messageId),
    previewMode: vi.fn().mockReturnValue(params?.previewMode ?? "message"),
    previewRevision: vi.fn().mockImplementation(() => previewRevision),
    lastDeliveredText: vi.fn().mockImplementation(() => lastDeliveredText),
    clear: vi.fn().mockResolvedValue(void 0),
    stop: vi.fn().mockImplementation(async () => {
      await params?.onStop?.();
    }),
    materialize: vi.fn().mockImplementation(async () => messageId),
    forceNewMessage: vi.fn().mockImplementation(() => {
      if (params?.clearMessageIdOnForceNew) {
        messageId = void 0;
      }
    }),
    sendMayHaveLanded: vi.fn().mockReturnValue(false),
    setMessageId: (value) => {
      messageId = value;
    }
  };
}
function createSequencedTestDraftStream(startMessageId = 1001) {
  let activeMessageId;
  let nextMessageId = startMessageId;
  let previewRevision = 0;
  let lastDeliveredText = "";
  return {
    update: vi.fn().mockImplementation((text) => {
      if (activeMessageId == null) {
        activeMessageId = nextMessageId++;
      }
      previewRevision += 1;
      lastDeliveredText = text.trimEnd();
    }),
    flush: vi.fn().mockResolvedValue(void 0),
    messageId: vi.fn().mockImplementation(() => activeMessageId),
    previewMode: vi.fn().mockReturnValue("message"),
    previewRevision: vi.fn().mockImplementation(() => previewRevision),
    lastDeliveredText: vi.fn().mockImplementation(() => lastDeliveredText),
    clear: vi.fn().mockResolvedValue(void 0),
    stop: vi.fn().mockResolvedValue(void 0),
    materialize: vi.fn().mockImplementation(async () => activeMessageId),
    forceNewMessage: vi.fn().mockImplementation(() => {
      activeMessageId = void 0;
    }),
    sendMayHaveLanded: vi.fn().mockReturnValue(false),
    setMessageId: (value) => {
      activeMessageId = value;
    }
  };
}
export {
  createSequencedTestDraftStream,
  createTestDraftStream
};
