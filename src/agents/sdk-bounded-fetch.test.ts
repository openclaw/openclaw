import { describe, expect, it } from "vitest";
import { createSdkBoundedFetch, testing } from "./sdk-bounded-fetch.js";

const SIXTEEN_MB = 16 * 1024 * 1024;

describe("createSdkBoundedFetch", () => {
  it("passes through non-SSE responses unchanged", async () => {
    const body = JSON.stringify({ ok: true });
    const mockFetch: typeof fetch = async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const boundedFetch = createSdkBoundedFetch(mockFetch);
    const response = await boundedFetch("https://example.com/api");

    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe(body);
    expect(response.status).toBe(200);
  });

  it("passes through SSE responses that fit within the cap", async () => {
    const chunks = [new TextEncoder().encode("data: hello\n\n")];
    const mockFetch: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            const chunk = chunks.shift();
            if (chunk) {
              controller.enqueue(chunk);
            } else {
              controller.close();
            }
          },
        }),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );

    const boundedFetch = createSdkBoundedFetch(mockFetch, { maxBytes: 1024 });
    const response = await boundedFetch("https://example.com/stream");
    const text = await response.text();

    expect(text).toBe("data: hello\n\n");
  });

  it("caps oversized SSE responses and cancels the upstream stream", async () => {
    const cap = 2048;
    const chunkSize = 1024;
    let upstreamPulls = 0;
    let upstreamCancelled = false;

    const mockFetch: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            upstreamPulls++;
            if (upstreamPulls > 20) {
              controller.close();
              return;
            }
            controller.enqueue(new Uint8Array(chunkSize));
          },
          cancel() {
            upstreamCancelled = true;
          },
        }),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );

    const boundedFetch = createSdkBoundedFetch(mockFetch, { maxBytes: cap });
    const response = await boundedFetch("https://example.com/stream");
    const reader = response.body!.getReader();

    // Read chunks until the stream ends or errors
    let totalRead = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        totalRead += value.byteLength;
      }
    } catch {
      // Stream errored — expected when cap is exceeded
    }

    // Should have delivered at most cap + one chunk (runoff allowed)
    expect(totalRead).toBeLessThanOrEqual(cap + chunkSize);

    // Should NOT have read all upstream chunks — the cap stopped it early
    expect(upstreamPulls).toBeLessThan(20);

    // Upstream stream must have been cancelled
    expect(upstreamCancelled).toBe(true);
  });

  it("does not cap non-ok SSE responses", async () => {
    const bodyText = "error details";
    const mockFetch: typeof fetch = async () =>
      new Response(bodyText, {
        status: 500,
        headers: { "content-type": "text/event-stream" },
      });

    const boundedFetch = createSdkBoundedFetch(mockFetch, { maxBytes: 1 });
    const response = await boundedFetch("https://example.com/stream");

    // Error response body passes through unchanged even though 1 byte cap
    // would have been exceeded
    expect(await response.text()).toBe(bodyText);
    expect(response.status).toBe(500);
  });

  it("caps at the default 16 MiB when no explicit maxBytes is given", () => {
    expect(testing.DEFAULT_SSE_STREAM_MAX_BYTES).toBe(SIXTEEN_MB);
  });
});

describe("isSseContentType", () => {
  it("matches text/event-stream", () => {
    expect(testing.isSseContentType("text/event-stream")).toBe(true);
  });

  it("matches text/event-stream with charset", () => {
    expect(testing.isSseContentType("text/event-stream; charset=utf-8")).toBe(true);
  });

  it("rejects application/json", () => {
    expect(testing.isSseContentType("application/json")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(testing.isSseContentType("")).toBe(false);
  });
});
