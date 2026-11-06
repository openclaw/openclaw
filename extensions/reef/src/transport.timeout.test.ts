import http from "node:http";
import { describe, expect, it } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { ReefTransportClient } from "./transport.js";
import type { ReefKeys } from "./types.js";

const keys: ReefKeys = {
  signing: {
    secretKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
    publicKey: "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg",
  },
  encryption: {
    secretKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  },
  auditKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  replayKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  keyEpoch: 1,
};

async function listen(server: http.Server): Promise<string> {
  const port = await listenOnLoopback(server);
  return `http://127.0.0.1:${port}`;
}

function client(relayUrl: string): ReefTransportClient {
  return new ReefTransportClient(relayUrl, "alice", keys, fetch, () => 1_752_300_000, 50);
}

describe("ReefTransportClient relay request timeout", () => {
  it.each([
    { phase: "before headers", status: undefined },
    { phase: "after success headers", status: 200 },
    { phase: "after error headers", status: 503 },
  ])("preserves TimeoutError when the relay stalls $phase", async ({ status }) => {
    const server = http.createServer((_request, response) => {
      if (status !== undefined) {
        response.writeHead(status, { "content-type": "application/json" });
        response.flushHeaders();
      }
    });
    const relayUrl = await listen(server);

    try {
      await expect(client(relayUrl).pull(0)).rejects.toMatchObject({ name: "TimeoutError" });
    } finally {
      server.closeAllConnections?.();
      await server[Symbol.asyncDispose]();
    }
  });
});
