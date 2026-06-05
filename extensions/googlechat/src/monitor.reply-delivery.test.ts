import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import type { GoogleChatCoreRuntime, GoogleChatRuntimeEnv } from "./monitor-types.js";

const mocks = vi.hoisted(() => ({
  deleteGoogleChatMessage: vi.fn(),
  sendGoogleChatMessage: vi.fn(),
  updateGoogleChatMessage: vi.fn(),
  uploadGoogleChatAttachment: vi.fn(),
}));

vi.mock("./api.js", () => ({
  deleteGoogleChatMessage: mocks.deleteGoogleChatMessage,
  isUploadAuthScopeFailure: (err: unknown) =>
    (err instanceof Error ? err.message : String(err)).includes("Google Chat upload 403:"),
  sendGoogleChatMessage: mocks.sendGoogleChatMessage,
  updateGoogleChatMessage: mocks.updateGoogleChatMessage,
  uploadGoogleChatAttachment: mocks.uploadGoogleChatAttachment,
}));

const account = {
  accountId: "default",
  enabled: true,
  credentialSource: "inline",
  config: {},
} as ResolvedGoogleChatAccount;

const config = {} as OpenClawConfig;

function createCore(params?: {
  chunks?: readonly string[];
  media?: { buffer: Buffer; contentType?: string; fileName?: string };
}) {
  return {
    channel: {
      text: {
        resolveChunkMode: vi.fn(() => "markdown"),
        chunkMarkdownTextWithMode: vi.fn((text: string) => params?.chunks ?? [text]),
      },
      media: {
        readRemoteMediaBuffer: vi.fn(async () => params?.media ?? { buffer: Buffer.from("image") }),
      },
    },
  } as unknown as GoogleChatCoreRuntime;
}

function createRuntime() {
  return {
    error: vi.fn(),
    log: vi.fn(),
  } satisfies GoogleChatRuntimeEnv;
}

let deliverGoogleChatReply: typeof import("./monitor-reply-delivery.js").deliverGoogleChatReply;

beforeEach(async () => {
  vi.clearAllMocks();
  ({ deliverGoogleChatReply } = await import("./monitor-reply-delivery.js"));
});

afterAll(() => {
  vi.doUnmock("./api.js");
  vi.resetModules();
});

describe("Google Chat reply delivery", () => {
  it("resends the first text chunk as a new message when typing update fails", async () => {
    const core = createCore({ chunks: ["first chunk", "second chunk"] });
    const runtime = createRuntime();
    const statusSink = vi.fn();
    mocks.updateGoogleChatMessage.mockRejectedValueOnce(new Error("message not found"));
    mocks.sendGoogleChatMessage.mockResolvedValue({ messageName: "spaces/AAA/messages/fallback" });

    await deliverGoogleChatReply({
      payload: { text: "first chunk\n\nsecond chunk", replyToId: "spaces/AAA/threads/root" },
      account,
      spaceId: "spaces/AAA",
      runtime,
      core,
      config,
      statusSink,
      typingMessageName: "spaces/AAA/messages/typing",
    });

    expect(mocks.updateGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: "spaces/AAA/messages/typing",
      text: "first chunk",
    });
    expect(mocks.sendGoogleChatMessage).toHaveBeenCalledTimes(2);
    expect(mocks.sendGoogleChatMessage).toHaveBeenNthCalledWith(1, {
      account,
      space: "spaces/AAA",
      text: "first chunk",
      thread: "spaces/AAA/threads/root",
    });
    expect(mocks.sendGoogleChatMessage).toHaveBeenNthCalledWith(2, {
      account,
      space: "spaces/AAA",
      text: "second chunk",
      thread: "spaces/AAA/threads/root",
    });
    expect(statusSink).toHaveBeenCalledTimes(2);
    expect(runtime.error).toHaveBeenCalledWith(
      "Google Chat message send failed: Error: message not found",
    );
  });

  it("falls back to text link when remote media upload fails with 403 (app-auth scope limit)", async () => {
    const core = createCore({
      media: { buffer: Buffer.from("image"), contentType: "image/png", fileName: "reply.png" },
    });
    const runtime = createRuntime();
    const statusSink = vi.fn();
    mocks.uploadGoogleChatAttachment.mockRejectedValue(
      new Error("Google Chat upload 403: PERMISSION_DENIED"),
    );
    mocks.sendGoogleChatMessage.mockResolvedValue({ messageName: "spaces/AAA/messages/fallback" });

    await deliverGoogleChatReply({
      payload: {
        text: "caption",
        mediaUrl: "https://example.invalid/reply.png",
        replyToId: "spaces/AAA/threads/root",
      },
      account,
      spaceId: "spaces/AAA",
      runtime,
      core,
      config,
      statusSink,
    });

    expect(mocks.sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/AAA",
      text: "caption\nhttps://example.invalid/reply.png",
      thread: "spaces/AAA/threads/root",
    });
    expect(statusSink).toHaveBeenCalledTimes(1);
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("falls back to URL-only link when upload fails with 403 and there is no caption", async () => {
    const core = createCore({
      media: { buffer: Buffer.from("image"), contentType: "image/png" },
    });
    const runtime = createRuntime();
    mocks.uploadGoogleChatAttachment.mockRejectedValue(
      new Error("Google Chat upload 403: PERMISSION_DENIED"),
    );
    mocks.sendGoogleChatMessage.mockResolvedValue({ messageName: "spaces/AAA/messages/link" });

    await deliverGoogleChatReply({
      payload: {
        mediaUrl: "https://example.invalid/file.png",
        replyToId: "spaces/AAA/threads/root",
      },
      account,
      spaceId: "spaces/AAA",
      runtime,
      core,
      config,
    });

    expect(mocks.sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/AAA",
      text: "https://example.invalid/file.png",
      thread: "spaces/AAA/threads/root",
    });
  });

  it("does not fall back to text link for non-403 upload failures", async () => {
    const core = createCore({
      media: { buffer: Buffer.from("image"), contentType: "image/png" },
    });
    const runtime = createRuntime();
    mocks.uploadGoogleChatAttachment.mockRejectedValue(
      new Error("Google Chat upload 500: internal"),
    );
    mocks.sendGoogleChatMessage.mockResolvedValue(undefined);

    await deliverGoogleChatReply({
      payload: {
        mediaUrl: "https://example.invalid/file.png",
        replyToId: "spaces/AAA/threads/root",
      },
      account,
      spaceId: "spaces/AAA",
      runtime,
      core,
      config,
    });

    expect(mocks.sendGoogleChatMessage).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Google Chat attachment send failed"),
    );
  });

  it("logs and swallows readRemoteMediaBuffer failures (original error contract preserved)", async () => {
    const core = createCore();
    const runtime = createRuntime();
    (core.channel.media.readRemoteMediaBuffer as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("network timeout"),
    );

    await deliverGoogleChatReply({
      payload: {
        mediaUrl: "https://example.invalid/file.png",
        replyToId: "spaces/AAA/threads/root",
      },
      account,
      spaceId: "spaces/AAA",
      runtime,
      core,
      config,
    });

    expect(mocks.sendGoogleChatMessage).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Google Chat attachment send failed"),
    );
  });

  it("logs and swallows sendGoogleChatMessage failures after successful upload", async () => {
    const core = createCore({
      media: { buffer: Buffer.from("image"), contentType: "image/png", fileName: "img.png" },
    });
    const runtime = createRuntime();
    mocks.uploadGoogleChatAttachment.mockResolvedValue({ attachmentUploadToken: "tok" });
    mocks.sendGoogleChatMessage.mockRejectedValue(new Error("Google Chat API 500: server error"));

    await deliverGoogleChatReply({
      payload: {
        mediaUrl: "https://example.invalid/file.png",
        replyToId: "spaces/AAA/threads/root",
      },
      account,
      spaceId: "spaces/AAA",
      runtime,
      core,
      config,
    });

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Google Chat attachment send failed"),
    );
  });

  it("does not update a deleted typing message before sending media with a caption", async () => {
    const core = createCore({
      media: { buffer: Buffer.from("image"), contentType: "image/png", fileName: "reply.png" },
    });
    const runtime = createRuntime();
    mocks.deleteGoogleChatMessage.mockResolvedValue(undefined);
    mocks.uploadGoogleChatAttachment.mockResolvedValue({ attachmentUploadToken: "upload-token" });
    mocks.sendGoogleChatMessage.mockResolvedValue({ messageName: "spaces/AAA/messages/media" });

    await deliverGoogleChatReply({
      payload: {
        text: "caption",
        mediaUrl: "https://example.invalid/reply.png",
        replyToId: "spaces/AAA/threads/root",
      },
      account,
      spaceId: "spaces/AAA",
      runtime,
      core,
      config,
      typingMessageName: "spaces/AAA/messages/typing",
    });

    expect(mocks.deleteGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: "spaces/AAA/messages/typing",
    });
    expect(mocks.updateGoogleChatMessage).not.toHaveBeenCalled();
    expect(mocks.sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/AAA",
      text: "caption",
      thread: "spaces/AAA/threads/root",
      attachments: [{ attachmentUploadToken: "upload-token", contentName: "reply.png" }],
    });
  });
});
