import { describe, expect, it, vi } from "vitest";
import { createClickClackClient } from "./http-client.js";

function createSignalAbortedJsonResponse(signal: AbortSignal): {
  response: Response;
  wasAborted: () => boolean;
} {
  let aborted = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const abortBody = () => {
        aborted = true;
        controller.error(signal.reason ?? new Error("body aborted"));
      };
      if (signal.aborted) {
        abortBody();
        return;
      }
      signal.addEventListener("abort", abortBody, { once: true });
    },
    async pull() {
      await new Promise<void>(() => {});
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    wasAborted: () => aborted,
  };
}

describe("ClickClack HTTP response timeout", () => {
  it("keeps the REST request deadline active while reading a hanging response body", async () => {
    vi.useFakeTimers();
    let body: ReturnType<typeof createSignalAbortedJsonResponse> | undefined;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) {
        throw new Error("expected ClickClack client to pass an AbortSignal");
      }
      const responseBody = createSignalAbortedJsonResponse(signal);
      body = responseBody;
      return responseBody.response;
    });
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "placeholder",
      fetch: fetchMock as unknown as typeof fetch,
    });

    try {
      const pending = client.me().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(30_000);
      const error = await pending;

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("request timed out");
      expect(error).toMatchObject({
        status: 200,
        request: { method: "GET", path: "/api/me" },
      });
      expect(body?.wasAborted()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
