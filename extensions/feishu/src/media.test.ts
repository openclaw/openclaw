import { Readable } from "node:stream";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS,
  type runFfprobe,
  type transcodeAudioBufferToOpus,
} from "openclaw/plugin-sdk/media-runtime";
import { withEnvAsync, withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import {
  saveMessageResourceFeishu,
  sendMediaFeishu,
  shouldSuppressFeishuTextForVoiceMedia,
} from "./media.js";

type FileUploadData = {
  file: Buffer;
  file_name: string;
  file_type: string;
  duration?: number;
};
type MessageData = { msg_type: string; content: string; receive_id: string };
type ResourceRequest = { params: { type: string }; path: { file_key: string; message_id: string } };

const createFeishuClientMock = vi.hoisted(() => vi.fn());
const resolveFeishuAccountMock = vi.hoisted(() => vi.fn());
const normalizeFeishuTargetMock = vi.hoisted(() => vi.fn());
const resolveReceiveIdTypeMock = vi.hoisted(() => vi.fn());
const loadWebMediaMock = vi.hoisted(() =>
  vi.fn<(url: string, options: { localRoots?: readonly string[] }) => Promise<unknown>>(),
);
const transcodeAudioMock = vi.hoisted(() => vi.fn<typeof transcodeAudioBufferToOpus>());
const runFfprobeMock = vi.hoisted(() => vi.fn<typeof runFfprobe>());

const fileCreateMock = vi.hoisted(() =>
  vi.fn<(request: { data: FileUploadData }) => Promise<unknown>>(),
);
const imageCreateMock = vi.hoisted(() => vi.fn());
const messageCreateMock = vi.hoisted(() =>
  vi.fn<(request: { data: MessageData }) => Promise<unknown>>(),
);
const messageResourceGetMock = vi.hoisted(() =>
  vi.fn<(request: ResourceRequest) => Promise<unknown>>(),
);
const messageReplyMock = vi.hoisted(() =>
  vi.fn<
    (request: {
      path: { message_id: string };
      data: { msg_type: string; content: string; reply_in_thread?: boolean };
    }) => Promise<unknown>
  >(),
);

const FEISHU_MEDIA_HTTP_TIMEOUT_MS = 120_000;
const emptyConfig: ClawdbotConfig = {};
const validPngImage = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de",
  "hex",
);
const account = {
  configured: true,
  accountId: "main",
  config: {},
  appId: "app_id",
  appSecret: "app_secret",
  domain: "feishu",
};

vi.mock("./client.js", () => ({ createFeishuClient: createFeishuClientMock }));

vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: resolveFeishuAccountMock,
  resolveFeishuRuntimeAccount: resolveFeishuAccountMock,
}));

vi.mock("./targets.js", () => ({
  normalizeFeishuTarget: normalizeFeishuTargetMock,
  resolveReceiveIdType: resolveReceiveIdTypeMock,
}));

vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({ media: { loadWebMedia: loadWebMediaMock } }),
}));

vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>();
  return { ...actual, transcodeAudioBufferToOpus: transcodeAudioMock, runFfprobe: runFfprobeMock };
});

function sendMedia(options: Omit<Parameters<typeof sendMediaFeishu>[0], "cfg" | "to">) {
  return sendMediaFeishu({ cfg: emptyConfig, to: "user:ou_target", ...options });
}

const webMedia = (fileName: string, contentType: string, bytes: string) => ({
  buffer: Buffer.from(bytes),
  fileName,
  contentType,
});
const mp3Media = webMedia("reply.mp3", "audio/mpeg", "remote-mp3");
const uploadData = () => mockCallArgs(fileCreateMock)[0].data;
const messageData = () => mockCallArgs(messageCreateMock)[0].data;
const resourceRequest = (callIndex: number) => mockCallArgs(messageResourceGetMock, callIndex)[0];
const resourceResponse = (data: string | Buffer[], headers?: Record<string, string>) => ({
  getReadableStream: () => Readable.from(typeof data === "string" ? [Buffer.from(data)] : data),
  headers,
});

function mockCallArgs<T extends unknown[]>(mock: { mock: { calls: T[] } }, callIndex = 0): T {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call;
}

function expectMediaLoad(url: string, localRoots: readonly string[], extra = {}) {
  const [loadedUrl, options] = mockCallArgs(loadWebMediaMock);
  expect(loadedUrl).toBe(url);
  expect(options).toEqual({
    maxBytes: expect.any(Number),
    optimizeImages: false,
    localRoots,
    ...extra,
  });
  expect(options.localRoots).toBe(localRoots);
}

async function withIsolatedHome<T>(run: () => Promise<T>): Promise<T> {
  return withTempDir("openclaw-feishu-media-", (tempHome) => withEnvAsync({ HOME: tempHome }, run));
}

function downloadResource(
  options: Partial<Omit<Parameters<typeof saveMessageResourceFeishu>[0], "cfg">> = {},
) {
  return withIsolatedHome(() =>
    saveMessageResourceFeishu({
      cfg: emptyConfig,
      maxBytes: 1024,
      messageId: "om_123",
      fileKey: "file_v3_01abc123",
      type: "file",
      ...options,
    }),
  );
}

afterAll(() => {
  for (const id of [
    "./client.js",
    "./accounts.js",
    "./targets.js",
    "./runtime.js",
    "openclaw/plugin-sdk/media-runtime",
  ]) {
    vi.doUnmock(id);
  }
  vi.resetModules();
});

beforeEach(() => {
  vi.clearAllMocks();
  resolveFeishuAccountMock.mockReturnValue(account);
  createFeishuClientMock.mockReturnValue({
    im: { messageResource: { get: messageResourceGetMock } },
  });
  messageResourceGetMock.mockImplementation(async () => resourceResponse("fake-audio-data"));
});

describe("sendMediaFeishu msg_type routing", () => {
  beforeEach(() => {
    normalizeFeishuTargetMock.mockReturnValue("ou_target");
    resolveReceiveIdTypeMock.mockReturnValue("open_id");

    createFeishuClientMock.mockReturnValue({
      im: {
        file: { create: fileCreateMock },
        image: { create: imageCreateMock },
        message: { create: messageCreateMock, reply: messageReplyMock },
        messageResource: { get: messageResourceGetMock },
      },
    });

    fileCreateMock.mockResolvedValue({ code: 0, data: { file_key: "file_key_1" } });
    imageCreateMock.mockResolvedValue({ code: 0, data: { image_key: "image_key_1" } });
    messageCreateMock.mockResolvedValue({ code: 0, data: { message_id: "msg_1" } });
    messageReplyMock.mockResolvedValue({ code: 0, data: { message_id: "reply_1" } });

    loadWebMediaMock.mockResolvedValue(webMedia("remote.opus", "audio/ogg", "remote-audio"));

    messageResourceGetMock.mockImplementation(async () => resourceResponse("resource-bytes"));
    transcodeAudioMock.mockResolvedValue(Buffer.from("opus-output"));
    runFfprobeMock.mockResolvedValue("1.234\n");
  });

  it.each([
    ["report.pdf", "application/pdf", Buffer.from("%PDF-1.7 document"), true],
    [
      "diagram.png",
      "image/png",
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
      false,
    ],
  ] as const)(
    "sends %s as a file despite voice intent or image metadata",
    async (fileName, contentType, buffer, audioAsVoice) => {
      loadWebMediaMock.mockResolvedValueOnce({ buffer, fileName, contentType });
      const result = await sendMedia({ mediaUrl: `https://example.com/${fileName}`, audioAsVoice });
      expect(imageCreateMock).not.toHaveBeenCalled();
      expect(uploadData().file_type).toBe(audioAsVoice ? "pdf" : "stream");
      expect(messageData()).toMatchObject({ msg_type: "file" });
      expect(result.voiceIntentDegradedToFile).toBe(audioAsVoice ? true : undefined);
    },
  );

  it("rejects images exceeding the platform image-upload limit before contacting Feishu", async () => {
    const oversizedImage = Buffer.alloc(10 * 1024 * 1024 + 1);
    validPngImage.copy(oversizedImage);
    await expect(
      sendMedia({ mediaBuffer: oversizedImage, fileName: "oversized.png" }),
    ).rejects.toThrow("Feishu image exceeds its 10485760-byte upload limit");
    expect(imageCreateMock).not.toHaveBeenCalled();
    expect(messageCreateMock).not.toHaveBeenCalled();
  });

  it("rejects oversized voice inputs before starting transcoding", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      ...account,
      config: { mediaMaxMb: 1 / (1024 * 1024) },
    });
    await expect(
      sendMedia({
        mediaBuffer: Buffer.from("oversized audio"),
        fileName: "voice.mp3",
        audioAsVoice: true,
      }),
    ).rejects.toThrow("Feishu file exceeds its 1-byte upload limit");
    expect(transcodeAudioMock).not.toHaveBeenCalled();
    expect(fileCreateMock).not.toHaveBeenCalled();
  });

  it("retains accepted image visibility when its platform identifier is missing", async () => {
    messageCreateMock.mockResolvedValueOnce({ code: 0, data: {} });
    const caught = await sendMedia({
      mediaBuffer: Buffer.from("49492a000800000000000000", "hex"),
      fileName: "scan.tif",
    }).catch((error: unknown) => error);
    expect(isChannelPartialDeliveryError(caught)).toBe(true);
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toHaveProperty("message", "Feishu image send failed: no message_id returned");
    expect(caught).toHaveProperty("deliveryResult", { messageIds: [], visibleReplySent: true });
    expect(messageCreateMock).toHaveBeenCalledOnce();
  });

  it("rejects empty image and file attachments before contacting Feishu", async () => {
    for (const fileName of ["empty.png", "empty.pdf"]) {
      await expect(sendMedia({ mediaBuffer: Buffer.alloc(0), fileName })).rejects.toThrow(
        "Feishu attachments cannot be empty",
      );
    }
    expect(imageCreateMock).not.toHaveBeenCalled();
    expect(fileCreateMock).not.toHaveBeenCalled();
  });
  it("respects ttsSupplement.visibleTextAlreadyDelivered over audioAsVoice", () => {
    for (const visibleTextAlreadyDelivered of [undefined, true]) {
      expect(
        shouldSuppressFeishuTextForVoiceMedia({
          mediaUrl: "https://example.com/tts.mp3",
          audioAsVoice: true,
          ttsSupplement: { spokenText: "Hello world", visibleTextAlreadyDelivered },
        }),
      ).toBe(visibleTextAlreadyDelivered === true);
    }
  });

  it("omits audio duration when probing fails", async () => {
    runFfprobeMock.mockRejectedValueOnce(new Error("ffprobe missing"));

    await sendMedia({ mediaBuffer: Buffer.from("opus"), fileName: "reply.ogg" });

    expect(transcodeAudioMock).not.toHaveBeenCalled();
    expect(uploadData()).not.toHaveProperty("duration");
    expect(JSON.parse(messageData().content ?? "{}")).toEqual({ file_key: "file_key_1" });
  });

  it("uses msg_type=media for remote mp4 content even when the filename is generic", async () => {
    runFfprobeMock.mockResolvedValueOnce("6.789\n");
    loadWebMediaMock.mockResolvedValueOnce(webMedia("download", "video/mp4", "remote-video"));

    await sendMedia({ mediaUrl: "https://example.com/video" });

    expect(uploadData()).toMatchObject({ file_type: "mp4", duration: 6789 });
    expect(mockCallArgs(runFfprobeMock)[0].at(-1)).toMatch(/input\.mp4$/);
    expect(messageData().msg_type).toBe("media");
  });

  it.each(["transcodes", "falls back"])("%s voice-intent mp3", async (outcome) => {
    const degraded = outcome === "falls back";
    const warnSpy = degraded
      ? vi.spyOn(console, "warn").mockImplementation(() => undefined)
      : undefined;
    loadWebMediaMock.mockResolvedValueOnce(mp3Media);
    try {
      if (degraded) {
        transcodeAudioMock.mockRejectedValueOnce(new Error("ffmpeg missing"));
      }
      const result = await sendMedia({
        mediaUrl: "https://example.com/reply.mp3",
        audioAsVoice: true,
      });
      expect(uploadData()).toMatchObject({
        file_type: degraded ? "stream" : "opus",
        file_name: degraded ? "reply.mp3" : "voice.ogg",
      });
      expect(uploadData().file).toEqual(Buffer.from(degraded ? "remote-mp3" : "opus-output"));
      expect(messageData().msg_type).toBe(degraded ? "file" : "audio");
      if (warnSpy) {
        expect(result.voiceIntentDegradedToFile).toBe(true);
        expect(mockCallArgs(warnSpy)[0]).toContain("audioAsVoice transcode failed");
        expect(mockCallArgs(warnSpy)[1]).toBeInstanceOf(Error);
      } else {
        expect(transcodeAudioMock).toHaveBeenCalledExactlyOnceWith({
          audioBuffer: Buffer.from("remote-mp3"),
          inputFileName: "reply.mp3",
          tempPrefix: "feishu-voice-",
          outputFileName: "voice.ogg",
          sampleRateHz: 48_000,
          bitrate: "64k",
          channels: 1,
          maxDurationSeconds: MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS,
        });
      }
    } finally {
      warnSpy?.mockRestore();
    }
  });

  it("preserves Feishu diagnostics when media sends reject before response checks", async () => {
    messageCreateMock.mockRejectedValueOnce(
      Object.assign(new Error("Request failed with status code 400"), {
        response: {
          status: 400,
          data: {
            code: 9499,
            msg: "Bad Request",
            error: {
              log_id: "20260429124731MEDIA",
              troubleshooter: "https://open.feishu.cn/search?log_id=20260429124731MEDIA",
            },
          },
        },
      }),
    );

    const send = sendMedia({ mediaBuffer: validPngImage, fileName: "photo.png" });

    await expect(send).rejects.toThrow(/Feishu image send failed: .*"feishu_code":9499/);
    await expect(send).rejects.toThrow(/"feishu_log_id":"20260429124731MEDIA"/);
  });

  it("passes reply_in_thread when replyInThread is true", async () => {
    await sendMedia({
      mediaBuffer: Buffer.from("video"),
      fileName: "reply.mp4",
      replyToMessageId: "om_parent",
      replyInThread: true,
    });

    const [{ path, data }] = mockCallArgs(messageReplyMock);
    expect(path).toEqual({ message_id: "om_parent" });
    expect(data).toMatchObject({ msg_type: "media", reply_in_thread: true });
  });

  it("falls back to top-level image sends for withdrawn reply targets", async () => {
    messageReplyMock.mockResolvedValueOnce({ code: 230011, msg: "The message was withdrawn." });
    messageCreateMock.mockResolvedValueOnce({
      code: 0,
      data: { message_id: "msg_image_fallback" },
    });

    const result = await sendMedia({
      mediaBuffer: validPngImage,
      fileName: "photo.png",
      replyToMessageId: "om_parent",
    });

    expect(result.messageId).toBe("msg_image_fallback");
    expect(messageCreateMock).toHaveBeenCalledTimes(1);
    expect(messageData()).toMatchObject({ msg_type: "image", receive_id: "ou_target" });
  });

  it("passes mediaLocalRoots as localRoots to loadWebMedia for local paths (#27884)", async () => {
    loadWebMediaMock.mockResolvedValue(
      webMedia("报告—详情（2026）.pdf", "application/pdf", "local-file"),
    );

    const roots = ["/allowed/workspace", "/tmp/openclaw"];
    await sendMedia({ mediaUrl: "/allowed/workspace/file.pdf", mediaLocalRoots: roots });

    expectMediaLoad("/allowed/workspace/file.pdf", roots);
    expect(uploadData().file_name).toBe("报告—详情（2026）.pdf");
  });

  it("keeps approved workspace access authoritative over legacy access", async () => {
    const readFile = vi.fn(async () => Buffer.from("approved image"));
    const legacyReadFile = vi.fn(async () => Buffer.from("legacy image"));
    const localRoots = ["/approved/workspace"];
    const mediaAccess = { localRoots, workspaceDir: "/approved/workspace", readFile };
    await sendMedia({
      mediaUrl: "chart.png",
      mediaAccess,
      mediaLocalRoots: ["/legacy/workspace"],
      mediaReadFile: legacyReadFile,
    });
    expectMediaLoad("chart.png", localRoots, {
      readFile,
      hostReadCapability: true,
      workspaceDir: "/approved/workspace",
    });
  });

  it("rejects host readers without approved roots before any media dispatch", async () => {
    const readFile = vi.fn(async () => Buffer.from("unapproved image"));
    await expect(
      sendMedia({
        mediaUrl: "chart.png",
        mediaAccess: { readFile, workspaceDir: "/unapproved/workspace" },
      }),
    ).rejects.toThrow("Host media read requires explicit localRoots");
    expect(loadWebMediaMock).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(fileCreateMock).not.toHaveBeenCalled();
    expect(imageCreateMock).not.toHaveBeenCalled();
    expect(messageCreateMock).not.toHaveBeenCalled();
  });

  it("fails closed when media URL fetch is blocked", async () => {
    loadWebMediaMock.mockRejectedValueOnce(
      new Error("Blocked: resolves to private/internal IP address"),
    );

    await expect(sendMedia({ mediaUrl: "https://x/img", fileName: "voice.opus" })).rejects.toThrow(
      /private\/internal/i,
    );

    for (const mock of [fileCreateMock, messageCreateMock, messageReplyMock]) {
      expect(mock).not.toHaveBeenCalled();
    }
  });

  it("rejects oversized message resource streams before saving the rest", async () => {
    messageResourceGetMock.mockResolvedValueOnce(
      resourceResponse([Buffer.alloc(4), Buffer.alloc(4)]),
    );
    await expect(downloadResource({ maxBytes: 7 })).rejects.toThrow(/Media exceeds/i);
  });

  it("rejects invalid file keys before calling feishu api", async () => {
    await expect(
      downloadResource({ fileKey: "x/../../bad", maxBytes: 30 * 1024 * 1024 }),
    ).rejects.toThrow("invalid file_key");

    expect(messageResourceGetMock).not.toHaveBeenCalled();
  });
});

describe("saveMessageResourceFeishu", () => {
  const httpStatusError = (status: number) =>
    Object.assign(new Error(`Request failed with status code ${status}`), {
      response: { status },
    });

  it("retries file resources as media after HTTP 502", async () => {
    const originalError = httpStatusError(502);
    messageResourceGetMock.mockRejectedValueOnce(originalError).mockResolvedValueOnce(
      resourceResponse("fake-ios-video-data", {
        "content-type": "video/mp4",
        "content-disposition": `attachment; filename="ios-video.mp4"`,
      }),
    );

    const result = await downloadResource();

    for (const [index, type] of ["file", "media"].entries()) {
      expect(resourceRequest(index)).toEqual({
        path: { message_id: "om_123", file_key: "file_v3_01abc123" },
        params: { type },
      });
    }
    expect(result).toMatchObject({
      size: "fake-ios-video-data".length,
      contentType: "video/mp4",
      id: expect.stringMatching(/^ios-video---[a-f0-9-]{36}\.mp4$/),
    });
  });

  it("rethrows the original HTTP 502 when the media retry fails", async () => {
    const originalError = httpStatusError(502);
    messageResourceGetMock
      .mockRejectedValueOnce(originalError)
      .mockRejectedValueOnce(new Error("media retry failed"));

    await expect(downloadResource()).rejects.toBe(originalError);

    expect(resourceRequest(0).params).toEqual({ type: "file" });
    expect(resourceRequest(1).params).toEqual({ type: "media" });
  });

  it.each(["header", "payload"])(
    "recovers Latin-1-decoded CJK filenames from %s",
    async (source) => {
      const fileName = "武汉15座山登山信息汇总.csv";
      const latin1 = Buffer.from(fileName, "utf8").toString("latin1");
      messageResourceGetMock.mockResolvedValueOnce(
        resourceResponse(
          "a,b\n1,2\n",
          source === "header"
            ? { "content-disposition": `attachment; filename="${latin1}"` }
            : { "content-type": "text/csv" },
        ),
      );
      const result = await downloadResource(
        source === "payload" ? { originalFilename: latin1 } : {},
      );
      expect(result.id).toMatch(/^武汉15座山登山信息汇总---[a-f0-9-]{36}\.csv$/);
    },
  );

  it("keeps the shipped 120-second media timeout for stalled stream bodies", async () => {
    vi.useFakeTimers();
    try {
      await withIsolatedHome(async () => {
        const { promise: readStarted, resolve: markReadStarted } = createDeferred<void>();
        const stalled = new Readable({
          read() {
            markReadStarted();
          },
        });
        messageResourceGetMock.mockResolvedValueOnce({
          getReadableStream: () => stalled,
          headers: { "content-type": "image/jpeg" },
        });

        let settled = false;
        const download = saveMessageResourceFeishu({
          cfg: emptyConfig,
          messageId: "om_stalled_stream",
          fileKey: "img_key_stalled",
          type: "image",
          maxBytes: 1024,
        });
        const markSettled = () => {
          settled = true;
        };
        const downloadSettled = download.then(markSettled, markSettled);

        try {
          await Promise.race([readStarted, download]);
          await vi.advanceTimersByTimeAsync(FEISHU_MEDIA_HTTP_TIMEOUT_MS - 1);
          expect(settled).toBe(false);
          await vi.advanceTimersByTimeAsync(1);
          await expect(download).rejects.toMatchObject({
            name: "FeishuInboundMediaTimeoutError",
            message: `Feishu media download stalled: no data received for ${FEISHU_MEDIA_HTTP_TIMEOUT_MS}ms`,
          });
          expect(stalled.destroyed).toBe(true);
        } finally {
          // Join the writer before its HOME and directory owners are released on assertion failure.
          stalled.destroy();
          await downloadSettled;
        }
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
