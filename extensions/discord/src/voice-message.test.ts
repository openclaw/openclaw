import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker, withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelTrackedTextResponse } from "../../test-support/streaming-error-response.js";
import { DiscordError, RequestClient } from "./internal/discord.js";
import { DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS } from "./monitor/timeouts.js";
import { hasDiscordMessageCreateAmbiguity } from "./retry.js";
import { sendVoiceMessageDiscord } from "./send.voice.js";

const GUARDED_FETCH_TEST_TIMEOUT_MS = 250;

const runFfprobeMock = vi.hoisted(() => vi.fn<(args: string[]) => Promise<string>>());
const runFfmpegMock = vi.hoisted(() => vi.fn<(args: string[]) => Promise<void>>());
const fetchWithSsrFGuardMock = vi.hoisted(() =>
  vi.fn(
    async (params: {
      url: string;
      init?: RequestInit;
      timeoutMs?: number;
      policy?: { allowRfc2544BenchmarkRange?: boolean; allowIpv6UniqueLocalRange?: boolean };
      auditContext?: string;
    }) => {
      if (
        params.auditContext !== "discord.endpoint-runtime" &&
        (!Number.isFinite(params.timeoutMs) || (params.timeoutMs ?? 0) <= 0)
      ) {
        throw new Error("guarded voice upload fetch requires a finite timeout");
      }
      return {
        response: await globalThis.fetch(params.url, {
          ...params.init,
          signal: AbortSignal.timeout(GUARDED_FETCH_TEST_TIMEOUT_MS),
        }),
        release: async () => {},
      };
    },
  ),
);

const tempRoot = vi.hoisted(() => ({ value: "" }));
vi.mock("openclaw/plugin-sdk/temp-path", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/temp-path")>()),
  resolvePreferredOpenClawTmpDir: () => tempRoot.value,
}));
vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>()),
  runFfprobe: runFfprobeMock,
  runFfmpeg: runFfmpegMock,
}));
vi.mock("openclaw/plugin-sdk/web-media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/web-media")>()),
  loadWebMediaRaw: vi.fn(async (source: string) => ({
    buffer: Buffer.from("ogg"),
    fileName: source.endsWith(".mp3") ? "input.mp3" : "input.ogg",
    contentType: "audio/ogg",
    kind: "audio",
  })),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const channelId = "273512430271856640";
const cfg = { channels: { discord: { token: "bot-token" } } };
beforeEach(() => {
  tempRoot.value = tempDirs.make("discord-voice-send-");
  runFfprobeMock
    .mockReset()
    .mockImplementation(async (args) =>
      args.includes("stream=codec_name,sample_rate") ? "opus,48000\n" : "1\n",
    );
  runFfmpegMock.mockReset().mockImplementation(async (args) => {
    const output = args.at(-1);
    if (!output) {
      throw new Error("Missing ffmpeg output path");
    }
    await fs.writeFile(output, args.includes("pcm_s16le") ? Buffer.alloc(512) : Buffer.from("ogg"));
  });
});

function sendVoice(client: RequestClient, attempts = 1, audioPath = "/tmp/input.ogg") {
  return sendVoiceMessageDiscord(channelId, audioPath, {
    cfg,
    rest: client,
    token: "bot-token",
    retry: { attempts, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
  });
}
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

const uploadBody = (upload_url: string, upload_filename = "uploaded.ogg") => ({
  attachments: [{ id: 0, upload_url, upload_filename }],
});
function uploadUrlResponse(upload_url: string, upload_filename: string) {
  return new Response(JSON.stringify(uploadBody(upload_url, upload_filename)), { status: 200 });
}

function mockVoiceUpload(
  uploads = [new Response(null, { status: 200 })],
  negotiationError?: Response,
) {
  let attempt = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = input instanceof Request ? input.method : (init?.method ?? "GET");
    const suffix = () => (uploads.length > 1 ? `-${attempt}` : "");
    if (method === "POST" && url.endsWith("/channels/273512430271856640/attachments")) {
      attempt += 1;
      return (
        negotiationError ??
        uploadUrlResponse(`https://cdn.test/upload${suffix()}`, `uploaded${suffix()}.ogg`)
      );
    }
    const response = uploads[attempt - 1];
    if (method === "PUT" && url === `https://cdn.test/upload${suffix()}` && response) {
      return response;
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  });
}

describe("sendVoiceMessageDiscord conversion", () => {
  function fixture() {
    const rest = new RequestClient("bot-token", {
      baseUrl: "https://discord.test/api/v10",
      timeout: 17,
      queueRequests: false,
    });
    const post = vi.spyOn(rest, "post").mockResolvedValue({ id: "msg-1", channel_id: channelId });
    mockVoiceUpload();
    return { rest, post };
  }

  it("materializes URL sources before invoking ffprobe or ffmpeg", async () => {
    const { rest } = fixture();
    await sendVoice(rest, 1, "https://example.com/audio.ogg");
    const inputPath = runFfprobeMock.mock.calls[0]?.[0].at(-1);
    expect(inputPath).toBeTypeOf("string");
    expect(inputPath).not.toContain("://");
    expect(path.dirname(inputPath ?? "")).toContain(tempRoot.value);
    expect(path.basename(inputPath ?? "")).toBe("input.ogg");
    expect(await fs.readdir(tempRoot.value)).toEqual([]);
  });

  it("keeps .ogg only when codec is opus and sample rate is 48kHz", async () => {
    const { rest, post } = fixture();
    await sendVoice(rest);
    const codecArgs = runFfprobeMock.mock.calls[0]?.[0] ?? [];
    expect(codecArgs.slice(0, -1)).toEqual([
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=codec_name,sample_rate",
      "-of",
      "csv=p=0",
    ]);
    expect(runFfprobeMock).toHaveBeenCalledTimes(2);
    expect(runFfmpegMock).toHaveBeenCalledTimes(1);
    expect(runFfmpegMock.mock.calls[0]?.[0]).toContain("pcm_s16le");
    expect(post).toHaveBeenCalledOnce();
    expect(await fs.readdir(tempRoot.value)).toEqual([]);
  });

  it.each([
    { extension: "ogg", probeOutput: "opus,24000\n" },
    { extension: "mp3", probeOutput: undefined },
  ])(
    "re-encodes .$extension input with bounded ffmpeg execution",
    async ({ extension, probeOutput }) => {
      const { rest, post } = fixture();
      if (probeOutput) {
        runFfprobeMock.mockResolvedValueOnce(probeOutput);
      }
      await sendVoice(rest, 1, "/tmp/input." + extension);
      expect(runFfprobeMock).toHaveBeenCalledTimes(probeOutput ? 2 : 1);
      expect(runFfmpegMock).toHaveBeenCalledTimes(2);
      const args = runFfmpegMock.mock.calls[0]?.[0] ?? [];
      const localInput = args[2];
      expect(path.basename(localInput ?? "")).toBe("input." + extension);
      expect(path.dirname(localInput ?? "")).toContain(tempRoot.value);
      expect(args.slice(0, -1)).toEqual([
        "-y",
        "-i",
        localInput,
        "-vn",
        "-sn",
        "-dn",
        "-t",
        "1200",
        "-ar",
        "48000",
        "-c:a",
        "libopus",
        "-b:a",
        "64k",
        "-f",
        "ogg",
      ]);
      const stagedPath = args.at(-1);
      expect(path.basename(stagedPath ?? "")).toMatch(/^\.fs-safe-output-.*-voice-.*\.ogg\.part$/);
      expect(post).toHaveBeenCalledOnce();
      expect(await fs.readdir(tempRoot.value)).toEqual([]);
    },
  );
});

describe("sendVoiceMessageDiscord uploads", () => {
  const post = vi.fn<(...args: unknown[]) => Promise<{ id: string; channel_id: string }>>();
  const rest = new RequestClient("bot-token", {
    baseUrl: "https://discord.test/api/v10",
    timeout: 17,
    queueRequests: false,
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    fetchWithSsrFGuardMock.mockClear();
    post.mockReset().mockResolvedValue({ id: "msg-1", channel_id: channelId });
    vi.spyOn(rest, "post").mockImplementation(post);
  });

  it("requests a fresh upload URL when rate limited and cancels the successful body", async () => {
    const successfulUpload = cancelTrackedTextResponse("uploaded", { status: 200 });
    const fetchMock = mockVoiceUpload([
      new Response(JSON.stringify({ message: "Slow down", retry_after: 0, global: false }), {
        status: 429,
      }),
      successfulUpload.response,
    ]);

    await expect(sendVoice(rest, 3)).resolves.toMatchObject({
      messageId: "msg-1",
      channelId,
    });

    expect(
      fetchMock.mock.calls.filter(([input]) => {
        const url = input instanceof Request ? input.url : input.toString();
        return url.endsWith("/attachments");
      }),
    ).toHaveLength(2);
    expect(successfulUpload.wasCanceled()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(4);
    expect(fetchWithSsrFGuardMock.mock.calls.map(([params]) => params.auditContext)).toEqual([
      "discord.voice.upload-url",
      "discord.voice.attachment-upload",
      "discord.voice.upload-url",
      "discord.voice.attachment-upload",
    ]);
    for (const [params] of fetchWithSsrFGuardMock.mock.calls) {
      expect(params.policy).toMatchObject({
        allowRfc2544BenchmarkRange: true,
        allowIpv6UniqueLocalRange: true,
      });
    }
    expect(post).toHaveBeenCalledWith("/channels/273512430271856640/messages", {
      body: {
        flags: 8192,
        nonce: expect.stringMatching(/^[0-9a-f]{24}$/),
        enforce_nonce: true,
        attachments: [
          {
            id: "0",
            filename: "voice-message.ogg",
            uploaded_filename: "uploaded-2.ogg",
            duration_secs: 1,
            waveform: Buffer.alloc(256).toString("base64"),
          },
        ],
      },
    });
  });

  it("reuses the voice-message nonce across an ambiguous create retry", async () => {
    post
      .mockRejectedValueOnce(Object.assign(new Error("bad gateway"), { status: 502 }))
      .mockResolvedValueOnce({ id: "msg-1", channel_id: "273512430271856640" });
    mockVoiceUpload();

    await expect(sendVoice(rest, 2)).resolves.toMatchObject({
      messageId: "msg-1",
      channelId,
    });

    expect(post).toHaveBeenCalledTimes(2);
    const firstBody = (post.mock.calls[0]?.[1] as { body?: { nonce?: unknown } } | undefined)?.body;
    const secondBody = (post.mock.calls[1]?.[1] as { body?: { nonce?: unknown } } | undefined)
      ?.body;
    expect(firstBody?.nonce).toMatch(/^[0-9a-f]{24}$/);
    expect(secondBody?.nonce).toBe(firstBody?.nonce);
  });

  it("records delivery ambiguity after a final message-create failure", async () => {
    const error = new DiscordError(new Response(null, { status: 503 }), {
      message: "voice message may have been accepted",
    });
    post.mockRejectedValue(error);
    mockVoiceUpload();

    await expect(sendVoice(rest)).rejects.toBe(error);

    expect(post).toHaveBeenCalledOnce();
    expect(hasDiscordMessageCreateAmbiguity(error)).toBe(true);
  });

  it("retains an earlier ambiguous create when its final retry cannot connect", async () => {
    const ambiguous = Object.assign(new Error("voice create response lost"), { status: 502 });
    const finalFailure = Object.assign(new Error("final create could not connect"), {
      code: "ECONNREFUSED",
    });
    post.mockRejectedValueOnce(ambiguous).mockRejectedValueOnce(finalFailure);
    mockVoiceUpload();

    await expect(sendVoice(rest, 2)).rejects.toBe(finalFailure);

    expect(post).toHaveBeenCalledTimes(2);
    expect(hasDiscordMessageCreateAmbiguity(finalFailure)).toBe(true);
  });

  it("does not mark an HTTP failure during upload-url negotiation", async () => {
    mockVoiceUpload([], new Response("voice attachment unavailable", { status: 503 }));

    const caught: unknown = await sendVoice(rest).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(Error);
    expect(hasDiscordMessageCreateAmbiguity(caught)).toBe(false);
    expect(post).not.toHaveBeenCalled();
    expect((caught as { status?: unknown }).status).toBe(503);
  });

  it("bounds voice upload error bodies without using response.text()", async () => {
    const tracked = cancelTrackedTextResponse(`${"cdn unavailable ".repeat(1024)}tail`, {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    mockVoiceUpload([tracked.response]);

    const error: unknown = await sendVoice(rest).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("DiscordError");
    expect((error as Error).message).toContain("cdn unavailable");
    expect(JSON.stringify((error as { rawBody?: unknown }).rawBody)).not.toContain("tail");
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["upload URL request", "POST /api/v10/channels/273512430271856640/attachments", 37],
    ["PUT upload request", "PUT /upload", DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS],
  ])("times out a hanging %s", async (_label, hangingRoute, expectedTimeoutMs) => {
    const closedResponses = vi.fn();
    let baseUrl = "";
    await withServer(
      (req, res) => {
        req.resume();
        const route = `${req.method ?? "GET"} ${req.url ?? "/"}`;
        res.on("close", () => closedResponses(route));
        if (route === hangingRoute) {
          return;
        }
        if (route !== "POST /api/v10/channels/273512430271856640/attachments") {
          res.statusCode = 500;
          res.end(`unexpected ${route}`);
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(uploadBody(`${baseUrl}/upload`)));
      },
      async (url) => {
        baseUrl = url;
        const timeoutClient = new RequestClient("bot-token", {
          baseUrl: `${baseUrl}/api/v10`,
          timeout: 37,
          queueRequests: false,
        });
        vi.spyOn(timeoutClient, "post").mockResolvedValue({ id: "msg-1", channel_id: channelId });

        await expect(sendVoice(timeoutClient)).rejects.toThrow(/timed out|abort/i);

        await vi.waitFor(() => expect(closedResponses).toHaveBeenCalledWith(hangingRoute));
        const guardedCall = fetchWithSsrFGuardMock.mock.calls.find(
          ([params]) => `${params.init?.method} ${new URL(params.url).pathname}` === hangingRoute,
        );
        expect(guardedCall?.[0].timeoutMs).toBe(expectedTimeoutMs);
      },
    );
  });
});
