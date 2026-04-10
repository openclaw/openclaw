/**
 * Audio resampler: 48 kHz stereo → 16 kHz mono via 3:1 decimation.
 *
 * The 48 k / 16 k ratio is exactly 3, so we take every 3rd sample from the
 * left channel (or average both channels first). This avoids fractional
 * resampling and requires no external dependencies.
 *
 * NOTE: Naive decimation without a low-pass filter aliases energy between
 * 8–24 kHz into the 0–8 kHz range. This is acceptable for wake word
 * detection (models are trained on imperfect audio). If this resampler is
 * reused for other purposes, consider adding a simple FIR low-pass first.
 */

const DECIMATION_FACTOR = 3;
const BYTES_PER_SAMPLE_STEREO = 4; // 2 bytes × 2 channels
const BYTES_PER_SAMPLE_MONO = 2;

/**
 * Downsample a 48 kHz, 16-bit, stereo PCM buffer to 16 kHz, 16-bit, mono.
 *
 * For each group of 3 stereo frames, we take the first frame and average
 * its left and right channels into a single mono sample.
 *
 * Input:  Int16LE interleaved stereo at 48 kHz
 * Output: Int16LE mono at 16 kHz
 */
export function downsample48kStereoTo16kMono(pcm: Buffer): Buffer {
  const totalFrames = Math.floor(pcm.length / BYTES_PER_SAMPLE_STEREO);
  const outFrames = Math.floor(totalFrames / DECIMATION_FACTOR);
  if (outFrames === 0) {
    return Buffer.alloc(0);
  }

  const out = Buffer.allocUnsafe(outFrames * BYTES_PER_SAMPLE_MONO);
  for (let i = 0; i < outFrames; i++) {
    const srcOffset = i * DECIMATION_FACTOR * BYTES_PER_SAMPLE_STEREO;
    const left = pcm.readInt16LE(srcOffset);
    const right = pcm.readInt16LE(srcOffset + 2);
    // Average L+R, clamped to Int16 range.
    const mono = (left + right) >> 1;
    out.writeInt16LE(mono, i * BYTES_PER_SAMPLE_MONO);
  }
  return out;
}
