import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
  resolveBrowserControlAuth: vi.fn(() => ({})),
  getBridgeAuthForPort: vi.fn(() => undefined),
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return { ...actual, getRuntimeConfig: authMocks.loadConfig, loadConfig: authMocks.loadConfig };
});
vi.mock("./control-auth.js", () => ({
  resolveBrowserControlAuth: authMocks.resolveBrowserControlAuth,
}));
vi.mock("./bridge-auth-registry.js", () => ({
  getBridgeAuthForPort: authMocks.getBridgeAuthForPort,
}));

const { fetchBrowserJson } = await import("./client-fetch.js");

const STREAM_CHUNK = Buffer.alloc(4 * 1024, "x");
const STREAM_BODY_BYTES = 1024 * 1024;

describe("fetchHttpJson error body boundary", () => {
  let server: http.Server;
  let baseUrl: string;
  let streamClosed: Promise<void>;
  let resolveStreamClosed: () => void;
  let smallConnectionClosed: Promise<void>;
  let resolveSmallConnectionClosed: () => void;
  let streamCompleted: boolean;

  beforeEach(async () => {
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

    streamClosed = new Promise<void>((resolve) => {
      resolveStreamClosed = resolve;
    });
    smallConnectionClosed = new Promise<void>((resolve) => {
      resolveSmallConnectionClosed = resolve;
    });
    streamCompleted = false;
    server = http.createServer((req, res) => {
      if (req.url === "/small") {
        req.socket.once("close", () => resolveSmallConnectionClosed());
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("session expired");
        return;
      }

      res.writeHead(500, { "Content-Type": "text/plain" });
      let written = 0;
      let closed = false;
      res.once("close", () => {
        closed = true;
        resolveStreamClosed();
      });
      const writeNext = () => {
        if (closed) {
          return;
        }
        if (written >= STREAM_BODY_BYTES) {
          streamCompleted = true;
          res.end();
          return;
        }
        written += STREAM_CHUNK.byteLength;
        const writeMore = () => setTimeout(writeNext, 2);
        if (res.write(STREAM_CHUNK)) {
          writeMore();
        } else {
          res.once("drain", writeMore);
        }
      };
      writeNext();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback server address");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("cancels an overflowing stream and releases the guarded fetch", async () => {
    const error = await fetchBrowserJson(`${baseUrl}/large`).catch((err: unknown) => err);

    expect(error).toMatchObject({ name: "BrowserServiceError", message: "HTTP 500" });
    await expect(streamClosed).resolves.toBeUndefined();
    expect(streamCompleted).toBe(false);
  });

  it("preserves a complete diagnostic body within the limit", async () => {
    const error = await fetchBrowserJson(`${baseUrl}/small`).catch((err: unknown) => err);

    expect(error).toMatchObject({
      name: "BrowserServiceError",
      message: "session expired",
    });
    await expect(smallConnectionClosed).resolves.toBeUndefined();
  });
});
