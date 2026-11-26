// Mouth shapes from model speech, cheap enough to run inline on every audio chunk.
// Each 20 ms hop yields two integers: jaw openness 0..100 and mouth width -100 (rounded,
// "oo") .. 100 (spread, "ee"). Openness follows loudness against a slowly decaying peak, so a
// quiet voice still opens the mouth; width follows how much of the energy sits above ~900 Hz,
// which separates back vowels from front vowels; hiss-like hops close the jaw for s/f/sh.
// The decibel ranges below were fitted to synthesized speech: voiced hops sit 0-26 dB under the
// running peak, and their high/low band ratio spans about -14 dB (back) to -6 dB (front).

export const LIP_SYNC_HOP_MS = 20;
const SAMPLE_RATE_HZ = 24_000;
const HOP_SAMPLES = (SAMPLE_RATE_HZ * LIP_SYNC_HOP_MS) / 1000;
// One-pole low-pass at about 900 Hz: 1 - exp(-2 * pi * 900 / 24000).
const LOW_PASS_COEFFICIENT = 0.21;
const SILENCE_RMS = 0.008;
const PEAK_FLOOR_RMS = 0.05;
// The loudness reference halves in about 7 seconds of quieter speech.
const PEAK_DECAY_PER_HOP = 0.998;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Returns an analyzer for one call's speech. Each call maps a PCM16 24 kHz mono chunk to flat
 * [openness, width, ...] pairs for its complete hops. A trailing partial hop is dropped: the
 * next chunk carries its own start time, so nothing drifts, and the renderer interpolates
 * across the gap.
 */
export function createLipSyncAnalyzer(): (pcm: Buffer) => number[] {
  let lowPass = 0;
  let peakRms = PEAK_FLOOR_RMS;
  return (pcm) => {
    const frames: number[] = [];
    const hops = Math.floor(pcm.byteLength / 2 / HOP_SAMPLES);
    for (let hop = 0; hop < hops; hop += 1) {
      let total = 0;
      let low = 0;
      let high = 0;
      let crossings = 0;
      let previous = 0;
      for (let index = 0; index < HOP_SAMPLES; index += 1) {
        const sample = pcm.readInt16LE((hop * HOP_SAMPLES + index) * 2) / 32_768;
        lowPass += LOW_PASS_COEFFICIENT * (sample - lowPass);
        const highPass = sample - lowPass;
        total += sample * sample;
        low += lowPass * lowPass;
        high += highPass * highPass;
        if (index > 0 && sample >= 0 !== previous >= 0) {
          crossings += 1;
        }
        previous = sample;
      }
      const rms = Math.sqrt(total / HOP_SAMPLES);
      peakRms = Math.max(rms, peakRms * PEAK_DECAY_PER_HOP, PEAK_FLOOR_RMS);
      if (rms < SILENCE_RMS) {
        frames.push(0, 0);
        continue;
      }
      const levelDb = 20 * Math.log10(rms / peakRms);
      const brightnessDb = 10 * Math.log10(high / low);
      const hiss = brightnessDb > 6 && crossings / HOP_SAMPLES > 0.3;
      // Compressed synthetic voices keep most vowels within a few dB of the peak. The curve
      // spends the jaw's range there, so syllables read as movement instead of a held-open mouth.
      const openness = clamp((levelDb + 26) / 26, 0, 1) ** 2.5;
      frames.push(
        Math.round((hiss ? Math.min(openness, 0.2) : openness) * 100),
        Math.round((hiss ? 0.6 : clamp((brightnessDb + 10) / 4, -1, 1)) * 100),
      );
    }
    return frames;
  };
}
