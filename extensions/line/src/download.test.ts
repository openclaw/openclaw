import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn<typeof fetch>());
const delayMock = vi.hoisted(() => vi.fn());
const saveMediaStreamMock = vi.hoisted(() => vi.fn());

vi.mock("node:timers/promises", () => ({ setTimeout: delayMock }));

function content(bytes: Buffer): Response {
  return new Response(Buffer.concat([bytes]));
}

function cancellableResponse(status: number) {
  const cancel = vi.fn();
  return { response: new Response(new ReadableStream<Uint8Array>({ cancel }), { status }), cancel };
}

// mock-isolation: Consume synthetic streams without writing to the real media store.
vi.mock("openclaw/plugin-sdk/media-store", () => ({ saveMediaStream: saveMediaStreamMock }));

let downloadLineMedia: typeof import("./download.js").downloadLineMedia;
let isRetryable: typeof import("./download.js").isRetryableLineInboundMediaError;

function expectMediaFetchError(err: unknown): MediaFetchError {
  if (!(err instanceof MediaFetchError)) {
    throw new Error("expected a MediaFetchError");
  }
  return err;
}

async function downloadError(id: string) {
  return expectMediaFetchError(await downloadLineMedia(id, "token").catch((e: unknown) => e));
}

describe("downloadLineMedia", () => {
  beforeAll(async () => {
    ({ downloadLineMedia, isRetryableLineInboundMediaError: isRetryable } =
      await import("./download.js"));
  });

  afterAll(() => {
    vi.doUnmock("node:timers/promises");
    vi.doUnmock("openclaw/plugin-sdk/media-store");
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    delayMock.mockReset().mockResolvedValue(undefined);
    saveMediaStreamMock.mockReset().mockImplementation(async (stream: AsyncIterable<Buffer>) => {
      // Consume the adapter stream so body failures, deadlines, and reader cleanup remain observable.
      let size = 0;
      for await (const chunk of stream) {
        size += chunk.byteLength;
      }
      return {
        path: "/home/user/.openclaw/media/inbound/saved-media",
        contentType: "image/jpeg",
        size,
      };
    });
  });

  it("does not pass the external messageId as a media filename", async () => {
    const messageId = "a/../../../../etc/passwd";
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    fetchMock.mockResolvedValueOnce(content(jpeg));

    const result = await downloadLineMedia(messageId, "token");

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api-data.line.me/v2/bot/message/a%2F..%2F..%2F..%2F..%2Fetc%2Fpasswd/content",
    );
    expect(result).toMatchObject({ size: jpeg.length, contentType: "image/jpeg" });
    expect(saveMediaStreamMock).toHaveBeenCalledOnce();
    for (const arg of saveMediaStreamMock.mock.calls[0]!) {
      if (typeof arg === "string") {
        expect(arg).not.toContain(messageId);
      }
    }
  });

  it("passes original filenames to the media store for extension fallback", async () => {
    fetchMock.mockResolvedValueOnce(content(Buffer.from("unknown-audio-bytes")));

    await downloadLineMedia("mid-file-audio", "token", 10 * 1024 * 1024, {
      originalFilename: "voice-note.m4a",
    });

    expect(saveMediaStreamMock.mock.calls[0]?.slice(3)).toEqual([
      10 * 1024 * 1024,
      "voice-note.m4a",
    ]);
  });

  it("cancels every response when content never becomes ready", async () => {
    const attempts = Array.from({ length: 6 }, () => cancellableResponse(202));
    for (const attempt of attempts) {
      fetchMock.mockResolvedValueOnce(attempt.response);
    }

    const err = await downloadError("mid-stuck");
    expect(err.message).toMatch(/still preparing/i);
    expect(err).toMatchObject({ code: "http_error", status: 202 });
    expect(isRetryable(err)).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(delayMock).toHaveBeenCalledTimes(5);
    expect(delayMock.mock.calls.map((call) => call[0])).toEqual([500, 1000, 2000, 4000, 4000]);
    for (const attempt of attempts) {
      expect(attempt.cancel).toHaveBeenCalledTimes(1);
    }
    expect(saveMediaStreamMock).not.toHaveBeenCalled();
  });

  it("preserves a permanent HTTP error when response cancellation fails", async () => {
    const response = cancellableResponse(404);
    response.cancel.mockRejectedValueOnce(new Error("cancel failed"));
    fetchMock.mockResolvedValueOnce(response.response);

    const err = await downloadError("mid-missing");
    expect(err).toMatchObject({ code: "http_error", status: 404 });
    expect(isRetryable(err)).toBe(false);
    expect(saveMediaStreamMock).not.toHaveBeenCalled();
  });

  it("aborts a hung content request at the total readiness deadline", async () => {
    let requestSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(new Error("fetch aborted")), {
          once: true,
        });
      });
    });

    vi.useFakeTimers();
    const pending = downloadLineMedia("mid-hung", "token");
    const rejection = expect(pending).rejects.toThrow(/did not download within 15 seconds/i);
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestSignal?.aborted).toBe(true);
    expect(saveMediaStreamMock).not.toHaveBeenCalled();
  });

  it.each(["network", "stream"])("propagates a %s failure for durable retry", async (stage) => {
    const cause = new Error(`${stage} reset`);
    if (stage === "network") {
      fetchMock.mockRejectedValueOnce(cause);
    } else {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(cause);
        },
      });
      fetchMock.mockResolvedValueOnce(new Response(body));
    }
    const err = await downloadError(`mid-${stage}`);
    expect(err.code).toBe("fetch_failed");
    expect(err.cause).toBe(cause);
    expect(isRetryable(err)).toBe(true);
    if (stage === "network") {
      expect(saveMediaStreamMock).not.toHaveBeenCalled();
    }
  });

  it("uses one deadline across headers and body, then permits an identical retry", async () => {
    let stalledBody: ReadableStreamDefaultController<Uint8Array> | undefined;
    let stalledResponse: Response | undefined;
    let requestSignal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce(async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stalledBody = controller;
          controller.enqueue(Buffer.from("partial"));
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), {
            once: true,
          });
        },
      });
      stalledResponse = new Response(body);
      return stalledResponse;
    });

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
    expect(isRetryable(err)).toBe(true);

    const healthy = Buffer.from("healthy retry");
    fetchMock.mockResolvedValueOnce(content(healthy));
    await expect(downloadLineMedia("mid-body-stall", "token")).resolves.toMatchObject({
      size: healthy.length,
    });
  });

  it("classifies media failures for durable retry", () => {
    for (const status of [202, 408, 429, 503]) {
      expect(isRetryable(new MediaFetchError("http_error", "x", { status }))).toBe(true);
    }
    expect(isRetryable(new MediaFetchError("fetch_failed", "x"))).toBe(false);
    expect(isRetryable(new MediaFetchError("http_error", "x", { status: 404 }))).toBe(false);
    expect(isRetryable(new MediaFetchError("max_bytes", "x"))).toBe(false);
    expect(isRetryable(new Error("Media exceeds 0MB limit"))).toBe(false);
  });
});
