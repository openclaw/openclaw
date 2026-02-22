import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createFeishuClientMock = vi.hoisted(() => vi.fn());
const resolveFeishuAccountMock = vi.hoisted(() => vi.fn());
const normalizeFeishuTargetMock = vi.hoisted(() => vi.fn());
const resolveReceiveIdTypeMock = vi.hoisted(() => vi.fn());
const loadWebMediaMock = vi.hoisted(() => vi.fn());

const fileCreateMock = vi.hoisted(() => vi.fn());
const imageGetMock = vi.hoisted(() => vi.fn());
const messageCreateMock = vi.hoisted(() => vi.fn());
const messageResourceGetMock = vi.hoisted(() => vi.fn());
const messageReplyMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: resolveFeishuAccountMock,
}));

vi.mock("./targets.js", () => ({
  normalizeFeishuTarget: normalizeFeishuTargetMock,
  resolveReceiveIdType: resolveReceiveIdTypeMock,
}));

vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({
    media: {
      loadWebMedia: loadWebMediaMock,
    },
  }),
}));

import { downloadImageFeishu, downloadMessageResourceFeishu, sendMediaFeishu } from "./media.js";

function expectPathIsolatedToTmpRoot(pathValue: string, key: string): void {
  expect(pathValue).not.toContain(key);
  expect(pathValue).not.toContain("..");

  const tmpRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(pathValue);
  const rel = path.relative(tmpRoot, resolved);
  expect(rel === ".." || rel.startsWith(`..${path.sep}`)).toBe(false);
}

describe("sendMediaFeishu msg_type routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    resolveFeishuAccountMock.mockReturnValue({
      configured: true,
      accountId: "main",
      config: {},
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
    });

    normalizeFeishuTargetMock.mockReturnValue("ou_target");
    resolveReceiveIdTypeMock.mockReturnValue("open_id");

    createFeishuClientMock.mockReturnValue({
      im: {
        file: {
          create: fileCreateMock,
        },
        image: {
          get: imageGetMock,
        },
        message: {
          create: messageCreateMock,
          reply: messageReplyMock,
        },
        messageResource: {
          get: messageResourceGetMock,
        },
      },
    });

    fileCreateMock.mockResolvedValue({
      code: 0,
      data: { file_key: "file_key_1" },
    });

    messageCreateMock.mockResolvedValue({
      code: 0,
      data: { message_id: "msg_1" },
    });

    messageReplyMock.mockResolvedValue({
      code: 0,
      data: { message_id: "reply_1" },
    });

    loadWebMediaMock.mockResolvedValue({
      buffer: Buffer.from("remote-audio"),
      fileName: "remote.opus",
      kind: "audio",
      contentType: "audio/ogg",
    });

    imageGetMock.mockResolvedValue(Buffer.from("image-bytes"));
    messageResourceGetMock.mockResolvedValue(Buffer.from("resource-bytes"));
  });

  it("uses msg_type=media for mp4", async () => {
    await sendMediaFeishu({
      cfg: {} as any,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("video"),
      fileName: "clip.mp4",
    });

    expect(fileCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ file_type: "mp4" }),
      }),
    );

    expect(messageCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ msg_type: "media" }),
      }),
    );
  });

  it("uses msg_type=media for opus", async () => {
    await sendMediaFeishu({
      cfg: {} as any,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("audio"),
      fileName: "voice.opus",
    });

    expect(fileCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ file_type: "opus" }),
      }),
    );

    expect(messageCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ msg_type: "media" }),
      }),
    );
  });

  it("uses msg_type=file for documents", async () => {
    await sendMediaFeishu({
      cfg: {} as any,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("doc"),
      fileName: "paper.pdf",
    });

    expect(fileCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ file_type: "pdf" }),
      }),
    );

    expect(messageCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ msg_type: "file" }),
      }),
    );
  });

  it("uses msg_type=media when replying with mp4", async () => {
    await sendMediaFeishu({
      cfg: {} as any,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("video"),
      fileName: "reply.mp4",
      replyToMessageId: "om_parent",
    });

    expect(messageReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { message_id: "om_parent" },
        data: expect.objectContaining({ msg_type: "media" }),
      }),
    );

    expect(messageCreateMock).not.toHaveBeenCalled();
  });

  it("fails closed when media URL fetch is blocked", async () => {
    loadWebMediaMock.mockRejectedValueOnce(
      new Error("Blocked: resolves to private/internal IP address"),
    );

    await expect(
      sendMediaFeishu({
        cfg: {} as any,
        to: "user:ou_target",
        mediaUrl: "https://x/img",
        fileName: "voice.opus",
      }),
    ).rejects.toThrow(/private\/internal/i);

    expect(fileCreateMock).not.toHaveBeenCalled();
    expect(messageCreateMock).not.toHaveBeenCalled();
    expect(messageReplyMock).not.toHaveBeenCalled();
  });

  it("uses isolated temp paths for image downloads", async () => {
    const imageKey = "img_v3_01abc123";
    let capturedPath: string | undefined;

    imageGetMock.mockResolvedValueOnce({
      writeFile: async (tmpPath: string) => {
        capturedPath = tmpPath;
        await fs.writeFile(tmpPath, Buffer.from("image-data"));
      },
    });

    const result = await downloadImageFeishu({
      cfg: {} as any,
      imageKey,
    });

    expect(result.buffer).toEqual(Buffer.from("image-data"));
    expect(capturedPath).toBeDefined();
    expectPathIsolatedToTmpRoot(capturedPath as string, imageKey);
  });

  it("uses isolated temp paths for message resource downloads", async () => {
    const fileKey = "file_v3_01abc123";
    let capturedPath: string | undefined;

    messageResourceGetMock.mockResolvedValueOnce({
      writeFile: async (tmpPath: string) => {
        capturedPath = tmpPath;
        await fs.writeFile(tmpPath, Buffer.from("resource-data"));
      },
    });

    const result = await downloadMessageResourceFeishu({
      cfg: {} as any,
      messageId: "om_123",
      fileKey,
      type: "image",
    });

    expect(result.buffer).toEqual(Buffer.from("resource-data"));
    expect(capturedPath).toBeDefined();
    expectPathIsolatedToTmpRoot(capturedPath as string, fileKey);
  });

  it("rejects invalid image keys before calling feishu api", async () => {
    await expect(
      downloadImageFeishu({
        cfg: {} as any,
        imageKey: "a/../../bad",
      }),
    ).rejects.toThrow("invalid image_key");

    expect(imageGetMock).not.toHaveBeenCalled();
  });

  it("rejects invalid file keys before calling feishu api", async () => {
    await expect(
      downloadMessageResourceFeishu({
        cfg: {} as any,
        messageId: "om_123",
        fileKey: "x/../../bad",
        type: "file",
      }),
    ).rejects.toThrow("invalid file_key");

    expect(messageResourceGetMock).not.toHaveBeenCalled();
  });
});
