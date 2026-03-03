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

  it("formats agent-before-reply errors into two-line English summary plus technical details", async () => {
    await sendText({
      cfg: {} as any,
      to: "chat_1",
      text: "⚠️ Agent failed before reply: session file locked (timeout 10000ms): pid=123 /path.lock\nLogs: openclaw logs --follow",
      accountId: "main",
    });

    expect(sendMarkdownCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        text: "**Session file lock error. This is usually temporary; please wait a few minutes and resend your last message. If it keeps happening, ask the operator to check the OpenClaw logs.**\n```Technical details: ⚠️ Agent failed before reply: session file locked (timeout 10000ms): pid=123 /path.lock```",
        accountId: "main",
      }),
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("formats exec failures into two-line English summary plus technical details", async () => {
    await sendText({
      cfg: {} as any,
      to: "chat_1",
      text: "⚠️ 🛠️ Exec: vercel env add VITE_API_URL production 2>&1 << 'EOF' failed: Vercel CLI 50.23.2",
      accountId: "main",
    });

    expect(sendMarkdownCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        text: "**Command execution failed. This usually means the host command or environment is misconfigured; please verify the command locally or ask the operator to review the OpenClaw gateway configuration.**\n```Technical details: ⚠️ 🛠️ Exec: vercel env add VITE_API_URL production 2>&1 << 'EOF' failed: Vercel CLI 50.23.2```",
        accountId: "main",
      }),
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("formats other warning messages into generic two-line English summary plus technical details", async () => {
    await sendText({
      cfg: {} as any,
      to: "chat_1",
      text: "⚠️ Model run failed: internal error",
      accountId: "main",
    });

    expect(sendMarkdownCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        text: "**Something went wrong while handling your request. This is often temporary; please try again in a few minutes, and contact the operator or check the OpenClaw docs if it keeps happening.**\n```Technical details: ⚠️ Model run failed: internal error```",
        accountId: "main",
      }),
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("formats non-session-lock agent-before-reply errors with generic summary", async () => {
    await sendText({
      cfg: {} as any,
      to: "chat_1",
      text: "⚠️ Agent failed before reply: context window exceeded",
      accountId: "main",
    });

    expect(sendMarkdownCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        text: "**The agent failed before replying. This is often a transient issue; please retry your last message shortly. If the problem persists, contact the operator or check the OpenClaw troubleshooting docs.**\n```Technical details: ⚠️ Agent failed before reply: context window exceeded```",
        accountId: "main",
      }),
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
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
});
