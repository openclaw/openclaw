// Feishu tests cover media plugin behavior.
import fs from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());
const resolveFeishuAccountMock = vi.hoisted(() => vi.fn());
const normalizeFeishuTargetMock = vi.hoisted(() => vi.fn());
const resolveReceiveIdTypeMock = vi.hoisted(() => vi.fn());
const loadWebMediaMock = vi.hoisted(() => vi.fn());
const runFfmpegMock = vi.hoisted(() => vi.fn());
const runFfprobeMock = vi.hoisted(() => vi.fn());

const fileCreateMock = vi.hoisted(() => vi.fn());
const imageCreateMock = vi.hoisted(() => vi.fn());
const messageCreateMock = vi.hoisted(() => vi.fn());
const messageReplyMock = vi.hoisted(() => vi.fn());

const emptyConfig: ClawdbotConfig = {};
vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./accounts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./accounts.js")>()),
  resolveFeishuAccount: resolveFeishuAccountMock,
  resolveFeishuRuntimeAccount: resolveFeishuAccountMock,
}));

vi.mock("./targets.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./targets.js")>()),
  normalizeFeishuTarget: normalizeFeishuTargetMock,
  resolveReceiveIdType: resolveReceiveIdTypeMock,
}));

vi.mock("./runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime.js")>()),
  getFeishuRuntime: () => ({ media: { loadWebMedia: loadWebMediaMock } }),
}));

vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>();
  return {
    ...actual,
    runFfmpeg: runFfmpegMock,
    runFfprobe: runFfprobeMock,
  };
});

let sendMediaFeishu: typeof import("./media.js").sendMediaFeishu;

function mockResolvedFeishuAccount(mediaMaxMb?: number) {
  resolveFeishuAccountMock.mockReturnValue({
    configured: true,
    accountId: "main",
    config: mediaMaxMb === undefined ? {} : { mediaMaxMb },
    appId: "app_id",
    appSecret: "app_secret",
    domain: "feishu",
  });
}

function mockCallArg<T>(
  mock: { mock: { calls: unknown[][] } },
  callIndex: number,
  argIndex: number,
  _type?: (value: unknown) => value is T,
): T {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call at index ${callIndex}`);
  }
  return call[argIndex] as T;
}

function callData<T>(
  mock: { mock: { calls: unknown[][] } },
  callIndex = 0,
  _type?: (value: unknown) => value is T,
): T {
  const arg = mockCallArg<{ data?: unknown }>(mock, callIndex, 0);
  if (arg.data === undefined) {
    throw new Error(`Expected mock call data at index ${callIndex}`);
  }
  return arg.data as T;
}

function sendTestVideo(options: Partial<Parameters<typeof sendMediaFeishu>[0]> = {}) {
  return sendMediaFeishu({
    cfg: emptyConfig,
    to: "user:ou_target",
    mediaBuffer: Buffer.from("video"),
    fileName: "clip.mp4",
    ...options,
  });
}

describe("sendMediaFeishu video covers through the shared sender", () => {
  beforeAll(async () => {
    ({ sendMediaFeishu } = await import("./media.js"));
  });

  afterAll(() => {
    vi.doUnmock("./client.js");
    vi.doUnmock("./accounts.js");
    vi.doUnmock("./targets.js");
    vi.doUnmock("./runtime.js");
    vi.doUnmock("openclaw/plugin-sdk/media-runtime");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolvedFeishuAccount();

    normalizeFeishuTargetMock.mockReturnValue("ou_target");
    resolveReceiveIdTypeMock.mockReturnValue("open_id");

    createFeishuClientMock.mockReturnValue({
      im: {
        file: { create: fileCreateMock },
        image: { create: imageCreateMock },
        message: { create: messageCreateMock, reply: messageReplyMock },
      },
    });

    fileCreateMock.mockResolvedValue({ code: 0, data: { file_key: "file_key_1" } });
    imageCreateMock.mockResolvedValue({ code: 0, data: { image_key: "image_key_1" } });
    messageCreateMock.mockResolvedValue({ code: 0, data: { message_id: "msg_1" } });
    messageReplyMock.mockResolvedValue({ code: 0, data: { message_id: "reply_1" } });

    loadWebMediaMock.mockResolvedValue({
      buffer: Buffer.from("remote-audio"),
      fileName: "remote.opus",
      kind: "audio",
      contentType: "audio/ogg",
    });

    runFfmpegMock.mockImplementation(async (args: string[]) => {
      await fs.writeFile(args.at(-1) ?? "", Buffer.from("opus-output"));
      return "";
    });
    runFfprobeMock.mockResolvedValue("1.234\n");
  });

  it("uses msg_type=media for mp4 video", async () => {
    runFfprobeMock.mockResolvedValueOnce("4.2\n");

    await sendMediaFeishu({
      cfg: emptyConfig,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("video"),
      fileName: "clip.mp4",
    });

    expect(callData<{ file_type?: string }>(fileCreateMock).file_type).toBe("mp4");
    expect(callData<{ duration?: number }>(fileCreateMock).duration).toBe(4200);
    const ffprobeArgs = mockCallArg<string[]>(runFfprobeMock, 0, 0);
    expect(ffprobeArgs.slice(0, -1)).toEqual([
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
    ]);
    expect(ffprobeArgs.at(-1)).toMatch(/input\.mp4$/);
    expect(callData<{ image?: Buffer }>(imageCreateMock).image).toEqual(Buffer.from("opus-output"));
    const ffmpegArgs = mockCallArg<string[]>(runFfmpegMock, 0, 0);
    expect(ffmpegArgs).toEqual(
      expect.arrayContaining([
        "-ss",
        "0.5",
        "-vf",
        "scale=1280:720:force_original_aspect_ratio=decrease",
        "-frames:v",
        "1",
        "-c:v",
        "mjpeg",
        "-f",
        "image2",
        "-fs",
        String(10 * 1024 * 1024 + 1),
      ]),
    );
    expect(ffmpegArgs.at(-1)).toContain("preview.jpg");
    expect(mockCallArg(runFfmpegMock, 0, 1)).toEqual({ timeoutMs: 5_000 });
    const messageData = callData<{ content?: string; msg_type?: string }>(messageCreateMock);
    expect(messageData.msg_type).toBe("media");
    expect(JSON.parse(messageData.content ?? "{}")).toEqual({
      file_key: "file_key_1",
      image_key: "image_key_1",
    });
  });

  it("sends video without a cover when preview rendering fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    runFfmpegMock.mockRejectedValueOnce(new Error("ffmpeg missing"));
    await sendTestVideo();
    expect(imageCreateMock).not.toHaveBeenCalled();
    expect(JSON.parse(callData<{ content?: string }>(messageCreateMock).content ?? "{}")).toEqual({
      file_key: "file_key_1",
    });
    warnSpy.mockRestore();
  });

  it("sends video without a cover when preview upload times out", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let signalUploadStart: () => void;
    const uploadStarted = new Promise<void>((resolve) => {
      signalUploadStart = resolve;
    });
    vi.useFakeTimers();
    imageCreateMock.mockImplementation(() => {
      signalUploadStart();
      return new Promise(() => {
        // Keep the upload pending so the timeout path is exercised.
      });
    });
    try {
      const send = sendTestVideo();
      await uploadStarted;
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5_000);
      await send;
      expect(imageCreateMock).toHaveBeenCalledOnce();
      expect(
        createFeishuClientMock.mock.calls.some(
          ([credentials]) =>
            typeof credentials === "object" &&
            credentials !== null &&
            "httpTimeoutMs" in credentials &&
            credentials.httpTimeoutMs === 5_000,
        ),
      ).toBe(true);
      expect(JSON.parse(callData<{ content?: string }>(messageCreateMock).content ?? "{}")).toEqual(
        {
          file_key: "file_key_1",
        },
      );
      expect(mockCallArg<string>(warnSpy, 0, 0)).toContain("video preview upload timed out");
    } finally {
      vi.useRealTimers();
      warnSpy.mockRestore();
    }
  });

  it.each([
    { mediaMaxMb: undefined, maxBytes: 10 * 1024 * 1024 },
    { mediaMaxMb: 1, maxBytes: 1024 * 1024 },
  ])(
    "sends video without a cover when the preview exceeds $maxBytes bytes",
    async ({ mediaMaxMb, maxBytes }) => {
      mockResolvedFeishuAccount(mediaMaxMb);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      runFfmpegMock.mockImplementationOnce(async (args: string[]) => {
        const outputPath = args.at(-1);
        const sizeLimitIndex = args.indexOf("-fs");
        const sizeLimit = Number(args[sizeLimitIndex + 1]);
        if (!outputPath || sizeLimitIndex < 0 || !Number.isSafeInteger(sizeLimit)) {
          throw new Error("test ffmpeg output limit setup failed");
        }
        await fs.writeFile(outputPath, Buffer.alloc(maxBytes + 1));
        return "";
      });

      try {
        await sendTestVideo();
        expect(imageCreateMock).not.toHaveBeenCalled();
        expect(
          JSON.parse(callData<{ content?: string }>(messageCreateMock).content ?? "{}"),
        ).toEqual({
          file_key: "file_key_1",
        });
        expect(mockCallArg<string>(warnSpy, 0, 0)).toContain("failed to render video preview");
      } finally {
        warnSpy.mockRestore();
      }
    },
  );

  it.each([false, true])(
    "preserves the cover in inline/thread replies (thread=%s)",
    async (replyInThread) => {
      await sendTestVideo({ replyToMessageId: "om_parent", replyInThread });
      const request = mockCallArg<{
        path: { message_id: string };
        data: { content: string; msg_type: string; reply_in_thread?: boolean };
      }>(messageReplyMock, 0, 0);
      expect(request.path).toEqual({ message_id: "om_parent" });
      expect(request.data.msg_type).toBe("media");
      expect(request.data.reply_in_thread).toBe(replyInThread ? true : undefined);
      expect(JSON.parse(request.data.content)).toEqual({
        file_key: "file_key_1",
        image_key: "image_key_1",
      });
      expect(messageCreateMock).not.toHaveBeenCalled();
    },
  );

  it("preserves both keys when a missing thread reply permits direct fallback", async () => {
    messageReplyMock.mockResolvedValueOnce({ code: 231003, msg: "The message is not found" });
    await sendTestVideo({
      replyToMessageId: "om_parent",
      replyInThread: true,
      allowTopLevelReplyFallback: true,
    });
    const reply = callData<{ content: string }>(messageReplyMock);
    const direct = callData<{ content: string; msg_type: string; receive_id: string }>(
      messageCreateMock,
    );
    expect(direct).toMatchObject({ msg_type: "media", receive_id: "ou_target" });
    expect(direct.content).toBe(reply.content);
    expect(JSON.parse(direct.content)).toEqual({
      file_key: "file_key_1",
      image_key: "image_key_1",
    });
  });

  it("does not broaden disallowed thread fallback after preparing a cover", async () => {
    messageReplyMock.mockResolvedValueOnce({ code: 231003, msg: "The message is not found" });
    await expect(
      sendTestVideo({ replyToMessageId: "om_parent", replyInThread: true }),
    ).rejects.toThrow();
    expect(JSON.parse(callData<{ content: string }>(messageReplyMock).content)).toEqual({
      file_key: "file_key_1",
      image_key: "image_key_1",
    });
    expect(messageCreateMock).not.toHaveBeenCalled();
  });

  it("keeps inferred-voice caption recovery for URLs that resolve to video", async () => {
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("remote-video"),
      fileName: "download",
      contentType: "video/mp4",
    });
    const result = await sendMediaFeishu({
      cfg: emptyConfig,
      to: "user:ou_target",
      mediaUrl: "https://example.com/reply.ogg",
    });
    expect(result.voiceIntentDegradedToFile).toBe(true);
    expect(JSON.parse(callData<{ content: string }>(messageCreateMock).content)).toEqual({
      file_key: "file_key_1",
      image_key: "image_key_1",
    });
  });

  it("replies with video only when cover upload fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    imageCreateMock.mockRejectedValueOnce(new Error("upload unavailable"));
    try {
      await sendTestVideo({ replyToMessageId: "om_parent", replyInThread: true });
      expect(JSON.parse(callData<{ content: string }>(messageReplyMock).content)).toEqual({
        file_key: "file_key_1",
      });
      expect(messageCreateMock).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
