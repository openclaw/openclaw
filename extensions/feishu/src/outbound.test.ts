import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveFeishuAccountMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const sendMarkdownCardFeishuMock = vi.hoisted(() => vi.fn());
const sendMediaFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: resolveFeishuAccountMock,
}));

vi.mock("./send.js", () => ({
  sendMessageFeishu: sendMessageFeishuMock,
  sendMarkdownCardFeishu: sendMarkdownCardFeishuMock,
}));

vi.mock("./media.js", () => ({
  sendMediaFeishu: sendMediaFeishuMock,
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("feishuOutbound.sendText local-image auto-convert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    resolveFeishuAccountMock.mockReturnValue({
      config: { renderMode: "auto" },
    });
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
        cfg: {} as never,
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
      expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
      expect(result).toEqual(
        expect.objectContaining({ channel: "feishu", messageId: "media_msg" }),
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps non-path text on the text-send path", async () => {
    await sendText({
      cfg: {} as never,
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
        cfg: {} as never,
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
      expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
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

describe("feishuOutbound renderMode routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    resolveFeishuAccountMock.mockReturnValue({
      config: { renderMode: "auto" },
    });
    sendMessageFeishuMock.mockResolvedValue({ messageId: "msg_text", chatId: "chat_1" });
    sendMarkdownCardFeishuMock.mockResolvedValue({ messageId: "msg_card", chatId: "chat_1" });
    sendMediaFeishuMock.mockResolvedValue({ messageId: "msg_media", chatId: "chat_1" });
  });

  it("uses markdown card when renderMode=card", async () => {
    resolveFeishuAccountMock.mockReturnValueOnce({
      config: { renderMode: "card" },
    });

    const sendText = feishuOutbound.sendText;
    if (!sendText) {
      throw new Error("feishuOutbound.sendText is not configured");
    }
    await sendText({
      cfg: {} as never,
      to: "chat:oc_xxx",
      text: "plain text",
      accountId: "pm",
    });

    expect(sendMarkdownCardFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMarkdownCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:oc_xxx",
        text: "plain text",
        accountId: "pm",
      }),
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("uses text send when renderMode=raw", async () => {
    resolveFeishuAccountMock.mockReturnValueOnce({
      config: { renderMode: "raw" },
    });

    const sendText = feishuOutbound.sendText;
    if (!sendText) {
      throw new Error("feishuOutbound.sendText is not configured");
    }
    await sendText({
      cfg: {} as never,
      to: "chat:oc_xxx",
      text: "plain text",
      accountId: "pm",
    });

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });

  it("uses markdown card in auto mode when message contains markdown block", async () => {
    resolveFeishuAccountMock.mockReturnValueOnce({
      config: { renderMode: "auto" },
    });

    const sendText = feishuOutbound.sendText;
    if (!sendText) {
      throw new Error("feishuOutbound.sendText is not configured");
    }
    await sendText({
      cfg: {} as never,
      to: "chat:oc_xxx",
      text: "```ts\nconst x = 1\n```",
      accountId: "pm",
    });

    expect(sendMarkdownCardFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("keeps media fallback aligned with renderMode=card", async () => {
    resolveFeishuAccountMock
      .mockReturnValueOnce({ config: { renderMode: "card" } })
      .mockReturnValueOnce({ config: { renderMode: "card" } });
    sendMediaFeishuMock.mockRejectedValueOnce(new Error("upload failed"));

    const sendMedia = feishuOutbound.sendMedia;
    if (!sendMedia) {
      throw new Error("feishuOutbound.sendMedia is not configured");
    }
    await sendMedia({
      cfg: {} as never,
      to: "chat:oc_xxx",
      text: "",
      mediaUrl: "https://example.com/a.png",
      accountId: "pm",
    });

    expect(sendMarkdownCardFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMarkdownCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "📎 https://example.com/a.png",
      }),
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });
});
