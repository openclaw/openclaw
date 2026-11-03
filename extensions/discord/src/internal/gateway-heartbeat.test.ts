import type { EventEmitter } from "node:events";
import { expectDefined } from "@openclaw/normalization-core";
import { GatewayOpcodes } from "discord-api-types/v10";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sharedGatewayIdentifyLimiter } from "./gateway-identify-limiter.js";
import { GatewayPlugin } from "./gateway.js";

const { sockets } = vi.hoisted(() => {
  const created: Array<EventEmitter & { send: ReturnType<typeof vi.fn> }> = [];
  return { sockets: created };
});

vi.mock("openclaw/plugin-sdk/websocket-runtime", async (importOriginal) => {
  const { EventEmitter } = await import("node:events");
  class MockWebSocket extends EventEmitter {
    readyState = 1;
    send = vi.fn();
    close = vi.fn();
    constructor() {
      super();
      sockets.push(this);
    }
  }
  return {
    ...(await importOriginal<typeof import("openclaw/plugin-sdk/websocket-runtime")>()),
    WebSocket: MockWebSocket,
  };
});

const gateways: GatewayPlugin[] = [];

function openGateway(intervalMs: number) {
  const gateway = new GatewayPlugin({ url: "wss://gateway.example.test" });
  gateways.push(gateway);
  const errors = vi.fn();
  gateway.emitter.on("error", errors);
  gateway.connect();
  const socket = expectDefined(sockets.at(-1), "Discord heartbeat socket");
  socket.emit("open");
  socket.emit(
    "message",
    JSON.stringify({ op: GatewayOpcodes.Hello, d: { heartbeat_interval: intervalMs } }),
  );
  const heartbeatCount = () =>
    socket.send.mock.calls.filter(
      ([raw]) => JSON.parse(String(raw)).op === GatewayOpcodes.Heartbeat,
    ).length;
  return { gateway, socket, errors, heartbeatCount };
}

describe("GatewayPlugin heartbeat lifecycle", () => {
  afterEach(() => {
    for (const gateway of gateways.splice(0)) {
      gateway.disconnect();
    }
    sockets.length = 0;
    sharedGatewayIdentifyLimiter.reset();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not false-timeout when the first heartbeat fires near the interval boundary", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.95);
    const { socket, errors, heartbeatCount } = openGateway(45_000);

    await vi.advanceTimersByTimeAsync(42_750);
    expect(heartbeatCount()).toBe(1);
    expect(errors).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_250);
    expect(errors).not.toHaveBeenCalled();
    socket.emit("message", JSON.stringify({ op: GatewayOpcodes.HeartbeatAck, d: null }));
    await vi.advanceTimersByTimeAsync(42_750);
    expect(heartbeatCount()).toBe(2);
    expect(errors).not.toHaveBeenCalled();
  });

  it("fires an ACK timeout when a heartbeat is genuinely not acknowledged", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { errors, heartbeatCount } = openGateway(45_000);

    await vi.advanceTimersByTimeAsync(0);
    expect(heartbeatCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(errors).toHaveBeenCalledExactlyOnceWith(new Error("Gateway heartbeat ACK timeout"));
  });

  it("disconnect cancels all pending heartbeat timers", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { gateway, errors, heartbeatCount } = openGateway(10_000);

    gateway.disconnect();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(heartbeatCount()).toBe(0);
    expect(errors).not.toHaveBeenCalled();
  });
});
