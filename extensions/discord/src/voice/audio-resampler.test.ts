import { describe, expect, it } from "vitest";
import { downsample48kStereoTo16kMono } from "./audio-resampler.js";

describe("downsample48kStereoTo16kMono", () => {
  it("returns empty buffer for empty input", () => {
    expect(downsample48kStereoTo16kMono(Buffer.alloc(0)).length).toBe(0);
  });

  it("returns empty buffer when input has fewer than 3 stereo frames", () => {
    // 2 stereo frames = 8 bytes, need at least 3 (12 bytes) for one output sample
    const buf = Buffer.alloc(8);
    expect(downsample48kStereoTo16kMono(buf).length).toBe(0);
  });

  it("produces exactly 1 output sample from 3 stereo frames", () => {
    // 3 stereo frames = 12 bytes → 1 mono sample = 2 bytes
    const buf = Buffer.alloc(12);
    buf.writeInt16LE(1000, 0); // L
    buf.writeInt16LE(2000, 2); // R
    // frames 2-3 are zeros (not used for output)
    const out = downsample48kStereoTo16kMono(buf);
    expect(out.length).toBe(2);
    // Average of 1000 and 2000 = 1500
    expect(out.readInt16LE(0)).toBe(1500);
  });

  it("averages left and right channels", () => {
    // 3 frames, first frame: L=4000, R=6000 → mono = 5000
    const buf = Buffer.alloc(12);
    buf.writeInt16LE(4000, 0);
    buf.writeInt16LE(6000, 2);
    const out = downsample48kStereoTo16kMono(buf);
    expect(out.readInt16LE(0)).toBe(5000);
  });

  it("handles negative samples correctly", () => {
    const buf = Buffer.alloc(12);
    buf.writeInt16LE(-3000, 0);
    buf.writeInt16LE(-5000, 2);
    const out = downsample48kStereoTo16kMono(buf);
    // (-3000 + -5000) >> 1 = -4000
    expect(out.readInt16LE(0)).toBe(-4000);
  });

  it("decimates by factor of 3 (takes every 3rd frame)", () => {
    // 6 stereo frames → 2 output mono samples
    const buf = Buffer.alloc(24); // 6 frames × 4 bytes
    // Frame 0: L=100, R=200 → output[0] = 150
    buf.writeInt16LE(100, 0);
    buf.writeInt16LE(200, 2);
    // Frame 1, 2: skip (not sampled)
    // Frame 3: L=300, R=400 → output[1] = 350
    buf.writeInt16LE(300, 12);
    buf.writeInt16LE(400, 14);

    const out = downsample48kStereoTo16kMono(buf);
    expect(out.length).toBe(4); // 2 mono samples × 2 bytes
    expect(out.readInt16LE(0)).toBe(150);
    expect(out.readInt16LE(2)).toBe(350);
  });

  it("drops trailing frames that don't complete a decimation group", () => {
    // 5 frames → floor(5/3) = 1 output sample (last 2 frames dropped)
    const buf = Buffer.alloc(20);
    buf.writeInt16LE(1000, 0);
    buf.writeInt16LE(1000, 2);
    const out = downsample48kStereoTo16kMono(buf);
    expect(out.length).toBe(2);
  });

  it("preserves output size ratio for larger buffers", () => {
    // 48000 stereo frames → 16000 mono samples
    const frames = 48000;
    const buf = Buffer.alloc(frames * 4);
    const out = downsample48kStereoTo16kMono(buf);
    expect(out.length).toBe(16000 * 2);
  });
});
