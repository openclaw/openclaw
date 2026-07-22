// Voice Call tests cover caller-turn normalization for media streams.
import type {
  RealtimeTranscriptionSession,
  RealtimeTranscriptionSessionCreateRequest,
} from "openclaw/plugin-sdk/realtime-transcription";
import { describe, expect, it, vi } from "vitest";
import { MediaStreamHandler } from "./media-stream.js";
import { connectWs, startUpgradeWsServer, waitForClose } from "./websocket-test-support.js";

const createStubSession = (): RealtimeTranscriptionSession => ({
  connect: async () => {},
  sendAudio: () => {},
  close: () => {},
  isConnected: () => true,
});

const startWsServer = (handler: MediaStreamHandler) =>
  startUpgradeWsServer({
    urlPath: "/voice/stream",
    onUpgrade: (request, socket, head) => {
      handler.handleUpgrade(request, socket, head);
    },
  });

describe("MediaStreamHandler caller turns", () => {
  it("normalizes partial, native-start, and lone-final signals once per utterance", async () => {
    let callbacks: RealtimeTranscriptionSessionCreateRequest | undefined;
    const onSpeechStart = vi.fn();
    const handler = new MediaStreamHandler({
      transcriptionProvider: {
        createSession: (request) => {
          callbacks = request;
          return createStubSession();
        },
        id: "elevenlabs",
        label: "ElevenLabs",
        isConfigured: () => true,
      },
      providerConfig: {},
      shouldAcceptStream: () => true,
      onSpeechStart,
    });
    const server = await startWsServer(handler);

    try {
      const ws = await connectWs(server.url);
      ws.send(
        JSON.stringify({
          event: "start",
          streamSid: "MZ-utterances",
          start: { callSid: "CA-utterances" },
        }),
      );
      await vi.waitFor(() => expect(callbacks).toBeDefined());

      callbacks?.onPartial?.("hel");
      callbacks?.onPartial?.("hello");
      callbacks?.onSpeechStart?.();
      expect(onSpeechStart).toHaveBeenCalledTimes(1);

      callbacks?.onTranscript?.("hello there");
      expect(onSpeechStart).toHaveBeenCalledTimes(1);

      callbacks?.onTranscript?.("lone final");
      expect(onSpeechStart).toHaveBeenCalledTimes(2);

      callbacks?.onSpeechStart?.();
      callbacks?.onPartial?.("next utterance");
      expect(onSpeechStart).toHaveBeenCalledTimes(3);

      ws.close();
      await waitForClose(ws);
    } finally {
      await server.close();
    }
  });
});
