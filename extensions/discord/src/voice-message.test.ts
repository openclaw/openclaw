import fs from "node:fs/promises";
import path from "node:path";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cancelTrackedTextResponse } from "../../test-support/streaming-error-response.js";
import { DiscordError, type RequestClient } from "./internal/discord.js";
import { DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS } from "./monitor/timeouts.js";
import { hasDiscordMessageCreateAmbiguity, type DiscordRetryRunner } from "./retry.js";
import { ensureOggOpus, sendDiscordVoiceMessage } from "./voice-message.js";

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

// mock-isolation: Pin the temporary directory for exact staged-output path assertions.
vi.mock("openclaw/plugin-sdk/temp-path", () => ({
  resolvePreferredOpenClawTmpDir: () => "/tmp",
}));

// mock-isolation: Keep ffprobe, ffmpeg, and unlink operations synthetic in upload tests.
vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  runFfprobe: runFfprobeMock,
  runFfmpeg: runFfmpegMock,
  parseFfprobeCodecAndSampleRate: (stdout: string) => {
    const [codec, sampleRate] = stdout.trim().split(",");
    return { codec, sampleRateHz: Number(sampleRate) };
  },
  MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS: 1200,
  unlinkIfExists: vi.fn(async () => {}),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

describe("ensureOggOpus", () => {
  beforeEach(() => {
    runFfprobeMock.mockReset();
    runFfmpegMock.mockReset();
  });

  function expectStagedFfmpegOutput(ffmpegOutputPath: string | undefined, finalPath: string) {
    expect(ffmpegOutputPath).toBeTypeOf("string");
    if (typeof ffmpegOutputPath !== "string") {
      throw new Error("missing ffmpeg output path");
    }
    expect(ffmpegOutputPath).not.toBe(finalPath);
    const stagedBase = path.basename(ffmpegOutputPath);
    expect(stagedBase.startsWith(".fs-safe-output-")).toBe(true);
    expect(stagedBase.endsWith(`-${path.basename(finalPath)}.part`)).toBe(true);
  }

  it("rejects URL/protocol input paths", async () => {
    await expect(ensureOggOpus("https://example.com/audio.ogg")).rejects.toThrow(
      /local file path/i,
    );
    expect(runFfprobeMock).not.toHaveBeenCalled();
    expect(runFfmpegMock).not.toHaveBeenCalled();
  });

  it("keeps .ogg only when codec is opus and sample rate is 48kHz", async () => {
    runFfprobeMock.mockResolvedValueOnce("opus,48000\n");

    const result = await ensureOggOpus("/tmp/input.ogg");

    expect(result).toEqual({ path: "/tmp/input.ogg", cleanup: false });
    expect(runFfprobeMock).toHaveBeenCalledTimes(1);
    expect(runFfprobeMock.mock.calls[0]?.[0]).toEqual(
      "-v error -select_streams a:0 -show_entries stream=codec_name,sample_rate -of csv=p=0 /tmp/input.ogg".split(
        " ",
      ),
    );
    expect(runFfmpegMock).not.toHaveBeenCalled();
  });

  it.each([
    { extension: "ogg", probeOutput: "opus,24000\n" },
    { extension: "mp3", probeOutput: undefined },
  ])(
    "re-encodes .$extension input with bounded ffmpeg execution",
    async ({ extension, probeOutput }) => {
      if (probeOutput) {
        runFfprobeMock.mockResolvedValueOnce(probeOutput);
      }
      runFfmpegMock.mockImplementationOnce(async (args) => {
        const outputPath = args.at(-1);
        if (typeof outputPath !== "string") {
          throw new Error("missing ffmpeg output path");
        }
        await fs.writeFile(outputPath, "ogg");
      });

      const inputPath = `/tmp/input.${extension}`;
      const result = await ensureOggOpus(inputPath);

      expect(result.cleanup).toBe(true);
      expect(path.dirname(result.path)).toBe(path.normalize("/tmp"));
      expect(path.basename(result.path)).toMatch(/^voice-.*\.ogg$/);
      expect(runFfprobeMock).toHaveBeenCalledTimes(probeOutput ? 1 : 0);
      expect(runFfmpegMock).toHaveBeenCalledTimes(1);
      const ffmpegArgs = runFfmpegMock.mock.calls[0]?.[0] ?? [];
      expect(ffmpegArgs.slice(0, -1)).toEqual([
        "-y",
        "-i",
        inputPath,
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
      const ffmpegOutputPath = ffmpegArgs.at(-1);
      expectStagedFfmpegOutput(ffmpegOutputPath, result.path);
      await expect(fs.readFile(result.path, "utf8")).resolves.toBe("ogg");
    },
  );
});

describe("sendDiscordVoiceMessage", () => {
  const post = vi.fn<(...args: unknown[]) => Promise<{ id: string; channel_id: string }>>();
  const rest = {
    options: { baseUrl: "https://discord.test/api/v10", timeout: 17 },
    post,
  } as unknown as RequestClient;
  const metadata = { durationSecs: 1, waveform: "waveform" };

  beforeEach(() => {
    vi.restoreAllMocks();
    fetchWithSsrFGuardMock.mockClear();
    post.mockReset().mockResolvedValue({ id: "msg-1", channel_id: "channel-1" });
  });

  function sendVoice(
    client: RequestClient,
    request: DiscordRetryRunner = async (fn) => await fn(),
  ) {
    return sendDiscordVoiceMessage(
      client,
      "channel-1",
      Buffer.from("ogg"),
      metadata,
      undefined,
      request,
      false,
      "bot-token",
    );
  }

  const uploadBody = (upload_url: string, upload_filename = "uploaded.ogg") => ({
    attachments: [{ id: 0, upload_url, upload_filename }],
  });
  function uploadUrlResponse(upload_url: string, upload_filename: string) {
    return new Response(JSON.stringify(uploadBody(upload_url, upload_filename)), { status: 200 });
  }

  const retryCreate: DiscordRetryRunner = async (fn, label) => {
    if (label === "voice-message") {
      await fn().catch(() => undefined);
    }
    return await fn();
  };

  function mockVoiceUpload(
    uploads = [new Response(null, { status: 200 })],
    negotiationError?: Response,
  ) {
    let attempt = 0;
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = input instanceof Request ? input.method : (init?.method ?? "GET");
      const suffix = () => (uploads.length > 1 ? `-${attempt}` : "");
      if (method === "POST" && url.endsWith("/channels/channel-1/attachments")) {
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

  async function retryRateLimits<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (!(err instanceof Error) || err.name !== "RateLimitError") {
          throw err;
        }
      }
    }
    throw lastError;
  }

  it("requests a fresh upload URL when rate limited and cancels the successful body", async () => {
    const successfulUpload = cancelTrackedTextResponse("uploaded", { status: 200 });
    const fetchMock = mockVoiceUpload([
      new Response(JSON.stringify({ message: "Slow down", retry_after: 0, global: false }), {
        status: 429,
      }),
      successfulUpload.response,
    ]);

    await expect(sendVoice(rest, retryRateLimits)).resolves.toEqual({
      id: "msg-1",
      channel_id: "channel-1",
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
    expect(post).toHaveBeenCalledWith("/channels/channel-1/messages", {
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
            waveform: "waveform",
          },
        ],
      },
    });
  });

  it("reuses the voice-message nonce across an ambiguous create retry", async () => {
    post
      .mockRejectedValueOnce(Object.assign(new Error("bad gateway"), { status: 502 }))
      .mockResolvedValueOnce({ id: "msg-1", channel_id: "channel-1" });
    mockVoiceUpload();

    await expect(sendVoice(rest, retryCreate)).resolves.toEqual({
      id: "msg-1",
      channel_id: "channel-1",
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

    await expect(sendVoice(rest, retryCreate)).rejects.toBe(finalFailure);

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
    ["upload URL request", "POST /api/v10/channels/channel-1/attachments", 37],
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
        if (route !== "POST /api/v10/channels/channel-1/attachments") {
          res.statusCode = 500;
          res.end(`unexpected ${route}`);
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(uploadBody(`${baseUrl}/upload`)));
      },
      async (url) => {
        baseUrl = url;
        const timeoutClient = {
          options: { baseUrl: `${baseUrl}/api/v10`, timeout: 37 },
          post: vi.fn(async () => ({ id: "msg-1", channel_id: "channel-1" })),
        } as unknown as RequestClient;

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
