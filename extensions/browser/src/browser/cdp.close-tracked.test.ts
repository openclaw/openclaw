import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { type WebSocket, WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, describe, expect, it } from "vitest";
import "../test-support/browser-security.mock.js";
import { closeTrackedCdpTarget, resolveCdpTabOwnership } from "./cdp.helpers.js";

const servers: Array<{ close: (callback: () => void) => void }> = [];

async function listen(server: {
  once: (event: string, callback: () => void) => void;
}): Promise<void> {
  await new Promise<void>((resolve) => {
    server.once("listening", resolve);
  });
}

function replyToCloseMessages(socket: WebSocket): void {
  socket.on("message", (data) => {
    const message = JSON.parse(rawDataToString(data)) as { id?: number; method?: string };
    if (message.method === "Target.getTargets") {
      socket.send(
        JSON.stringify({
          id: message.id,
          result: { targetInfos: [{ targetId: "OWNED", type: "page" }] },
        }),
      );
    } else if (message.method === "Target.closeTarget") {
      socket.send(JSON.stringify({ id: message.id, result: { success: false } }));
    }
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(resolve);
        }),
    ),
  );
});

describe("closeTrackedCdpTarget", () => {
  it("keeps ownership retryable when CDP declines the close", async () => {
    const wsServer = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    servers.push(wsServer);
    await listen(wsServer);
    wsServer.on("connection", replyToCloseMessages);

    const browserWebSocketUrl = `ws://127.0.0.1:${(wsServer.address() as AddressInfo).port}/devtools/browser/TEST`;
    const httpServer = createServer((_, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ webSocketDebuggerUrl: browserWebSocketUrl }));
    });
    servers.push(httpServer);
    httpServer.listen(0, "127.0.0.1");
    await listen(httpServer);
    const cdpUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    const ownership = await resolveCdpTabOwnership({
      profileName: "remote",
      cdpUrl,
      nativeTargetId: "OWNED",
    });
    if (ownership.status !== "durable") {
      throw new Error("expected durable ownership");
    }

    await expect(
      closeTrackedCdpTarget({
        profileName: "remote",
        cdpUrl,
        nativeTargetId: "OWNED",
        expectedProfileFingerprint: ownership.profileFingerprint,
        expectedBrowserInstanceFingerprint: ownership.browserInstanceFingerprint,
      }),
    ).resolves.toEqual({ status: "unavailable", reason: "target-close-failed" });
  });

  it("closes through the normalized endpoint with the pre-upgrade advertised fingerprint", async () => {
    let sawClose = false;
    const httpServer = createServer((_, response) => {
      response.setHeader("content-type", "application/json");
      // Omit the port so loopback normalization rewrites onto the configured listener.
      response.end(
        JSON.stringify({
          webSocketDebuggerUrl: "ws://localhost/devtools/browser/SIDECAR",
        }),
      );
    });
    servers.push(httpServer);
    const wsServer = new WebSocketServer({ server: httpServer });
    servers.push(wsServer);
    wsServer.on("connection", (socket) => {
      socket.on("message", (data) => {
        const message = JSON.parse(rawDataToString(data)) as { id?: number; method?: string };
        if (message.method === "Target.getTargets") {
          socket.send(
            JSON.stringify({
              id: message.id,
              result: { targetInfos: [{ targetId: "OWNED", type: "page" }] },
            }),
          );
        } else if (message.method === "Target.closeTarget") {
          sawClose = true;
          socket.send(JSON.stringify({ id: message.id, result: { success: true } }));
        }
      });
    });
    httpServer.listen(0, "127.0.0.1");
    await listen(httpServer);
    const port = (httpServer.address() as AddressInfo).port;
    const cdpUrl = `http://127.0.0.1:${port}`;

    const ownership = await resolveCdpTabOwnership({
      profileName: "remote",
      cdpUrl,
      nativeTargetId: "OWNED",
    });
    if (ownership.status !== "durable") {
      throw new Error("expected durable ownership");
    }

    await expect(
      closeTrackedCdpTarget({
        profileName: "remote",
        cdpUrl,
        nativeTargetId: "OWNED",
        expectedProfileFingerprint: ownership.profileFingerprint,
        expectedBrowserInstanceFingerprint:
          "sha256:e40b808cae2f166a9e1e0f0fc45e3600f01f6dfd5265d9ff59d13de95356dae2",
      }),
    ).resolves.toEqual({ status: "closed" });
    expect(sawClose).toBe(true);
  });
});
