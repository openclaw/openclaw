// Real-behavior proof: a hanging loopback server must not block voice-call
// provider API calls indefinitely once we forward a timeout to the SSRF guard.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guardedJsonApiRequest } from "./guarded-json-api.js";

async function listenLoopbackServer(server: Server): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected loopback TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

describe("guardedJsonApiRequest timeout with a hanging loopback server", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    // Accept the TCP connection but never send a byte.
    server = createServer((_req, res) => {
      // Intentionally keep the response open forever.
      res.socket?.setTimeout(0);
    });
    port = await listenLoopbackServer(server);
  });

  afterAll(async () => {
    await closeServer(server);
  });

  it("rejects before the configured timeout when the server hangs", async () => {
    const timeoutMs = 500;
    const start = Date.now();
    await expect(
      guardedJsonApiRequest({
        url: `http://127.0.0.1:${port}/hang`,
        method: "GET",
        headers: {},
        allowedHostnames: ["127.0.0.1"],
        auditContext: "voice-call:loopback-timeout-proof",
        errorPrefix: "loopback request failed",
        timeoutMs,
      }),
    ).rejects.toThrow();
    const elapsed = Date.now() - start;
    // Give a small scheduling margin, but prove we did not wait indefinitely.
    expect(elapsed).toBeLessThan(timeoutMs + 2_000);
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 100);
  });
});
