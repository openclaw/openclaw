import { afterEach, describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { minimaxUnderstandImage } from "./minimax-vlm.js";

describe("minimaxUnderstandImage response boundaries", () => {
  const priorFetch = global.fetch;

  afterEach(() => {
    global.fetch = priorFetch;
    vi.restoreAllMocks();
  });

  it("accepts provider success JSON below the shared cap", async () => {
    const content = "bounded-response-ok";
    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          base_resp: { status_code: 0 },
          content,
          padding: "x".repeat(5 * 1024 * 1024),
        }),
        { status: 200 },
      );
    });
    global.fetch = withFetchPreconnect(fetchSpy);

    await expect(
      minimaxUnderstandImage({
        apiKey: "minimax-test-key",
        prompt: "hi",
        imageDataUrl: "data:image/png;base64,AAAA",
        apiHost: "https://api.minimax.io",
      }),
    ).resolves.toBe(content);
  });

  it("bounds large provider success response bodies", async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16 * 1024 * 1024));
        controller.enqueue(new TextEncoder().encode("tail-marker"));
      },
      cancel() {
        canceled = true;
      },
    });
    const fetchSpy = vi.fn(async () => {
      return new Response(body, {
        status: 200,
        headers: { "Trace-Id": "trace-456" },
      });
    });
    global.fetch = withFetchPreconnect(fetchSpy);

    const error = await minimaxUnderstandImage({
      apiKey: "minimax-test-key",
      prompt: "hi",
      imageDataUrl: "data:image/png;base64,AAAA",
      apiHost: "https://api.minimax.io",
    }).catch((caught: unknown) => caught);

    if (!(error instanceof Error)) {
      throw new Error("expected MiniMax VLM request to throw an Error");
    }
    expect(error.message).toContain(
      "MiniMax VLM response [Trace-Id=trace-456]: JSON response exceeds 16777216 bytes",
    );
    expect(error.message).not.toContain("tail-marker");
    expect(canceled).toBe(true);
  });
});
