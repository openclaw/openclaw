import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/googlechat";
import { describe, expect, it, vi } from "vitest";

const uploadGoogleChatAttachmentMock = vi.hoisted(() => vi.fn());
const sendGoogleChatMessageMock = vi.hoisted(() => vi.fn());

vi.mock("./api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.js")>();
  return {
    ...actual,
    sendGoogleChatMessage: sendGoogleChatMessageMock,
    uploadGoogleChatAttachment: uploadGoogleChatAttachmentMock,
  };
});

import { googlechatPlugin } from "./channel.js";
import { setGoogleChatRuntime } from "./runtime.js";

function createGoogleChatCfg(): OpenClawConfig {
  return {
    channels: {
      googlechat: {
        enabled: true,
        serviceAccount: {
          type: "service_account",
          client_email: "bot@example.com",
          private_key: "test-key", // pragma: allowlist secret
          token_uri: "https://oauth2.googleapis.com/token",
        },
      },
    },
  };
}

function setupRuntimeMediaMocks(params: { loadFileName: string; loadBytes: string }) {
  const loadWebMedia = vi.fn(async () => ({
    buffer: Buffer.from(params.loadBytes),
    fileName: params.loadFileName,
    contentType: "image/png",
  }));
  const fetchRemoteMedia = vi.fn(async () => ({
    buffer: Buffer.from("remote-bytes"),
    fileName: "remote.png",
    contentType: "image/png",
  }));

  setGoogleChatRuntime({
    media: { loadWebMedia },
    channel: {
      media: { fetchRemoteMedia },
      text: { chunkMarkdownText: (text: string) => [text] },
    },
  } as unknown as PluginRuntime);

  return { loadWebMedia, fetchRemoteMedia };
}

describe("googlechatPlugin outbound sendMedia", () => {
  it("loads local media with mediaLocalRoots via runtime media loader", async () => {
    const { loadWebMedia, fetchRemoteMedia } = setupRuntimeMediaMocks({
      loadFileName: "image.png",
      loadBytes: "image-bytes",
    });

    uploadGoogleChatAttachmentMock.mockResolvedValue({
      attachmentUploadToken: "token-1",
    });
    sendGoogleChatMessageMock.mockResolvedValue({
      messageName: "spaces/AAA/messages/msg-1",
    });

    const cfg = createGoogleChatCfg();

    const result = await googlechatPlugin.outbound?.sendMedia?.({
      cfg,
      to: "spaces/AAA",
      text: "caption",
      mediaUrl: "/tmp/workspace/image.png",
      mediaLocalRoots: ["/tmp/workspace"],
      accountId: "default",
    });

    expect(loadWebMedia).toHaveBeenCalledWith(
      "/tmp/workspace/image.png",
      expect.objectContaining({
        localRoots: ["/tmp/workspace"],
      }),
    );
    expect(fetchRemoteMedia).not.toHaveBeenCalled();
    expect(uploadGoogleChatAttachmentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        space: "spaces/AAA",
        filename: "image.png",
        contentType: "image/png",
      }),
    );
    expect(sendGoogleChatMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        space: "spaces/AAA",
        text: "caption",
      }),
    );
    expect(result).toEqual({
      channel: "googlechat",
      messageId: "spaces/AAA/messages/msg-1",
      chatId: "spaces/AAA",
    });
  });

  it("keeps remote URL media fetch on fetchRemoteMedia with maxBytes cap", async () => {
    const { loadWebMedia, fetchRemoteMedia } = setupRuntimeMediaMocks({
      loadFileName: "unused.png",
      loadBytes: "should-not-be-used",
    });

    uploadGoogleChatAttachmentMock.mockResolvedValue({
      attachmentUploadToken: "token-2",
    });
    sendGoogleChatMessageMock.mockResolvedValue({
      messageName: "spaces/AAA/messages/msg-2",
    });

    const cfg = createGoogleChatCfg();

    const result = await googlechatPlugin.outbound?.sendMedia?.({
      cfg,
      to: "spaces/AAA",
      text: "caption",
      mediaUrl: "https://example.com/image.png",
      accountId: "default",
    });

    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/image.png",
        maxBytes: 20 * 1024 * 1024,
      }),
    );
    expect(loadWebMedia).not.toHaveBeenCalled();
    expect(uploadGoogleChatAttachmentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        space: "spaces/AAA",
        filename: "remote.png",
        contentType: "image/png",
      }),
    );
    expect(sendGoogleChatMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        space: "spaces/AAA",
        text: "caption",
      }),
    );
    expect(result).toEqual({
      channel: "googlechat",
      messageId: "spaces/AAA/messages/msg-2",
      chatId: "spaces/AAA",
    });
  });
});
