import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockMatrixQaHttp } from "./http.test-support.js";
import { requestMatrixJson } from "./request.js";

const request = <T = unknown>(params: Partial<Parameters<typeof requestMatrixJson>[0]> = {}) =>
  requestMatrixJson<T>({
    baseUrl: "https://matrix.example.test",
    endpoint: "/_matrix/client/v3/account/whoami",
    method: "GET",
    ...params,
  });

function mockResponse(body: BodyInit, status = 200) {
  return mockMatrixQaHttp(
    vi.fn<typeof fetch>(
      async () => new Response(body, { status, headers: { "content-type": "application/json" } }),
    ),
  );
}

describe("requestMatrixJson", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("caps oversized request timeouts before creating the abort signal", async () => {
    const signal = AbortSignal.abort();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));

    const http = mockMatrixQaHttp(fetchImpl);

    await request({ timeoutMs: MAX_TIMER_TIMEOUT_MS + 1_000_000 });

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
    const http = mockResponse(stream, status);

    await expect(request({ endpoint: "/_matrix/client/v3/sync" })).rejects.toThrow(
      /Matrix homeserver response exceeds 16777216 bytes/,
    );

    expect(canceled).toBe(true);
    expect(reads).toBeLessThan(chunkCount);
    expect(http.release).toHaveBeenCalledOnce();
  });

  it("still falls back to an empty body for malformed in-bounds JSON", async () => {
    mockResponse("{ not valid json");
    const result = await request<{ ok?: boolean }>();

    expect(result).toEqual({ status: 200, body: {} });
  });

  it("reads a large in-bounds JSON body unchanged", async () => {
    const filler = "x".repeat(8 * 1024 * 1024);
    const payload = JSON.stringify({ data: filler });
    mockResponse(payload);
    const result = await request<{ data: string }>({ endpoint: "/_matrix/client/v3/sync" });

    expect(result).toEqual({ status: 200, body: { data: filler } });
  });
});
