import { EventEmitter } from "node:events";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { vi } from "vitest";
import type { WebSocket } from "ws";
import { Client } from "../internal/client.js";
import { GatewayPlugin } from "../internal/gateway.js";
import { createDiscordGatewaySupervisor } from "./gateway-supervisor.js";
import { runDiscordGatewayLifecycle } from "./provider.lifecycle.js";

class GatewaySocket extends EventEmitter {
  readyState = 1;
  sent: Array<{ op: number; d: unknown }> = [];
  send(payload: string) {
    this.sent.push(JSON.parse(payload));
  }
  close() {}
  payload(op: number, d: unknown, extra = {}) {
    this.emit("message", JSON.stringify({ op, d, ...extra }));
  }
}

class FixtureGateway extends GatewayPlugin {
  sockets: GatewaySocket[] = [];
  protected override createWebSocket(): WebSocket {
    const socket = new GatewaySocket();
    this.sockets.push(socket);
    return socket as unknown as WebSocket;
  }
}

/** Only Discord's external socket is substituted; protocol and status ownership stay real. */
export async function createDiscordReadinessFixture() {
  const gateway = new FixtureGateway({ url: "wss://gateway.example.test" });
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const gatewaySupervisor = createDiscordGatewaySupervisor({
    gateway,
    runtime,
    isDisallowedIntentsError: () => false,
  });
  const client = new Client({ clientId: "123", token: "test-token" }, {});
  await gateway.registerClient(client);
  const currentSocket = () => {
    const socket = gateway.sockets.at(-1);
    if (!socket) {
      throw new Error("Discord fixture has no socket");
    }
    return socket;
  };
  currentSocket().emit("open");
  currentSocket().payload(
    0,
    {
      user: { id: "123" },
      session_id: "fixture-session",
      resume_gateway_url: "wss://gateway.example.test",
    },
    { t: "READY", s: 1 },
  );
  const snapshot: ChannelAccountSnapshot = {
    accountId: "default",
    running: true,
    enabled: true,
    configured: true,
    lifecycle: "starting",
    lastStartAt: Date.now(),
  };
  const abort = new AbortController();
  const lifecycle = runDiscordGatewayLifecycle({
    accountId: "readiness-fixture",
    gateway,
    runtime,
    gatewaySupervisor,
    abortSignal: abort.signal,
    isDisallowedIntentsError: () => false,
    voiceManager: null,
    voiceManagerRef: { current: null },
    threadBindings: { stop() {} },
    statusSink: (patch) => Object.assign(snapshot, patch),
  });
  // Observe terminal settlement immediately, before the test yields to timers or HTTP.
  const settled = lifecycle
    .catch(() => {})
    .finally(() => {
      snapshot.running = false;
    });
  await vi.advanceTimersByTimeAsync(0);
  return {
    snapshot,
    currentSocket,
    runtime,
    async stop() {
      abort.abort();
      await settled;
      gateway.disconnect();
      gatewaySupervisor.dispose();
    },
  };
}
