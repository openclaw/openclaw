import { createServer, type Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createClickClackClient } from "./http-client.js";

const CLICKCLACK_JSON_CAP_BYTES = 16 * 1024 * 1024;
const LOOPBACK_RESPONSE_BYTES = 18 * 1024 * 1024;

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

function createOversizedJsonServer(): { server: Server; closed: Promise<number> } {
  let resolveClosed: (sentBytes: number) => void = () => {};
  const closed = new Promise<number>((resolve) => {
    resolveClosed = resolve;
  });
  const server = createServer((_req, res) => {
    let sentBytes = 0;
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    res.writeHead(200, { "content-type": "application/json" });
    const timer = setInterval(() => {
      if (sentBytes >= LOOPBACK_RESPONSE_BYTES) {
        clearInterval(timer);
        res.end();
        return;
      }
      sentBytes += chunk.length;
      res.write(chunk);
    }, 1);
    res.on("close", () => {
      clearInterval(timer);
      resolveClosed(sentBytes);
    });
  });
  return { server, closed };
}

function streamedErrorResponse(body: string, limit: number) {
  const encoded = new TextEncoder().encode(body);
  let readCount = 0;
  const cancel = vi.fn(async () => undefined);
  const releaseLock = vi.fn();
  const text = vi.fn(async () => {
    throw new Error("raw response.text() should not be used");
  });

  const response = {
    ok: false,
    status: 502,
    text,
    body: {
      getReader: () => ({
        read: async () => {
          if (readCount > 0) {
            return { done: true, value: undefined };
          }
          readCount += 1;
          return { done: false, value: encoded };
        },
        cancel,
        releaseLock,
      }),
    },
  } as unknown as Response;

  return {
    response,
    cancel,
    releaseLock,
    text,
    expectedDetail: body.slice(0, limit),
  };
}

describe("ClickClack HTTP client", () => {
  it("bounds oversized success JSON responses and closes the stream early", async () => {
    const { server, closed } = createOversizedJsonServer();
    const port = await listenLoopbackServer(server);
    const client = createClickClackClient({
      baseUrl: `http://127.0.0.1:${port}`,
      token: "test-token",
    });

    try {
      await expect(client.me()).rejects.toThrow(
        "ClickClack response: JSON response exceeds 16777216 bytes",
      );
      await expect(closed).resolves.toBeLessThan(LOOPBACK_RESPONSE_BYTES);
      await expect(closed).resolves.toBeGreaterThan(CLICKCLACK_JSON_CAP_BYTES);
    } finally {
      server.close();
    }
  });

  it("bounds error response bodies without using raw response.text()", async () => {
    const streamed = streamedErrorResponse("x".repeat(9000), 8 * 1024);
    const fetchMock = vi.fn(async () => streamed.response);
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "test-token",
      fetch: fetchMock,
    });

    await expect(client.me()).rejects.toThrow(`ClickClack 502: ${streamed.expectedDetail}`);

    expect(streamed.text).not.toHaveBeenCalled();
    expect(streamed.cancel).toHaveBeenCalledTimes(1);
    expect(streamed.releaseLock).toHaveBeenCalledTimes(1);
  });
});
