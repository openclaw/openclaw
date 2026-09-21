import { once } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { openAIRealtimeHost } from "./realtime-host.js";
import { createHarness } from "./realtime-quicksilver-bridge.test-support.js";
import { OpenAIQuicksilverGatewayBridge } from "./realtime-quicksilver-gateway-bridge.js";
import { fakeQuicksilverMediaSocket } from "./realtime-quicksilver-socket.test-support.js";
import { emitSideband, FakeSocket } from "./realtime-quicksilver.test-helpers.js";

function gateway(
  mediaSocketFactory: ReturnType<typeof fakeQuicksilverMediaSocket>,
  audioFormat?: ConstructorParameters<typeof OpenAIQuicksilverGatewayBridge>[0]["audioFormat"],
) {
  return new OpenAIQuicksilverGatewayBridge(
    {
      providerConfig: {},
      model: "gpt-live-1",
      audioFormat,
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      resolveAuth: async () => ({ type: "api-key", token: "fixture-key" }),
      runAgentConsult: async () => ({ text: "done" }),
      logger: { debug() {}, warn() {} },
      mediaSocketFactory,
    },
    openAIRealtimeHost,
  );
}

describe("GPT-Live direct output endpoint ownership", () => {
  it("keeps the endpoint out of failed socket attempts and binds the adopted socket", async () => {
    const { port1, port2 } = new MessageChannel();
    const state = new SharedArrayBuffer(4);
    const sockets: FakeSocket[] = [];
    const boundAttempts: number[] = [];
    const create = fakeQuicksilverMediaSocket(() => {
      const socket = new FakeSocket(sockets.length ? "open" : "error");
      sockets.push(socket);
      return socket;
    });
    const bridge = gateway((...args) => {
      const socket = create(...args);
      const bind = socket.setAudioOutputPort.bind(socket);
      socket.setAudioOutputPort = (output) => {
        boundAttempts.push(sockets.length);
        bind(output);
      };
      return socket;
    });
    try {
      bridge.setAudioOutputPort({ port: port1, state });
      const connecting = bridge.connect();
      await vi.waitFor(() => expect(sockets[1]?.sent).toHaveLength(1));
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
      for (const socket of sockets) {
        if (!socket.closed) {
          emitSideband(socket, { type: "session.closed", reason: "close_requested" });
        }
      }
      await Promise.allSettled([bridge.close()]);
      port1.close();
      port2.close();
    }
  });

  it.each(["gateway", "legacy"] as const)(
    "closes an unadopted %s endpoint before connect",
    async (kind) => {
      const { port1, port2 } = new MessageChannel();
      const state = new SharedArrayBuffer(4);
      const bridge =
        kind === "gateway"
          ? gateway(fakeQuicksilverMediaSocket(() => new FakeSocket()))
          : createHarness().bridge;
      try {
        bridge.setAudioOutputPort({ port: port1, state });
        const closed = once(port2, "close");
        await bridge.close();
        expect(Atomics.load(new Int32Array(state), 0)).toBe(1);
        await closed;
      } finally {
        port1.close();
        port2.close();
      }
    },
  );
  it("delivers provider interruption on the media port without a delayed duplicate clear", async () => {
    const { port1, port2 } = new MessageChannel();
    const harness = createHarness();
    try {
      harness.bridge.setAudioOutputPort({ port: port1, state: new SharedArrayBuffer(4) });
      await harness.bridge.connect();
      const cleared = once(port2, "message");
      harness.socket.serverEvent({ type: "output_audio_buffer.cleared" });
      expect((await cleared)[0]).toEqual({ type: "clear" });
      expect(harness.onClearAudio).not.toHaveBeenCalled();
      expect(harness.onEvent).toHaveBeenCalledWith({
        direction: "server",
        type: "output_audio_buffer.cleared",
      });
    } finally {
      await harness.bridge.close();
      port1.close();
      port2.close();
    }
  });

  it.each(["gateway", "legacy"] as const)(
    "rejects a non-PCM %s bridge output endpoint",
    async (kind) => {
      const { port1, port2 } = new MessageChannel();
      const bridge =
        kind === "gateway"
          ? gateway(
              fakeQuicksilverMediaSocket(() => new FakeSocket()),
              { encoding: "g711_ulaw", sampleRateHz: 8_000, channels: 1 },
            )
          : createHarness({ audioFormat: "g711_ulaw" }).bridge;
      try {
        expect(() =>
          bridge.setAudioOutputPort({ port: port1, state: new SharedArrayBuffer(4) }),
        ).toThrow("mono PCM16 at 24 kHz");
      } finally {
        await bridge.close();
        port1.close();
        port2.close();
      }
    },
  );
});
