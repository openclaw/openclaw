// Real HTTP: production fetchBrowserJson must cancel an unread 429 body and
// release the loopback socket without awaiting a never-ending stream.
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

describe("fetchBrowserJson rate-limit hanging-body transport", () => {
  let server: http.Server;
  let baseUrl: string;
  let socketClosed: Promise<void>;
  let resolveSocketClosed: () => void;

  beforeEach(async () => {
    for (const key of ["ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"]) {
      vi.stubEnv(key, "");
    }
    socketClosed = new Promise<void>((resolve) => {
      resolveSocketClosed = resolve;
    });
    server = http.createServer((_req, res) => {
      res.socket?.once("close", () => resolveSocketClosed());
      res.writeHead(429, { "Content-Type": "application/json" });
      // Leave the body unread so production discardResponseBody must cancel it.
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

  it("rejects 429 and closes the hanging loopback socket", async () => {
    const startedAt = Date.now();
    await expect(fetchBrowserJson(`${baseUrl}/ok`, { timeoutMs: 2_000 })).rejects.toThrow(
      /rate[ -]?limit/i,
    );
    await Promise.race([
      socketClosed,
      new Promise<never>((_, reject) => {
        AbortSignal.timeout(1_000).addEventListener("abort", () => {
          reject(new Error("loopback socket stayed open after 429 cancel"));
        });
      }),
    ]);
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(1_000);
    console.log(
      `[browser client-fetch 429 transport proof] rejected_rate_limit=true socket_closed=true elapsed_ms=${elapsedMs}`,
    );
  });
});
