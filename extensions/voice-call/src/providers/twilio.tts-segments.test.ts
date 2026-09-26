// Voice Call tests cover segmented Twilio media-stream TTS playback.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { guardedJsonApiRequestMock } = vi.hoisted(() => ({
  guardedJsonApiRequestMock: vi.fn(),
}));

vi.mock("./shared/guarded-json-api.js", () => ({
  guardedJsonApiRequest: guardedJsonApiRequestMock,
}));

import { chunkTelephonyReply, MAX_TELEPHONY_TTS_SYNTH_CHARS } from "../telephony-tts-chunking.js";
import { TwilioProvider } from "./twilio.js";

beforeEach(() => {
  vi.useRealTimers();
  guardedJsonApiRequestMock.mockReset();
});

function createProvider(): TwilioProvider {
  return new TwilioProvider(
    { accountSid: "AC123", authToken: "secret" },
    { publicUrl: "https://example.ngrok.app", streamPath: "/voice/stream" },
  );
}

/** A reply well past the synthesis budget, several sentences long. */
function longReply(): string {
  return Array.from(
    { length: 14 },
    (_, index) => `This is sentence number ${index} with a handful of filler words.`,
  ).join(" ");
}

/**
 * Wire a provider to a fake media stream plus a TTS provider whose
 * `prepareSpeech` splits with the real chunker.
 */
function wireProvider(params: {
  provider: TwilioProvider;
  signal: AbortSignal;
  synthesizeSegment: (segment: string) => Promise<Buffer>;
  sendAudio?: (streamSid: string, chunk: Buffer) => { sent: boolean };
}) {
  const sendAudio = vi.fn(params.sendAudio ?? (() => ({ sent: true })));
  const sendMarkAndWait = vi.fn(async () => {});
  const clearAudio = vi.fn();
  const mediaStreamHandler = {
    queueTts: async (
      _streamSid: string,
      playFn: (signal: AbortSignal) => Promise<void>,
    ): Promise<void> => {
      await playFn(params.signal);
    },
    sendAudio,
    sendMarkAndWait,
    clearAudio,
  };
  params.provider.setMediaStreamHandler(mediaStreamHandler as never);
  params.provider.setTTSProvider({
    synthesisTimeoutMs: 5_000,
    synthesizeForTelephony: async () => Buffer.alloc(160),
    prepareSpeech: async (text: string) => ({
      segments: chunkTelephonyReply(text, MAX_TELEPHONY_TTS_SYNTH_CHARS),
      synthesizeSegment: params.synthesizeSegment,
    }),
  });
  return { sendAudio, sendMarkAndWait, clearAudio };
}

describe("TwilioProvider segmented stream playback", () => {
  it("synthesizes every segment in order and sends one completion mark", async () => {
    vi.useFakeTimers();
    try {
      const provider = createProvider();
      provider.registerCallStream("CA-long", "MZ-long");
      const synthesized: string[] = [];
      const { sendMarkAndWait } = wireProvider({
        provider,
        signal: new AbortController().signal,
        synthesizeSegment: async (segment) => {
          synthesized.push(segment);
          return Buffer.alloc(160);
        },
      });

      const text = longReply();
      const expected = chunkTelephonyReply(text, MAX_TELEPHONY_TTS_SYNTH_CHARS);
      expect(expected.length).toBeGreaterThan(1);

      const playback = provider.playTts({
        callId: "call-long",
        providerCallId: "CA-long",
        text,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await playback;

      expect(synthesized).toEqual(expected);
      for (const segment of synthesized) {
        expect(segment.length).toBeLessThanOrEqual(MAX_TELEPHONY_TTS_SYNTH_CHARS);
      }
      // One mark for the whole reply, not one per segment.
      expect(sendMarkAndWait).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never interleaves keep-alive silence with a segment's speech frames", async () => {
    vi.useFakeTimers();
    try {
      const provider = createProvider();
      provider.registerCallStream("CA-pace", "MZ-pace");
      // Each frame is tagged with its segment so the emitted order can be read
      // back exactly: 0xff is keep-alive silence, anything else is speech.
      const frames: number[] = [];
      let segmentIndex = 0;
      wireProvider({
        provider,
        signal: new AbortController().signal,
        sendAudio: (_streamSid: string, chunk: Buffer) => {
          frames.push(chunk[0] ?? 0);
          return { sent: true };
        },
        synthesizeSegment: async () => {
          segmentIndex += 1;
          // Synthesis takes real time, so keep-alive silence has a gap to fill.
          await new Promise((resolve) => {
            setTimeout(resolve, 100);
          });
          return Buffer.alloc(160 * 3, segmentIndex);
        },
      });

      const text = longReply();
      expect(chunkTelephonyReply(text, MAX_TELEPHONY_TTS_SYNTH_CHARS).length).toBeGreaterThan(1);

      const playback = provider.playTts({
        callId: "call-pace",
        providerCallId: "CA-pace",
        text,
      });
      await vi.advanceTimersByTimeAsync(60_000);
      await playback;

      // Silence before and between segments is expected: it holds the carrier
      // stream open while nothing is being spoken. Silence *inside* a segment
      // is the defect, so each segment's frames must be one unbroken run.
      for (let segment = 1; segment <= segmentIndex; segment += 1) {
        const positions = frames.flatMap((value, index) => (value === segment ? [index] : []));
        expect(positions.length).toBeGreaterThan(0);
        const span = positions[positions.length - 1]! - positions[0]! + 1;
        expect(span).toBe(positions.length);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears buffered audio when a later segment fails to synthesize", async () => {
    vi.useFakeTimers();
    try {
      const provider = createProvider();
      provider.registerCallStream("CA-fail", "MZ-fail");
      let calls = 0;
      const { clearAudio, sendMarkAndWait } = wireProvider({
        provider,
        signal: new AbortController().signal,
        synthesizeSegment: async () => {
          calls += 1;
          if (calls === 1) {
            return Buffer.alloc(160);
          }
          throw new Error("Telephony TTS synthesis timed out after 5000ms");
        },
      });

      const playback = provider.playTts({
        callId: "call-fail",
        providerCallId: "CA-fail",
        text: longReply(),
      });
      const settled = playback.then(
        () => "resolved" as const,
        () => "rejected" as const,
      );
      await vi.advanceTimersByTimeAsync(1_000);

      expect(await settled).toBe("rejected");
      // The first segment's frames were already accepted, so the partially
      // played reply must be flushed rather than left for the caller to hear.
      expect(clearAudio).toHaveBeenCalledWith("MZ-fail");
      expect(sendMarkAndWait).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels every remaining segment when a barge-in aborts playback", async () => {
    vi.useFakeTimers();
    try {
      const provider = createProvider();
      provider.registerCallStream("CA-barge", "MZ-barge");
      const controller = new AbortController();
      const synthesized: string[] = [];
      const { sendMarkAndWait, clearAudio } = wireProvider({
        provider,
        signal: controller.signal,
        synthesizeSegment: async (segment) => {
          synthesized.push(segment);
          // The caller interrupts while the first segment is synthesizing.
          if (synthesized.length === 1) {
            controller.abort();
          }
          return Buffer.alloc(160);
        },
      });

      const text = longReply();
      expect(chunkTelephonyReply(text, MAX_TELEPHONY_TTS_SYNTH_CHARS).length).toBeGreaterThan(1);

      const playback = provider.playTts({
        callId: "call-barge",
        providerCallId: "CA-barge",
        text,
      });
      const settled = playback.then(
        () => "resolved" as const,
        () => "rejected" as const,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await settled;

      // The whole reply occupies one serialized queue slot, so aborting it drops
      // every remaining segment instead of playing them after the caller stops.
      expect(synthesized).toHaveLength(1);
      expect(sendMarkAndWait).not.toHaveBeenCalled();
      // Abort is a cancellation, not a failure: the queue owns that cleanup.
      expect(clearAudio).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
