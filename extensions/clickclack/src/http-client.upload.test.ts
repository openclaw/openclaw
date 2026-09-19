import { describe, expect, it, vi } from "vitest";
import { createClickClackClient } from "./http-client.js";

function stalledFetch() {
  return vi.fn(
    async (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      }),
  );
}

describe("ClickClack upload HTTP client", () => {
  it("carries account cancellation into upload consumption", async () => {
    const fetchMock = stalledFetch();
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "placeholder",
      fetch: fetchMock,
    });
    const abort = new AbortController();

    const pending = client.consumeUpload({
      uploadId: "upl_1",
      signal: abort.signal,
      consume: async () => undefined,
    });
    abort.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://clickclack.example/api/uploads/upl_1",
      expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }),
    );
  });

  it("bounds stalled upload response acquisition", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = stalledFetch();
      const client = createClickClackClient({
        baseUrl: "https://clickclack.example",
        token: "placeholder",
        fetch: fetchMock,
      });

      const pending = client.consumeUpload({
        uploadId: "upl_stalled",
        consume: async () => undefined,
      });
      const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(30_000);

      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });
});
