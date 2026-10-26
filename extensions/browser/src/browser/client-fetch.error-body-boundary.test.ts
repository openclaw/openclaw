import http from "node:http";
import { Readable, pipeline } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import "./client-fetch.auth.test-support.js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { listenOnLoopback } from "../../../test-support/hanging-loopback-server.js";

const { fetchBrowserJson } = await import("./client-fetch.js");

const BROWSER_SUCCESS_BODY_LIMIT_BYTES = 32 * 1024 * 1024;
const MALFORMED_UTF8_STATUSES = [200, 401, 408, 500, 504] as const;

function streamBody(res: http.ServerResponse, success: boolean, state: { completed: boolean }) {
  const chunk = Buffer.alloc((success ? 64 : 4) * 1024, "x");
  const total = (success ? 33 : 1) * 1024 * 1024;
  res.writeHead(success ? 200 : 500, {
    "Content-Type": success ? "application/json" : "text/plain",
  });
  pipeline(
    Readable.from(
      (async function* () {
        if (success) {
          yield '{"payload":"';
        }
        for (let written = 0; written < total; written += chunk.length) {
          yield chunk.subarray(0, total - written);
          await nextTurn();
        }
        state.completed = true;
        if (success) {
          yield '"}';
        }
      })(),
    ),
    res,
    () => {}, // Cancellation is expected; the test observes the socket and completion state.
  );
}

async function serve(body: (res: http.ServerResponse) => void) {
  const closed = Promise.withResolvers<void>();
  const server = http.createServer((req, res) => {
    req.socket.once("close", closed.resolve);
    body(res);
  });
  const port = await listenOnLoopback(server);
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
  return {
    closed: closed.promise,
    fetch: (init?: Parameters<typeof fetchBrowserJson>[1]) =>
      fetchBrowserJson(`http://127.0.0.1:${port}/`, init),
  };
}

describe("fetchHttpJson error body boundary", () => {
  beforeEach(() => {
    for (const scheme of ["ALL", "HTTP", "HTTPS"]) {
      vi.stubEnv(`${scheme}_PROXY`, "");
      vi.stubEnv(`${scheme.toLowerCase()}_proxy`, "");
    }

    vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "0");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("rejects 429 and closes the hanging loopback socket", async ({ signal }) => {
    const server = await serve((res) => {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.write('{"error":"rate-limited"');
    });
    await expect(server.fetch({ signal })).rejects.toThrow(/rate[ -]?limit/i);
    await server.closed;
  });

  it.each([
    [false, "HTTP 500"],
    [true, `Browser control response exceeded ${BROWSER_SUCCESS_BODY_LIMIT_BYTES} bytes`],
  ] as const)("cancels overflowing responses (success=%s)", async (success, message) => {
    const state = { completed: false };
    const server = await serve((res) => streamBody(res, success, state));
    const error = await server.fetch().catch((err: unknown) => err);
    expect(error).toMatchObject({ name: "BrowserServiceError", message });
    await server.closed;
    expect(state.completed).toBe(false);
  });

  it("rejects malformed UTF-8 responses, preserves retry policy, and releases each fetch", async () => {
    for (const status of MALFORMED_UTF8_STATUSES) {
      const server = await serve((res) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        // Latin-1 emits a literal 0xff byte, invalid in UTF-8.
        res.end(Buffer.from('{"error":"control \xff"}', "latin1"));
      });
      const error = await server.fetch().catch((err: unknown) => err);

      expect(error).toMatchObject({ name: "BrowserServiceError", status });
      const message = error instanceof Error ? error.message : "";
      expect(message).toContain(`Browser control response was not valid UTF-8 (HTTP ${status})`);
      if (status === 401) {
        expect(message).toContain("Do NOT retry the browser tool");
      } else if (status === 408 || status === 504) {
        expect(message).toContain("Retry the browser tool once");
      } else {
        expect(message).not.toContain("Retry the browser tool");
      }
      await server.closed;
    }
  });
});
