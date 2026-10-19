// Qa Lab Matrix tests cover request behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockMatrixQaHttp } from "./http.test-support.js";
import { requestMatrixJson } from "./request.js";

describe("requestMatrixJson", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("caps oversized request timeouts before creating the abort signal", async () => {
    const signal = AbortSignal.abort();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));

    const http = mockMatrixQaHttp(fetchImpl);

    await requestMatrixJson({
      baseUrl: "https://matrix.example.test",
      endpoint: "/_matrix/client/v3/account/whoami",
      method: "GET",
      timeoutMs: MAX_TIMER_TIMEOUT_MS + 1_000_000,
    });

    expect(timeoutSpy).toHaveBeenCalledWith(MAX_TIMER_TIMEOUT_MS);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://matrix.example.test/_matrix/client/v3/account/whoami",
      expect.objectContaining({ signal }),
    );
    expect(http.release).toHaveBeenCalledOnce();
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
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(stream, {
          status,
          headers: { "content-type": "application/json" },
        }),
    );

    const http = mockMatrixQaHttp(fetchImpl);

    await expect(
      requestMatrixJson({
        baseUrl: "https://matrix.example.test",
        endpoint: "/_matrix/client/v3/sync",
        method: "GET",
      }),
    ).rejects.toThrow(/Matrix homeserver response exceeds 16777216 bytes/);

    expect(canceled).toBe(true);
    expect(reads).toBeLessThan(chunkCount);
    expect(http.release).toHaveBeenCalledOnce();
  });

  it("still falls back to an empty body for malformed in-bounds JSON", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response("{ not valid json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    mockMatrixQaHttp(fetchImpl);

    const result = await requestMatrixJson<{ ok?: boolean }>({
      baseUrl: "https://matrix.example.test",
      endpoint: "/_matrix/client/v3/account/whoami",
      method: "GET",
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({});
  });

  it("reads a large in-bounds JSON body unchanged", async () => {
    const filler = "x".repeat(8 * 1024 * 1024);
    const payload = JSON.stringify({ data: filler });
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(payload, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    mockMatrixQaHttp(fetchImpl);

    const result = await requestMatrixJson<{ data: string }>({
      baseUrl: "https://matrix.example.test",
      endpoint: "/_matrix/client/v3/sync",
      method: "GET",
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ data: filler });
  });
});
