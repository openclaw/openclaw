// Control: uncaptured HTTP responses still release their socket when the body never ends.
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  resolveBrowserControlAuth: vi.fn(() => ({})),
  getBridgeAuthForPort: vi.fn(() => undefined),
}));

vi.mock("./control-auth.js", () => ({
  resolveBrowserControlAuth: authMocks.resolveBrowserControlAuth,
}));
vi.mock("./bridge-auth-registry.js", () => ({
  getBridgeAuthForPort: authMocks.getBridgeAuthForPort,
}));

const { fetchBrowserJson } = await import("./client-fetch.js");

describe("fetchBrowserJson rate-limit hanging-body transport", () => {
  let server: http.Server;
  let baseUrl: string;
  let socketClosed: Promise<void>;
  let resolveSocketClosed: () => void;

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
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "0");
    socketClosed = new Promise<void>((resolve) => {
      resolveSocketClosed = resolve;
    });
    server = http.createServer((_req, res) => {
      res.socket?.once("close", () => resolveSocketClosed());
      res.writeHead(429, { "Content-Type": "application/json" });
      // Keep the response open so consuming it cannot release the socket.
      res.write('{"error":"rate-limited"');
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback TCP address");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  });

  it("rejects 429 and closes the hanging loopback socket", async ({ signal }) => {
    await expect(fetchBrowserJson(`${baseUrl}/ok`, { signal })).rejects.toThrow(/rate[ -]?limit/i);
    await socketClosed;
  });
});
