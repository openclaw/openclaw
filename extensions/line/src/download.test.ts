// Line tests cover download plugin behavior.
import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
const delayMock = vi.hoisted(() => vi.fn());
const saveResponseMediaMock = vi.hoisted(() => vi.fn());

vi.mock("node:timers/promises", () => ({
  setTimeout: delayMock,
}));

vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>();
  return { ...actual, saveResponseMedia: saveResponseMediaMock };
});

function responseWithChunks(status: number, parts: Buffer[]): Response {
  return new Response(Buffer.concat(parts), { status });
}

function cancellableResponse(status: number): {
  response: Response;
  cancel: ReturnType<typeof vi.fn>;
} {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  return { response: new Response(body, { status }), cancel };
}

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  createSubsystemLogger: () => {
    const logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => logger,
    };
    return logger;
  },
  logVerbose: () => {},
}));

let downloadLineMedia: typeof import("./download.js").downloadLineMedia;
let isRetryableLineInboundMediaError: typeof import("./download.js").isRetryableLineInboundMediaError;

function saveResponseMediaCall(): unknown[] {
  const call = saveResponseMediaMock.mock.calls.at(0);
  if (!call) {
    throw new Error("Expected saveResponseMedia call");
  }
  return call;
}

function detectMockContentType(buffer: Buffer, contentType?: string): string | undefined {
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    return "image/jpeg";
  }
  if (buffer.toString("ascii", 4, 8) === "ftyp") {
    return buffer.toString("ascii", 8, 12) === "M4A " ? "audio/x-m4a" : "video/mp4";
  }
  return contentType;
}

function expectMediaFetchError(err: unknown): MediaFetchError {
  expect(err).toBeInstanceOf(MediaFetchError);
  if (!(err instanceof MediaFetchError)) {
    throw new Error("expected a MediaFetchError");
  }
  return err;
}

describe("downloadLineMedia", () => {
  beforeAll(async () => {
    ({ downloadLineMedia, isRetryableLineInboundMediaError } = await import("./download.js"));
  });

  afterAll(() => {
    vi.doUnmock("node:timers/promises");
    vi.doUnmock("openclaw/plugin-sdk/runtime-env");
    vi.doUnmock("openclaw/plugin-sdk/media-runtime");
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    delayMock.mockReset().mockResolvedValue(undefined);
    saveResponseMediaMock.mockReset();
    saveResponseMediaMock.mockImplementation(
      async (response: Response, options: { subdir?: string }) => {
        const buffer = Buffer.from(await response.arrayBuffer());
        return {
          path: `/home/user/.openclaw/media/${options.subdir ?? "unknown"}/saved-media`,
          contentType: detectMockContentType(
            buffer,
            response.headers.get("content-type") ?? undefined,
          ),
          size: buffer.length,
        };
      },
    );
  });

  it("persists inbound media with the shared media store", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    fetchMock.mockResolvedValueOnce(responseWithChunks(200, [jpeg]));

    const result = await downloadLineMedia("mid-jpeg", "token");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api-data.line.me/v2/bot/message/mid-jpeg/content",
      expect.objectContaining({
        headers: { Authorization: "Bearer token" },
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(saveResponseMediaMock).toHaveBeenCalledTimes(1);
    const call = saveResponseMediaCall();
    expect(call[0]).toBeInstanceOf(Response);
    expect(call[1]).toEqual({
      sourceUrl: "https://api-data.line.me/v2/bot/message/mid-jpeg/content",
      subdir: "inbound",
      maxBytes: 10 * 1024 * 1024,
      originalFilename: undefined,
    });
    expect(result).toEqual({
      path: "/home/user/.openclaw/media/inbound/saved-media",
      contentType: "image/jpeg",
      size: jpeg.length,
    });
  });

  it("does not pass the external messageId as a media filename", async () => {
    const messageId = "a/../../../../etc/passwd";
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    fetchMock.mockResolvedValueOnce(responseWithChunks(200, [jpeg]));

    const result = await downloadLineMedia(messageId, "token");

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api-data.line.me/v2/bot/message/a%2F..%2F..%2F..%2F..%2Fetc%2Fpasswd/content",
    );
    expect(result.size).toBe(jpeg.length);
    expect(result.contentType).toBe("image/jpeg");
    expect(saveResponseMediaCall()[1]).toEqual({
      sourceUrl:
        "https://api-data.line.me/v2/bot/message/a%2F..%2F..%2F..%2F..%2Fetc%2Fpasswd/content",
      subdir: "inbound",
      maxBytes: 10 * 1024 * 1024,
      originalFilename: undefined,
    });
  });

  it("cancels content when the media store rejects it", async () => {
    const content = cancellableResponse(200);
    fetchMock.mockResolvedValueOnce(content.response);
    saveResponseMediaMock.mockImplementationOnce(async (response: Response) => {
      await response.body?.cancel();
      throw new MediaFetchError("max_bytes", "Media exceeds 0MB limit");
    });

    await expect(downloadLineMedia("mid", "token", 7)).rejects.toThrow(/Media exceeds/i);
    expect(saveResponseMediaMock).toHaveBeenCalledTimes(1);
    expect(content.cancel).toHaveBeenCalledTimes(1);
  });

  it("uses media store content type for M4A media", async () => {
    const m4aHeader = Buffer.from([
      0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20,
    ]);
    fetchMock.mockResolvedValueOnce(responseWithChunks(200, [m4aHeader]));

    const result = await downloadLineMedia("mid-audio", "token");

    expect(result.contentType).toBe("audio/x-m4a");
    expect(saveResponseMediaCall()[1]).toEqual(expect.objectContaining({ subdir: "inbound" }));
  });

  it("passes original filenames to the media store for extension fallback", async () => {
    fetchMock.mockResolvedValueOnce(responseWithChunks(200, [Buffer.from("unknown-audio-bytes")]));

    await downloadLineMedia("mid-file-audio", "token", 10 * 1024 * 1024, {
      originalFilename: "voice-note.m4a",
    });

    const call = saveResponseMediaCall();
    expect(call[1]).toEqual(
      expect.objectContaining({
        maxBytes: 10 * 1024 * 1024,
        originalFilename: "voice-note.m4a",
      }),
    );
  });

  it("uses media store content type for MP4 video", async () => {
    const mp4 = Buffer.from([
      0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
    ]);
    fetchMock.mockResolvedValueOnce(responseWithChunks(200, [mp4]));

    const result = await downloadLineMedia("mid-mp4", "token");

    expect(result.contentType).toBe("video/mp4");
  });

  it("retries 202 responses and cancels every discarded body", async () => {
    const m4aHeader = Buffer.from([
      0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20,
    ]);
    const first = cancellableResponse(202);
    const second = cancellableResponse(202);
    fetchMock
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(second.response)
      .mockResolvedValueOnce(responseWithChunks(200, [m4aHeader]));

    const result = await downloadLineMedia("mid-preparing", "token");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(delayMock).toHaveBeenNthCalledWith(1, 500, undefined, {
      signal: expect.any(AbortSignal),
    });
    expect(delayMock).toHaveBeenNthCalledWith(2, 1000, undefined, {
      signal: expect.any(AbortSignal),
    });
    expect(first.cancel).toHaveBeenCalledTimes(1);
    expect(second.cancel).toHaveBeenCalledTimes(1);
    expect(result.contentType).toBe("audio/x-m4a");
    expect(result.size).toBe(m4aHeader.length);
  });

  it("cancels every response when content never becomes ready", async () => {
    const attempts = Array.from({ length: 6 }, () => cancellableResponse(202));
    for (const attempt of attempts) {
      fetchMock.mockResolvedValueOnce(attempt.response);
    }

    await expect(downloadLineMedia("mid-stuck", "token")).rejects.toThrow(/still preparing/i);

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(delayMock).toHaveBeenCalledTimes(5);
    expect(delayMock.mock.calls.map((call) => call[0])).toEqual([500, 1000, 2000, 4000, 4000]);
    for (const attempt of attempts) {
      expect(attempt.cancel).toHaveBeenCalledTimes(1);
    }
    expect(saveResponseMediaMock).not.toHaveBeenCalled();
  });

  it("cancels error responses without retrying", async () => {
    const response = cancellableResponse(404);
    fetchMock.mockResolvedValueOnce(response.response);

    await expect(downloadLineMedia("mid-missing", "token")).rejects.toThrow(/HTTP 404/i);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.cancel).toHaveBeenCalledTimes(1);
    expect(saveResponseMediaMock).not.toHaveBeenCalled();
  });

  it("aborts a hung content request at the total readiness deadline", async () => {
    let requestSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        requestSignal = init?.signal ?? undefined;
        return await new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener("abort", () => reject(new Error("fetch aborted")), {
            once: true,
          });
        });
      },
    );

    vi.useFakeTimers();
    const pending = downloadLineMedia("mid-hung", "token");
    const rejection = expect(pending).rejects.toThrow(/did not become ready within 15 seconds/i);
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestSignal?.aborted).toBe(true);
    expect(saveResponseMediaMock).not.toHaveBeenCalled();
  });

  it("wraps an ordinary network failure for durable retry", async () => {
    const cause = new Error("socket reset");
    fetchMock.mockRejectedValueOnce(cause);

    const err = expectMediaFetchError(
      await downloadLineMedia("mid-network", "token").catch((e: unknown) => e),
    );

    expect(err.code).toBe("fetch_failed");
    expect(err.cause).toBe(cause);
    expect(isRetryableLineInboundMediaError(err)).toBe(true);
    expect(saveResponseMediaMock).not.toHaveBeenCalled();
  });

  it("propagates a response-stream failure for durable retry", async () => {
    fetchMock.mockResolvedValueOnce(responseWithChunks(200, [Buffer.from("partial")]));
    const failure = new MediaFetchError("fetch_failed", "response stream reset");
    saveResponseMediaMock.mockRejectedValueOnce(failure);

    const err = expectMediaFetchError(
      await downloadLineMedia("mid-stream", "token").catch((e: unknown) => e),
    );

    expect(err).toBe(failure);
    expect(isRetryableLineInboundMediaError(err)).toBe(true);
  });

  it("raises a retryable MediaFetchError when content stays 202 until the attempt cap", async () => {
    for (let i = 0; i < 6; i++) {
      fetchMock.mockResolvedValueOnce(cancellableResponse(202).response);
    }

    const err = expectMediaFetchError(
      await downloadLineMedia("mid-stuck", "token").catch((e: unknown) => e),
    );

    expect(err.code).toBe("http_error");
    expect(err.status).toBe(202);
    expect(isRetryableLineInboundMediaError(err)).toBe(true);
  });

  it("raises a retryable MediaFetchError when the readiness deadline aborts", async () => {
    fetchMock.mockImplementation(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("fetch aborted")), {
            once: true,
          });
        }),
    );

    vi.useFakeTimers();
    const pending = downloadLineMedia("mid-hung", "token").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(15_000);
    const err = expectMediaFetchError(await pending);

    expect(err.code).toBe("fetch_failed");
    expect(isRetryableLineInboundMediaError(err)).toBe(true);
  });

  it("raises a non-retryable MediaFetchError for a permanent HTTP error", async () => {
    fetchMock.mockResolvedValueOnce(cancellableResponse(404).response);

    const err = expectMediaFetchError(
      await downloadLineMedia("mid-missing", "token").catch((e: unknown) => e),
    );

    expect(err.code).toBe("http_error");
    expect(err.status).toBe(404);
    expect(isRetryableLineInboundMediaError(err)).toBe(false);
  });

  it("classifies media failures for durable retry", () => {
    expect(
      isRetryableLineInboundMediaError(new MediaFetchError("http_error", "x", { status: 202 })),
    ).toBe(true);
    expect(
      isRetryableLineInboundMediaError(new MediaFetchError("http_error", "x", { status: 408 })),
    ).toBe(true);
    expect(
      isRetryableLineInboundMediaError(new MediaFetchError("http_error", "x", { status: 429 })),
    ).toBe(true);
    expect(
      isRetryableLineInboundMediaError(new MediaFetchError("http_error", "x", { status: 503 })),
    ).toBe(true);
    expect(isRetryableLineInboundMediaError(new MediaFetchError("fetch_failed", "x"))).toBe(true);
    expect(
      isRetryableLineInboundMediaError(new MediaFetchError("http_error", "x", { status: 404 })),
    ).toBe(false);
    expect(isRetryableLineInboundMediaError(new MediaFetchError("max_bytes", "x"))).toBe(false);
    expect(isRetryableLineInboundMediaError(new Error("Media exceeds 0MB limit"))).toBe(false);
  });
});
