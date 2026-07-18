// Discord tests cover the live gateway send queue boundary.
import { once } from "node:events";
import { expectDefined } from "@openclaw/normalization-core";
import {
  GatewayOpcodes,
  PresenceUpdateStatus,
  type GatewaySendPayload,
} from "discord-api-types/v10";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { GatewayPlugin } from "./gateway.js";

function presenceUpdate(index: number): GatewaySendPayload {
  return {
    op: GatewayOpcodes.PresenceUpdate,
    d: {
      since: index,
      activities: [],
      status: PresenceUpdateStatus.Online,
      afk: false,
    },
  };
}

describe("GatewayPlugin loopback rate limit", () => {
  it("rejects sends after one full gateway window is queued", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Discord gateway loopback server did not expose a TCP port");
    }
    let received = 0;
    server.on("connection", (socket) => {
      socket.on("message", () => {
        received += 1;
      });
    });

    const gateway = new GatewayPlugin({
      autoInteractions: false,
      url: `ws://127.0.0.1:${address.port}`,
    });
    gateway.connect(false);
    const socket = expectDefined(gateway.ws, "Discord gateway loopback socket");

    try {
      await once(socket, "open");
      for (let index = 0; index < 240; index += 1) {
        gateway.send(presenceUpdate(index));
      }

      expect(() => gateway.send(presenceUpdate(240))).toThrow(
        "Discord gateway outbound queue is full",
      );
      expect(gateway.getRateLimitStatus().queuedEvents).toBe(120);
      gateway.send({ op: GatewayOpcodes.Heartbeat, d: 1 }, true);
      await vi.waitFor(() => expect(received).toBe(121));
      console.log(
        `[discord gateway loopback proof] sent=${received} queued=${gateway.getRateLimitStatus().queuedEvents} overflow=rejected critical=bypassed`,
      );
    } finally {
      gateway.disconnect();
      for (const client of server.clients) {
        client.terminate();
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
  });
});
