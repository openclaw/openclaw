import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createDeferred as deferred } from "openclaw/plugin-sdk/extension-shared";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { type WebSocket, WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { monitorSlackRelaySource } from "./relay-source.js";

afterEach(() => vi.useRealTimers());

// A server ping/pong round trip fences real I/O after each injected clock tick.
async function roundTrip(socket: WebSocket) {
  const pong = once(socket, "pong");
  socket.ping();
  await pong;
}

it.each([true, false])(
  "checks idle relay transport health with responsive=%s",
  async (responsive) => {
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance"],
    });
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0, autoPong: responsive });
    await once(server, "listening");
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/gateway/ws`;
    const connected = deferred<void>();
    const recovered = deferred<void>();
    const recovering = deferred<Record<string, unknown>>();
    const ack = deferred<unknown>();
    const identities: unknown[] = [];
    let connections = 0;
    let pings = 0;
    const firstSocket = deferred<WebSocket>();
    const firstClosed = deferred<void>();
    server.on("connection", (socket) => {
      connections++;
      socket.on("ping", () => {
        pings++;
      });
      if (connections === 1) {
        firstSocket.resolve(socket);
        socket.once("close", () => firstClosed.resolve());
        socket.send(
          JSON.stringify({ type: "hello", slack_identity: { username: "Relay identity" } }),
        );
      } else {
        socket.on("message", (data) => ack.resolve(JSON.parse(rawDataToString(data))));
        socket.send(
          JSON.stringify({
            type: "slack_event",
            delivery_id: "after-recovery",
            route: { kind: "channel_default", key: "T1:C1" },
            payload: { event: { type: "message", channel: "C1", text: "recovered", ts: "1.1" } },
          }),
        );
      }
    });
    const controller = new AbortController();
    const acceptRelayEvent = vi.fn(async () => {});
    const monitor = monitorSlackRelaySource({
      config: { url, authToken: "synthetic-relay-token", gatewayId: "test-gateway" },
      acceptRelayEvent,
      identityHealth: { lifecycle: "ready", lastError: null },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      abortSignal: controller.signal,
      setIdentity: (identity) => identities.push(identity),
      setStatus: (status) => {
        if (status.connected === true) {
          (connections === 1 ? connected : recovered).resolve();
        }
        if (status.connected === false) {
          recovering.resolve(status);
        }
      },
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        throw error;
      }
    });
    try {
      await connected.promise;
      const socket = await firstSocket.promise;
      await vi.advanceTimersByTimeAsync(25_000);
      await roundTrip(socket);
      expect(pings).toBe(1);
      expect(identities).toContainEqual({ username: "Relay identity" });
      if (responsive) {
        for (let tick = 0; tick < 2; tick++) {
          await vi.advanceTimersByTimeAsync(25_000);
          await roundTrip(socket);
        }
        expect(pings).toBe(3);
        expect(connections).toBe(1);
        expect(acceptRelayEvent).not.toHaveBeenCalled();
      } else {
        await vi.advanceTimersByTimeAsync(25_000);
        await firstClosed.promise;
        await expect(recovering.promise).resolves.toMatchObject({
          connected: false,
          lifecycle: "recovering",
          lastError: expect.stringContaining("heartbeat timed out"),
        });
        await vi.advanceTimersByTimeAsync(3_000);
        await recovered.promise;
        await expect(ack.promise).resolves.toEqual({ type: "ack", delivery_id: "after-recovery" });
        expect(connections).toBe(2);
        expect(identities).toContain(undefined);
        expect(acceptRelayEvent).toHaveBeenCalledExactlyOnceWith({
          deliveryId: "after-recovery",
          message: expect.objectContaining({ channel: "C1", text: "recovered" }),
        });
      }
    } finally {
      controller.abort();
      await monitor;
      for (const socket of server.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  },
);
