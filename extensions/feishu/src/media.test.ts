import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../../../src/infra/tmp-openclaw-dir.js";

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

const getAudioDurationMsMock = vi.hoisted(() => vi.fn());

vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({
    media: {
      loadWebMedia: loadWebMediaMock,
      getAudioDurationMs: getAudioDurationMsMock,
    },
  }),
}));

import {
  downloadImageFeishu,
  downloadMessageResourceFeishu,
  sanitizeFileNameForUpload,
  sendMediaFeishu,
} from "./media.js";

function expectPathIsolatedToTmpRoot(pathValue: string, key: string): void {
  expect(pathValue).not.toContain(key);
  expect(pathValue).not.toContain("..");

  const tmpRoot = path.resolve(resolvePreferredOpenClawTmpDir());
  const resolved = path.resolve(pathValue);
  const rel = path.relative(tmpRoot, resolved);
  expect(rel === ".." || rel.startsWith(`..${path.sep}`)).toBe(false);
}

describe("sendMediaFeishu msg_type routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    getAudioDurationMsMock.mockResolvedValue(undefined);

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

  it("uses msg_type=file for mp4", async () => {
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
        data: expect.objectContaining({ msg_type: "file" }),
      }),
    );
  });

  it("uses msg_type=audio for opus", async () => {
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
        data: expect.objectContaining({ msg_type: "audio" }),
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

  it("uses msg_type=file when replying with mp4", async () => {
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
        data: expect.objectContaining({ msg_type: "file" }),
      }),
    );

    expect(messageCreateMock).not.toHaveBeenCalled();
  });

  it("passes reply_in_thread when replyInThread is true", async () => {
    await sendMediaFeishu({
      cfg: {} as any,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("video"),
      fileName: "reply.mp4",
      replyToMessageId: "om_parent",
      replyInThread: true,
    });

    expect(messageReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { message_id: "om_parent" },
        data: expect.objectContaining({ msg_type: "file", reply_in_thread: true }),
      }),
    );
  });

  it("omits reply_in_thread when replyInThread is false", async () => {
    await sendMediaFeishu({
      cfg: {} as any,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("video"),
      fileName: "reply.mp4",
      replyToMessageId: "om_parent",
      replyInThread: false,
    });

    const callData = messageReplyMock.mock.calls[0][0].data;
    expect(callData).not.toHaveProperty("reply_in_thread");
  });

  it("passes duration to uploadFileFeishu for local-path opus TTS audio (#33043)", async () => {
    getAudioDurationMsMock.mockResolvedValue(12345);
    loadWebMediaMock.mockResolvedValue({
      buffer: Buffer.from("opus-audio"),
      fileName: "tts.opus",
      kind: "audio",
      contentType: "audio/ogg",
    });

    await sendMediaFeishu({
      cfg: {} as any,
      to: "user:ou_target",
      mediaUrl: "/tmp/openclaw-tts/audio.opus",
    });

    expect(getAudioDurationMsMock).toHaveBeenCalledWith("/tmp/openclaw-tts/audio.opus");
    expect(fileCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ file_type: "opus", duration: 12345 }),
      }),
    );
  });

  it("omits duration when getAudioDurationMs returns undefined (ffprobe unavailable)", async () => {
    getAudioDurationMsMock.mockResolvedValue(undefined);
    loadWebMediaMock.mockResolvedValue({
      buffer: Buffer.from("opus-audio"),
      fileName: "tts.opus",
      kind: "audio",
      contentType: "audio/ogg",
    });

    await sendMediaFeishu({
      cfg: {} as any,
      to: "user:ou_target",
      mediaUrl: "/tmp/openclaw-tts/audio.opus",
    });

    const uploadCall = fileCreateMock.mock.calls[0][0];
    expect(uploadCall.data).not.toHaveProperty("duration");
  });

  it("does not probe duration for opus sent via mediaBuffer (no local path)", async () => {
    await sendMediaFeishu({
      cfg: {} as any,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("audio"),
      fileName: "voice.opus",
    });

    expect(getAudioDurationMsMock).not.toHaveBeenCalled();
  });

  it("probes duration when mediaUrl is a file:// URL pointing to opus (#33043 codex-p2)", async () => {
    getAudioDurationMsMock.mockResolvedValue(8000);
    loadWebMediaMock.mockResolvedValue({
      buffer: Buffer.from("opus-audio"),
      fileName: "tts.opus",
      kind: "audio",
      contentType: "audio/ogg",
    });

    await sendMediaFeishu({
      cfg: {} as any,
      to: "user:ou_target",
      mediaUrl: "file:///tmp/openclaw-tts/audio.opus",
    });

    // fileURLToPath("file:///tmp/openclaw-tts/audio.opus") === "/tmp/openclaw-tts/audio.opus"
    expect(getAudioDurationMsMock).toHaveBeenCalledWith("/tmp/openclaw-tts/audio.opus");
    expect(fileCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ file_type: "opus", duration: 8000 }),
      }),
    );
  });

  it("passes mediaLocalRoots as localRoots to loadWebMedia for local paths (#27884)", async () => {
    loadWebMediaMock.mockResolvedValue({
      buffer: Buffer.from("local-file"),
      fileName: "doc.pdf",
      kind: "document",
      contentType: "application/pdf",
    });

    const roots = ["/allowed/workspace", "/tmp/openclaw"];
    await sendMediaFeishu({
      cfg: {} as any,
      to: "user:ou_target",
      mediaUrl: "/allowed/workspace/file.pdf",
      mediaLocalRoots: roots,
    });

    expect(loadWebMediaMock).toHaveBeenCalledWith(
      "/allowed/workspace/file.pdf",
      expect.objectContaining({
        maxBytes: expect.any(Number),
        optimizeImages: false,
        localRoots: roots,
      }),
    );
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

  it("encodes Chinese filenames for file uploads", async () => {
    await sendMediaFeishu({
      cfg: {} as any,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("doc"),
      fileName: "测试文档.pdf",
    });

    const createCall = fileCreateMock.mock.calls[0][0];
    expect(createCall.data.file_name).not.toBe("测试文档.pdf");
    expect(createCall.data.file_name).toBe(encodeURIComponent("测试文档") + ".pdf");
  });

  it("preserves ASCII filenames unchanged for file uploads", async () => {
    await sendMediaFeishu({
      cfg: {} as any,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("doc"),
      fileName: "report-2026.pdf",
    });

    const createCall = fileCreateMock.mock.calls[0][0];
    expect(createCall.data.file_name).toBe("report-2026.pdf");
  });

  it("encodes special characters (em-dash, full-width brackets) in filenames", async () => {
    await sendMediaFeishu({
      cfg: {} as any,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("doc"),
      fileName: "报告—详情（2026）.md",
    });

    const createCall = fileCreateMock.mock.calls[0][0];
    expect(createCall.data.file_name).toMatch(/\.md$/);
    expect(createCall.data.file_name).not.toContain("—");
    expect(createCall.data.file_name).not.toContain("（");
  });
});

describe("sanitizeFileNameForUpload", () => {
  it("returns ASCII filenames unchanged", () => {
    expect(sanitizeFileNameForUpload("report.pdf")).toBe("report.pdf");
    expect(sanitizeFileNameForUpload("my-file_v2.txt")).toBe("my-file_v2.txt");
  });

  it("encodes Chinese characters in basename, preserves extension", () => {
    const result = sanitizeFileNameForUpload("测试文件.md");
    expect(result).toBe(encodeURIComponent("测试文件") + ".md");
    expect(result).toMatch(/\.md$/);
  });

  it("encodes em-dash and full-width brackets", () => {
    const result = sanitizeFileNameForUpload("文件—说明（v2）.pdf");
    expect(result).toMatch(/\.pdf$/);
    expect(result).not.toContain("—");
    expect(result).not.toContain("（");
    expect(result).not.toContain("）");
  });

  it("encodes single quotes and parentheses per RFC 5987", () => {
    const result = sanitizeFileNameForUpload("文件'(test).txt");
    expect(result).toContain("%27");
    expect(result).toContain("%28");
    expect(result).toContain("%29");
    expect(result).toMatch(/\.txt$/);
  });

  it("handles filenames without extension", () => {
    const result = sanitizeFileNameForUpload("测试文件");
    expect(result).toBe(encodeURIComponent("测试文件"));
  });

  it("handles mixed ASCII and non-ASCII", () => {
    const result = sanitizeFileNameForUpload("Report_报告_2026.xlsx");
    expect(result).toMatch(/\.xlsx$/);
    expect(result).not.toContain("报告");
  });

  it("encodes non-ASCII extensions", () => {
    const result = sanitizeFileNameForUpload("报告.文档");
    expect(result).toContain("%E6%96%87%E6%A1%A3");
    expect(result).not.toContain("文档");
  });

  it("encodes emoji filenames", () => {
    const result = sanitizeFileNameForUpload("report_😀.txt");
    expect(result).toContain("%F0%9F%98%80");
    expect(result).toMatch(/\.txt$/);
  });

  it("encodes mixed ASCII and non-ASCII extensions", () => {
    const result = sanitizeFileNameForUpload("notes_总结.v测试");
    expect(result).toContain("notes_");
    expect(result).toContain("%E6%B5%8B%E8%AF%95");
    expect(result).not.toContain("测试");
  });
});

describe("downloadMessageResourceFeishu", () => {
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

    createFeishuClientMock.mockReturnValue({
      im: {
        messageResource: {
          get: messageResourceGetMock,
        },
      },
    });

    messageResourceGetMock.mockResolvedValue(Buffer.from("fake-audio-data"));
  });

  // Regression: Feishu API only supports type=image|file for messageResource.get.
  // Audio/video resources must use type=file, not type=audio (#8746).
  it("forwards provided type=file for non-image resources", async () => {
    const result = await downloadMessageResourceFeishu({
      cfg: {} as any,
      messageId: "om_audio_msg",
      fileKey: "file_key_audio",
      type: "file",
    });

    expect(messageResourceGetMock).toHaveBeenCalledWith({
      path: { message_id: "om_audio_msg", file_key: "file_key_audio" },
      params: { type: "file" },
    });
    expect(result.buffer).toBeInstanceOf(Buffer);
  });

  it("image uses type=image", async () => {
    messageResourceGetMock.mockResolvedValue(Buffer.from("fake-image-data"));

    const result = await downloadMessageResourceFeishu({
      cfg: {} as any,
      messageId: "om_img_msg",
      fileKey: "img_key_1",
      type: "image",
    });

    expect(messageResourceGetMock).toHaveBeenCalledWith({
      path: { message_id: "om_img_msg", file_key: "img_key_1" },
      params: { type: "image" },
    });
    expect(result.buffer).toBeInstanceOf(Buffer);
  });
});
