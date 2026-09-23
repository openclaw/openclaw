import { resamplePcm } from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it } from "vitest";
import {
  createDiscordPcmToRealtimeConverter,
  createRealtimePcmToDiscordConverter,
} from "./audio.js";

function createMono(sampleRate: number): Buffer {
  const pcm = Buffer.alloc((sampleRate / 10) * 2);
  for (let offset = 0; offset < pcm.length; offset += 2) {
    pcm.writeInt16LE(Math.round(Math.sin((offset / 2) * 0.19) * 24_000), offset);
  }
  return pcm;
}

function streamFragments(
  pcm: Buffer,
  converter: { process(chunk: Buffer): Buffer; flush(): Buffer },
): Buffer {
  const output: Buffer[] = [];
  const sizes = [1, 389, 2, 960, 7, 1_919];
  let offset = 0;
  let chunkIndex = 0;
  while (offset < pcm.length) {
    const chunk = Buffer.from(
      pcm.subarray(offset, offset + (sizes[chunkIndex % sizes.length] ?? 1)),
    );
    offset += chunk.length;
    chunkIndex += 1;
    output.push(converter.process(chunk));
    chunk.fill(0x7f);
  }
  output.push(converter.flush());
  expect(converter.flush()).toHaveLength(0);
  expect(() => converter.process(Buffer.alloc(4))).toThrow(/flushed/);
  return Buffer.concat(output);
}

describe("Discord streaming PCM conversion", () => {
  it("preserves the waveform and stereo frame fragments across incoming packet boundaries", () => {
    const mono = createMono(48_000);
    const stereo = Buffer.alloc(mono.length * 2);
    for (let offset = 0; offset < mono.length; offset += 2) {
      const sample = mono.readInt16LE(offset);
      stereo.writeInt16LE(sample - 3_000, offset * 2);
      stereo.writeInt16LE(sample + 3_000, offset * 2 + 2);
    }
    const actual = streamFragments(stereo, createDiscordPcmToRealtimeConverter());
    expect(actual).toEqual(resamplePcm(mono, 48_000, 24_000));
  });

  it("preserves the waveform and split samples across outgoing provider chunks", () => {
    const mono = createMono(24_000);
    const resampled = resamplePcm(mono, 24_000, 48_000);
    const actual = streamFragments(mono, createRealtimePcmToDiscordConverter());
    expect(actual.length).toBe(resampled.length * 2);
    for (let offset = 0; offset < resampled.length; offset += 2) {
      expect(actual.readInt16LE(offset * 2)).toBe(resampled.readInt16LE(offset));
      expect(actual.readInt16LE(offset * 2 + 2)).toBe(resampled.readInt16LE(offset));
    }
  });

  it("drains a playback gap without losing history, samples, or a split PCM byte", () => {
    const input = createMono(24_000);
    const splitBytes = 961;
    const completePrefixBytes = splitBytes - 1;
    const converter = createRealtimePcmToDiscordConverter();
    const prefix = Buffer.concat([
      converter.process(input.subarray(0, splitBytes)),
      converter.drain(),
    ]);
    expect(converter.drain()).toHaveLength(0);
    const suffix = Buffer.concat([
      converter.process(input.subarray(splitBytes)),
      converter.flush(),
    ]);
    const prefixReference = resamplePcm(input.subarray(0, completePrefixBytes), 24_000, 48_000);
    const fullReference = resamplePcm(input, 24_000, 48_000);
    expect(prefix.length).toBe(prefixReference.length * 2);
    expect(prefix.length + suffix.length).toBe(fullReference.length * 2);
    for (let offset = 0; offset < prefixReference.length; offset += 2) {
      expect(prefix.readInt16LE(offset * 2)).toBe(prefixReference.readInt16LE(offset));
    }
    // The already played gap edge was approximated; later output still uses its
    // real preceding samples rather than treating the resumed chunk as a new signal.
    for (let offset = 0; offset < suffix.length / 2; offset += 2) {
      const sample = fullReference.readInt16LE(prefixReference.length + offset);
      expect(suffix.readInt16LE(offset * 2)).toBe(sample);
      expect(suffix.readInt16LE(offset * 2 + 2)).toBe(sample);
    }
  });
});
