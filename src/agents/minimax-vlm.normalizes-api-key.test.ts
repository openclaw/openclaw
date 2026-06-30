// Covers MiniMax VLM auth/header normalization, provider-specific routing,
// and bounded JSON response enforcement including oversized-response rejection.
import * as http from "node:http";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { isMinimaxVlmModel, minimaxUnderstandImage } from "./minimax-vlm.js";

describe("minimaxUnderstandImage apiKey normalization", () => {
  const priorFetch = global.fetch;
  const priorMinimaxApiHost = process.env.MINIMAX_API_HOST;
  const apiResponse = JSON.stringify({
    base_resp: { status_code: 0, status_msg: "ok" },
    content: "ok",
  });

  afterEach(() => {
    global.fetch = priorFetch;
    if (priorMinimaxApiHost === undefined) {
      delete process.env.MINIMAX_API_HOST;
    } else {
      process.env.MINIMAX_API_HOST = priorMinimaxApiHost;
    }
    vi.restoreAllMocks();
  });

  async function runNormalizationCase(apiKey: string) {
    // Headers must be Latin-1 and line-break free; normalize user/API-key
    // input before constructing the Authorization header.
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      expect(auth).toBe("Bearer minimax-test-key");

      return new Response(apiResponse, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    global.fetch = withFetchPreconnect(fetchSpy);

    const text = await minimaxUnderstandImage({
      apiKey,
      prompt: "hi",
      imageDataUrl: "data:image/png;base64,AAAA",
      apiHost: "https://api.minimax.io",
    });

    expect(text).toBe("ok");
    expect(fetchSpy).toHaveBeenCalledOnce();
  }

  it("strips embedded CR/LF before sending Authorization header", async () => {
    await runNormalizationCase("minimax-test-\r\nkey");
  });

  it("drops non-Latin1 characters from apiKey before sending Authorization header", async () => {
    await runNormalizationCase("minimax-\u0417\u2502test-key");
  });

  it("keeps trusted MINIMAX_API_HOST env fallback for VLM routing", async () => {
    process.env.MINIMAX_API_HOST = "https://api.minimaxi.com";
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const requestUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      expect(requestUrl).toBe("https://api.minimaxi.com/v1/coding_plan/vlm");
      return new Response(apiResponse, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    global.fetch = withFetchPreconnect(fetchSpy);

    await expect(
      minimaxUnderstandImage({
        apiKey: "minimax-test-key",
        prompt: "hi",
        imageDataUrl: "data:image/png;base64,AAAA",
      }),
    ).resolves.toBe("ok");

    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it.each(["minimax-cn", "minimax-portal-cn"])(
    "routes %s to the CN VLM host by default",
    async (provider) => {
      const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
        const requestUrl =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        expect(requestUrl).toBe("https://api.minimaxi.com/v1/coding_plan/vlm");
        return new Response(apiResponse, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
      global.fetch = withFetchPreconnect(fetchSpy);

      await expect(
        minimaxUnderstandImage({
          apiKey: "minimax-test-key",
          provider,
          prompt: "hi",
          imageDataUrl: "data:image/png;base64,AAAA",
        }),
      ).resolves.toBe("ok");

      expect(fetchSpy).toHaveBeenCalledOnce();
    },
  );

  it.each(["minimax-cn", "minimax-portal-cn"])(
    "keeps %s on the CN VLM host when the configured host is malformed",
    async (provider) => {
      const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
        const requestUrl =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        expect(requestUrl).toBe("https://api.minimaxi.com/v1/coding_plan/vlm");
        return new Response(apiResponse, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
      global.fetch = withFetchPreconnect(fetchSpy);

      await expect(
        minimaxUnderstandImage({
          apiKey: "minimax-test-key",
          provider,
          apiHost: "https://[",
          prompt: "hi",
          imageDataUrl: "data:image/png;base64,AAAA",
        }),
      ).resolves.toBe("ok");

      expect(fetchSpy).toHaveBeenCalledOnce();
    },
  );

  it("uses the caller-provided request timeout", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchSpy = vi.fn(async () => {
      return new Response(apiResponse, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    global.fetch = withFetchPreconnect(fetchSpy);

    await expect(
      minimaxUnderstandImage({
        apiKey: "minimax-test-key",
        prompt: "hi",
        imageDataUrl: "data:image/png;base64,AAAA",
        apiHost: "https://api.minimax.io",
        timeoutMs: 180_000,
      }),
    ).resolves.toBe("ok");

    expect(timeoutSpy).toHaveBeenCalledOnce();
    expect(timeoutSpy).toHaveBeenCalledWith(180_000);
  });

  it("uses the default request timeout for non-positive caller timeouts", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchSpy = vi.fn(async () => {
      return new Response(apiResponse, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    global.fetch = withFetchPreconnect(fetchSpy);

    await expect(
      minimaxUnderstandImage({
        apiKey: "minimax-test-key",
        prompt: "hi",
        imageDataUrl: "data:image/png;base64,AAAA",
        apiHost: "https://api.minimax.io",
        timeoutMs: 0,
      }),
    ).resolves.toBe("ok");

    expect(timeoutSpy).toHaveBeenCalledOnce();
    expect(timeoutSpy).toHaveBeenCalledWith(60_000);
  });

  it("clamps oversized caller request timeouts before creating the abort signal", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchSpy = vi.fn(async () => {
      return new Response(apiResponse, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    global.fetch = withFetchPreconnect(fetchSpy);

    await expect(
      minimaxUnderstandImage({
        apiKey: "minimax-test-key",
        prompt: "hi",
        imageDataUrl: "data:image/png;base64,AAAA",
        apiHost: "https://api.minimax.io",
        timeoutMs: Number.MAX_SAFE_INTEGER,
      }),
    ).resolves.toBe("ok");

    expect(timeoutSpy).toHaveBeenCalledOnce();
    expect(timeoutSpy).toHaveBeenCalledWith(MAX_TIMER_TIMEOUT_MS);
  });

  it("rejects oversized VLM response bodies, preserves Trace-Id, and cancels the stream", async () => {
    let canceled = false;
    const ONE_MIB = 1024 * 1024;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 18; i++) {
          controller.enqueue(new Uint8Array(ONE_MIB));
        }
        controller.close();
      },
      cancel() {
        canceled = true;
      },
    });
    const fetchSpy = vi.fn(async () => {
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json", "Trace-Id": "trace-abc" },
      });
    });
    global.fetch = withFetchPreconnect(fetchSpy);

    await expect(
      minimaxUnderstandImage({
        apiKey: "minimax-test-key",
        prompt: "hi",
        imageDataUrl: "data:image/png;base64,AAAA",
        apiHost: "https://api.minimax.io",
      }),
    ).rejects.toThrow("MiniMax VLM: JSON response exceeds 16777216 bytes. Trace-Id: trace-abc");

    expect(canceled).toBe(true);
  });

  it("rejects oversized VLM responses from a real HTTP server (behavior proof)", async () => {
    // Real TCP server proof: oversized JSON stream is cancelled mid-flight
    // by the bounded reader before the full body is buffered.
    let bytesWritten = 0;
    let socketDestroyed = false;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      const ONE_MIB = 1024 * 1024;
      const chunk = Buffer.alloc(ONE_MIB, 0x41);
      const writeMore = () => {
        // Stop writing once the client cancels (socket is destroyed).
        if (socketDestroyed) {
          return;
        }
        for (let i = 0; i < 4; i++) {
          if (socketDestroyed) {
            return;
          }
          bytesWritten += chunk.length;
          if (!res.write(chunk)) {
            res.once("drain", writeMore);
            return;
          }
        }
        if (!socketDestroyed) {
          setImmediate(writeMore);
        }
      };
      writeMore();
    });
    server.on("connection", (socket) => {
      socket.on("close", () => {
        socketDestroyed = true;
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as { port: number }).port;

    try {
      await expect(
        minimaxUnderstandImage({
          apiKey: "test-key",
          prompt: "hi",
          imageDataUrl: "data:image/png;base64,AAAA",
          apiHost: `http://127.0.0.1:${port}`,
        }),
      ).rejects.toThrow("MiniMax VLM: JSON response exceeds");
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("bounds large provider error response bodies", async () => {
    // Provider error bodies can be large. Read enough for diagnostics, then
    // cancel the stream so failures stay bounded.
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${"x".repeat(9_000)}tail-marker`));
      },
      cancel() {
        canceled = true;
      },
    });
    const fetchSpy = vi.fn(async () => {
      return new Response(body, {
        status: 500,
        statusText: "Internal Server Error",
        headers: { "Trace-Id": "trace-123" },
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
    expect(error.message).toContain("MiniMax VLM request failed");
    expect(error.message).toContain("Trace-Id: trace-123");
    expect(error.message).not.toContain("tail-marker");
    expect(error.message.length).toBeLessThan(520);
    expect(canceled).toBe(true);
  });
});

describe("isMinimaxVlmModel", () => {
  it("only matches the canonical MiniMax VLM model id", () => {
    expect(isMinimaxVlmModel("minimax", "MiniMax-VL-01")).toBe(true);
    expect(isMinimaxVlmModel("minimax-cn", "MiniMax-VL-01")).toBe(true);
    expect(isMinimaxVlmModel("minimax-portal", "MiniMax-VL-01")).toBe(true);
    expect(isMinimaxVlmModel("minimax-portal-cn", "MiniMax-VL-01")).toBe(true);
    expect(isMinimaxVlmModel("minimax-portal", "custom-vision")).toBe(false);
    expect(isMinimaxVlmModel("openai", "MiniMax-VL-01")).toBe(false);
  });
});
