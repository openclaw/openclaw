import { describe, expect, it } from "vitest";
import { createLipSyncAnalyzer } from "../src/avatar-lipsync.js";

const SAMPLE_RATE_HZ = 24_000;

function pcm(milliseconds: number, sample: (seconds: number, index: number) => number): Buffer {
  const samples = (SAMPLE_RATE_HZ * milliseconds) / 1000;
  const audio = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.max(-1, Math.min(1, sample(index / SAMPLE_RATE_HZ, index)));
    audio.writeInt16LE(Math.round(value * 32_767), index * 2);
  }
  return audio;
}

const tone = (hz: number, gain: number) => (seconds: number) =>
  gain * Math.sin(2 * Math.PI * hz * seconds);

// Deterministic noise: a hiss needs energy and zero crossings across the whole band.
function noise(gain: number) {
  let state = 0x2545f491;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return gain * ((state >>> 0) / 0x80000000 - 1);
  };
}

const pairs = (frames: number[]) =>
  Array.from({ length: frames.length / 2 }, (_unused, index) => ({
    open: frames[index * 2],
    wide: frames[index * 2 + 1],
  }));

describe("FaceTime avatar lip sync", () => {
  it("emits one closed mouth per 20 ms hop of silence and drops a partial hop", () => {
    const analyze = createLipSyncAnalyzer();

    expect(analyze(pcm(50, () => 0))).toEqual([0, 0, 0, 0]);
    expect(analyze(Buffer.alloc(0))).toEqual([]);
  });

  it("opens and rounds the mouth for a low, back-vowel-like sound", () => {
    const shapes = pairs(createLipSyncAnalyzer()(pcm(200, tone(150, 0.4)))).slice(2);

    for (const shape of shapes) {
      expect(shape.open).toBeGreaterThan(70);
      expect(shape.wide).toBeLessThan(-50);
    }
  });

  it("spreads the mouth for a sound with strong upper formant energy", () => {
    const voiced = (seconds: number) => tone(300, 0.2)(seconds) + tone(2_300, 0.3)(seconds);
    const shapes = pairs(createLipSyncAnalyzer()(pcm(200, voiced))).slice(2);

    for (const shape of shapes) {
      expect(shape.open).toBeGreaterThan(70);
      expect(shape.wide).toBeGreaterThan(50);
    }
  });

  it("nearly closes the jaw for hiss", () => {
    const shapes = pairs(createLipSyncAnalyzer()(pcm(200, noise(0.3)))).slice(2);

    for (const shape of shapes) {
      expect(shape).toEqual({ open: 20, wide: 60 });
    }
  });

  it("scales openness with loudness relative to recent speech", () => {
    const analyze = createLipSyncAnalyzer();
    const loud = pairs(analyze(pcm(100, tone(300, 0.5)))).at(-1);
    const soft = pairs(analyze(pcm(100, tone(300, 0.1)))).at(-1);

    expect(loud?.open).toBe(100);
    expect(soft?.open).toBeGreaterThan(5);
    expect(soft?.open).toBeLessThan(40);
  });
});
