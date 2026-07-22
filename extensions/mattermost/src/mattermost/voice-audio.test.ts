import { describe, expect, it } from "vitest";
import {
  buildMonoWav,
  createVoiceCapture,
  decodePcmWavToStereo48k,
  downsampleStereo48kToMono16k,
} from "./voice-audio.js";

function frame(value: number): Int16Array {
  return new Int16Array([value, value]);
}

describe("Mattermost voice audio", () => {
  it("includes bounded pre-roll when speech starts", () => {
    const capture = createVoiceCapture({ maxSpeechSamples: 100, preRollFrames: 2 });

    capture.push(frame(1));
    capture.push(frame(2));
    capture.push(frame(3));
    capture.start();
    capture.push(frame(4));

    expect(Array.from(capture.stop())).toEqual([2, 2, 3, 3, 4, 4]);
    expect(capture.stop()).toHaveLength(0);
  });

  it("keeps the current utterance when speaking-on is repeated", () => {
    const capture = createVoiceCapture({ maxSpeechSamples: 100, preRollFrames: 2 });

    capture.push(frame(1));
    capture.start();
    capture.push(frame(2));
    capture.start();
    capture.push(frame(3));

    expect(Array.from(capture.stop())).toEqual([1, 1, 2, 2, 3, 3]);
  });

  it("bounds captured speech samples while voice activity remains active", () => {
    const capture = createVoiceCapture({ maxSpeechSamples: 4, preRollFrames: 1 });

    capture.push(frame(1));
    capture.start();
    capture.push(frame(2));
    capture.push(frame(3));

    expect(Array.from(capture.stop())).toEqual([1, 1, 2, 2]);
  });

  it("downsamples 48 kHz stereo PCM to 16 kHz mono", () => {
    const stereo = new Int16Array([
      900, 1_100, 1_900, 2_100, 2_900, 3_100, 3_900, 4_100, 4_900, 5_100, 5_900, 6_100,
    ]);

    expect(Array.from(downsampleStereo48kToMono16k(stereo))).toEqual([2_000, 5_000]);
  });

  it("builds a valid 16-bit mono WAV", () => {
    const wav = buildMonoWav(new Int16Array([1, -2]), 16_000);

    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(4);
    expect(wav.readInt16LE(44)).toBe(1);
    expect(wav.readInt16LE(46)).toBe(-2);
  });

  it("decodes and resamples PCM WAV replies for WebRTC playback", () => {
    const source = new Int16Array(441).fill(1_234);
    const decoded = decodePcmWavToStereo48k(buildMonoWav(source, 44_100));

    expect(decoded).toHaveLength(480 * 2 * 2);
    expect(decoded?.readInt16LE(0)).toBe(1_234);
    expect(decoded?.readInt16LE(2)).toBe(1_234);
    expect(decoded?.readInt16LE((480 - 1) * 4)).toBe(1_234);
  });
});
