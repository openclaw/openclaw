import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { OpenClawConfig } from "../runtime-api.js";
import type { WebhookTarget } from "./http.js";
import { createWebhookRelayConnector } from "./relay.js";

class FakeWebSocket extends EventEmitter {
  static OPEN = WebSocket.OPEN;
  readyState = WebSocket.OPEN;
  sent: string[] = [];
  closed = false;

  send(payload: string) {
    this.sent.push(payload);
  }

  close() {
    this.closed = true;
    this.readyState = WebSocket.CLOSED;
  }
}

function parseSent(socket: FakeWebSocket, index = 0) {
  return JSON.parse(socket.sent[index] ?? "{}");
}

describe("createWebhookRelayConnector", () => {
  it("dispatches relay envelopes through route auth and agent scheduling", async () => {
    const socket = new FakeWebSocket();
    const scheduleSessionTurn = vi.fn(async () => ({
      id: "job-1",
      pluginId: "webhooks",
      sessionKey: "agent:reviewer:codebase",
      kind: "agentTurn",
    }));
    const target: WebhookTarget = {
      routeId: "codebase",
      path: "/plugins/webhooks/codebase-mr-review",
      dispatchMode: "agent",
      auth: {
        mode: "header",
        header: "x-vecode-hook-id",
        secret: "hook-secret",
      },
      event: {
        header: "x-vecode-event",
      },
      events: ["merge_request"],
      idempotency: {
        header: "x-vecode-delivery",
        ttlMs: 60_000,
      },
      sessionKey: "agent:reviewer:codebase",
      agent: {
        deliveryMode: "none",
        delayMs: 1,
        messageTemplate: "Review MR {MergeRequest.URL}",
      },
    };
    const connector = createWebhookRelayConnector({
      cfg: {} as OpenClawConfig,
      relay: {
        mode: "websocket",
        url: "ws://relay.example.test/openclaw",
        tokenHeader: "authorization",
        reconnect: {
          minDelayMs: 1_000,
          maxDelayMs: 30_000,
        },
        ack: true,
      },
      targetsByPath: new Map([[target.path, [target]]]),
      scheduleSessionTurn,
      webSocketFactory: () => socket as unknown as WebSocket,
    });

    connector.start();
    await vi.waitFor(() => expect(socket.listenerCount("message")).toBe(1));
    socket.emit("open");
    socket.emit(
      "message",
      JSON.stringify({
        id: "relay-delivery-1",
        path: target.path,
        headers: {
          "x-vecode-hook-id": "hook-secret",
          "x-vecode-event": "merge_request",
          "x-vecode-delivery": "delivery-1",
        },
        body: {
          MergeRequest: {
            URL: "https://code.example.test/group/repo/merge_requests/1",
          },
        },
      }),
    );
    await vi.waitFor(() => expect(scheduleSessionTurn).toHaveBeenCalledTimes(1));

    expect(scheduleSessionTurn.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: "agent:reviewer:codebase",
      message: "Review MR https://code.example.test/group/repo/merge_requests/1",
      deliveryMode: "none",
    });
    expect(parseSent(socket)).toMatchObject({
      type: "webhook.result",
      id: "relay-delivery-1",
      ok: true,
      statusCode: 202,
      body: {
        ok: true,
        routeId: "codebase",
      },
    });

    connector.stop();
    expect(socket.closed).toBe(true);
  });

  it("deduplicates repeated relay deliveries before dispatch", async () => {
    const socket = new FakeWebSocket();
    const scheduleSessionTurn = vi.fn(async () => undefined);
    const target: WebhookTarget = {
      routeId: "alerts",
      path: "/plugins/webhooks/alerts",
      dispatchMode: "ack",
      auth: {
        mode: "bearer",
        prefix: "Bearer",
        secret: "shared-secret",
      },
      event: {},
      idempotency: {
        header: "x-delivery-id",
        ttlMs: 60_000,
      },
    };
    const connector = createWebhookRelayConnector({
      cfg: {} as OpenClawConfig,
      relay: {
        mode: "websocket",
        url: "ws://relay.example.test/openclaw",
        tokenHeader: "authorization",
        reconnect: {
          minDelayMs: 1_000,
          maxDelayMs: 30_000,
        },
        ack: true,
      },
      targetsByPath: new Map([[target.path, [target]]]),
      scheduleSessionTurn,
      webSocketFactory: () => socket as unknown as WebSocket,
    });

    connector.start();
    await vi.waitFor(() => expect(socket.listenerCount("message")).toBe(1));
    const payload = {
      path: target.path,
      headers: {
        authorization: "Bearer shared-secret",
        "x-delivery-id": "delivery-1",
      },
      body: {
        ok: true,
      },
    };
    socket.emit("message", JSON.stringify({ ...payload, id: "first" }));
    socket.emit("message", JSON.stringify({ ...payload, id: "second" }));

    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    expect(parseSent(socket, 0)).toMatchObject({
      id: "first",
      ok: true,
      statusCode: 200,
    });
    expect(parseSent(socket, 1)).toMatchObject({
      id: "second",
      ok: true,
      statusCode: 200,
      body: {
        duplicate: true,
        idempotencyKey: "delivery-1",
      },
    });
    expect(scheduleSessionTurn).not.toHaveBeenCalled();
  });
});
