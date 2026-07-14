// Real `ws` handshakeTimeout proof for Signal container receive streaming.
// Kept separate from client-container.test.ts so that file's `vi.mock("ws")` does not apply.
import net from "node:net";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { streamContainerEvents } from "./client-container.js";

describe("streamContainerEvents real websocket handshakeTimeout", () => {
  it("returns when a peer accepts TCP but never completes the websocket upgrade", async () => {
    // Accept TCP but never complete the websocket upgrade so missing
    // handshakeTimeout would leave streamContainerEvents waiting forever.
    const accepted: net.Socket[] = [];
    const server = net.createServer((socket) => {
      accepted.push(socket);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    const logError = (msg: string) => {
      if (msg.includes("Opening handshake has timed out") || msg.includes("closed")) {
        console.log(`[signal handshake live proof] ${msg}`);
      }
    };

    try {
      const startedAt = Date.now();
      await streamContainerEvents({
        baseUrl: `http://127.0.0.1:${port}`,
        account: "+10000000000",
        onEvent: () => {},
        logger: { error: logError, log: () => {} },
      });
      const elapsedMs = Date.now() - startedAt;
      // Production floor is 30s; allow a small timer/scheduling skew.
      expect(elapsedMs).toBeGreaterThanOrEqual(29_000);
      expect(elapsedMs).toBeLessThan(35_000);
      console.log(
        `[signal handshake live proof] timed_out=true elapsed_ms=${elapsedMs} handshakeTimeout_ms=30000`,
      );
    } finally {
      for (const socket of accepted) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }, 45_000);
});
