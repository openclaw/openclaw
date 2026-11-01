import { calculateMulawRms } from "openclaw/plugin-sdk/realtime-voice";
import { expect, it, vi } from "vitest";
import {
  createAudioPeer,
  createGatewayHarness,
} from "./realtime-quicksilver-gateway.test-support.js";
import type { OpenAIQuicksilverAudioPeerCallbacks } from "./realtime-quicksilver-peer.runtime.js";
import {
  createCallResponse,
  emitSideband,
  parseSent,
} from "./realtime-quicksilver.test-helpers.js";

it.each(["direct", "webrtc"] as const)(
  "adapts carrier mu-law to native PCM and back over %s",
  async (transport) => {
    let callbacks: OpenAIQuicksilverAudioPeerCallbacks | undefined;
    const input: Buffer[] = [];
    const output: Buffer[] = [];
    const { bridge, getSocket } = createGatewayHarness({
      model: "gpt-live-test",
      audioFormat: { encoding: "g711_ulaw", sampleRateHz: 8_000, channels: 1 },
      onAudio: (audio) => output.push(audio),
      resolveAuth: async () =>
        transport === "direct"
          ? { type: "api-key", token: "synthetic-key" }
          : { type: "oauth", token: "synthetic-token", accountId: "synthetic-account" },
      createPeer: async (value) => {
        callbacks = value;
        return createAudioPeer((audio) => input.push(audio));
      },
      fetchImpl: vi.fn(async () => createCallResponse("v=answer\r\n", "rtc_audio")),
      startSession: {},
      onSend: (event) => {
        if (event.type === "input_audio.append" && event.audio) {
          input.push(Buffer.from(event.audio, "base64"));
        }
      },
    });
    try {
      bridge.sendAudio(Buffer.alloc(160, 0x80));
      await bridge.connect();
      const captured = input[0];
      if (!captured) {
        throw new Error("Missing converted microphone audio");
      }
      expect(captured.length).toBeGreaterThan(800);
      expect(captured.length).toBeLessThanOrEqual(960);
      let loudSamples = 0;
      for (let offset = 0; offset < captured.length; offset += 2) {
        if (captured.readInt16LE(offset) > 30_000) {
          loudSamples += 1;
        }
      }
      expect(loudSamples).toBeGreaterThan(300);
      const pcm = Buffer.alloc(960);
      for (let offset = 0; offset < pcm.length; offset += 2) {
        pcm.writeInt16LE(10_000, offset);
      }
      const socket = getSocket();
      if (transport === "direct") {
        emitSideband(socket, { type: "output_audio.delta", audio: pcm.toString("base64") });
      } else {
        emitSideband(socket, { type: "session.started", session: {} });
        callbacks?.onAudio(pcm);
      }
      const carrierAudio = Buffer.concat(output);
      expect(carrierAudio.length).toBeGreaterThanOrEqual(150);
      expect(carrierAudio.length).toBeLessThanOrEqual(160);
      expect(calculateMulawRms(carrierAudio)).toBeGreaterThan(0.25);
      expect(calculateMulawRms(carrierAudio)).toBeLessThan(0.35);
      bridge.triggerGreeting("Say hello to the caller.");
      expect(parseSent(socket)).toContainEqual(
        expect.objectContaining({ type: "session.context.append" }),
      );
    } finally {
      await bridge.close();
    }
  },
);
