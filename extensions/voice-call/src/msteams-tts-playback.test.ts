// Voice Call tests cover msteams TTS playback viseme-mark selection (aligned vs estimated).
import { describe, expect, it, vi } from "vitest";
import type { MsteamsSession } from "./msteams-media-stream.js";
import { playTtsToCall, type TtsPlaybackTarget } from "./msteams-tts-playback.js";
import { createMsteamsTtsProvider, type MsteamsTtsProvider } from "./msteams-tts.js";
import { estimateVisemes, visemesFromAlignment } from "./viseme-estimate.js";

/** One 20 ms PCM 16 kHz mono frame (640 bytes) so playback sends a single frame and returns fast. */
const ONE_FRAME = Buffer.alloc(640, 1);

function createPlaybackState(sent: unknown[]): TtsPlaybackTarget {
  const session = {
    send: vi.fn((message: unknown) => {
      sent.push(message);
      return true;
    }),
  } as unknown as MsteamsSession;
  return {
    providerCallId: "call-1",
    session,
    ttsAbort: null,
    turnId: 0,
    outboundSeq: 0,
    outboundTimestampMs: 0,
    lastOutboundFrameAt: 0,
  };
}

function sentSpeechMarks(sent: unknown[]): { marks: unknown } | undefined {
  return sent.find((message) => (message as { type?: string }).type === "speech.marks") as
    | { marks: unknown }
    | undefined;
}

describe("playTtsToCall viseme marks", () => {
  it("uses real alignment timing when the provider returns it", async () => {
    const alignment = {
      characters: ["m", "a", "a"],
      startTimesSeconds: [0, 0.25, 0.5],
    };
    const synthesizePcm16k = vi.fn(async () => ONE_FRAME);
    const provider: MsteamsTtsProvider = {
      synthesizePcm16k,
      synthesizePcm16kWithTiming: vi.fn(async () => ({ pcm16k: ONE_FRAME, alignment })),
    };
    const sent: unknown[] = [];

    await playTtsToCall({ ttsProvider: provider }, createPlaybackState(sent), "maa");

    const expected = visemesFromAlignment(alignment.characters, alignment.startTimesSeconds);
    expect(expected.length).toBeGreaterThan(0);
    expect(sentSpeechMarks(sent)?.marks).toEqual(expected);
    // The aligned path must not consult the audio-only method.
    expect(synthesizePcm16k).not.toHaveBeenCalled();
  });

  it("falls back to estimated marks when the provider returns no alignment", async () => {
    const provider: MsteamsTtsProvider = {
      synthesizePcm16k: vi.fn(async () => ONE_FRAME),
      synthesizePcm16kWithTiming: vi.fn(async () => ({ pcm16k: ONE_FRAME })),
    };
    const sent: unknown[] = [];

    await playTtsToCall({ ttsProvider: provider }, createPlaybackState(sent), "hello there");

    const durationMs = (ONE_FRAME.length / 2 / 16_000) * 1000;
    expect(sentSpeechMarks(sent)?.marks).toEqual(estimateVisemes("hello there", durationMs));
  });

  it("falls back to estimated marks for providers without the timing method", async () => {
    const provider: MsteamsTtsProvider = {
      synthesizePcm16k: vi.fn(async () => ONE_FRAME),
    };
    const sent: unknown[] = [];

    await playTtsToCall({ ttsProvider: provider }, createPlaybackState(sent), "hello there");

    const durationMs = (ONE_FRAME.length / 2 / 16_000) * 1000;
    expect(sentSpeechMarks(sent)?.marks).toEqual(estimateVisemes("hello there", durationMs));
  });
});

describe("createMsteamsTtsProvider alignment forwarding", () => {
  it("forwards runtime alignment alongside resampled audio", async () => {
    const alignment = { characters: ["h", "i"], startTimesSeconds: [0, 0.4] };
    const provider = createMsteamsTtsProvider({
      coreConfig: {},
      runtime: {
        textToSpeechTelephony: async () => ({
          success: true,
          // 22050 Hz input forces the resample branch; alignment must survive it.
          audioBuffer: Buffer.alloc(882, 1),
          sampleRate: 22_050,
          alignment,
        }),
      },
    });

    const result = await provider.synthesizePcm16kWithTiming?.("hi");
    expect(result?.alignment).toEqual(alignment);
    expect(result?.pcm16k.length).toBeGreaterThan(0);
  });

  it("returns audio without alignment when the runtime result has none", async () => {
    const provider = createMsteamsTtsProvider({
      coreConfig: {},
      runtime: {
        textToSpeechTelephony: async () => ({
          success: true,
          audioBuffer: ONE_FRAME,
          sampleRate: 16_000,
        }),
      },
    });

    const result = await provider.synthesizePcm16kWithTiming?.("hi");
    expect(result?.alignment).toBeUndefined();
    expect(result?.pcm16k.equals(ONE_FRAME)).toBe(true);
  });
});
