// Discord tests cover gateway websocket transport options.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayPlugin } from "./gateway.js";

const { webSocketCtorCalls, mockOwner } = vi.hoisted(() => {
  const calls: Array<{ url: string; options: unknown }> = [];
  const owner: { constructor: unknown } = { constructor: undefined };
  return { webSocketCtorCalls: calls, mockOwner: owner };
});

vi.mock("openclaw/plugin-sdk/websocket-runtime", async (importOriginal) => {
  const { EventEmitter } = await import("node:events");
  class MockWebSocket extends EventEmitter {
    readyState = 1;
    send = vi.fn();
    close = vi.fn();

    constructor(url: string, options?: unknown) {
      super();
      webSocketCtorCalls.push({ url, options });
    }
  }
  mockOwner.constructor = MockWebSocket;
  return {
    ...(await importOriginal<typeof import("openclaw/plugin-sdk/websocket-runtime")>()),
    WebSocket: MockWebSocket,
  };
});

import { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";

describe("GatewayPlugin websocket options", () => {
  beforeEach(() => {
    webSocketCtorCalls.length = 0;
  });

  it("bounds inbound gateway websocket payloads and the opening handshake", () => {
    expect(WebSocket).toBe(mockOwner.constructor);
    const gateway = new GatewayPlugin({
      url: "wss://gateway.example.test",
    });

    gateway.connect(false);

    expect(webSocketCtorCalls).toHaveLength(1);
    expect(webSocketCtorCalls[0]).toEqual({
      url: "wss://gateway.example.test/?v=10&encoding=json",
      options: { maxPayload: 16 * 1024 * 1024, handshakeTimeout: 30_000 },
    });
  });
});
