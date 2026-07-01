import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Replace fetchWithSsrFGuard with a lightweight pass-through so the test
// can drive fetch against a real loopback HTTP server.
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: async (params: {
      url: string;
      init?: RequestInit;
      signal?: AbortSignal;
    }) => ({
      response: await fetch(params.url, { ...params.init, signal: params.signal }),
      finalUrl: params.url,
      release: async () => {},
    }),
  };
});

// Override the token URL to hit our loopback server by intercepting
// at the fetch call.
const origFetch = globalThis.fetch;

const CHUNK = Buffer.alloc(64 * 1024, "X");

describe("openai oauth error body boundary", () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      let written = 0;
      function write() {
        if (written >= 4 * 1024 * 1024) { res.end(); return; }
        const ok = res.write(CHUNK);
        written += CHUNK.length;
        if (ok) setImmediate(write);
        else res.once("drain", write);
      }
      write();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("bounds token refresh error body at 16 KiB", async () => {
    // Intercept the fetch call so the OAuth token URL goes to our server.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("auth.openai.com/oauth/token")) {
        return await origFetch(`http://127.0.0.1:${port}/`, init);
      }
      return await origFetch(input, init);
    });

    const { refreshOpenAICodexToken } = await import("./openai-chatgpt-oauth-flow.runtime.js");
    const result = await refreshOpenAICodexToken("stale-refresh-token").catch(
      (e: unknown) => e,
    );

    // refreshTokensForCodex returns {type: "failed", status, message}
    // on HTTP errors, or throws for transport errors.
    const msg =
      result && typeof result === "object" && "message" in result
        ? (result as { message: string }).message
        : result instanceof Error
          ? result.message
          : String(result);
    expect(Buffer.byteLength(msg, "utf8")).toBeLessThan(32 * 1024);
    expect(msg).toContain("X");
  });
});
