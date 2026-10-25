import { once } from "node:events";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness } from "./realtime-quicksilver-bridge.test-support.js";
import { createGatewayHarness } from "./realtime-quicksilver-gateway.test-support.js";

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
  }
});

describe("GPT-Live direct output endpoint ownership", () => {
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
