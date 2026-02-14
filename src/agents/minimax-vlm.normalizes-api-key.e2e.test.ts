import { afterEach, describe, expect, it, vi } from "vitest";

describe("minimaxUnderstandImage apiKey normalization", () => {
  const priorFetch = global.fetch;

  afterEach(() => {
    // @ts-expect-error restore
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
    // @ts-expect-error mock fetch
    global.fetch = fetchSpy;

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
