// Azure Speech voice list live timeout proof.
// Uses a local node:http server that accepts the connection but never responds,
// proving that listAzureSpeechVoices aborts within the configured timeout.
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listAzureSpeechVoices } from "./tts.js";

async function listenLocal(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

describe("listAzureSpeechVoices live timeout", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("aborts a hanging voice list request within the configured timeout", async () => {
    const sockets = new Set<Socket>();
    let requestCount = 0;
    const server = createServer((_req, _res) => {
      requestCount += 1;
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });

    const port = await listenLocal(server);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        return await originalFetch(`http://127.0.0.1:${port}/cognitiveservices/voices/list`, init);
      }) as unknown as typeof globalThis.fetch,
    );

    const startedAt = Date.now();

    try {
      await expect(
        Promise.race([
          listAzureSpeechVoices({
            apiKey: "speech-key",
            baseUrl: "https://custom.example.com",
            timeoutMs: 250,
          }),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error("voices list did not time out")), 2_000);
          }),
        ]),
      ).rejects.toThrow(/aborted|timeout|timed out/i);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(requestCount).toBe(1);
    } finally {
      await closeServer(server, sockets);
    }
  });
});
