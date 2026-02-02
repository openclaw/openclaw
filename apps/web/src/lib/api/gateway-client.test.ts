/**
 * Unit tests for gateway-client module
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  GatewayClient,
  createGatewayClient,
  getGatewayClient,
  resetGatewayClient,
  GATEWAY_CLIENT_ID,
  GATEWAY_CLIENT_MODE,
  DEFAULT_ROLE,
  DEFAULT_SCOPES,
} from "./gateway-client";

// Mock WebSocket
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  sentMessages: string[] = [];

  constructor(url: string) {
    this.url = url;
    // Simulate connection after a tick
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    }, 0);
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close(code?: number, reason?: string) {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: code ?? 1000, reason: reason ?? "" });
  }

  // Test helpers
  simulateMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateChallenge(nonce: string) {
    this.simulateMessage({
      type: "event",
      event: "connect.challenge",
      payload: { nonce },
    });
  }

  simulateConnectSuccess(auth?: { deviceToken?: string }) {
    // Find the connect request
    const connectMsg = this.sentMessages.find((msg) => {
      const parsed = JSON.parse(msg);
      return parsed.method === "connect";
    });
    if (!connectMsg) return;

    const { id } = JSON.parse(connectMsg);
    this.simulateMessage({
      type: "res",
      id,
      ok: true,
      payload: {
        type: "hello-ok",
        protocol: 3,
        auth,
      },
    });
  }

  simulateEvent(event: string, payload?: unknown, seq?: number) {
    this.simulateMessage({
      type: "event",
      event,
      payload,
      seq,
    });
  }
}

describe("gateway-client", () => {
  let originalWebSocket: typeof WebSocket | undefined;

  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).WebSocket = MockWebSocket;
    resetGatewayClient();
  });

  afterEach(() => {
    resetGatewayClient();
    if (originalWebSocket) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).WebSocket = originalWebSocket;
    }
  });

  describe("constants", () => {
    it("exports correct client constants", () => {
      expect(GATEWAY_CLIENT_ID).toBe("openclaw-control-ui");
      expect(GATEWAY_CLIENT_MODE).toBe("webchat");
      expect(DEFAULT_ROLE).toBe("operator");
      expect(DEFAULT_SCOPES).toEqual([
        "operator.admin",
        "operator.approvals",
        "operator.pairing",
      ]);
    });
  });

  describe("createGatewayClient", () => {
    it("creates a new client instance", () => {
      const client = createGatewayClient();
      expect(client).toBeInstanceOf(GatewayClient);
    });

    it("creates independent instances", () => {
      const client1 = createGatewayClient();
      const client2 = createGatewayClient();
      expect(client1).not.toBe(client2);
    });
  });

  describe("getGatewayClient", () => {
    it("returns singleton instance", () => {
      const client1 = getGatewayClient();
      const client2 = getGatewayClient();
      expect(client1).toBe(client2);
    });

    it("returns new instance after reset", () => {
      const client1 = getGatewayClient();
      resetGatewayClient();
      const client2 = getGatewayClient();
      expect(client1).not.toBe(client2);
    });
  });

  describe("GatewayClient", () => {
    it("starts in disconnected state", () => {
      const client = createGatewayClient();
      expect(client.getStatus()).toBe("disconnected");
      expect(client.isConnected()).toBe(false);
    });

    it("uses default URL if not provided", async () => {
      const client = createGatewayClient();
      const connectPromise = client.connect();

      // Wait for WebSocket to be created
      await new Promise((r) => setTimeout(r, 10));

      expect(client.getStatus()).toBe("connecting");

      // Clean up
      client.stop();
      await expect(connectPromise).rejects.toThrow("Client stopped");
    });

    it("uses custom URL if provided", async () => {
      const client = createGatewayClient({ url: "ws://custom:1234" });
      const connectPromise = client.connect();

      await new Promise((r) => setTimeout(r, 10));
      expect(client.getStatus()).toBe("connecting");

      // Clean up
      client.stop();
      await expect(connectPromise).rejects.toThrow("Client stopped");
    });

    it("calls onStatusChange when status changes", async () => {
      const onStatusChange = vi.fn();
      const client = createGatewayClient({ onStatusChange });

      const connectPromise = client.connect();
      await new Promise((r) => setTimeout(r, 10));

      expect(onStatusChange).toHaveBeenCalledWith("connecting");

      // Clean up
      client.stop();
      await expect(connectPromise).rejects.toThrow("Client stopped");
    });

    it("stops cleanly", () => {
      const client = createGatewayClient();
      client.stop();
      expect(client.getStatus()).toBe("disconnected");
    });

    it("can stop while connecting", async () => {
      const client = createGatewayClient();
      const connectPromise = client.connect();
      await new Promise((r) => setTimeout(r, 5));
      client.stop();
      // The connect promise should reject when stopped
      await expect(connectPromise).rejects.toThrow("Client stopped");
      expect(client.getStatus()).toBe("disconnected");
    });
  });

  describe("request/response", () => {
    it("throws when not connected", async () => {
      const client = createGatewayClient();

      await expect(client.request("test.method")).rejects.toThrow(
        "Not connected to gateway"
      );
    });
  });

  describe("event handling", () => {
    it("calls onEvent for event frames", async () => {
      const onEvent = vi.fn();
      const client = createGatewayClient({ onEvent });

      const connectPromise = client.connect();
      await new Promise((r) => setTimeout(r, 10));

      // Get the mock WebSocket
      const ws = (client as unknown as { ws: MockWebSocket }).ws;

      // Simulate an event
      ws.simulateEvent("test.event", { foo: "bar" }, 1);

      expect(onEvent).toHaveBeenCalledWith({
        event: "test.event",
        payload: { foo: "bar" },
        seq: 1,
      });

      // Clean up - stop client and catch the rejection
      client.stop();
      await expect(connectPromise).rejects.toThrow("Client stopped");
    });

    it("calls onGap when sequence gap detected", async () => {
      const onGap = vi.fn();
      const onEvent = vi.fn();
      const client = createGatewayClient({ onEvent, onGap });

      const connectPromise = client.connect();
      await new Promise((r) => setTimeout(r, 10));

      const ws = (client as unknown as { ws: MockWebSocket }).ws;

      // Send events with a gap
      ws.simulateEvent("event1", {}, 1);
      ws.simulateEvent("event2", {}, 5); // Gap: expected 2, got 5

      expect(onGap).toHaveBeenCalledWith({ expected: 2, received: 5 });

      // Clean up - stop client and catch the rejection
      client.stop();
      await expect(connectPromise).rejects.toThrow("Client stopped");
    });
  });
});
