import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  resolveAccount: vi.fn(),
  loadWebMedia: vi.fn(),
  fileCreate: vi.fn(),
  imageCreate: vi.fn(),
  messageCreate: vi.fn(),
  runFfmpeg: vi.fn(),
  runFfprobe: vi.fn(),
}));

vi.mock("./client.js", () => ({ createFeishuClient: mocks.createClient }));
vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: mocks.resolveAccount,
  resolveFeishuRuntimeAccount: mocks.resolveAccount,
}));
vi.mock("./targets.js", () => ({
  normalizeFeishuTarget: () => "ou_target",
  resolveReceiveIdType: () => "open_id",
}));
vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({ media: { loadWebMedia: mocks.loadWebMedia } }),
}));
vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>()),
  runFfmpeg: mocks.runFfmpeg,
  runFfprobe: mocks.runFfprobe,
}));

let sendMediaFeishu: typeof import("./media.js").sendMediaFeishu;
const emptyConfig: ClawdbotConfig = {};
const pngImage = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de",
  "hex",
);
const svgImage = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const avifImage = Buffer.from("00000018667479706176696600000000617669666d696631", "hex");
const heicImage = Buffer.from("00000018667479706865696300000000686569636d696631", "hex");
const tiffImage = Buffer.from("49492a000800000000000000", "hex");
const jpegImage = Buffer.from("ffd8ffe000104a46494600010100000100010000ffdb0043", "hex");
const icoImage = Buffer.from("00000100010010100000010020006804000016000000", "hex");

function resolvedAccount(mediaMaxMb?: number) {
  return {
    configured: true,
    accountId: "main",
    config: mediaMaxMb === undefined ? {} : { mediaMaxMb },
    appId: "app_id",
    appSecret: "app_secret",
    domain: "feishu",
  };
}

function sendMedia(options: Omit<Parameters<typeof sendMediaFeishu>[0], "cfg" | "to">) {
  return sendMediaFeishu({ cfg: emptyConfig, to: "user:ou_target", ...options });
}

function mockCallData(mock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  return (mock.mock.calls[0]?.[0] as { data?: Record<string, unknown> } | undefined)?.data ?? {};
}

describe("Feishu upload contracts", () => {
  beforeAll(async () => {
    ({ sendMediaFeishu } = await import("./media.js"));
  });

  afterAll(() => {
    for (const id of ["./client.js", "./accounts.js", "./targets.js", "./runtime.js"]) {
      vi.doUnmock(id);
    }
    vi.doUnmock("openclaw/plugin-sdk/media-runtime");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAccount.mockReturnValue(resolvedAccount());
    mocks.createClient.mockReturnValue({
      im: {
        file: { create: mocks.fileCreate },
        image: { create: mocks.imageCreate },
        message: { create: mocks.messageCreate, reply: vi.fn() },
      },
    });
    mocks.fileCreate.mockResolvedValue({ code: 0, data: { file_key: "file_1" } });
    mocks.imageCreate.mockResolvedValue({ code: 0, data: { image_key: "image_1" } });
    mocks.messageCreate.mockResolvedValue({ code: 0, data: { message_id: "message_1" } });
    mocks.runFfprobe.mockResolvedValue("1.25\n");
  });

  it.each([
    {
      label: "a voice-looking URL resolves to a PDF",
      mediaUrl: "https://example.com/download.ogg",
      fileName: "report.pdf",
      contentType: "application/pdf",
      buffer: Buffer.from("%PDF-1.7 document"),
      messageType: "file",
      degraded: true,
    },
    {
      label: "a voice-looking URL resolves to an image",
      mediaUrl: "https://example.com/download.opus",
      fileName: "photo.png",
      contentType: "image/png",
      buffer: pngImage,
      messageType: "image",
      degraded: true,
    },
    {
      label: "a voice-looking URL resolves to a video",
      mediaUrl: "https://example.com/download.ogg",
      fileName: "clip.mp4",
      contentType: "video/mp4",
      buffer: Buffer.from("video bytes"),
      messageType: "media",
      degraded: true,
    },
    {
      label: "actual native voice remains audio",
      mediaUrl: "https://example.com/download.ogg",
      fileName: "voice.ogg",
      contentType: "audio/ogg",
      buffer: Buffer.from("voice bytes"),
      messageType: "audio",
      degraded: false,
    },
    {
      label: "an ordinary PDF was never treated as voice",
      mediaUrl: "https://example.com/report.pdf",
      fileName: "report.pdf",
      contentType: "application/pdf",
      buffer: Buffer.from("%PDF-1.7 document"),
      messageType: "file",
      degraded: false,
    },
    {
      label: "explicit voice intent still reports a PDF degradation",
      mediaUrl: "https://example.com/report.pdf",
      fileName: "report.pdf",
      contentType: "application/pdf",
      buffer: Buffer.from("%PDF-1.7 document"),
      audioAsVoice: true,
      messageType: "file",
      degraded: true,
    },
  ])("reconciles voice visibility after loading when $label", async (media) => {
    mocks.loadWebMedia.mockResolvedValueOnce({
      buffer: media.buffer,
      fileName: media.fileName,
      contentType: media.contentType,
    });

    const result = await sendMedia({
      mediaUrl: media.mediaUrl,
      ...(media.audioAsVoice ? { audioAsVoice: true } : {}),
    });

    expect(mockCallData(mocks.messageCreate).msg_type).toBe(media.messageType);
    expect(result.voiceIntentDegradedToFile).toBe(media.degraded ? true : undefined);
  });

  it.each([
    { fileName: "diagram.png", contentType: "image/png", buffer: svgImage },
    { fileName: "photo.png", contentType: "image/png", buffer: avifImage },
    { fileName: "photo.heic", contentType: "image/heic", buffer: Buffer.from("heic image") },
  ])("sends unsupported image format $contentType as a file attachment", async (media) => {
    mocks.loadWebMedia.mockResolvedValueOnce({
      buffer: media.buffer,
      fileName: media.fileName,
      kind: "image",
      contentType: media.contentType,
    });

    await sendMedia({
      mediaUrl: `https://example.com/${media.fileName}`,
    });

    expect(mocks.imageCreate).not.toHaveBeenCalled();
    expect(mockCallData(mocks.fileCreate).file_type).toBe("stream");
    expect(mockCallData(mocks.messageCreate).msg_type).toBe("file");
  });

  it("uploads actual HEIC bytes despite a JPEG filename", async () => {
    mocks.loadWebMedia.mockResolvedValueOnce({
      buffer: heicImage,
      fileName: "photo.jpg",
      kind: "image",
      contentType: "image/heic",
    });
    await sendMedia({ mediaUrl: "https://example.com/photo.jpg" });
    expect(mocks.fileCreate).not.toHaveBeenCalled();
    expect(mocks.imageCreate).toHaveBeenCalledOnce();
    expect(mockCallData(mocks.messageCreate).msg_type).toBe("image");
  });

  it("recognizes supported TIFF bytes in a direct attachment", async () => {
    await sendMedia({ mediaBuffer: tiffImage, fileName: "scan.tif" });
    expect(mocks.imageCreate).toHaveBeenCalledOnce();
    expect(mockCallData(mocks.messageCreate).msg_type).toBe("image");
  });

  it.each([
    { fileName: "photo.bin", contentType: "image/jpg", buffer: jpegImage },
    { fileName: "icon.bin", contentType: "image/ico", buffer: icoImage },
    { fileName: "download", contentType: "application/octet-stream", buffer: pngImage },
  ])("routes supported image bytes with $contentType metadata natively", async (media) => {
    mocks.loadWebMedia.mockResolvedValueOnce({
      ...media,
      kind: "image",
    });

    await sendMedia({
      mediaUrl: `https://example.com/${media.fileName}`,
    });

    expect(mocks.fileCreate).not.toHaveBeenCalled();
    expect(mocks.imageCreate).toHaveBeenCalledOnce();
    expect(mockCallData(mocks.messageCreate).msg_type).toBe("image");
  });

  it("rejects images exceeding the platform image-upload limit before contacting Feishu", async () => {
    const oversizedImage = Buffer.alloc(10 * 1024 * 1024 + 1);
    pngImage.copy(oversizedImage);
    await expect(
      sendMedia({
        mediaBuffer: oversizedImage,
        fileName: "oversized.png",
      }),
    ).rejects.toThrow("Feishu image exceeds its 10485760-byte upload limit");

    expect(mocks.imageCreate).not.toHaveBeenCalled();
    expect(mocks.messageCreate).not.toHaveBeenCalled();
  });

  it("rejects files exceeding the configured attachment limit before contacting Feishu", async () => {
    mocks.resolveAccount.mockReturnValue(resolvedAccount(1 / (1024 * 1024)));

    await expect(
      sendMedia({
        mediaBuffer: Buffer.from("too large"),
        fileName: "notes.pdf",
      }),
    ).rejects.toThrow("Feishu file exceeds its 1-byte upload limit");

    expect(mocks.fileCreate).not.toHaveBeenCalled();
    expect(mocks.messageCreate).not.toHaveBeenCalled();
  });

  it("rejects oversized voice inputs before starting transcoding", async () => {
    mocks.resolveAccount.mockReturnValue(resolvedAccount(1 / (1024 * 1024)));

    await expect(
      sendMedia({
        mediaBuffer: Buffer.from("oversized audio"),
        fileName: "voice.mp3",
        audioAsVoice: true,
      }),
    ).rejects.toThrow("Feishu file exceeds its 1-byte upload limit");

    expect(mocks.runFfmpeg).not.toHaveBeenCalled();
    expect(mocks.fileCreate).not.toHaveBeenCalled();
  });

  it("retains accepted image visibility when its platform identifier is missing", async () => {
    mocks.messageCreate.mockResolvedValueOnce({ code: 0, data: {} });
    let caught: unknown;
    try {
      await sendMedia({ mediaBuffer: pngImage, fileName: "photo.png" });
    } catch (error) {
      caught = error;
    }
    expect(isChannelPartialDeliveryError(caught)).toBe(true);
    if (!(caught instanceof Error) || !isChannelPartialDeliveryError(caught)) {
      throw new Error("expected an accepted Feishu media delivery without an identity");
    }
    expect(caught.message).toBe("Feishu image send failed: no message_id returned");
    expect(caught.deliveryResult).toEqual({ messageIds: [], visibleReplySent: true });
    expect(mocks.messageCreate).toHaveBeenCalledOnce();
  });

  it("rejects empty image and file attachments before contacting Feishu", async () => {
    for (const fileName of ["empty.png", "empty.pdf"]) {
      await expect(
        sendMedia({
          mediaBuffer: Buffer.alloc(0),
          fileName,
        }),
      ).rejects.toThrow("Feishu attachments cannot be empty");
    }

    expect(mocks.imageCreate).not.toHaveBeenCalled();
    expect(mocks.fileCreate).not.toHaveBeenCalled();
  });
});
