import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../../../test-support/hanging-loopback-server.js";

const authMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
  resolveBrowserControlAuth: vi.fn(() => ({})),
  getBridgeAuthForPort: vi.fn(() => undefined),
}));

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/runtime-config-snapshot")
  >("openclaw/plugin-sdk/runtime-config-snapshot");
  return { ...actual, readRuntimeConfig: authMocks.loadConfig, loadConfig: authMocks.loadConfig };
});
vi.mock("./control-auth.js", () => ({
  resolveBrowserControlAuth: authMocks.resolveBrowserControlAuth,
}));
vi.mock("./bridge-auth-registry.js", () => ({
  getBridgeAuthForPort: authMocks.getBridgeAuthForPort,
}));

const { fetchBrowserJson } = await import("./client-fetch.js");

const BROWSER_SUCCESS_BODY_LIMIT_BYTES = 32 * 1024 * 1024;
const MALFORMED_UTF8_STATUSES = [200, 401, 408, 500, 504] as const;

function streamState() {
  return { ...Promise.withResolvers<void>(), completed: false };
}

function streamBody(
  res: http.ServerResponse,
  success: boolean,
  state: ReturnType<typeof streamState>,
) {
  const chunk = Buffer.alloc((success ? 64 : 4) * 1024, "x");
  const total = (success ? 33 : 1) * 1024 * 1024;
  let written = 0;
  let closed = false;
  res.once("close", () => {
    closed = true;
    state.resolve();
  });
  res.writeHead(success ? 200 : 500, {
    "Content-Type": success ? "application/json" : "text/plain",
  });
  if (success) {
    res.write('{"payload":"');
  }
  const writeNext = () => {
    if (closed) {
      return;
    }
    if (written >= total) {
      state.completed = true;
      res.end(success ? '"}' : undefined);
      return;
    }
    const next = chunk.subarray(0, total - written);
    written += next.byteLength;
    // Preserve separate event-loop turns and backpressure without wall-clock sleeps.
    if (res.write(next)) {
      setImmediate(writeNext);
    } else {
      res.once("drain", () => setImmediate(writeNext));
    }
  };
  writeNext();
}

describe("fetchHttpJson error body boundary", () => {
  let server: http.Server;
  let baseUrl: string;
  const fetchRoute = (route: string) => fetchBrowserJson(`${baseUrl}/${route}`);
  let streams: Record<"large" | "success-large", ReturnType<typeof streamState>>;
  let malformedConnectionClosed: Map<number, ReturnType<typeof Promise.withResolvers<void>>>;

  beforeEach(async () => {
    for (const scheme of ["ALL", "HTTP", "HTTPS"]) {
      vi.stubEnv(`${scheme}_PROXY`, "");
      vi.stubEnv(`${scheme.toLowerCase()}_proxy`, "");
    }

    vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "0");
    streams = { large: streamState(), "success-large": streamState() };
    malformedConnectionClosed = new Map(
      MALFORMED_UTF8_STATUSES.map((status) => [status, Promise.withResolvers<void>()]),
    );
    server = http.createServer((req, res) => {
      if (req.url === "/rate-limit") {
        req.socket.once("close", () => streams.large.resolve());
        res.writeHead(429, { "Content-Type": "application/json" });
        res.write('{"error":"rate-limited"');
        return;
      }
      const malformedStatus = Number(req.url?.match(/^\/malformed-utf8\/(\d+)$/)?.[1]);
      if (MALFORMED_UTF8_STATUSES.some((status) => status === malformedStatus)) {
        req.socket.once("close", () => malformedConnectionClosed.get(malformedStatus)?.resolve());
        res.writeHead(malformedStatus, { "Content-Type": "application/json" });
        // Latin-1 emits a literal 0xff byte, invalid in UTF-8.
        res.end(Buffer.from('{"error":"control \xff"}', "latin1"));
        return;
      }
      if (req.url === "/navigation-blocked") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "browser navigation blocked by policy",
            reason: "navigation_blocked",
            details: { url: "http://internal.example/admin" },
          }),
        );
        return;
      }

      const success = req.url === "/success-large";
      streamBody(res, success, streams[success ? "success-large" : "large"]);
    });
    const port = await listenOnLoopback(server);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("rejects 429 and closes the hanging loopback socket", async ({ signal }) => {
    await expect(fetchBrowserJson(`${baseUrl}/rate-limit`, { signal })).rejects.toThrow(
      /rate[ -]?limit/i,
    );
    await streams.large.promise;
  });

  it.each([
    ["large", "HTTP 500"],
    [
      "success-large",
      `Browser control response exceeded ${BROWSER_SUCCESS_BODY_LIMIT_BYTES} bytes`,
    ],
  ] as const)("cancels overflowing %s responses and releases fetch", async (route, message) => {
    const error = await fetchBrowserJson(`${baseUrl}/${route}`).catch((err: unknown) => err);
    expect(error).toMatchObject({ name: "BrowserServiceError", message });
    await expect(streams[route].promise).resolves.toBeUndefined();
    expect(streams[route].completed).toBe(false);
  });

  it("rejects malformed UTF-8 responses, preserves retry policy, and releases each fetch", async () => {
    for (const status of MALFORMED_UTF8_STATUSES) {
      const error = await fetchRoute(`malformed-utf8/${status}`).catch((err: unknown) => err);

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
      const connectionClosed = malformedConnectionClosed.get(status);
      expect(connectionClosed).toBeDefined();
      await expect(connectionClosed?.promise).resolves.toBeUndefined();
    }
  });

  it("preserves a navigation denial without exposing raw policy details over HTTP", async () => {
    const error = await fetchRoute("navigation-blocked").catch((err: unknown) => err);

    expect(error).toMatchObject({
      name: "BrowserServiceError",
      message: "browser navigation blocked by policy",
      reason: "navigation_blocked",
      status: 400,
      details: undefined,
    });
  });
});
