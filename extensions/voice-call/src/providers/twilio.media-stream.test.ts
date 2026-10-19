import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { guardedJsonApiRequestMock } = vi.hoisted(() => ({
  guardedJsonApiRequestMock: vi.fn(),
}));

vi.mock("./shared/guarded-json-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared/guarded-json-api.js")>()),
  guardedJsonApiRequest: guardedJsonApiRequestMock,
}));

import { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import type { MediaStreamHandler } from "../media-stream.js";
import { createHandler, startWsServer } from "../media-stream.test-support.js";
import {
  createTelephonyTtsProvider,
  type TelephonyTtsProvider,
  type TelephonyTtsRuntime,
} from "../telephony-tts.js";
import { connectWs, withTimeout } from "../websocket-test-support.js";
import { TwilioProvider } from "./twilio.js";

beforeEach(() => {
  vi.useRealTimers();
  guardedJsonApiRequestMock.mockReset();
});
afterEach(() => vi.useRealTimers());

function createProvider(): TwilioProvider {
  return new TwilioProvider(
    { accountSid: "AC123", authToken: "secret" },
    { publicUrl: "https://example.ngrok.app", streamPath: "/voice/stream" },
  );
}

function timedPlayback(synthesizeForTelephony: TelephonyTtsProvider["synthesizeForTelephony"]) {
  vi.useFakeTimers();
  const provider = createProvider();
  provider.registerCallStream("CA-timed", "MZ-timed");
  const controller = new AbortController();
  const sendAudio = vi.fn<MediaStreamHandler["sendAudio"]>(() => true);
  const sendMarkAndWait = vi.fn(async () => {});
  provider.setMediaStreamHandler({
    queueTts: async (_streamSid: string, play: (signal: AbortSignal) => Promise<void>) =>
      await play(controller.signal),
    sendAudio,
    sendMarkAndWait,
    clearAudio: vi.fn(),
  } as never);
  provider.setTTSProvider({ synthesisTimeoutMs: 5000, synthesizeForTelephony });
  return {
    controller,
    sendAudio,
    sendMarkAndWait,
    play: (text: string) =>
      provider.playTts({ callId: "call-timed", providerCallId: "CA-timed", text }),
  };
}

type StreamFrame =
  | { event: "media"; streamSid: string; media: { payload: string } }
  | { event: "mark"; streamSid: string; mark: { name: string } }
  | { event: "clear"; streamSid: string };

function createStreamFixture() {
  const provider = createProvider();
  const messages: StreamFrame[] = [];
  const playbacks: Promise<void>[] = [];
  const releaseSynthesis: Array<() => void> = [];
  const beforeSend = vi.fn<(frame: StreamFrame) => void>();
  const result = {
    success: true,
    audioBuffer: Buffer.alloc(1_920, Buffer.from([0xe8, 0x03])),
    sampleRate: 24_000,
    outputFormat: "pcm",
  };
  const synthesize = vi.fn<TelephonyTtsRuntime["textToSpeechTelephony"]>(async () => result);
  const marks = () => messages.filter((frame) => frame.event === "mark");
  return {
    provider,
    messages,
    playbacks,
    releaseSynthesis,
    beforeSend,
    result,
    synthesize,
    marks,
    texts: () => synthesize.mock.calls.map(([request]) => request.text),
    deferSynthesis: (audio = result.audioBuffer) => {
      const pending = createDeferred<void>();
      releaseSynthesis.push(pending.resolve);
      synthesize.mockImplementationOnce(async () => {
        await pending.promise;
        return { ...result, audioBuffer: audio };
      });
      return pending.resolve;
    },
    play: (text: string) => {
      const playback = provider.playTts({
        callId: "call-stream",
        providerCallId: "CA-stream",
        text,
      });
      playbacks.push(playback);
      return playback;
    },
    speech: () =>
      messages.flatMap((frame) => {
        if (frame.event !== "media") {
          return [];
        }
        const audio = Buffer.from(frame.media.payload, "base64");
        return audio.every((byte) => byte === 0xff) ? [] : [audio];
      }),
  };
}

async function withStreamingProvider(
  run: (
    fixture: ReturnType<typeof createStreamFixture> & { acknowledge: (index: number) => void },
  ) => Promise<void>,
) {
  const fixture = createStreamFixture();
  const { provider, messages, beforeSend, synthesize, marks, releaseSynthesis, playbacks } =
    fixture;
  const connected = createDeferred<void>();
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
  const handler = createHandler({
    shouldAcceptStream: ({ callId, streamSid }) =>
      callId === "CA-stream" && streamSid === "MZ-stream",
    onConnect: (callId, streamSid) => provider.registerCallStream(callId, streamSid),
    onTranscriptionReady: () => connected.resolve(),
  });
  provider.setMediaStreamHandler(handler);
  guardedJsonApiRequestMock.mockImplementation(() => {
    throw new Error("Unexpected Twilio REST request during stream playback");
  });
  const server = await startWsServer(handler);
  let peer: WebSocket | undefined;
  let restoreSend: (() => void) | undefined;
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
    const originalSend = WebSocket.prototype.send;
    const send = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
      this: WebSocket,
      ...args
    ) {
      const data = args[0];
      // Intercept only the server's frames; client acknowledgements use the original transport.
      if (this !== client) {
        if (typeof data !== "string" && !Buffer.isBuffer(data) && !(data instanceof ArrayBuffer)) {
          throw new Error("Expected a JSON text or byte frame from the media handler");
        }
        beforeSend(
          JSON.parse(typeof data === "string" ? data : rawDataToString(data)) as StreamFrame,
        );
      }
      originalSend.apply(this, args);
    });
    restoreSend = () => send.mockRestore();
    await run({
      ...fixture,
      acknowledge: (index) =>
        client.send(JSON.stringify(expectDefined(marks()[index], "playback mark"))),
    });
    expect(guardedJsonApiRequestMock).not.toHaveBeenCalled();
  } finally {
    for (const release of releaseSynthesis) {
      release();
    }
    provider.clearTtsQueue("CA-stream", "test cleanup");
    restoreSend?.();
    peer?.terminate();
    await handler.close();
    await Promise.allSettled(playbacks);
    await server.close();
  }
}

describe("TwilioProvider", () => {
  it("times out telephony synthesis in stream mode and does not send completion mark", async () => {
    const f = timedPlayback(async () => await new Promise<Buffer>(() => {}));
    const playExpectation = expect(f.play("Timeout me")).rejects.toThrow(
      "Telephony TTS synthesis timed out after 5000ms",
    );
    await vi.advanceTimersByTimeAsync(5_100);
    await playExpectation;
    expect(f.sendAudio).toHaveBeenCalled();
    expect(f.sendMarkAndWait).not.toHaveBeenCalled();
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
    const f = timedPlayback(async () => Buffer.alloc(160 * 10, 0x80));
    f.sendAudio.mockImplementation(() => {
      // The first send is the synthesis keepalive; the second is the first real audio chunk.
      if (f.sendAudio.mock.calls.length === 2) {
        f.controller.abort();
      }
      return true;
    });

    const startedAt = Date.now();
    await expect(f.play("hello")).resolves.toBeUndefined();
    expect(Date.now()).toBe(startedAt);
    expect(f.sendAudio).toHaveBeenCalledTimes(2);
    expect(f.sendMarkAndWait).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("streams exact PCM output and gates the real queue on echoed playback marks", async () => {
    await withStreamingProvider(async (f) => {
      const finishSynthesis = f.deferSynthesis();
      let completed = false;
      const first = f.play("first").then(() => {
        completed = true;
      });
      f.playbacks.push(first);
      const second = f.play("second");
      await vi.waitFor(() => expect(f.messages.length).toBeGreaterThanOrEqual(2));
      for (const frame of f.messages) {
        expect(frame).toEqual({
          event: "media",
          streamSid: "MZ-stream",
          media: { payload: Buffer.alloc(160, 0xff).toString("base64") },
        });
      }
      finishSynthesis();
      await vi.waitFor(() => expect(f.marks()).toHaveLength(1));
      expect(f.speech()).toEqual([Buffer.alloc(160, 0xce), Buffer.alloc(160, 0xce)]);
      expect(completed).toBe(false);
      expect(f.synthesize).toHaveBeenCalledTimes(1);
      f.acknowledge(0);
      await withTimeout(first);
      expect(completed).toBe(true);
      await vi.waitFor(() => expect(f.marks()).toHaveLength(2));
      expect(f.marks()[1]?.mark.name).not.toBe(f.marks()[0]?.mark.name);
      expect(f.texts()).toEqual(["first", "second"]);
      f.acknowledge(1);
      await withTimeout(second);
      expect(Buffer.concat(f.speech())).toEqual(Buffer.alloc(640, 0xce));
    });
  });

  it.each([false, true])(
    "preserves synthesis outcome after a failed keepalive (rejects=%s)",
    async (rejects) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await withStreamingProvider(async (f) => {
        f.beforeSend.mockImplementationOnce(() => {
          throw new Error("keepalive socket failure");
        });
        const synthesisError = new Error("z22-private-speech-failure");
        if (rejects) {
          f.synthesize.mockRejectedValueOnce(synthesisError);
        }
        const playback = f.play("keepalive");
        if (rejects) {
          await expect(withTimeout(playback)).rejects.toBe(synthesisError);
          expect(f.marks()).toEqual([]);
          expect(warn).toHaveBeenCalledWith("[voice-call] Telephony TTS failed callId=call-stream");
          expect(warn.mock.calls.flat().join(" ")).not.toContain(synthesisError.message);
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
      }).finally(() => warn.mockRestore());
    },
  );

  it("cancels active and queued synthesis and recovers through the real stream queue", async () => {
    await withStreamingProvider(async (f) => {
      const finishSynthesis = f.deferSynthesis(Buffer.alloc(1_920, Buffer.from([0x18, 0xfc])));
      const cancelled = f.play("cancel me");
      const queued = f.play("discard me");
      await vi.waitFor(() => expect(f.synthesize).toHaveBeenCalledTimes(1));
      f.provider.clearTtsQueue("CA-stream", "barge-in");
      await withTimeout(Promise.all([cancelled, queued]));
      expect(f.speech()).toEqual([]);
      expect(f.marks()).toEqual([]);
      const next = f.play("play next");
      finishSynthesis();
      await vi.waitFor(() => expect(f.marks()).toHaveLength(1));
      expect(f.texts()).toEqual(["cancel me", "play next"]);
      expect(f.speech()).toEqual([Buffer.alloc(160, 0xce), Buffer.alloc(160, 0xce)]);
      f.acknowledge(0);
      await withTimeout(next);
    });
  });
});
