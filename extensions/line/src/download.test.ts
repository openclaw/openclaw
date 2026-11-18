import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn<typeof fetch>());
const delayMock = vi.hoisted(() => vi.fn());
const saveMediaStreamMock = vi.hoisted(() => vi.fn());
vi.mock("node:timers/promises", () => ({ setTimeout: delayMock }));
const savedMedia = { path: "/saved-media", contentType: "image/jpeg" };
const maxBytes = 10 * 1024 * 1024;
function responseBody(start: UnderlyingDefaultSource<Uint8Array>["start"]) {
  return new Response(new ReadableStream<Uint8Array>({ start }));
}
function cancellableResponse(status: number) {
  const cancel = vi.fn();
  return { response: new Response(new ReadableStream<Uint8Array>({ cancel }), { status }), cancel };
}

// mock-isolation: Consume synthetic streams without writing to the real media store.
vi.mock("openclaw/plugin-sdk/media-store", () => ({ saveMediaStream: saveMediaStreamMock }));

let downloadLineMedia: typeof import("./download.js").downloadLineMedia;
let isRetryable: typeof import("./download.js").isRetryableLineInboundMediaError;

async function downloadError(id: string) {
  const err = await downloadLineMedia(id, "token").catch((e: unknown) => e);
  if (!(err instanceof MediaFetchError)) {
    throw new Error("expected a MediaFetchError");
  }
  return err;
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

  afterEach(() => vi.useRealTimers());

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    delayMock.mockReset().mockResolvedValue(undefined);
    saveMediaStreamMock.mockReset().mockImplementation(async (stream: AsyncIterable<Buffer>) => {
      for await (const chunk of stream) {
        void chunk; // Drain through EOF so body errors and cleanup remain observable.
      }
      return savedMedia;
    });
  });

  it.each([undefined, "voice-note.m4a"])(
    "saves media safely with filename %s",
    async (originalFilename) => {
      const messageId = "a/../../../../etc/passwd";
      fetchMock.mockResolvedValueOnce(new Response("unknown-audio-bytes"));
      const result = await downloadLineMedia(messageId, "token", maxBytes, {
        originalFilename,
      });

      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        "https://api-data.line.me/v2/bot/message/a%2F..%2F..%2F..%2F..%2Fetc%2Fpasswd/content",
      );
      expect(result).toEqual(savedMedia);
      expect(saveMediaStreamMock.mock.calls[0]?.slice(3)).toEqual([maxBytes, originalFilename]);
      expect(saveMediaStreamMock.mock.calls[0]?.join("\n")).not.toContain(messageId);
    },
  );

  it.each([202, 404])("cancels HTTP %s without masking the error", async (status) => {
    const attempts = Array.from({ length: status === 202 ? 6 : 1 }, () =>
      cancellableResponse(status),
    );
    if (status === 404) {
      attempts[0]!.cancel.mockRejectedValueOnce(new Error("cancel failed"));
    }
    for (const attempt of attempts) {
      fetchMock.mockResolvedValueOnce(attempt.response);
    }

    const err = await downloadError("mid-unavailable");
    expect(err).toMatchObject({ code: "http_error", status });
    expect(isRetryable(err)).toBe(status === 202);
    expect(delayMock.mock.calls.map((call) => call[0])).toEqual(
      status === 202 ? [500, 1000, 2000, 4000, 4000] : [],
    );
    for (const attempt of attempts) {
      expect(attempt.cancel).toHaveBeenCalledTimes(1);
    }
    expect(saveMediaStreamMock).not.toHaveBeenCalled();
  });

  it.each(["network", "stream"])("propagates a %s failure for durable retry", async (stage) => {
    const cause = new Error(`${stage} reset`);
    if (stage === "network") {
      fetchMock.mockRejectedValueOnce(cause);
    } else {
      fetchMock.mockResolvedValueOnce(responseBody((controller) => controller.error(cause)));
    }
    const err = await downloadError(`mid-${stage}`);
    expect(err.code).toBe("fetch_failed");
    expect(err.cause).toBe(cause);
    expect(isRetryable(err)).toBe(true);
    if (stage === "network") {
      expect(saveMediaStreamMock).not.toHaveBeenCalled();
    }
  });

  it.each(["headers", "body"])("bounds stalled %s and permits retry", async (stage) => {
    let stalledBody: ReadableStreamDefaultController<Uint8Array> | undefined;
    let stalledResponse: Response | undefined;
    let requestSignal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce(async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      if (stage === "headers") {
        return await new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener("abort", () => reject(new Error("fetch aborted")), {
            once: true,
          });
        });
      }
      stalledResponse = responseBody((controller) => {
        stalledBody = controller;
        controller.enqueue(Buffer.from("partial"));
        init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), {
          once: true,
        });
      });
      return stalledResponse;
    });

    vi.useFakeTimers();
    let atDeadline: MediaFetchError | undefined;
    const pending = downloadError("mid-body-stall").then((err) => {
      atDeadline = err;
      return err;
    });
    const started = stage === "body" ? saveMediaStreamMock : fetchMock;
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(15_000);
    await Promise.resolve();
    const observedAtDeadline = atDeadline;
    if (!atDeadline) {
      stalledBody?.error(new Error("pre-fix test cleanup"));
    }
    const err = await pending;

    expect(observedAtDeadline).toBe(err);
    expect(err.code).toBe("fetch_failed");
    expect(err.message).toMatch(/did not download within 15 seconds/i);
    expect(err).toBe(requestSignal?.reason);
    expect(requestSignal?.aborted).toBe(true);
    if (stage === "body") {
      expect(stalledResponse?.body?.locked).toBe(false);
    } else {
      expect(saveMediaStreamMock).not.toHaveBeenCalled();
    }
    expect(isRetryable(err)).toBe(true);

    fetchMock.mockResolvedValueOnce(new Response("healthy retry"));
    await expect(downloadLineMedia("mid-body-stall", "token")).resolves.toEqual(savedMedia);
  });

  it("classifies media failures for durable retry", () => {
    for (const status of [408, 429, 503]) {
      expect(isRetryable(new MediaFetchError("http_error", "x", { status }))).toBe(true);
    }
    expect(isRetryable(new MediaFetchError("fetch_failed", "x"))).toBe(false);
    expect(isRetryable(new MediaFetchError("max_bytes", "x"))).toBe(false);
    expect(isRetryable(new Error("Media exceeds 0MB limit"))).toBe(false);
  });
});
