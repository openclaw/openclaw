import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { guardedJsonApiRequestMock } = vi.hoisted(() => ({
  guardedJsonApiRequestMock: vi.fn(),
}));

vi.mock("./shared/guarded-json-api.js", () => ({
  guardedJsonApiRequest: guardedJsonApiRequestMock,
}));

import { MediaStreamHandler } from "../media-stream.js";
import { createTelephonyTtsProvider, type TelephonyTtsRuntime } from "../telephony-tts.js";
import { connectWs, startUpgradeWsServer, withTimeout } from "../websocket-test-support.js";
import { WebSocket } from "../websocket.js";
import { TwilioProvider } from "./twilio.js";

beforeEach(() => {
  vi.useRealTimers();
  guardedJsonApiRequestMock.mockReset();
});

function createStreamSendResult(sent = true): ReturnType<MediaStreamHandler["sendAudio"]> {
  return { sent, bufferedBeforeBytes: 0, bufferedAfterBytes: 0 };
}

function createProvider(): TwilioProvider {
  return new TwilioProvider(
    { accountSid: "AC123", authToken: "secret" },
    { publicUrl: "https://example.ngrok.app", streamPath: "/voice/stream" },
  );
}

type StreamFrame =
  | { event: "media"; streamSid: string; media: { payload: string } }
  | { event: "mark"; streamSid: string; mark: { name: string } }
  | { event: "clear"; streamSid: string };

async function withStreamingProvider(
  run: (fixture: {
    provider: TwilioProvider;
    messages: StreamFrame[];
    beforeSend: ReturnType<typeof vi.fn<(frame: StreamFrame) => void>>;
    synthesize: ReturnType<typeof vi.fn<TelephonyTtsRuntime["textToSpeechTelephony"]>>;
    result: Awaited<ReturnType<TelephonyTtsRuntime["textToSpeechTelephony"]>>;
    play: (text: string) => Promise<void>;
    marks: () => Array<Extract<StreamFrame, { event: "mark" }>>;
    speech: () => Buffer[];
    acknowledge: (index: number) => void;
  }) => Promise<void>,
): Promise<void> {
  const provider = createProvider();
  const connected = createDeferred<void>();
  const messages: StreamFrame[] = [];
  const playbacks: Promise<void>[] = [];
  const beforeSend = vi.fn<(frame: StreamFrame) => void>();
  const result = {
    success: true,
    audioBuffer: Buffer.alloc(1_920, Buffer.from([0xe8, 0x03])),
    sampleRate: 24_000,
    outputFormat: "pcm",
  };
  const synthesize = vi.fn<TelephonyTtsRuntime["textToSpeechTelephony"]>(async () => result);
  provider.setTTSProvider(
    await createTelephonyTtsProvider({
      coreConfig: {},
      runtime: {
        prepareTtsRequest: async ({ cfg, text }) => ({
          cfg,
          directives: { cleanedText: text, hasDirective: false, overrides: {}, warnings: [] },
        }),
        textToSpeechTelephony: synthesize,
      },
    }),
  );
  const handler = new MediaStreamHandler({
    transcriptionProvider: {
      id: "fixture",
      label: "Fixture",
      isConfigured: () => true,
      createSession: () => ({
        connect: async () => {},
        sendAudio: () => {},
        close: () => {},
        isConnected: () => true,
      }),
    },
    providerConfig: {},
    shouldAcceptStream: ({ callId, streamSid }) =>
      callId === "CA-stream" && streamSid === "MZ-stream",
    onConnect: (callId, streamSid) => provider.registerCallStream(callId, streamSid),
    onTranscriptionReady: () => connected.resolve(),
  });
  provider.setMediaStreamHandler(handler);
  guardedJsonApiRequestMock.mockImplementation(() => {
    throw new Error("Unexpected Twilio REST request during stream playback");
  });
  const server = await startUpgradeWsServer({
    urlPath: "/voice/stream",
    onUpgrade: (request, socket, head) => handler.handleUpgrade(request, socket, head),
  });
  let peer: WebSocket | undefined;
  try {
    const client = await connectWs(server.url);
    peer = client;
    client.on("message", (data) => {
      messages.push(JSON.parse(rawDataToString(data)) as StreamFrame);
    });
    client.send(
      JSON.stringify({ event: "start", streamSid: "MZ-stream", start: { callSid: "CA-stream" } }),
    );
    await withTimeout(connected.promise);
    const discovery = vi.spyOn(WebSocket.prototype, "send");
    let serverSocket: WebSocket;
    try {
      expect(handler.sendMark("MZ-stream", "fixture-ready").sent).toBe(true);
      const receiver = discovery.mock.contexts[0];
      if (!(receiver instanceof WebSocket)) {
        throw new Error("Expected the stream's WebSocket receiver");
      }
      serverSocket = receiver;
      await vi.waitFor(() => expect(messages).toHaveLength(1));
      expect(messages.shift()).toEqual({
        event: "mark",
        streamSid: "MZ-stream",
        mark: { name: "fixture-ready" },
      });
    } finally {
      discovery.mockRestore();
    }
    const originalSend = serverSocket.send.bind(serverSocket);
    const send = vi.spyOn(serverSocket, "send").mockImplementation((...args) => {
      const data = args[0];
      if (typeof data !== "string" && !Buffer.isBuffer(data) && !(data instanceof ArrayBuffer)) {
        throw new Error("Expected a JSON text or byte frame from the media handler");
      }
      beforeSend(
        JSON.parse(typeof data === "string" ? data : rawDataToString(data)) as StreamFrame,
      );
      originalSend(...args);
    });
    const marks = () => messages.filter((frame) => frame.event === "mark");
    try {
      await run({
        provider,
        messages,
        beforeSend,
        synthesize,
        result,
        play: (text) => {
          const playback = provider.playTts({
            callId: "call-stream",
            providerCallId: "CA-stream",
            text,
          });
          playbacks.push(playback);
          return playback;
        },
        marks,
        speech: () =>
          messages.flatMap((frame) => {
            if (frame.event !== "media") {
              return [];
            }
            const audio = Buffer.from(frame.media.payload, "base64");
            return audio.every((byte) => byte === 0xff) ? [] : [audio];
          }),
        acknowledge: (index) =>
          client.send(JSON.stringify(expectDefined(marks()[index], "playback mark"))),
      });
      expect(guardedJsonApiRequestMock).not.toHaveBeenCalled();
    } finally {
      send.mockRestore();
    }
  } finally {
    provider.clearTtsQueue("CA-stream", "test cleanup");
    peer?.terminate();
    await handler.close();
    await Promise.allSettled(playbacks);
    await server.close();
  }
}

describe("TwilioProvider", () => {
  it("times out telephony synthesis in stream mode and does not send completion mark", async () => {
    vi.useFakeTimers();
    try {
      const provider = createProvider();
      provider.registerCallStream("CA-timeout", "MZ-timeout");

      const sendAudio = vi.fn<MediaStreamHandler["sendAudio"]>(() => createStreamSendResult());
      const sendMarkAndWait = vi.fn();
      const mediaStreamHandler = {
        queueTts: async (
          _streamSid: string,
          playFn: (signal: AbortSignal) => Promise<void>,
        ): Promise<void> => {
          await playFn(new AbortController().signal);
        },
        sendAudio,
        sendMarkAndWait,
        clearAudio: vi.fn(),
      };

      provider.setMediaStreamHandler(mediaStreamHandler as never);
      provider.setTTSProvider({
        synthesisTimeoutMs: 5000,
        synthesizeForTelephony: async () => await new Promise<Buffer>(() => {}),
      });

      const playExpectation = expect(
        provider.playTts({
          callId: "call-timeout",
          providerCallId: "CA-timeout",
          text: "Timeout me",
        }),
      ).rejects.toThrow("Telephony TTS synthesis timed out after 5000ms");
      await vi.advanceTimersByTimeAsync(5_100);
      await playExpectation;
      expect(sendAudio).toHaveBeenCalled();
      expect(sendMarkAndWait).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops and clears real stream playback on the first failed audio chunk", async () => {
    await withStreamingProvider(async (f) => {
      f.synthesize.mockResolvedValueOnce({
        ...f.result,
        audioBuffer: Buffer.alloc(2_880, Buffer.from([0xe8, 0x03])),
      });
      const order: string[] = [];
      let speechAttempts = 0;
      f.beforeSend.mockImplementation((frame) => {
        if (frame.event === "media" && Buffer.from(frame.media.payload, "base64")[0] === 0xce) {
          speechAttempts += 1;
          order.push(`speech-${speechAttempts}`);
          if (speechAttempts === 2) {
            throw new Error("synthetic socket send failure");
          }
        } else if (frame.event === "clear") {
          order.push("clear");
        }
      });
      const playback = f.play("Dropped audio").catch((error: unknown) => {
        order.push("error");
        throw error;
      });
      await expect(withTimeout(playback)).rejects.toThrow("audio chunk 2 not delivered");
      await vi.waitFor(() => {
        expect(f.messages.some((frame) => frame.event === "clear")).toBe(true);
      });
      expect(order).toEqual(["speech-1", "speech-2", "clear", "error"]);
      expect(f.speech()).toEqual([Buffer.alloc(160, 0xce)]);
      expect(f.marks()).toEqual([]);
      expect(f.beforeSend.mock.calls.some(([frame]) => frame.event === "mark")).toBe(false);
    });
  });

  it("fails stream playback when telephony synthesis returns empty audio", async () => {
    await withStreamingProvider(async (f) => {
      f.synthesize.mockResolvedValueOnce({ ...f.result, audioBuffer: Buffer.alloc(0) });
      await expect(withTimeout(f.play("Empty audio"))).rejects.toThrow(
        "Telephony TTS produced no audio",
      );
      expect(f.beforeSend).toHaveBeenCalled();
      expect(f.beforeSend.mock.calls.some(([frame]) => frame.event === "mark")).toBe(false);
    });
  });

  it("exits chunk pacing early when the abort signal fires after the first chunk", async () => {
    vi.useFakeTimers();
    try {
      const provider = createProvider();
      provider.registerCallStream("CA-abort-chunk", "MZ-abort-chunk");

      const sendMarkAndWait = vi.fn(async () => {});
      const controller = new AbortController();
      const sendAudio = vi.fn<MediaStreamHandler["sendAudio"]>(() => {
        // The first send is the synthesis keepalive; the second is the first real audio chunk.
        if (sendAudio.mock.calls.length === 2) {
          controller.abort();
        }
        return createStreamSendResult();
      });

      const mediaStreamHandler = {
        queueTts: async (
          _streamSid: string,
          playFn: (signal: AbortSignal) => Promise<void>,
        ): Promise<void> => {
          await playFn(controller.signal);
        },
        sendAudio,
        sendMarkAndWait,
        clearAudio: vi.fn(),
      };

      provider.setMediaStreamHandler(mediaStreamHandler as never);
      provider.setTTSProvider({
        synthesisTimeoutMs: 5000,
        synthesizeForTelephony: async () => Buffer.alloc(160 * 10, 0x80),
      });

      const startedAt = Date.now();
      await expect(
        provider.playTts({
          callId: "call-abort-chunk",
          providerCallId: "CA-abort-chunk",
          text: "hello",
          voice: "default",
          locale: "en-US",
        }),
      ).resolves.toBeUndefined();

      expect(Date.now()).toBe(startedAt);
      expect(sendAudio).toHaveBeenCalledTimes(2);
      expect(sendMarkAndWait).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("streams exact PCM output and gates the real queue on echoed playback marks", async () => {
    await withStreamingProvider(async (f) => {
      const synthesis = createDeferred<void>();
      f.synthesize.mockImplementationOnce(async () => {
        await synthesis.promise;
        return f.result;
      });
      let completed = false;
      const first = f.play("first").then(() => {
        completed = true;
      });
      const second = f.play("second");
      try {
        await vi.waitFor(() => expect(f.messages.length).toBeGreaterThanOrEqual(2));
        for (const frame of f.messages) {
          expect(frame).toEqual({
            event: "media",
            streamSid: "MZ-stream",
            media: { payload: Buffer.alloc(160, 0xff).toString("base64") },
          });
        }
        synthesis.resolve();
        await vi.waitFor(() => expect(f.marks()).toHaveLength(1));
        expect(f.speech()).toEqual([Buffer.alloc(160, 0xce), Buffer.alloc(160, 0xce)]);
        expect(completed).toBe(false);
        expect(f.synthesize).toHaveBeenCalledTimes(1);
        f.acknowledge(0);
        await withTimeout(first);
        expect(completed).toBe(true);
        await vi.waitFor(() => expect(f.marks()).toHaveLength(2));
        expect(f.marks()[1]?.mark.name).not.toBe(f.marks()[0]?.mark.name);
        expect(f.synthesize.mock.calls.map(([request]) => request.text)).toEqual([
          "first",
          "second",
        ]);
        f.acknowledge(1);
        await withTimeout(second);
        expect(Buffer.concat(f.speech())).toEqual(Buffer.alloc(640, 0xce));
      } finally {
        synthesis.resolve();
        f.provider.clearTtsQueue("CA-stream", "test cleanup");
        await Promise.allSettled([first, second]);
      }
    });
  });

  it.each([false, true])(
    "preserves synthesis outcome after a failed keepalive (rejects=%s)",
    async (rejects) => {
      await withStreamingProvider(async (f) => {
        f.beforeSend.mockImplementationOnce(() => {
          throw new Error("keepalive socket failure");
        });
        const synthesisError = new Error("synthesis failure");
        if (rejects) {
          f.synthesize.mockRejectedValueOnce(synthesisError);
        }
        const playback = f.play("keepalive");
        if (rejects) {
          await expect(withTimeout(playback)).rejects.toBe(synthesisError);
          expect(f.marks()).toEqual([]);
        } else {
          await vi.waitFor(() => expect(f.marks()).toHaveLength(1));
          expect(Buffer.concat(f.speech())).toEqual(Buffer.alloc(320, 0xce));
          f.acknowledge(0);
          await withTimeout(playback);
        }
        expect(f.beforeSend.mock.calls[0]?.[0]).toEqual({
          event: "media",
          streamSid: "MZ-stream",
          media: { payload: Buffer.alloc(160, 0xff).toString("base64") },
        });
      });
    },
  );

  it("cancels active and queued synthesis and recovers through the real stream queue", async () => {
    await withStreamingProvider(async (f) => {
      const lateSynthesis = createDeferred<void>();
      f.synthesize.mockImplementationOnce(async () => {
        await lateSynthesis.promise;
        return { ...f.result, audioBuffer: Buffer.alloc(1_920, Buffer.from([0x18, 0xfc])) };
      });
      const cancelled = f.play("cancel me");
      const queued = f.play("discard me");
      try {
        await vi.waitFor(() => expect(f.synthesize).toHaveBeenCalledTimes(1));
        f.provider.clearTtsQueue("CA-stream", "barge-in");
        await withTimeout(Promise.all([cancelled, queued]));
        expect(f.speech()).toEqual([]);
        expect(f.marks()).toEqual([]);
        const next = f.play("play next");
        lateSynthesis.resolve();
        await vi.waitFor(() => expect(f.marks()).toHaveLength(1));
        expect(f.synthesize.mock.calls.map(([request]) => request.text)).toEqual([
          "cancel me",
          "play next",
        ]);
        expect(f.speech()).toEqual([Buffer.alloc(160, 0xce), Buffer.alloc(160, 0xce)]);
        f.acknowledge(0);
        await withTimeout(next);
      } finally {
        lateSynthesis.resolve();
        f.provider.clearTtsQueue("CA-stream", "test cleanup");
        await Promise.allSettled([cancelled, queued]);
      }
    });
  });
});
