// Qa Lab Matrix tests cover request behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestMatrixJson, type MatrixQaFetchLike } from "./request.js";

describe("requestMatrixJson", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("caps oversized request timeouts before creating the abort signal", async () => {
    const signal = AbortSignal.abort();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    const fetchImpl = vi.fn<MatrixQaFetchLike>(async () => Response.json({ ok: true }));

    await requestMatrixJson({
      baseUrl: "https://matrix.example.test",
      endpoint: "/_matrix/client/v3/account/whoami",
      fetchImpl,
      method: "GET",
      timeoutMs: MAX_TIMER_TIMEOUT_MS + 1_000_000,
    });

    expect(timeoutSpy).toHaveBeenCalledWith(MAX_TIMER_TIMEOUT_MS);
    expect(fetchImpl).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ signal }));
  });

  it.each([200, 500])("cancels an over-cap response before handling HTTP %s", async (status) => {
    const chunkSize = 1024 * 1024;
    const chunkCount = 32;
    let reads = 0;
    let canceled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        controller.enqueue(encoder.encode("a".repeat(chunkSize)));
        if (reads >= chunkCount) {
          controller.close();
        }
      },
      cancel() {
        canceled = true;
      },
    });
    const fetchImpl = vi.fn<MatrixQaFetchLike>(
      async () =>
        new Response(stream, {
          status,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(
      requestMatrixJson({
        baseUrl: "https://matrix.example.test",
        endpoint: "/_matrix/client/v3/sync",
        fetchImpl,
        method: "GET",
      }),
    ).rejects.toThrow(/Matrix homeserver response exceeds 16777216 bytes/);

    expect(canceled).toBe(true);
    expect(reads).toBeLessThan(chunkCount);
  });

  it("still falls back to an empty body for malformed in-bounds JSON", async () => {
    const fetchImpl = vi.fn<MatrixQaFetchLike>(
      async () =>
        new Response("{ not valid json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await requestMatrixJson<{ ok?: boolean }>({
      baseUrl: "https://matrix.example.test",
      endpoint: "/_matrix/client/v3/account/whoami",
      fetchImpl,
      method: "GET",
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({});
  });

  it("reads a large in-bounds JSON body unchanged", async () => {
    const filler = "x".repeat(8 * 1024 * 1024);
    const payload = JSON.stringify({ data: filler });
    const fetchImpl = vi.fn<MatrixQaFetchLike>(
      async () =>
        new Response(payload, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await requestMatrixJson<{ data: string }>({
      baseUrl: "https://matrix.example.test",
      endpoint: "/_matrix/client/v3/sync",
      fetchImpl,
      method: "GET",
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ data: filler });
  });
});
