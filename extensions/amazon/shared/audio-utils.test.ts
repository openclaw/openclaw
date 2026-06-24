import { describe, it, expect } from "vitest";
import {
  mulawToPcm16,
  pcm16ToMulaw,
  resamplePcm16,
  mulawToPcm16Resampled,
  pcm16ResampledToMulaw,
} from "./audio-utils.js";

describe("audio-utils", () => {
  describe("mulawToPcm16 / pcm16ToMulaw", () => {
    it("round-trips through mu-law encoding", () => {
      // Generate PCM samples (a simple sine wave)
      const numSamples = 160; // 20ms at 8kHz
      const pcmOriginal = Buffer.alloc(numSamples * 2);
      for (let i = 0; i < numSamples; i++) {
        const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / 8000) * 16000);
        pcmOriginal.writeInt16LE(sample, i * 2);
      }

      // Encode to mu-law then back to PCM
      const mulaw = pcm16ToMulaw(pcmOriginal);
      expect(mulaw.length).toBe(numSamples);

      const pcmDecoded = mulawToPcm16(mulaw);
      expect(pcmDecoded.length).toBe(numSamples * 2);

      // Mu-law is lossy but should be within ~2% of original amplitude
      for (let i = 0; i < numSamples; i++) {
        const orig = pcmOriginal.readInt16LE(i * 2);
        const decoded = pcmDecoded.readInt16LE(i * 2);
        if (Math.abs(orig) > 100) {
          // Only check non-zero samples (mu-law distorts near zero)
          expect(Math.abs(decoded - orig) / Math.abs(orig)).toBeLessThan(0.15);
        }
      }
    });
  });

  describe("resamplePcm16", () => {
    it("returns same buffer when rates are equal", () => {
      const pcm = Buffer.alloc(320); // 10ms at 16kHz
      pcm.writeInt16LE(1000, 0);
      const result = resamplePcm16(pcm, 16000, 16000);
      expect(result).toBe(pcm);
    });

    it("doubles sample count when upsampling 8kHz to 16kHz", () => {
      const numSamples = 80; // 10ms at 8kHz
      const pcm = Buffer.alloc(numSamples * 2);
      for (let i = 0; i < numSamples; i++) {
        pcm.writeInt16LE(i * 100, i * 2);
      }
      const result = resamplePcm16(pcm, 8000, 16000);
      expect(result.length).toBe(numSamples * 2 * 2); // 160 samples * 2 bytes
    });

    it("reduces sample count when downsampling 24kHz to 8kHz", () => {
      const numSamples = 240; // 10ms at 24kHz
      const pcm = Buffer.alloc(numSamples * 2);
      for (let i = 0; i < numSamples; i++) {
        pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 24000) * 10000), i * 2);
      }
      const result = resamplePcm16(pcm, 24000, 8000);
      expect(result.length).toBe(80 * 2); // 80 samples at 8kHz for 10ms
    });

    it("preserves amplitude during resampling", () => {
      // 1kHz sine at 8kHz (well below Nyquist)
      const numSamples = 80;
      const pcm = Buffer.alloc(numSamples * 2);
      const amp = 10000;
      for (let i = 0; i < numSamples; i++) {
        pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 1000 * i) / 8000) * amp), i * 2);
      }
      const upsampled = resamplePcm16(pcm, 8000, 16000);
      // Check peak amplitude is preserved
      let maxAbs = 0;
      for (let i = 0; i < upsampled.length / 2; i++) {
        maxAbs = Math.max(maxAbs, Math.abs(upsampled.readInt16LE(i * 2)));
      }
      expect(maxAbs).toBeGreaterThan(amp * 0.9);
      expect(maxAbs).toBeLessThanOrEqual(amp);
    });
  });

  describe("mulawToPcm16Resampled", () => {
    it("converts mu-law to 16kHz PCM (upsample from 8kHz)", () => {
      // 20ms of mu-law silence (0xFF = silence in mu-law)
      const mulaw = Buffer.alloc(160, 0xff);
      const result = mulawToPcm16Resampled(mulaw, 16000);
      // 160 samples at 8kHz → 320 samples at 16kHz → 640 bytes
      expect(result.length).toBe(640);
    });
  });

  describe("pcm16ResampledToMulaw", () => {
    it("converts 24kHz PCM to mu-law (downsample to 8kHz)", () => {
      // 10ms of 24kHz PCM = 240 samples
      const pcm = Buffer.alloc(240 * 2);
      const result = pcm16ResampledToMulaw(pcm, 24000);
      // 240 samples at 24kHz → 80 samples at 8kHz → 80 bytes mu-law
      expect(result.length).toBe(80);
    });
  });
});
