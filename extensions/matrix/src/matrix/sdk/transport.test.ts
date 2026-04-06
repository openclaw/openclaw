import { beforeEach, describe, expect, it, vi } from "vitest";
import { MatrixMediaSizeLimitError } from "../media-errors.js";
import { performMatrixRequest } from "./transport.js";

function createPinnedDispatcherCompatibilityError(): Error {
  const cause = Object.assign(new Error("invalid onRequestStart method"), {
    code: "UND_ERR_INVALID_ARG",
  });
  return Object.assign(new TypeError("fetch failed"), { cause });
}

describe("performMatrixRequest", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects oversized raw responses before buffering the whole body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("too-big", {
            status: 200,
            headers: {
              "content-length": "8192",
            },
          }),
      ),
    );

    await expect(
      performMatrixRequest({
        homeserver: "http://127.0.0.1:8008",
        accessToken: "token",
        method: "GET",
        endpoint: "/_matrix/media/v3/download/example/id",
        timeoutMs: 5000,
        raw: true,
        maxBytes: 1024,
        ssrfPolicy: { allowPrivateNetwork: true },
      }),
    ).rejects.toBeInstanceOf(MatrixMediaSizeLimitError);
  });

  it("applies streaming byte limits when raw responses omit content-length", async () => {
    const chunk = new Uint8Array(768);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(stream, {
            status: 200,
          }),
      ),
    );

    await expect(
      performMatrixRequest({
        homeserver: "http://127.0.0.1:8008",
        accessToken: "token",
        method: "GET",
        endpoint: "/_matrix/media/v3/download/example/id",
        timeoutMs: 5000,
        raw: true,
        maxBytes: 1024,
        ssrfPolicy: { allowPrivateNetwork: true },
      }),
    ).rejects.toBeInstanceOf(MatrixMediaSizeLimitError);
  });

  it("uses the matrix-specific idle-timeout error for stalled raw downloads", async () => {
    vi.useFakeTimers();
    try {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
        },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(stream, {
              status: 200,
            }),
        ),
      );

      const requestPromise = performMatrixRequest({
        homeserver: "http://127.0.0.1:8008",
        accessToken: "token",
        method: "GET",
        endpoint: "/_matrix/media/v3/download/example/id",
        timeoutMs: 5000,
        raw: true,
        maxBytes: 1024,
        readIdleTimeoutMs: 50,
        ssrfPolicy: { allowPrivateNetwork: true },
      });

      const rejection = expect(requestPromise).rejects.toThrow(
        "Matrix media download stalled: no data received for 50ms",
      );
      await vi.advanceTimersByTimeAsync(60);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  }, 5_000);

  it("retries without the direct pinned dispatcher when the runtime rejects that dispatcher shape", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const requestInit = init as RequestInit & { dispatcher?: unknown };
      if (requestInit.dispatcher) {
        throw createPinnedDispatcherCompatibilityError();
      }
      return new Response('{"ok":true}', {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await performMatrixRequest({
      homeserver: "http://127.0.0.1:8008",
      accessToken: "token",
      method: "GET",
      endpoint: "/_matrix/client/v3/account/whoami",
      timeoutMs: 5000,
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    expect(result.text).toBe('{"ok":true}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      (fetchMock.mock.calls[0]?.[1] as RequestInit & { dispatcher?: unknown })?.dispatcher,
    ).toBeDefined();
    expect(
      (fetchMock.mock.calls[1]?.[1] as RequestInit & { dispatcher?: unknown })?.dispatcher,
    ).toBeUndefined();
  });
});
