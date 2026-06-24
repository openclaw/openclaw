/** mu-law to 16-bit linear PCM conversion lookup table. */
const MULAW_TO_PCM = new Int16Array(256);
(function buildTable() {
  for (let i = 0; i < 256; i++) {
    let mu = ~i & 0xff;
    const sign = mu & 0x80 ? -1 : 1;
    mu &= 0x7f;
    const exponent = (mu >> 4) & 0x07;
    const mantissa = mu & 0x0f;
    const sample = sign * ((2 * mantissa + 33) * (1 << (exponent + 3)) - 33);
    MULAW_TO_PCM[i] = sample;
  }
})();

/**
 * Convert mu-law (G.711) audio to 16-bit signed PCM little-endian.
 * OpenClaw telephony uses mu-law; Nova Sonic expects PCM 16-bit.
 */
export function mulawToPcm16(mulaw: Buffer): Buffer {
  const pcm = Buffer.alloc(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) {
    pcm.writeInt16LE(MULAW_TO_PCM[mulaw[i]], i * 2);
  }
  return pcm;
}

/**
 * Convert 16-bit signed PCM little-endian to mu-law (G.711).
 * Nova Sonic outputs PCM; OpenClaw telephony expects mu-law.
 */
export function pcm16ToMulaw(pcm: Buffer): Buffer {
  const mulaw = Buffer.alloc(pcm.length / 2);
  for (let i = 0; i < mulaw.length; i++) {
    let sample = pcm.readInt16LE(i * 2);
    const sign = sample < 0 ? 0x80 : 0;
    if (sample < 0) {
      sample = -sample;
    }
    sample = Math.min(sample, 32635);
    sample += 0x84;

    let exponent = 7;
    for (let expMask = 0x4000; exponent > 0; exponent--, expMask >>= 1) {
      if (sample & expMask) {
        break;
      }
    }
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    mulaw[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return mulaw;
}

/**
 * Resample PCM 16-bit audio using linear interpolation.
 * @param pcm Source PCM buffer (16-bit LE samples)
 * @param fromRate Source sample rate (Hz)
 * @param toRate Target sample rate (Hz)
 * @returns Resampled PCM buffer
 */
export function resamplePcm16(pcm: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return pcm;
  const srcSamples = pcm.length / 2;
  const dstSamples = Math.round((srcSamples * toRate) / fromRate);
  const out = Buffer.alloc(dstSamples * 2);
  const ratio = fromRate / toRate;
  for (let i = 0; i < dstSamples; i++) {
    const srcPos = i * ratio;
    const srcIdx = Math.floor(srcPos);
    const frac = srcPos - srcIdx;
    const s0 = pcm.readInt16LE(Math.min(srcIdx, srcSamples - 1) * 2);
    const s1 = pcm.readInt16LE(Math.min(srcIdx + 1, srcSamples - 1) * 2);
    const sample = Math.round(s0 + frac * (s1 - s0));
    out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }
  return out;
}

/**
 * Convert mu-law (8kHz telephony) to PCM 16-bit at a target sample rate.
 * Handles the mu-law decode + upsample in one step.
 */
export function mulawToPcm16Resampled(mulaw: Buffer, targetRate: number): Buffer {
  const pcm8k = mulawToPcm16(mulaw);
  return resamplePcm16(pcm8k, 8000, targetRate);
}

/**
 * Convert PCM 16-bit at a given sample rate to mu-law (8kHz telephony).
 * Handles the downsample + mu-law encode in one step.
 */
export function pcm16ResampledToMulaw(pcm: Buffer, sourceRate: number): Buffer {
  const pcm8k = resamplePcm16(pcm, sourceRate, 8000);
  return pcm16ToMulaw(pcm8k);
}
