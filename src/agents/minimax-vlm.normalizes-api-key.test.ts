import { afterEach, describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";

describe("minimaxUnderstandImage apiKey normalization", () => {
  const priorFetch = global.fetch;

  afterEach(() => {
    global.fetch = priorFetch;
    vi.restoreAllMocks();
  });

  it("strips embedded CR/LF before sending Authorization header", async () => {
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      expect(auth).toBe("Bearer minimax-test-key");

      return new Response(
        JSON.stringify({
          base_resp: { status_code: 0, status_msg: "ok" },
          content: "ok",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    global.fetch = withFetchPreconnect(fetchSpy);

    const { minimaxUnderstandImage } = await import("./minimax-vlm.js");
    const text = await minimaxUnderstandImage({
      apiKey: "minimax-test-\r\nkey",
      prompt: "hi",
      imageDataUrl: "data:image/png;base64,AAAA",
      apiHost: "https://api.minimax.io",
    });

    expect(text).toBe("ok");
    expect(fetchSpy).toHaveBeenCalled();
  });
});

describe("isMinimaxVlmModel", () => {
  it("only matches the canonical MiniMax VLM model id", async () => {
    const { isMinimaxVlmModel } = await import("./minimax-vlm.js");

    expect(isMinimaxVlmModel("minimax", "MiniMax-VL-01")).toBe(true);
    expect(isMinimaxVlmModel("minimax-portal", "MiniMax-VL-01")).toBe(true);
    expect(isMinimaxVlmModel("minimax-portal", "custom-vision")).toBe(false);
    expect(isMinimaxVlmModel("openai", "MiniMax-VL-01")).toBe(false);
  });
});
