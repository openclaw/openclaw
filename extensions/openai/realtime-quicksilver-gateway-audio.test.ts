import { calculateMulawRms } from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import { openAIRealtimeHost } from "./realtime-host.js";
import type { OpenAIQuicksilverPendingAudio } from "./realtime-quicksilver-audio-buffer.js";
import { OpenAIQuicksilverGatewayBridge } from "./realtime-quicksilver-gateway-bridge.js";
import type { OpenAIQuicksilverAudioPeerCallbacks } from "./realtime-quicksilver-peer.runtime.js";
import {
  createCallResponse,
  emitSideband,
  FakeSocket,
  parseSent,
} from "./realtime-quicksilver.test-helpers.js";

describe("GPT-Live gateway telephony audio", () => {
  it.each(["direct", "webrtc"] as const)(
    "adapts carrier mu-law to native PCM and back over %s",
    async (transport) => {
      let socket: FakeSocket | undefined;
      let callbacks: OpenAIQuicksilverAudioPeerCallbacks | undefined;
      const input: Buffer[] = [];
      const output: Buffer[] = [];
      const bridge = new OpenAIQuicksilverGatewayBridge(
        {
          providerConfig: {},
          model: "gpt-live-test",
          audioFormat: { encoding: "g711_ulaw", sampleRateHz: 8_000, channels: 1 },
          onAudio: (audio) => output.push(audio),
          onClearAudio: () => {},
          runAgentConsult: async () => ({ text: "Done" }),
          logger: { debug: () => {}, warn: () => {} },
          resolveAuth: async () =>
            transport === "direct"
              ? { type: "api-key", token: "synthetic-key" }
              : { type: "oauth", token: "synthetic-token", accountId: "synthetic-account" },
          createPeer: async (value) => {
            callbacks = value;
            return {
              createOffer: async () => "v=offer\r\n",
              applyAnswer: async () => {},
              adoptPendingAudio: (pending: OpenAIQuicksilverPendingAudio) => {
                const audio = Buffer.alloc(pending.length);
                pending.readInto(audio);
                input.push(audio);
              },
              sendAudio: (audio) => input.push(audio),
              close: () => {},
            };
          },
          fetchImpl: vi.fn(async () => createCallResponse("v=answer\r\n", "rtc_audio")),
          webSocketFactory: () => {
            socket = new FakeSocket();
            const send = socket.send.bind(socket);
            socket.send = (payload) => {
              send(payload);
              const event = JSON.parse(payload) as { type?: string; audio?: string };
              if (event.type === "session.update") {
                queueMicrotask(() =>
                  emitSideband(socket!, { type: "session.started", session: {} }),
                );
              } else if (event.type === "input_audio.append" && event.audio) {
                input.push(Buffer.from(event.audio, "base64"));
              }
            };
            return socket;
          },
        },
        openAIRealtimeHost,
      );
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
        if (!socket) {
          throw new Error("Missing Live sideband");
        }
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
});
