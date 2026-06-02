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

  it("delivers the media URL as a text link when app-auth upload returns 403 (#89430)", async () => {
    const core = createCore({
      media: { buffer: Buffer.from("image"), contentType: "image/png", fileName: "shot.png" },
    });
    const runtime = createRuntime();
    const statusSink = vi.fn();
    mocks.uploadGoogleChatAttachment.mockRejectedValueOnce(
      new Error(
        'Google Chat upload 403: {"error":{"status":"PERMISSION_DENIED","message":"Request had insufficient authentication scopes."}}',
      ),
    );
    mocks.sendGoogleChatMessage.mockResolvedValue({ messageName: "spaces/AAA/messages/link" });

    await deliverGoogleChatReply({
      payload: {
        text: "here you go",
        mediaUrl: "https://example.invalid/shot.png",
        replyToId: "spaces/AAA/threads/root",
      },
      account,
      spaceId: "spaces/AAA",
      runtime,
      core,
      config,
      statusSink,
    });

    // The reply is salvaged as a normal text message carrying the public URL instead of dropped.
    expect(mocks.sendGoogleChatMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/AAA",
      text: "here you go\nhttps://example.invalid/shot.png",
      thread: "spaces/AAA/threads/root",
    });
    // No attachment send is attempted once the upload 403s.
    expect(mocks.sendGoogleChatMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ attachments: expect.anything() }),
    );
    expect(statusSink).toHaveBeenCalledWith({ lastOutboundAt: expect.any(Number) });
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("does not fall back for non-auth upload failures (#89430)", async () => {
    const core = createCore({
      media: { buffer: Buffer.from("image"), contentType: "image/png", fileName: "shot.png" },
    });
    const runtime = createRuntime();
    mocks.uploadGoogleChatAttachment.mockRejectedValueOnce(
      new Error("Google Chat upload 500: internal error"),
    );

    await deliverGoogleChatReply({
      payload: {
        text: "here you go",
        mediaUrl: "https://example.invalid/shot.png",
        replyToId: "spaces/AAA/threads/root",
      },
      account,
      spaceId: "spaces/AAA",
      runtime,
      core,
      config,
    });

    // A 500 is not an auth/scope failure, so no text-link fallback is sent and the error surfaces.
    expect(mocks.sendGoogleChatMessage).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Google Chat attachment send failed"),
    );
  });
});
