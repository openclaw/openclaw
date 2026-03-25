import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMediaFeishuMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const sendMarkdownCardFeishuMock = vi.hoisted(() => vi.fn());
const sendStructuredCardFeishuMock = vi.hoisted(() => vi.fn());
const sendCardFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./media.js", () => ({
  sendMediaFeishu: sendMediaFeishuMock,
}));

vi.mock("./send.js", () => ({
  sendMessageFeishu: sendMessageFeishuMock,
  sendMarkdownCardFeishu: sendMarkdownCardFeishuMock,
  sendStructuredCardFeishu: sendStructuredCardFeishuMock,
  sendCardFeishu: sendCardFeishuMock,
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

async function createTmpImage(ext = ".png"): Promise<{ dir: string; file: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-outbound-"));
  const file = path.join(dir, `sample${ext}`);
  await fs.writeFile(file, "image-data");
  return { dir, file };
}

function resetOutboundMocks() {
  vi.clearAllMocks();
  sendMessageFeishuMock.mockResolvedValue({ messageId: "text_msg" });
  sendMarkdownCardFeishuMock.mockResolvedValue({ messageId: "card_msg" });
  sendStructuredCardFeishuMock.mockResolvedValue({ messageId: "card_msg" });
  sendMediaFeishuMock.mockResolvedValue({ messageId: "media_msg" });
  sendCardFeishuMock.mockResolvedValue({ messageId: "interactive_card_msg" });
}

describe("feishuOutbound.sendText local-image auto-convert", () => {
  beforeEach(() => {
    resetOutboundMocks();
  });

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

  it("uses structured cards for captions when renderMode=card", async () => {
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

    // sendOutboundText now uses sendStructuredCardFeishu (supports replyInThread + header)
    expect(sendStructuredCardFeishuMock).toHaveBeenCalledWith(
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
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
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
  const sendPayload = feishuOutbound.sendPayload!;

  beforeEach(() => {
    resetOutboundMocks();
  });

  it("sends interactive card when channelData.feishu.card is present", async () => {
    const card = { header: { title: "Test" }, elements: [{ tag: "div" }] };
    const result = await sendPayload({
      cfg: {} as any,
      to: "chat_1",
      text: "ignored text",
      accountId: "main",
      payload: {
        channelData: { feishu: { card } },
      },
    } as any);

    expect(sendCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        card,
        accountId: "main",
      }),
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({ channel: "feishu", messageId: "interactive_card_msg" }),
    );
  });

  it("sends text then media for mediaUrl payload", async () => {
    const result = await sendPayload({
      cfg: {} as any,
      to: "chat_1",
      text: "caption",
      accountId: "main",
      mediaLocalRoots: ["/sandbox"],
      payload: {
        mediaUrl: "https://example.com/image.png",
      },
    } as any);

    // Text sent first
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        text: "caption",
        accountId: "main",
      }),
    );
    // Then media with mediaLocalRoots passed through
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        mediaUrl: "https://example.com/image.png",
        accountId: "main",
        mediaLocalRoots: ["/sandbox"],
      }),
    );
    expect(result).toEqual(expect.objectContaining({ channel: "feishu", messageId: "media_msg" }));
  });

  it("falls back to url-only text if media send fails (no text duplication)", async () => {
    sendMediaFeishuMock.mockRejectedValueOnce(new Error("upload failed"));
    await sendPayload({
      cfg: {} as any,
      to: "chat_1",
      text: "caption",
      accountId: "main",
      payload: {
        mediaUrl: "https://example.com/image.png",
      },
    } as any);

    // Text was sent once as caption
    const textCalls = sendMessageFeishuMock.mock.calls;
    // First call: caption text, second call: fallback URL only (no duplicated caption)
    expect(textCalls).toHaveLength(2);
    expect(textCalls[0][0].text).toBe("caption");
    expect(textCalls[1][0].text).toBe("\u{1F4CE} https://example.com/image.png");
  });

  it("sends text-only payload when no media or card", async () => {
    const result = await sendPayload({
      cfg: {} as any,
      to: "chat_1",
      text: "hello world",
      accountId: "main",
      payload: {},
    } as any);

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        text: "hello world",
        accountId: "main",
      }),
    );
    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ channel: "feishu", messageId: "text_msg" }));
  });

  it("passes replyInThread to sendCardFeishu when threadId is set without replyToId", async () => {
    const card = { header: { title: "Thread Card" }, elements: [] };
    await sendPayload({
      cfg: {} as any,
      to: "chat_1",
      text: "",
      accountId: "main",
      threadId: "om_thread_1",
      payload: {
        channelData: { feishu: { card } },
      },
    } as any);

    expect(sendCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        card,
        replyToMessageId: "om_thread_1",
        replyInThread: true,
      }),
    );
  });

  it("does not set replyInThread when replyToId is present", async () => {
    const card = { header: { title: "Reply Card" }, elements: [] };
    await sendPayload({
      cfg: {} as any,
      to: "chat_1",
      text: "",
      accountId: "main",
      replyToId: "om_reply_1",
      threadId: "om_thread_1",
      payload: {
        channelData: { feishu: { card } },
      },
    } as any);

    expect(sendCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        card,
        replyToMessageId: "om_reply_1",
        replyInThread: false,
      }),
    );
  });

  it("handles multiple mediaUrls by sending each attachment", async () => {
    const result = await sendPayload({
      cfg: {} as any,
      to: "chat_1",
      text: "",
      accountId: "main",
      payload: {
        mediaUrls: ["https://example.com/image1.png", "https://example.com/image2.png"],
      },
    } as any);

    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(2);
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({ mediaUrl: "https://example.com/image1.png" }),
    );
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({ mediaUrl: "https://example.com/image2.png" }),
    );
    expect(result).toEqual(expect.objectContaining({ channel: "feishu", messageId: "media_msg" }));
  });

  it("passes identity header to sendStructuredCardFeishu in card mode text fallback", async () => {
    await sendPayload({
      cfg: {
        channels: { feishu: { renderMode: "card" } },
      } as any,
      to: "chat_1",
      text: "hello from agent",
      accountId: "main",
      identity: { name: "DailyBot", emoji: "📊" },
      payload: { channelData: {} },
    } as any);

    expect(sendStructuredCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        text: "hello from agent",
        header: expect.objectContaining({ title: "📊 DailyBot" }),
      }),
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("passes replyInThread to sendStructuredCardFeishu in card mode text fallback", async () => {
    await sendPayload({
      cfg: {
        channels: { feishu: { renderMode: "card" } },
      } as any,
      to: "chat_1",
      text: "hello",
      accountId: "main",
      threadId: "om_thread_1",
      payload: { channelData: {} },
    } as any);

    expect(sendStructuredCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        replyToMessageId: "om_thread_1",
        replyInThread: true,
      }),
    );
  });

  it("auto-uploads local image path text in sendPayload fallback", async () => {
    const { dir, file } = await createTmpImage();
    try {
      const result = await sendPayload({
        cfg: {} as any,
        to: "chat_1",
        text: file,
        accountId: "main",
        mediaLocalRoots: [dir],
        payload: { channelData: {} },
      } as any);

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

  it("short-circuits without sending when payload has no text, media, or card", async () => {
    const result = await sendPayload({
      cfg: {} as any,
      to: "chat_1",
      text: "",
      accountId: "main",
      payload: {},
    } as any);

    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ channel: "feishu", messageId: "" }));
  });

  it("prefers mediaUrls over legacy mediaUrl when both are present", async () => {
    await sendPayload({
      cfg: {} as any,
      to: "chat_1",
      text: "",
      accountId: "main",
      payload: {
        mediaUrl: "https://example.com/legacy.png",
        mediaUrls: ["https://example.com/new1.png", "https://example.com/new2.png"],
      },
    } as any);

    // Should send the two mediaUrls entries, not the legacy mediaUrl
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(2);
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({ mediaUrl: "https://example.com/new1.png" }),
    );
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({ mediaUrl: "https://example.com/new2.png" }),
    );
    expect(sendMediaFeishuMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ mediaUrl: "https://example.com/legacy.png" }),
    );
  });
});
