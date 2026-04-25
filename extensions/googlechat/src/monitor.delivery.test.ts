import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";

// --- Hoisted mocks for Google Chat API surface ---
const deleteGoogleChatMessageMock = vi.hoisted(() => vi.fn());
const sendGoogleChatMessageMock = vi.hoisted(() => vi.fn());
const updateGoogleChatMessageMock = vi.hoisted(() => vi.fn());
const downloadGoogleChatMediaMock = vi.hoisted(() => vi.fn());
const uploadGoogleChatAttachmentMock = vi.hoisted(() => vi.fn());

vi.mock("./api.js", () => ({
  deleteGoogleChatMessage: deleteGoogleChatMessageMock,
  sendGoogleChatMessage: sendGoogleChatMessageMock,
  updateGoogleChatMessage: updateGoogleChatMessageMock,
  downloadGoogleChatMedia: downloadGoogleChatMediaMock,
  uploadGoogleChatAttachment: uploadGoogleChatAttachmentMock,
}));

vi.mock("./monitor-routing.js", () => ({
  handleGoogleChatWebhookRequest: vi.fn(),
  registerGoogleChatWebhookTarget: vi.fn(),
  setGoogleChatWebhookEventProcessor: vi.fn(),
}));

vi.mock("./runtime.js", () => ({
  getGoogleChatRuntime: vi.fn(() => ({})),
}));

vi.mock("./monitor-access.js", () => ({
  applyGoogleChatInboundAccessPolicy: vi.fn(),
  isSenderAllowed: vi.fn(),
}));

let __testOnly_deliverGoogleChatReply: typeof import("./monitor.js").__testOnly_deliverGoogleChatReply;

beforeEach(async () => {
  vi.clearAllMocks();
  ({ __testOnly_deliverGoogleChatReply } = await import("./monitor.js"));
});

function buildAccount(): ResolvedGoogleChatAccount {
  return {
    accountId: "default",
    name: "default",
    enabled: true,
    config: {
      textChunkLimit: 4000,
      mediaMaxMb: 20,
    },
    credentialSource: "inline",
  } as unknown as ResolvedGoogleChatAccount;
}

function buildCore() {
  return {
    channel: {
      text: {
        resolveChunkMode: () => "newline" as const,
        chunkMarkdownTextWithMode: (text: string) => (text ? [text] : []),
      },
      media: {
        fetchRemoteMedia: vi.fn(),
        saveMediaBuffer: vi.fn(),
      },
    },
    logging: {
      shouldLogVerbose: () => false,
    },
  };
}

function buildRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  };
}

const baseConfig = {} as never;
const SPACE_ID = "spaces/AAAA";
const TYPING_NAME = "spaces/AAAA/messages/typing-1";

describe("googlechat deliverGoogleChatReply — typing indicator handling", () => {
  describe("media+text path", () => {
    it("clears typingMessageName after successful delete; text uses sendGoogleChatMessage", async () => {
      deleteGoogleChatMessageMock.mockResolvedValueOnce(undefined);
      sendGoogleChatMessageMock.mockResolvedValue({ messageName: "msg-1" });
      const core = buildCore();
      core.channel.media.fetchRemoteMedia.mockResolvedValue({
        buffer: Buffer.from("x"),
        contentType: "image/png",
      });
      uploadGoogleChatAttachmentMock.mockResolvedValue({
        attachmentUploadToken: "upload-token-123",
      });

      await __testOnly_deliverGoogleChatReply({
        payload: { text: "hello world", mediaUrls: ["https://example.com/img.png"] },
        account: buildAccount(),
        spaceId: SPACE_ID,
        runtime: buildRuntime(),
        core: core as never,
        config: baseConfig,
        typingMessageName: TYPING_NAME,
      });

      expect(deleteGoogleChatMessageMock).toHaveBeenCalledTimes(1);
      expect(updateGoogleChatMessageMock).not.toHaveBeenCalled();
      const textCalls = sendGoogleChatMessageMock.mock.calls.filter(
        (c) => typeof c[0]?.text === "string" && c[0].text.includes("hello"),
      );
      expect(textCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("falls back to update when delete fails; suppresses caption", async () => {
      deleteGoogleChatMessageMock.mockRejectedValueOnce(new Error("delete-failed"));
      updateGoogleChatMessageMock.mockResolvedValue(undefined);
      sendGoogleChatMessageMock.mockResolvedValue({ messageName: "msg-1" });
      const core = buildCore();
      core.channel.media.fetchRemoteMedia.mockResolvedValue({
        buffer: Buffer.from("x"),
        contentType: "image/png",
      });
      uploadGoogleChatAttachmentMock.mockResolvedValue({
        attachmentUploadToken: "upload-token-123",
      });

      await __testOnly_deliverGoogleChatReply({
        payload: { text: "hello", mediaUrls: ["https://example.com/img.png"] },
        account: buildAccount(),
        spaceId: SPACE_ID,
        runtime: buildRuntime(),
        core: core as never,
        config: baseConfig,
        typingMessageName: TYPING_NAME,
      });

      expect(updateGoogleChatMessageMock).toHaveBeenCalledTimes(1);
      expect(updateGoogleChatMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({ messageName: TYPING_NAME, text: "hello" }),
      );
    });

    it("clears typingMessageName when both delete AND fallback update fail", async () => {
      deleteGoogleChatMessageMock.mockRejectedValueOnce(new Error("delete-failed"));
      updateGoogleChatMessageMock.mockRejectedValueOnce(new Error("update-failed"));
      sendGoogleChatMessageMock.mockResolvedValue({ messageName: "msg-1" });
      const core = buildCore();
      core.channel.media.fetchRemoteMedia.mockResolvedValue({
        buffer: Buffer.from("x"),
        contentType: "image/png",
      });
      uploadGoogleChatAttachmentMock.mockResolvedValue({
        attachmentUploadToken: "upload-token-123",
      });

      await __testOnly_deliverGoogleChatReply({
        payload: { text: "hello", mediaUrls: ["https://example.com/img.png"] },
        account: buildAccount(),
        spaceId: SPACE_ID,
        runtime: buildRuntime(),
        core: core as never,
        config: baseConfig,
        typingMessageName: TYPING_NAME,
      });

      expect(updateGoogleChatMessageMock).toHaveBeenCalledTimes(1);
      const textCalls = sendGoogleChatMessageMock.mock.calls.filter(
        (c) => typeof c[0]?.text === "string" && c[0].text.includes("hello"),
      );
      expect(textCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("text-only path", () => {
    it("uses updateGoogleChatMessage to replace typing indicator on first chunk", async () => {
      updateGoogleChatMessageMock.mockResolvedValue(undefined);
      sendGoogleChatMessageMock.mockResolvedValue({ messageName: "msg-1" });

      await __testOnly_deliverGoogleChatReply({
        payload: { text: "hello world" },
        account: buildAccount(),
        spaceId: SPACE_ID,
        runtime: buildRuntime(),
        core: buildCore() as never,
        config: baseConfig,
        typingMessageName: TYPING_NAME,
      });

      expect(updateGoogleChatMessageMock).toHaveBeenCalledTimes(1);
      expect(updateGoogleChatMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({ messageName: TYPING_NAME, text: "hello world" }),
      );
      expect(deleteGoogleChatMessageMock).not.toHaveBeenCalled();
    });

    it("retries the failed first chunk via sendGoogleChatMessage when update fails", async () => {
      updateGoogleChatMessageMock.mockRejectedValueOnce(new Error("typing-message-gone"));
      sendGoogleChatMessageMock.mockResolvedValue({ messageName: "msg-1" });

      await __testOnly_deliverGoogleChatReply({
        payload: { text: "important payload" },
        account: buildAccount(),
        spaceId: SPACE_ID,
        runtime: buildRuntime(),
        core: buildCore() as never,
        config: baseConfig,
        typingMessageName: TYPING_NAME,
      });

      expect(updateGoogleChatMessageMock).toHaveBeenCalledTimes(1);
      expect(sendGoogleChatMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({ space: SPACE_ID, text: "important payload" }),
      );
    });

    it("does not retry update for subsequent chunks after first chunk failed", async () => {
      const longText = `aaa\n\nbbb`;
      updateGoogleChatMessageMock.mockRejectedValueOnce(new Error("typing-message-gone"));
      sendGoogleChatMessageMock.mockResolvedValue({ messageName: "msg-1" });

      const core = buildCore();
      core.channel.text.chunkMarkdownTextWithMode = (text: string) => {
        if (!text) return [];
        return text.split("\n\n").filter(Boolean);
      };

      await __testOnly_deliverGoogleChatReply({
        payload: { text: longText },
        account: buildAccount(),
        spaceId: SPACE_ID,
        runtime: buildRuntime(),
        core: core as never,
        config: baseConfig,
        typingMessageName: TYPING_NAME,
      });

      expect(updateGoogleChatMessageMock).toHaveBeenCalledTimes(1);
      // Both chunks delivered: failed first chunk retried + second chunk.
      expect(sendGoogleChatMessageMock).toHaveBeenCalledTimes(2);
      expect(sendGoogleChatMessageMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ text: "aaa" }),
      );
      expect(sendGoogleChatMessageMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ text: "bbb" }),
      );
    });

    it("logs but does not throw when both update and fallback send fail", async () => {
      updateGoogleChatMessageMock.mockRejectedValueOnce(new Error("typing-message-gone"));
      sendGoogleChatMessageMock.mockRejectedValueOnce(new Error("space-not-accessible"));
      const runtime = buildRuntime();

      await expect(
        __testOnly_deliverGoogleChatReply({
          payload: { text: "hello" },
          account: buildAccount(),
          spaceId: SPACE_ID,
          runtime,
          core: buildCore() as never,
          config: baseConfig,
          typingMessageName: TYPING_NAME,
        }),
      ).resolves.toBeUndefined();

      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("Google Chat message send failed"),
      );
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("Google Chat fallback send failed"),
      );
    });

    it("sends via sendGoogleChatMessage when no typingMessageName provided", async () => {
      sendGoogleChatMessageMock.mockResolvedValue({ messageName: "msg-1" });

      await __testOnly_deliverGoogleChatReply({
        payload: { text: "hello" },
        account: buildAccount(),
        spaceId: SPACE_ID,
        runtime: buildRuntime(),
        core: buildCore() as never,
        config: baseConfig,
      });

      expect(updateGoogleChatMessageMock).not.toHaveBeenCalled();
      expect(sendGoogleChatMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({ space: SPACE_ID, text: "hello" }),
      );
    });
  });
});
