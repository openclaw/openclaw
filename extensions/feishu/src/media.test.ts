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
const imageCreateMock = vi.hoisted(() => vi.fn());
const imageGetMock = vi.hoisted(() => vi.fn());
const messageCreateMock = vi.hoisted(() => vi.fn());
const messageResourceGetMock = vi.hoisted(() => vi.fn());
const messageReplyMock = vi.hoisted(() => vi.fn());

const FEISHU_MEDIA_HTTP_TIMEOUT_MS = 120_000;

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

import {
  detectFileType,
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

function expectMediaTimeoutClientConfigured(): void {
  expect(createFeishuClientMock).toHaveBeenCalledWith(
    expect.objectContaining({
      httpTimeoutMs: FEISHU_MEDIA_HTTP_TIMEOUT_MS,
    }),
  );
}

function mockResolvedFeishuAccount() {
  resolveFeishuAccountMock.mockReturnValue({
    configured: true,
    accountId: "main",
    config: {},
    appId: "app_id",
    appSecret: "app_secret",
    domain: "feishu",
  });
}

describe("sendMediaFeishu msg_type routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolvedFeishuAccount();

    normalizeFeishuTargetMock.mockReturnValue("ou_target");
    resolveReceiveIdTypeMock.mockReturnValue("open_id");

    createFeishuClientMock.mockReturnValue({
      im: {
        file: {
          create: fileCreateMock,
        },
        image: {
          create: imageCreateMock,
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
    imageCreateMock.mockResolvedValue({
      code: 0,
      data: { image_key: "image_key_1" },
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

  it("uses msg_type=media for mp4 video", async () => {
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

  it("configures the media client timeout for image uploads", async () => {
    await sendMediaFeishu({
      cfg: {} as any,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("image"),
      fileName: "photo.png",
    });

    expectMediaTimeoutClientConfigured();
    expect(messageCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ msg_type: "image" }),
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
        data: expect.objectContaining({
          msg_type: "media",
          reply_in_thread: true,
        }),
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

    expect(imageGetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { image_key: imageKey },
      }),
    );
    expectMediaTimeoutClientConfigured();
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

  it("preserves Chinese filenames for file uploads", async () => {
    await sendMediaFeishu({
      cfg: {} as any,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("doc"),
      fileName: "测试文档.pdf",
    });

    const createCall = fileCreateMock.mock.calls[0][0];
    expect(createCall.data.file_name).toBe("测试文档.pdf");
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

  it("preserves special Unicode characters (em-dash, full-width brackets) in filenames", async () => {
    await sendMediaFeishu({
      cfg: {} as any,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("doc"),
      fileName: "报告—详情（2026）.md",
    });

    const createCall = fileCreateMock.mock.calls[0][0];
    expect(createCall.data.file_name).toBe("报告—详情（2026）.md");
  });
});

describe("sanitizeFileNameForUpload", () => {
  it("returns ASCII filenames unchanged", () => {
    expect(sanitizeFileNameForUpload("report.pdf")).toBe("report.pdf");
    expect(sanitizeFileNameForUpload("my-file_v2.txt")).toBe("my-file_v2.txt");
  });

  it("preserves Chinese characters", () => {
    expect(sanitizeFileNameForUpload("测试文件.md")).toBe("测试文件.md");
    expect(sanitizeFileNameForUpload("武汉15座山登山信息汇总.csv")).toBe(
      "武汉15座山登山信息汇总.csv",
    );
  });

  it("preserves em-dash and full-width brackets", () => {
    expect(sanitizeFileNameForUpload("文件—说明（v2）.pdf")).toBe("文件—说明（v2）.pdf");
  });

  it("preserves single quotes and parentheses", () => {
    expect(sanitizeFileNameForUpload("文件'(test).txt")).toBe("文件'(test).txt");
  });

  it("preserves filenames without extension", () => {
    expect(sanitizeFileNameForUpload("测试文件")).toBe("测试文件");
  });

  it("preserves mixed ASCII and non-ASCII", () => {
    expect(sanitizeFileNameForUpload("Report_报告_2026.xlsx")).toBe("Report_报告_2026.xlsx");
  });

  it("preserves emoji filenames", () => {
    expect(sanitizeFileNameForUpload("report_😀.txt")).toBe("report_😀.txt");
  });

  it("strips control characters", () => {
    expect(sanitizeFileNameForUpload("bad\x00file.txt")).toBe("bad_file.txt");
    expect(sanitizeFileNameForUpload("inject\r\nheader.txt")).toBe("inject__header.txt");
  });

  it("strips quotes and backslashes to prevent header injection", () => {
    expect(sanitizeFileNameForUpload('file"name.txt')).toBe("file_name.txt");
    expect(sanitizeFileNameForUpload("file\\name.txt")).toBe("file_name.txt");
  });
});

describe("downloadMessageResourceFeishu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolvedFeishuAccount();

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

    expect(messageResourceGetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { message_id: "om_audio_msg", file_key: "file_key_audio" },
        params: { type: "file" },
      }),
    );
    expectMediaTimeoutClientConfigured();
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

    expect(messageResourceGetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { message_id: "om_img_msg", file_key: "img_key_1" },
        params: { type: "image" },
      }),
    );
    expectMediaTimeoutClientConfigured();
    expect(result.buffer).toBeInstanceOf(Buffer);
  });
});

describe("detectFileType", () => {
  it("detects opus audio files", () => {
    expect(detectFileType("voice.opus")).toBe("opus");
    expect(detectFileType("voice.ogg")).toBe("opus");
  });

  it("detects common audio formats as opus (Issue #37868)", () => {
    expect(detectFileType("voice.mp3")).toBe("opus");
    expect(detectFileType("voice.wav")).toBe("opus");
    expect(detectFileType("voice.m4a")).toBe("opus");
    expect(detectFileType("voice.aac")).toBe("opus");
    expect(detectFileType("voice.flac")).toBe("opus");
    expect(detectFileType("voice.wma")).toBe("opus");
  });

  it("detects video files as mp4", () => {
    expect(detectFileType("video.mp4")).toBe("mp4");
    expect(detectFileType("video.mov")).toBe("mp4");
    expect(detectFileType("video.avi")).toBe("mp4");
  });

  it("detects document files", () => {
    expect(detectFileType("document.pdf")).toBe("pdf");
    expect(detectFileType("document.doc")).toBe("doc");
    expect(detectFileType("document.docx")).toBe("doc");
    expect(detectFileType("spreadsheet.xls")).toBe("xls");
    expect(detectFileType("spreadsheet.xlsx")).toBe("xls");
    expect(detectFileType("presentation.ppt")).toBe("ppt");
    expect(detectFileType("presentation.pptx")).toBe("ppt");
  });

  it("falls back to stream for unknown extensions", () => {
    expect(detectFileType("file.zip")).toBe("stream");
    expect(detectFileType("file.txt")).toBe("stream");
    expect(detectFileType("file")).toBe("stream");
  });

  it("handles case-insensitive extensions", () => {
    expect(detectFileType("VOICE.MP3")).toBe("opus");
    expect(detectFileType("Video.MP4")).toBe("mp4");
    expect(detectFileType("DOC.PDF")).toBe("pdf");
  });
});

describe("sendMediaFeishu - audio edge cases", () => {
  const mockCfg = { feishu: { accounts: [] } } as any;
  
  beforeEach(() => {
    resolveFeishuAccountMock.mockReturnValue({
      configured: true,
      accountId: "default",
      config: { mediaMaxMb: 30 },
    });
    createFeishuClientMock.mockReturnValue({
      im: {
        file: { create: fileCreateMock },
        image: { create: imageCreateMock },
        message: { create: messageCreateMock },
      },
    });
    fileCreateMock.mockResolvedValue({
      code: 0,
      data: { file_key: "file_abc123" },
    });
    messageCreateMock.mockResolvedValue({
      code: 0,
      data: { message_id: "om_test" },
    });
  });

  it("warns when mediaBuffer lacks fileName extension (audio detection fails)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const audioBuffer = Buffer.from("fake-mp3-data");

    await sendMediaFeishu({
      cfg: mockCfg,
      to: "user@example.com",
      mediaBuffer: audioBuffer,
      fileName: undefined, // No extension → can't detect as audio
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("mediaBuffer provided without fileName extension")
    );
    
    // Verify it was sent as generic "file" type (not "audio")
    expect(messageCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          msg_type: "file", // Not "audio" because no extension
        }),
      })
    );

    warnSpy.mockRestore();
  });

  it("detects audio format correctly when fileName is provided", async () => {
    const audioBuffer = Buffer.from("fake-mp3-data");

    await sendMediaFeishu({
      cfg: mockCfg,
      to: "user@example.com",
      mediaBuffer: audioBuffer,
      fileName: "voice.mp3", // Extension provided → detected as audio
    });

    // Verify it was sent as "audio" type
    expect(messageCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          msg_type: "audio", // Correct audio type
        }),
      })
    );
  });

  it("handles empty mediaBuffer gracefully", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const emptyBuffer = Buffer.from("");

    await sendMediaFeishu({
      cfg: mockCfg,
      to: "user@example.com",
      mediaBuffer: emptyBuffer,
      fileName: undefined,
    });

    // No warning for empty buffer (mediaBuffer.length === 0)
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
