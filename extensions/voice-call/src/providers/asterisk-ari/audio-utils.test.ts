import { describe, it, expect } from "vitest";
import { computeRms } from "./audio-utils.js";

describe("asterisk-ari/audio-utils computeRms", () => {
  it("does not read out-of-bounds for odd-length buffers", () => {
    // 1 byte short of a full int16 sample.
    const pcm = Buffer.from([0x01, 0x00, 0xff]);
    expect(() => computeRms(pcm)).not.toThrow();
  });

  it("uses only full int16 samples", () => {
    // Two samples: 1 and -1, plus one extra trailing byte (should be ignored).
    const pcm = Buffer.from([0x01, 0x00, 0xff, 0xff, 0x7f]);

    const rms = computeRms(pcm);

    // sqrt((1^2 + (-1)^2) / 2) === 1
    expect(rms).toBeCloseTo(1, 8);
  });
});
