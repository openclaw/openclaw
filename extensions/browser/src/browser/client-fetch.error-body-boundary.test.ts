/**
 * Boundary test: fetchHttpJson error body is read under a byte cap.
 *
 * Proves that a streaming error response larger than 16 KiB is cancelled
 * mid-stream instead of being fully buffered, preventing OOM on malformed
 * upstream error pages from the browser control service.
 */
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-support/browser-security.mock.js";

// Replace fetchWithSsrFGuard with a lightweight pass-through so the test
// can drive fetchHttpJson against a real loopback HTTP server.  The SSRF
// guard is tested separately; this test keeps the focus on the response
// body boundary.
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
      response: await fetch(params.url, {
        ...params.init,
        signal: params.signal,
      }),
      finalUrl: params.url,
      release: async () => {},
    }),
  };
});

// Config/auth mocks — the test hits a loopback URL so the auth path
// tries to look up config; stub it out to avoid side effects.
const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
  resolveBrowserControlAuth: vi.fn(() => ({})),
  getBridgeAuthForPort: vi.fn(() => undefined),
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return { ...actual, getRuntimeConfig: mocks.loadConfig, loadConfig: mocks.loadConfig };
});

vi.mock("./control-auth.js", () => ({
  resolveBrowserControlAuth: mocks.resolveBrowserControlAuth,
}));

vi.mock("./bridge-auth-registry.js", () => ({
  getBridgeAuthForPort: mocks.getBridgeAuthForPort,
}));

const { fetchBrowserJson } = await import("./client-fetch.js");

/** Streaming chunks are large enough to exceed the 16 KiB cap in one chunk. */
const CHUNK_SIZE = 64 * 1024;

/** Total bytes the server will stream before closing. */
const TOTAL_BODY_SIZE = 4 * 1024 * 1024;

describe("fetchHttpJson error body boundary", () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    vi.restoreAllMocks();
    for (const key of [
      "ALL_PROXY",
      "all_proxy",
      "HTTP_PROXY",
      "http_proxy",
      "HTTPS_PROXY",
      "https_proxy",
    ]) {
      vi.stubEnv(key, "");
    }
    mocks.loadConfig.mockReturnValue({});
    mocks.resolveBrowserControlAuth.mockReturnValue({});
    mocks.getBridgeAuthForPort.mockReturnValue(undefined);

    // Start a loopback server that streams a large error body.
    // No Content-Length header — the client must read until the cap,
    // not until a known size.
    server = http.createServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "text/html" });
      let written = 0;
      const chunk = Buffer.alloc(CHUNK_SIZE, "x");
      function writeChunk() {
        if (written >= TOTAL_BODY_SIZE) {
          res.end();
          return;
        }
        const ok = res.write(chunk);
        written += CHUNK_SIZE;
        if (ok) {
          // Drain the microtask queue so the reader can consume, then
          // schedule the next chunk through setTimeout to avoid starving
          // the event loop when backpressure isn't applied.
          setImmediate(writeChunk);
        } else {
          res.once("drain", writeChunk);
        }
      }
      writeChunk();
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("cancels the stream after 16 KiB on a non-ok response", async () => {
    const url = `http://127.0.0.1:${port}/error`;

    const err = await fetchBrowserJson(url, { timeoutMs: 5000 }).catch((e: unknown) => e);

    // Must throw — the server returned 500.
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;

    // The error body snippet must be bounded at ~16 KiB.  If unguarded,
    // the raw res.text() would buffer the full 4 MiB streaming body
    // into the error message.  This assertion is the core invariant.
    const messageBytes = Buffer.byteLength(message, "utf8");
    expect(messageBytes).toBeLessThan(32 * 1024); // well under 4 MiB
    expect(messageBytes).toBeGreaterThan(0); // body was read

    // The body text should contain a snippet of the padding —
    // readResponseTextLimited returns what it read (up to the cap).
    expect(message).toContain("x");
  });

  it("parses a small JSON success response correctly", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, targetId: "abc" }));
    });
    let p: number;
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    p = (server.address() as { port: number }).port;

    try {
      const result = await fetchBrowserJson<{ ok: boolean; targetId: string }>(
        `http://127.0.0.1:${p}/ok`,
        { timeoutMs: 5000 },
      );
      expect(result).toEqual({ ok: true, targetId: "abc" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("throws on a success response body exceeding 16 MiB", async () => {
    // Stream a JSON body that exceeds 16 MiB.  readResponseWithLimit
    // must cancel the stream at the cap instead of buffering the whole
    // payload.
    const bodySize = 17 * 1024 * 1024; // just over 16 MiB
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      // Emit a JSON array prefix so the stream is valid JSON-shaped,
      // then pad with whitespace to hit the byte cap.
      res.write('{"items":[');
      let written = 2 + 8; // '{"items":[' bytes
      const chunk = Buffer.alloc(64 * 1024, 0x20); // space padding
      while (written < bodySize) {
        const toWrite = Math.min(chunk.length, bodySize - written);
        res.write(toWrite === chunk.length ? chunk : chunk.subarray(0, toWrite));
        written += toWrite;
      }
      res.end("]}");
    });
    let p: number;
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    p = (server.address() as { port: number }).port;

    try {
      const err = await fetchBrowserJson(`http://127.0.0.1:${p}/large`, {
        timeoutMs: 10000,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("exceeds");
      expect((err as Error).message).toContain("16777216"); // 16 MiB
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("preserves the full error body when it fits under the cap", async () => {
    // Small error body: the server returns a short text/plain message.
    const snippetServer = http.createServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("session expired");
    });
    const snippetPort = await new Promise<number>((resolve) => {
      snippetServer.listen(0, "127.0.0.1", () =>
        resolve((snippetServer.address() as { port: number }).port),
      );
    });

    try {
      const err = await fetchBrowserJson(`http://127.0.0.1:${snippetPort}/err`, {
        timeoutMs: 5000,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("session expired");
    } finally {
      await new Promise<void>((resolve) => {
        snippetServer.close(() => resolve());
      });
    }
  });
});
