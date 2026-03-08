import { afterEach, describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";

describe("minimaxUnderstandImage error hints", () => {
  const priorFetch = global.fetch;

  afterEach(() => {
    global.fetch = priorFetch;
    vi.restoreAllMocks();
  });

  it("includes API key hint on 401", async () => {
    global.fetch = withFetchPreconnect(
      vi.fn(async () => new Response("Unauthorized", { status: 401, statusText: "Unauthorized" })),
    );

    const { minimaxUnderstandImage } = await import("./minimax-vlm.js");
    await expect(
      minimaxUnderstandImage({
        apiKey: "bad-key",
        prompt: "test",
        imageDataUrl: "data:image/png;base64,AAAA",
        apiHost: "https://api.minimax.io",
      }),
    ).rejects.toThrow(/Check that your MiniMax API key is valid/);
  });

  it("includes permission hint on 403", async () => {
    global.fetch = withFetchPreconnect(
      vi.fn(async () => new Response("Forbidden", { status: 403, statusText: "Forbidden" })),
    );

    const { minimaxUnderstandImage } = await import("./minimax-vlm.js");
    await expect(
      minimaxUnderstandImage({
        apiKey: "limited-key",
        prompt: "test",
        imageDataUrl: "data:image/png;base64,AAAA",
        apiHost: "https://api.minimax.io",
      }),
    ).rejects.toThrow(/lack the required permissions/);
  });

  it("includes rate limit hint on 429", async () => {
    global.fetch = withFetchPreconnect(
      vi.fn(
        async () =>
          new Response("Too Many Requests", { status: 429, statusText: "Too Many Requests" }),
      ),
    );

    const { minimaxUnderstandImage } = await import("./minimax-vlm.js");
    await expect(
      minimaxUnderstandImage({
        apiKey: "some-key",
        prompt: "test",
        imageDataUrl: "data:image/png;base64,AAAA",
        apiHost: "https://api.minimax.io",
      }),
    ).rejects.toThrow(/rate limit exceeded/i);
  });
});
