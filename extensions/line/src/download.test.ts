// Line tests cover download plugin behavior.
import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
const delayMock = vi.hoisted(() => vi.fn());
const saveMediaStreamMock = vi.hoisted(() => vi.fn());

vi.mock("node:timers/promises", () => ({
  setTimeout: delayMock,
}));

function responseWithChunks(status: number, parts: Buffer[]): Response {
  return new Response(Buffer.concat(parts), { status });
}

function cancellableResponse(
  status: number,
  parts: Buffer[] = [],
): {
  response: Response;
  cancel: ReturnType<typeof vi.fn>;
} {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
    },
    cancel,
  });
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

vi.mock("openclaw/plugin-sdk/media-store", () => ({
  saveMediaStream: saveMediaStreamMock,
}));

let downloadLineMedia: typeof import("./download.js").downloadLineMedia;
let isRetryableLineInboundMediaError: typeof import("./download.js").isRetryableLineInboundMediaError;
let storedContentType: string;

function saveMediaStreamCall(): unknown[] {
  const call = saveMediaStreamMock.mock.calls.at(0);
  if (!call) {
    throw new Error("Expected saveMediaStream call");
  }
  return call;
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
    vi.doUnmock("openclaw/plugin-sdk/media-store");
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
    storedContentType = "image/jpeg";
    saveMediaStreamMock.mockReset();
    saveMediaStreamMock.mockImplementation(async (stream: AsyncIterable<Buffer>) => {
      const chunksLocal: Buffer[] = [];
      // Consume the adapter stream so body failures, deadlines, and reader cleanup remain observable.
      for await (const chunk of stream) {
        chunksLocal.push(Buffer.from(chunk));
      }
      return {
        path: "/home/user/.openclaw/media/inbound/saved-media",
        contentType: storedContentType,
        size: Buffer.concat(chunksLocal).length,
      };
    });
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
    expect(saveMediaStreamMock).toHaveBeenCalledTimes(1);
    const call = saveMediaStreamCall();
    expect(call[1]).toBeUndefined();
    expect(call[2]).toBe("inbound");
    expect(call[3]).toBe(10 * 1024 * 1024);
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
    for (const arg of saveMediaStreamCall()) {
      if (typeof arg === "string") {
        expect(arg).not.toContain(messageId);
      }
    }
  });

  it("cancels content when the media store rejects it", async () => {
    const content = cancellableResponse(200, [Buffer.from("oversized")]);
    fetchMock.mockResolvedValueOnce(content.response);
    saveMediaStreamMock.mockImplementationOnce(async (stream: AsyncIterable<Buffer>) => {
      for await (const chunk of stream) {
        expect(chunk).toEqual(Buffer.from("oversized"));
        throw new Error("Media exceeds 0MB limit");
      }
      throw new Error("Expected media content");
    });

    await expect(downloadLineMedia("mid", "token", 7)).rejects.toThrow(/Media exceeds/i);
    expect(saveMediaStreamMock).toHaveBeenCalledTimes(1);
    expect(content.cancel).toHaveBeenCalledTimes(1);
  });

  it.each(["audio/x-m4a", "video/mp4"])(
    "uses the media store content type %s",
    async (contentType) => {
      storedContentType = contentType;
      fetchMock.mockResolvedValueOnce(responseWithChunks(200, [Buffer.from("media")]));

      const result = await downloadLineMedia("mid", "token");

      expect(result.contentType).toBe(contentType);
      expect(saveMediaStreamCall()[2]).toBe("inbound");
    },
  );

  it("passes original filenames to the media store for extension fallback", async () => {
    fetchMock.mockResolvedValueOnce(responseWithChunks(200, [Buffer.from("unknown-audio-bytes")]));

    await downloadLineMedia("mid-file-audio", "token", 10 * 1024 * 1024, {
      originalFilename: "voice-note.m4a",
    });

    const call = saveMediaStreamCall();
    expect(call[3]).toBe(10 * 1024 * 1024);
    expect(call[4]).toBe("voice-note.m4a");
  });

  it("passes the LINE response content type to the media store", async () => {
    storedContentType = "text/plain";
    fetchMock.mockResolvedValueOnce(
      new Response(Buffer.from("plain attachment"), {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );

    const result = await downloadLineMedia("mid-text", "token");

    expect(saveMediaStreamCall()[1]).toBe("text/plain");
    expect(result.contentType).toBe("text/plain");
  });

  it("retries 202 responses and cancels every discarded body", async () => {
    storedContentType = "audio/x-m4a";
    const media = Buffer.from("ready media");
    const first = cancellableResponse(202);
    const second = cancellableResponse(202);
    fetchMock
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(second.response)
      .mockResolvedValueOnce(responseWithChunks(200, [media]));

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
    expect(result.size).toBe(media.length);
  });

  it("cancels every response when content never becomes ready", async () => {
    const attempts = Array.from({ length: 6 }, () => cancellableResponse(202));
    for (const attempt of attempts) {
      fetchMock.mockResolvedValueOnce(attempt.response);
    }

    const err = expectMediaFetchError(
      await downloadLineMedia("mid-stuck", "token").catch((e: unknown) => e),
    );

    expect(err.message).toMatch(/still preparing/i);
    expect(err.code).toBe("http_error");
    expect(err.status).toBe(202);
    expect(isRetryableLineInboundMediaError(err)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(delayMock).toHaveBeenCalledTimes(5);
    expect(delayMock.mock.calls.map((call) => call[0])).toEqual([500, 1000, 2000, 4000, 4000]);
    for (const attempt of attempts) {
      expect(attempt.cancel).toHaveBeenCalledTimes(1);
    }
    expect(saveMediaStreamMock).not.toHaveBeenCalled();
  });

  it("cancels error responses without retrying", async () => {
    const response = cancellableResponse(404);
    fetchMock.mockResolvedValueOnce(response.response);

    const err = expectMediaFetchError(
      await downloadLineMedia("mid-missing", "token").catch((e: unknown) => e),
    );

    expect(err.message).toMatch(/HTTP 404/i);
    expect(err.code).toBe("http_error");
    expect(err.status).toBe(404);
    expect(isRetryableLineInboundMediaError(err)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.cancel).toHaveBeenCalledTimes(1);
    expect(saveMediaStreamMock).not.toHaveBeenCalled();
  });

  it("preserves a permanent HTTP error when response cancellation fails", async () => {
    const response = cancellableResponse(404);
    response.cancel.mockRejectedValueOnce(new Error("cancel failed"));
    fetchMock.mockResolvedValueOnce(response.response);

    const err = expectMediaFetchError(
      await downloadLineMedia("mid-missing", "token").catch((e: unknown) => e),
    );

    expect(err.code).toBe("http_error");
    expect(err.status).toBe(404);
    expect(isRetryableLineInboundMediaError(err)).toBe(false);
    expect(saveMediaStreamMock).not.toHaveBeenCalled();
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
    const rejection = expect(pending).rejects.toThrow(/did not download within 15 seconds/i);
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestSignal?.aborted).toBe(true);
    expect(saveMediaStreamMock).not.toHaveBeenCalled();
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
    expect(saveMediaStreamMock).not.toHaveBeenCalled();
  });

  it("propagates a response-stream failure for durable retry", async () => {
    const failure = new Error("response stream reset");
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(failure);
          },
        }),
        { status: 200 },
      ),
    );

    const err = expectMediaFetchError(
      await downloadLineMedia("mid-stream", "token").catch((e: unknown) => e),
    );

    expect(err.code).toBe("fetch_failed");
    expect(err.cause).toBe(failure);
    expect(isRetryableLineInboundMediaError(err)).toBe(true);
  });

  it("does not retry a permanent media-store failure", async () => {
    fetchMock.mockResolvedValueOnce(responseWithChunks(200, [Buffer.from("media")]));
    const failure = Object.assign(new Error("media store unavailable"), { code: "EACCES" });
    saveMediaStreamMock.mockRejectedValueOnce(failure);

    const err = await downloadLineMedia("mid-store", "token").catch((e: unknown) => e);

    expect(err).toBe(failure);
    expect(isRetryableLineInboundMediaError(err)).toBe(false);
  });

  it("uses one deadline across headers and body, then permits an identical retry", async () => {
    let stalledBody: ReadableStreamDefaultController<Uint8Array> | undefined;
    let stalledResponse: Response | undefined;
    let requestSignal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        requestSignal = init?.signal ?? undefined;
        stalledResponse = new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stalledBody = controller;
              controller.enqueue(Buffer.from("partial"));
              init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), {
                once: true,
              });
            },
          }),
          { status: 200 },
        );
        return stalledResponse;
      },
    );

    vi.useFakeTimers();
    let settledAtDeadline = false;
    const pending = downloadLineMedia("mid-body-stall", "token")
      .catch((error: unknown) => error)
      .finally(() => {
        settledAtDeadline = true;
      });
    await vi.waitFor(() => expect(saveMediaStreamMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(15_000);
    await Promise.resolve();
    const observedAtDeadline = settledAtDeadline;
    if (!settledAtDeadline) {
      stalledBody?.error(new Error("pre-fix test cleanup"));
    }
    const err = expectMediaFetchError(await pending);

    expect(observedAtDeadline).toBe(true);
    expect(err.code).toBe("fetch_failed");
    expect(err).toBe(requestSignal?.reason);
    expect(requestSignal?.aborted).toBe(true);
    expect(stalledResponse?.body?.locked).toBe(false);
    expect(isRetryableLineInboundMediaError(err)).toBe(true);

    const healthy = Buffer.from("healthy retry");
    fetchMock.mockResolvedValueOnce(responseWithChunks(200, [healthy]));
    await expect(downloadLineMedia("mid-body-stall", "token")).resolves.toMatchObject({
      size: healthy.length,
    });
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
    expect(isRetryableLineInboundMediaError(new MediaFetchError("fetch_failed", "x"))).toBe(false);
    expect(
      isRetryableLineInboundMediaError(new MediaFetchError("http_error", "x", { status: 404 })),
    ).toBe(false);
    expect(isRetryableLineInboundMediaError(new MediaFetchError("max_bytes", "x"))).toBe(false);
    expect(isRetryableLineInboundMediaError(new Error("Media exceeds 0MB limit"))).toBe(false);
  });
});
