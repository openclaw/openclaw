import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  startExtensionBridgeServer,
  type ExtensionBridgeHandle,
} from "./extension-bridge-server.js";

// Covers #93680 review [medium]: the loopback CDP face (/devtools/browser/...)
// must require the bridge token when one is configured, so a stray local process
// cannot drive the user's real Chrome over the unauthenticated CDP endpoint. The
// node's Playwright client presents the token via getHeadersWithAuth + the
// bridge-auth registry; with no token configured the bridge stays trusted-local.
const PORT = 39524;
const WS_URL = "ws://127.0.0.1:" + PORT + "/devtools/browser/test-guid";

describe("extension bridge CDP face auth", () => {
  let handle: ExtensionBridgeHandle | null = null;
  afterEach(async () => {
    await handle?.stop();
    handle = null;
  });

  function probeUpgrade(headers?: Record<string, string>): Promise<number | null> {
    return new Promise((resolve) => {
      const ws = new WebSocket(WS_URL, { headers });
      let settled = false;
      const done = (code: number | null) => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        resolve(code);
      };
      ws.on("close", (code) => done(code));
      ws.on("error", () => done(-1));
      setTimeout(() => done(null), 400);
    });
  }

  it("rejects a /devtools/browser upgrade without the bridge token", async () => {
    handle = await startExtensionBridgeServer({ port: PORT, authToken: "secret-tok" });
    expect(await probeUpgrade()).toBe(1008);
  });

  it("accepts the upgrade with the matching bearer token", async () => {
    handle = await startExtensionBridgeServer({ port: PORT, authToken: "secret-tok" });
    expect(await probeUpgrade({ Authorization: "Bearer secret-tok" })).not.toBe(1008);
  });

  it("stays trusted-local when no token is configured", async () => {
    handle = await startExtensionBridgeServer({ port: PORT });
    expect(await probeUpgrade()).not.toBe(1008);
  });

  // Each fetch-based case uses its own port so undici cannot reuse a keep-alive
  // connection to a previous test's already-stopped server.
  async function fetchJson(port: number, path: string, headers?: Record<string, string>): Promise<number> {
    const res = await fetch("http://127.0.0.1:" + port + path, { headers });
    return res.status;
  }

  it("rejects /json discovery routes without the bridge token", async () => {
    handle = await startExtensionBridgeServer({ port: 39531, authToken: "secret-tok" });
    expect(await fetchJson(39531, "/json/version")).toBe(401);
    expect(await fetchJson(39531, "/json/list")).toBe(401);
  });

  it("accepts /json discovery with the matching bearer token", async () => {
    handle = await startExtensionBridgeServer({ port: 39532, authToken: "secret-tok" });
    expect(await fetchJson(39532, "/json/version", { Authorization: "Bearer secret-tok" })).toBe(200);
    expect(await fetchJson(39532, "/json/list", { Authorization: "Bearer secret-tok" })).toBe(200);
  });

  it("serves /json discovery openly when no token is configured (trusted-local)", async () => {
    handle = await startExtensionBridgeServer({ port: 39533 });
    expect(await fetchJson(39533, "/json/version")).toBe(200);
    expect(await fetchJson(39533, "/json/list")).toBe(200);
  });

  async function fetchCorsOrigin(port: number, origin: string): Promise<string | null> {
    const res = await fetch("http://127.0.0.1:" + port + "/whoami", { headers: { Origin: origin } });
    return res.headers.get("access-control-allow-origin");
  }

  it("reflects CORS only for a chrome-extension origin, never arbitrary websites", async () => {
    handle = await startExtensionBridgeServer({ port: 39534 });
    expect(await fetchCorsOrigin(39534, "chrome-extension://abcdefghijklmnopabcdefghijklmnop")).toBe(
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    );
    expect(await fetchCorsOrigin(39534, "https://evil.example.com")).toBeNull();
  });
});
