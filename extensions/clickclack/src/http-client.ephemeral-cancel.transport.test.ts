import { createServer, type Server } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { createClickClackClient } from "./http-client.js";

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

describe("ClickClack ephemeral hanging-body HTTP transport", () => {
  it("returns from publishEphemeral and closes a hanging loopback body", async () => {
    const socketClosed = createDeferred<void>();
    const server = createServer((_req, res) => {
      res.socket?.once("close", () => {
        socketClosed.resolve();
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write("{}");
    });
    const port = await listenLoopbackServer(server);
    try {
      const client = createClickClackClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: "fake",
      });
      await client.publishEphemeral({
        workspaceId: "wsp_1",
        type: "typing.started",
      });
      await socketClosed.promise;
      console.log(`[clickclack ephemeral HTTP transport proof] returned=true socket_closed=true`);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
        server.closeAllConnections();
      });
    }
  });
});

describe("ClickClack ephemeral responseMode none cancel", () => {
  it("returns without waiting when optional response body cancel never settles", async () => {
    const cancelStarted = createDeferred<void>();
    const fetchMock = vi.fn(async () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelStarted.resolve();
            return new Promise(() => {});
          },
        }),
        { status: 200 },
      );
    });
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "fake",
      fetch: fetchMock,
    });

    const publishPromise = client.publishEphemeral({
      workspaceId: "wsp_1",
      type: "typing.started",
    });
    await expect(publishPromise).resolves.toBeUndefined();
    await cancelStarted.promise;
    expect(fetchMock).toHaveBeenCalledOnce();
    console.log(`[clickclack ephemeral cancel-nofollow proof] cancel_started=true returned=true`);
  });
});
