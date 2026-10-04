import { describe, expect, it, vi } from "vitest";
import { openAIRealtimeHost } from "./realtime-host.js";
import { OpenAIQuicksilverGatewayBridge } from "./realtime-quicksilver-gateway-bridge.js";
import { fakeQuicksilverMediaSocket } from "./realtime-quicksilver-socket.test-support.js";
import { emitSideband, FakeSocket, parseSent } from "./realtime-quicksilver.test-helpers.js";

describe("GPT-Live ordered direct completion", () => {
  it.each(["pcm16", "g711_ulaw"] as const)(
    "delivers the full %s tail before completion and honors transcript callback closure",
    async (encoding) => {
      let socket!: FakeSocket;
      const callbacks: string[] = [];
      const audio: Buffer[] = [];
      const onResponseDone = vi.fn(() => callbacks.push("completed"));
      const onTranscript = vi.fn((_role: "user" | "assistant", text: string, done: boolean) => {
        if (done) {
          callbacks.push("final");
          if (text === "Stop") {
            void bridge.close();
          }
        }
      });
      const bridge = new OpenAIQuicksilverGatewayBridge(
        {
          providerConfig: {},
          model: "gpt-live-test-canary",
          audioFormat:
            encoding === "pcm16"
              ? { encoding, sampleRateHz: 24_000, channels: 1 }
              : { encoding, sampleRateHz: 8_000, channels: 1 },
          onAudio: (chunk) => {
            audio.push(chunk);
            callbacks.push("audio");
          },
          onClearAudio: vi.fn(),
          onTranscript,
          onResponseDone,
          runAgentConsult: async () => ({ text: "Done" }),
          logger: { debug: vi.fn(), warn: vi.fn() },
          resolveAuth: async () => ({ type: "api-key", token: "synthetic-token" }),
          mediaSocketFactory: fakeQuicksilverMediaSocket(() => {
            socket = new FakeSocket();
            const send = socket.send.bind(socket);
            socket.send = (payload) => {
              send(payload);
              if (parseSent(socket).at(-1)?.type === "session.update") {
                queueMicrotask(() =>
                  emitSideband(socket, { type: "session.started", session: {} }),
                );
              }
            };
            return socket;
          }),
        },
        openAIRealtimeHost,
      );
      const pcm = Buffer.alloc(960, 0x12);
      const sendAudio = () =>
        emitSideband(socket, {
          type: "output_audio.delta",
          audio: pcm.toString("base64"),
        });
      const finish = (transcript: string) =>
        emitSideband(socket, {
          type: "turn.done",
          turn: { role: "assistant", transcript },
        });
      try {
        await bridge.connect();
        sendAudio();
        finish("First reply");
        expect(Buffer.concat(audio)).toHaveLength(encoding === "pcm16" ? 960 : 160);
        expect(callbacks.slice(-2)).toEqual(["final", "completed"]);
        expect(onResponseDone).toHaveBeenCalledExactlyOnceWith({ status: "completed" });
        finish("First reply");
        expect(onTranscript).toHaveBeenCalledTimes(1);
        expect(onResponseDone).toHaveBeenCalledTimes(1);

        bridge.sendUserMessage("Next reply");
        sendAudio();
        finish("Stop");
        expect(Buffer.concat(audio)).toHaveLength(encoding === "pcm16" ? 1920 : 320);
        expect(onTranscript).toHaveBeenLastCalledWith("assistant", "Stop", true);
        expect(onResponseDone).toHaveBeenCalledTimes(1);
        expect(bridge.isConnected()).toBe(false);
      } finally {
        await bridge.close();
      }
    },
  );
});
