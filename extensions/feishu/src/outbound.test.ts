import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMediaFeishuMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const sendMarkdownCardFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./media.js", () => ({
  sendMediaFeishu: sendMediaFeishuMock,
}));

vi.mock("./send.js", () => ({
  sendMessageFeishu: sendMessageFeishuMock,
  sendMarkdownCardFeishu: sendMarkdownCardFeishuMock,
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

describe("feishuOutbound.sendText local-image auto-convert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendMessageFeishuMock.mockResolvedValue({ messageId: "text_msg" });
    sendMarkdownCardFeishuMock.mockResolvedValue({ messageId: "card_msg" });
    sendMediaFeishuMock.mockResolvedValue({ messageId: "media_msg" });
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
      });

      expect(sendMediaFeishuMock).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "chat_1",
          mediaUrl: file,
          accountId: "main",
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

    expect(sendMarkdownCardFeishuMock).toHaveBeenCalledWith(
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
    vi.clearAllMocks();
    sendMessageFeishuMock.mockResolvedValue({ messageId: "text_msg" });
    sendMarkdownCardFeishuMock.mockResolvedValue({ messageId: "card_msg" });
    sendMediaFeishuMock.mockResolvedValue({ messageId: "media_msg" });
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

  it("forwards replyToId to sendMarkdownCardFeishu when renderMode=card", async () => {
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

    expect(sendMarkdownCardFeishuMock).toHaveBeenCalledWith(
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
    vi.clearAllMocks();
    sendMessageFeishuMock.mockResolvedValue({ messageId: "text_msg" });
    sendMarkdownCardFeishuMock.mockResolvedValue({ messageId: "card_msg" });
    sendMediaFeishuMock.mockResolvedValue({ messageId: "media_msg" });
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
    vi.clearAllMocks();
    sendMessageFeishuMock.mockResolvedValue({ messageId: "text_msg" });
    sendMarkdownCardFeishuMock.mockResolvedValue({ messageId: "card_msg" });
    sendMediaFeishuMock.mockResolvedValue({ messageId: "media_msg" });
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

describe("feishuOutbound.sendPayload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendMessageFeishuMock.mockResolvedValue({ messageId: "text_msg" });
    sendMarkdownCardFeishuMock.mockResolvedValue({ messageId: "card_msg" });
    sendMediaFeishuMock.mockResolvedValue({ messageId: "media_msg" });
  });

  const baseCtx = {
    to: "chat_1",
    cfg: {} as any,
    payload: {} as any,
    accountId: "main",
  };

  it("text-only delegates to sendText", async () => {
    const result = await feishuOutbound.sendPayload!({
      ...baseCtx,
      payload: { text: "hello" },
    });

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ channel: "feishu" }));
  });

  it("single media delegates to sendMedia", async () => {
    const result = await feishuOutbound.sendPayload!({
      ...baseCtx,
      payload: { text: "caption", mediaUrl: "https://example.com/a.png" },
    });

    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ channel: "feishu" }));
  });

  it("multi-media iterates URLs with caption on first", async () => {
    const result = await feishuOutbound.sendPayload!({
      ...baseCtx,
      payload: {
        text: "caption",
        mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
      },
    });

    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual(expect.objectContaining({ channel: "feishu" }));
  });

  it("empty payload returns no-op", async () => {
    const result = await feishuOutbound.sendPayload!({
      ...baseCtx,
      payload: {},
    });

    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: "feishu", messageId: "" });
  });

  it("returns no-op when chunker produces empty array", async () => {
    const chunkerSpy = vi.spyOn(feishuOutbound, "chunker").mockReturnValue([]);
    const sendTextSpy = vi.spyOn(feishuOutbound, "sendText");
    const result = await feishuOutbound.sendPayload!({
      ...baseCtx,
      payload: { text: "   " },
    } as never);
    expect(sendTextSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: "feishu", messageId: "" });
    chunkerSpy.mockRestore();
    sendTextSpy.mockRestore();
  });

  it("chunking splits long text", async () => {
    // feishuOutbound.textChunkLimit is 4000; mock chunker returns [text] (single chunk)
    // so for text under limit, one call
    const result = await feishuOutbound.sendPayload!({
      ...baseCtx,
      payload: { text: "short text" },
    });

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ channel: "feishu" }));
  });
});
