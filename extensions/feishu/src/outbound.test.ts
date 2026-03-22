import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMediaFeishuMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const sendMarkdownCardFeishuMock = vi.hoisted(() => vi.fn());
const sendStructuredCardFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./media.js", () => ({
  sendMediaFeishu: sendMediaFeishuMock,
}));

vi.mock("./send.js", () => ({
  sendMessageFeishu: sendMessageFeishuMock,
  sendMarkdownCardFeishu: sendMarkdownCardFeishuMock,
  sendStructuredCardFeishu: sendStructuredCardFeishuMock,
}));

vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({
    channel: {
      text: {
        chunkMarkdownText: (text: string) => [text],
      },
    },
  }),
}));

import { feishuOutbound } from "./outbound.js";
const sendText = feishuOutbound.sendText!;

function resetOutboundMocks() {
  vi.clearAllMocks();
  sendMessageFeishuMock.mockResolvedValue({ messageId: "text_msg" });
  sendMarkdownCardFeishuMock.mockResolvedValue({ messageId: "card_msg" });
  sendStructuredCardFeishuMock.mockResolvedValue({ messageId: "card_msg" });
  sendMediaFeishuMock.mockResolvedValue({ messageId: "media_msg" });
}

describe("feishuOutbound.sendText local-image auto-convert", () => {
  beforeEach(() => {
    resetOutboundMocks();
  });

  async function createTmpImage(ext = ".png"): Promise<{ dir: string; file: string }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-outbound-"));
    const file = path.join(dir, `sample${ext}`);
    await fs.writeFile(file, "image-data");
    return { dir, file };
  }

  it("sends an absolute existing local image path as media", async () => {
    const { dir, file } = await createTmpImage();
    try {
      const result = await sendText({
        cfg: {} as any,
        to: "chat_1",
        text: file,
        accountId: "main",
        mediaLocalRoots: [dir],
      });

      expect(sendMediaFeishuMock).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "chat_1",
          mediaUrl: file,
          accountId: "main",
          mediaLocalRoots: [dir],
        }),
      );
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
      expect(result).toEqual(
        expect.objectContaining({ channel: "feishu", messageId: "media_msg" }),
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps non-path text on the text-send path", async () => {
    await sendText({
      cfg: {} as any,
      to: "chat_1",
      text: "please upload /tmp/example.png",
      accountId: "main",
    });

    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        text: "please upload /tmp/example.png",
        accountId: "main",
      }),
    );
  });

  it("falls back to plain text if local-image media send fails", async () => {
    const { dir, file } = await createTmpImage();
    sendMediaFeishuMock.mockRejectedValueOnce(new Error("upload failed"));
    try {
      await sendText({
        cfg: {} as any,
        to: "chat_1",
        text: file,
        accountId: "main",
      });

      expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
      expect(sendMessageFeishuMock).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "chat_1",
          text: file,
          accountId: "main",
        }),
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("uses markdown cards when renderMode=card", async () => {
    const result = await sendText({
      cfg: {
        channels: {
          feishu: {
            renderMode: "card",
          },
        },
      } as any,
      to: "chat_1",
      text: "| a | b |\n| - | - |",
      accountId: "main",
    });

    expect(sendStructuredCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        text: "| a | b |\n| - | - |",
        accountId: "main",
      }),
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ channel: "feishu", messageId: "card_msg" }));
  });

  it("forwards replyToId as replyToMessageId on sendText", async () => {
    await sendText({
      cfg: {} as any,
      to: "chat_1",
      text: "hello",
      replyToId: "om_reply_1",
      accountId: "main",
    } as any);

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        text: "hello",
        replyToMessageId: "om_reply_1",
        accountId: "main",
      }),
    );
  });

  it("falls back to threadId when replyToId is empty on sendText", async () => {
    await sendText({
      cfg: {} as any,
      to: "chat_1",
      text: "hello",
      replyToId: " ",
      threadId: "om_thread_2",
      accountId: "main",
    } as any);

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        text: "hello",
        replyToMessageId: "om_thread_2",
        accountId: "main",
      }),
    );
  });
});

describe("feishuOutbound.sendText replyToId forwarding", () => {
  beforeEach(() => {
    resetOutboundMocks();
  });

  it("forwards replyToId as replyToMessageId to sendMessageFeishu", async () => {
    await sendText({
      cfg: {} as any,
      to: "chat_1",
      text: "hello",
      replyToId: "om_reply_target",
      accountId: "main",
    });

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        text: "hello",
        replyToMessageId: "om_reply_target",
        accountId: "main",
      }),
    );
  });

  it("forwards replyToId to sendStructuredCardFeishu when renderMode=card", async () => {
    await sendText({
      cfg: {
        channels: {
          feishu: {
            renderMode: "card",
          },
        },
      } as any,
      to: "chat_1",
      text: "```code```",
      replyToId: "om_reply_target",
      accountId: "main",
    });

    expect(sendStructuredCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_reply_target",
      }),
    );
  });

  it("does not pass replyToMessageId when replyToId is absent", async () => {
    await sendText({
      cfg: {} as any,
      to: "chat_1",
      text: "hello",
      accountId: "main",
    });

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        text: "hello",
        accountId: "main",
      }),
    );
    expect(sendMessageFeishuMock.mock.calls[0][0].replyToMessageId).toBeUndefined();
  });
});

describe("feishuOutbound.sendMedia replyToId forwarding", () => {
  beforeEach(() => {
    resetOutboundMocks();
  });

  it("forwards replyToId to sendMediaFeishu", async () => {
    await feishuOutbound.sendMedia?.({
      cfg: {} as any,
      to: "chat_1",
      text: "",
      mediaUrl: "https://example.com/image.png",
      replyToId: "om_reply_target",
      accountId: "main",
    });

    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_reply_target",
      }),
    );
  });

  it("forwards replyToId to text caption send", async () => {
    await feishuOutbound.sendMedia?.({
      cfg: {} as any,
      to: "chat_1",
      text: "caption text",
      mediaUrl: "https://example.com/image.png",
      replyToId: "om_reply_target",
      accountId: "main",
    });

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_reply_target",
      }),
    );
  });
});

describe("feishuOutbound.sendMedia renderMode", () => {
  beforeEach(() => {
    resetOutboundMocks();
  });

  it("uses markdown cards for captions when renderMode=card", async () => {
    const result = await feishuOutbound.sendMedia?.({
      cfg: {
        channels: {
          feishu: {
            renderMode: "card",
          },
        },
      } as any,
      to: "chat_1",
      text: "| a | b |\n| - | - |",
      mediaUrl: "https://example.com/image.png",
      accountId: "main",
    });

    expect(sendMarkdownCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        text: "| a | b |\n| - | - |",
        accountId: "main",
      }),
    );
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        mediaUrl: "https://example.com/image.png",
        accountId: "main",
      }),
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ channel: "feishu", messageId: "media_msg" }));
  });

  it("uses threadId fallback as replyToMessageId on sendMedia", async () => {
    await feishuOutbound.sendMedia?.({
      cfg: {} as any,
      to: "chat_1",
      text: "caption",
      mediaUrl: "https://example.com/image.png",
      threadId: "om_thread_1",
      accountId: "main",
    } as any);

    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        mediaUrl: "https://example.com/image.png",
        replyToMessageId: "om_thread_1",
        accountId: "main",
      }),
    );
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        text: "caption",
        replyToMessageId: "om_thread_1",
        accountId: "main",
      }),
    );
  });
});

describe("feishuOutbound.sendText markdown image extraction", () => {
  beforeEach(() => {
    resetOutboundMocks();
  });

  it("extracts markdown image URL and sends as native image", async () => {
    await sendText({
      cfg: {} as any,
      to: "chat_1",
      text: "Here is the result:\n\n![generated image](https://example.com/image.png)",
      accountId: "main",
    });

    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        mediaUrl: "https://example.com/image.png",
        accountId: "main",
      }),
    );
    // Remaining text should still be sent
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        text: "Here is the result:",
        accountId: "main",
      }),
    );
  });

  it("handles multiple markdown images", async () => {
    await sendText({
      cfg: {} as any,
      to: "chat_1",
      text: "![img1](https://example.com/a.png)\n\n![img2](https://example.com/b.jpg)",
      accountId: "main",
    });

    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(2);
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({ mediaUrl: "https://example.com/a.png" }),
    );
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({ mediaUrl: "https://example.com/b.jpg" }),
    );
    // No remaining text, so text send should not be called
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("sends only text when no markdown images present", async () => {
    await sendText({
      cfg: {} as any,
      to: "chat_1",
      text: "No images here, just text.",
      accountId: "main",
    });

    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: "No images here, just text." }),
    );
  });

  it("falls back gracefully when image upload fails", async () => {
    sendMediaFeishuMock.mockRejectedValueOnce(new Error("upload failed"));

    await sendText({
      cfg: {} as any,
      to: "chat_1",
      text: "Check this:\n\n![img](https://example.com/broken.png)\n\nDone.",
      accountId: "main",
    });

    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    // Remaining text should still be sent
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("📎 https://example.com/broken.png"),
      }),
    );
  });

  it("does not extract non-HTTP image URLs", async () => {
    await sendText({
      cfg: {} as any,
      to: "chat_1",
      text: "![local](file:///tmp/secret.png) and ![data](data:image/png;base64,abc)",
      accountId: "main",
    });

    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
  });

  it("handles image-only text without remaining content", async () => {
    const result = await sendText({
      cfg: {} as any,
      to: "chat_1",
      text: "![only image](https://example.com/photo.jpg)",
      accountId: "main",
    });

    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ channel: "feishu", messageId: "media_msg" }));
  });

  it("preserves replyToId when extracting images", async () => {
    await sendText({
      cfg: {} as any,
      to: "chat_1",
      text: "Reply with image:\n\n![pic](https://example.com/reply.png)",
      replyToId: "om_reply_1",
      accountId: "main",
    } as any);

    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_reply_1",
      }),
    );
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_reply_1",
      }),
    );
  });
});
