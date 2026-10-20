import { once } from "node:events";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness } from "./realtime-quicksilver-bridge.test-support.js";
import { createGatewayHarness } from "./realtime-quicksilver-gateway.test-support.js";
import { fakeQuicksilverMediaSocket } from "./realtime-quicksilver-socket.test-support.js";
import { emitSideband, FakeSocket } from "./realtime-quicksilver.test-helpers.js";

let port1: MessagePort, port2: MessagePort, state: SharedArrayBuffer;
let bridge:
  | ReturnType<typeof createGatewayHarness>["bridge"]
  | ReturnType<typeof createHarness>["bridge"];
beforeEach(() => {
  ({ port1, port2 } = new MessageChannel());
  state = new SharedArrayBuffer(4);
});
afterEach(async () => {
  try {
    await bridge.close();
  } finally {
    port1.close();
    port2.close();
    vi.useRealTimers();
  }
});

describe("GPT-Live direct output endpoint ownership", () => {
  it("keeps the endpoint out of failed socket attempts and binds the adopted socket", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const sockets: FakeSocket[] = [];
    const boundAttempts: number[] = [];
    const create = fakeQuicksilverMediaSocket(() => {
      const socket = new FakeSocket("manual");
      sockets.push(socket);
      return socket;
    });
    bridge = createGatewayHarness({
      mediaSocketFactory: (...args) => {
        const socket = create(...args);
        const bind = socket.setAudioOutputPort.bind(socket);
        socket.setAudioOutputPort = (output) => {
          boundAttempts.push(sockets.length);
          bind(output);
        };
        return socket;
      },
    }).bridge;
    let connecting: Promise<void> | undefined;
    try {
      bridge.setAudioOutputPort({ port: port1, state });
      connecting = bridge.connect();
      void connecting.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(sockets).toHaveLength(1);
      expect(boundAttempts).toEqual([]);
      sockets[0]!.emit("error", new Error("first attempt failed"));
      await vi.advanceTimersByTimeAsync(200);
      expect(sockets[0]!.closed).toBe(true);
      expect(sockets).toHaveLength(2);
      expect(boundAttempts).toEqual([]);
      sockets[1]!.readyState = 1;
      sockets[1]!.emit("open");
      await vi.advanceTimersByTimeAsync(0);
      expect(sockets[1]!.sent).toHaveLength(1);
      expect(boundAttempts).toEqual([2]);
      expect(Atomics.load(new Int32Array(state), 0)).toBe(0);
      emitSideband(sockets[1]!, { type: "session.started", session: {} });
      await connecting;
      const audio = once(port2, "message");
      emitSideband(sockets[1]!, { type: "session.output_audio.delta", delta: "AQE=" });
      expect((await audio)[0]).toEqual({ type: "audio", audio: new Uint8Array([1, 1]) });
      const closing = bridge.close();
      expect(Atomics.load(new Int32Array(state), 0)).toBe(1);
      emitSideband(sockets[1]!, { type: "session.closed", reason: "close_requested" });
      await closing;
    } finally {
      const closing = bridge.close();
      for (const socket of sockets) {
        if (!socket.closed) {
          emitSideband(socket, { type: "session.closed", reason: "close_requested" });
        }
      }
      await Promise.allSettled([connecting, closing]);
    }
  });

  it.each(["gateway", "legacy"] as const)("closes the unadopted %s port", async (kind) => {
    bridge = kind === "gateway" ? createGatewayHarness().bridge : createHarness().bridge;
    bridge.setAudioOutputPort({ port: port1, state });
    const closed = once(port2, "close");
    await bridge.close();
    expect(Atomics.load(new Int32Array(state), 0)).toBe(1);
    await closed;
  });
  it("delivers provider interruption on the media port without a delayed duplicate clear", async () => {
    const { bridge: voice, socket, onClearAudio, onEvent } = createHarness();
    bridge = voice;
    voice.setAudioOutputPort({ port: port1, state });
    await voice.connect();
    const cleared = once(port2, "message");
    socket.serverEvent({ type: "output_audio_buffer.cleared" });
    expect((await cleared)[0]).toEqual({ type: "clear" });
    expect(onClearAudio).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith({
      direction: "server",
      type: "output_audio_buffer.cleared",
    });
  });

  it.each(["gateway", "legacy"] as const)("rejects a non-PCM %s port", async (kind) => {
    bridge =
      kind === "gateway"
        ? createGatewayHarness({
            audioFormat: { encoding: "g711_ulaw", sampleRateHz: 8_000, channels: 1 },
          }).bridge
        : createHarness({ audioFormat: "g711_ulaw" }).bridge;
    expect(() => bridge.setAudioOutputPort({ port: port1, state })).toThrow("mono PCM16 at 24 kHz");
  });
});
