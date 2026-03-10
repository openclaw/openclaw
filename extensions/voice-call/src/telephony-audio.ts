const TELEPHONY_SAMPLE_RATE = 8000;

function clamp16(value: number): number {
  return Math.max(-32768, Math.min(32767, value));
}

/**
 * Resample 16-bit PCM (little-endian mono) to 8kHz using linear interpolation.
 */
export function resamplePcmTo8k(input: Buffer, inputSampleRate: number): Buffer {
  if (inputSampleRate === TELEPHONY_SAMPLE_RATE) {
    return input;
  }
  const inputSamples = Math.floor(input.length / 2);
  if (inputSamples === 0) {
    return Buffer.alloc(0);
  }

  const ratio = inputSampleRate / TELEPHONY_SAMPLE_RATE;
  const outputSamples = Math.floor(inputSamples / ratio);
  const output = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const srcPos = i * ratio;
    const srcIndex = Math.floor(srcPos);
    const frac = srcPos - srcIndex;

    const s0 = input.readInt16LE(srcIndex * 2);
    const s1Index = Math.min(srcIndex + 1, inputSamples - 1);
    const s1 = input.readInt16LE(s1Index * 2);

    const sample = Math.round(s0 + frac * (s1 - s0));
    output.writeInt16LE(clamp16(sample), i * 2);
  }

  return output;
}

/**
 * Convert 16-bit PCM to 8-bit mu-law (G.711).
 */
export function pcmToMulaw(pcm: Buffer): Buffer {
  const samples = Math.floor(pcm.length / 2);
  const mulaw = Buffer.alloc(samples);

  for (let i = 0; i < samples; i++) {
    const sample = pcm.readInt16LE(i * 2);
    mulaw[i] = linearToMulaw(sample);
  }

  return mulaw;
}

export function convertPcmToMulaw8k(pcm: Buffer, inputSampleRate: number): Buffer {
  const pcm8k = resamplePcmTo8k(pcm, inputSampleRate);
  return pcmToMulaw(pcm8k);
}

/**
 * Chunk audio buffer into 20ms frames for streaming (8kHz mono mu-law).
 */
export function chunkAudio(audio: Buffer, chunkSize = 160): Generator<Buffer, void, unknown> {
  return (function* () {
    for (let i = 0; i < audio.length; i += chunkSize) {
      yield audio.subarray(i, Math.min(i + chunkSize, audio.length));
    }
  })();
}

/**
 * State for incremental PCM-to-mulaw conversion across chunk boundaries.
 * Tracks a leftover byte when a 16-bit sample straddles two chunks.
 */
export type PcmToMulawStreamState = {
  leftover: Buffer | null;
  /** Fractional source position carried across chunks for resampling continuity */
  srcPosCarry: number;
  /** Number of input samples already consumed (for resampling continuity) */
  inputSamplesConsumed: number;
};

export function createPcmToMulawStreamState(): PcmToMulawStreamState {
  return { leftover: null, srcPosCarry: 0, inputSamplesConsumed: 0 };
}

/**
 * Convert an incremental PCM chunk to 8kHz mu-law, handling split 16-bit samples
 * across chunk boundaries via the state's leftover byte.
 */
export function convertPcmChunkToMulaw8k(
  chunk: Buffer,
  inputSampleRate: number,
  state: PcmToMulawStreamState,
): Buffer {
  let pcm: Buffer;
  if (state.leftover) {
    pcm = Buffer.concat([state.leftover, chunk]);
    state.leftover = null;
  } else {
    pcm = chunk;
  }

  // If odd number of bytes, stash the last byte for next chunk
  if (pcm.length % 2 !== 0) {
    state.leftover = Buffer.from([pcm[pcm.length - 1]]);
    pcm = pcm.subarray(0, pcm.length - 1);
  }

  if (pcm.length === 0) {
    return Buffer.alloc(0);
  }

  // No resampling needed — delegate directly
  if (inputSampleRate === TELEPHONY_SAMPLE_RATE) {
    return pcmToMulaw(pcm);
  }

  // Stateful resampling: continue interpolation from where previous chunk left off
  const inputSamples = Math.floor(pcm.length / 2);
  const ratio = inputSampleRate / TELEPHONY_SAMPLE_RATE;

  const outputSamples: number[] = [];
  let srcPos = state.srcPosCarry;
  let brokeForInterp = false;

  while (srcPos < inputSamples) {
    const srcIndex = Math.floor(srcPos);
    const frac = srcPos - srcIndex;

    // Defer to next chunk when interpolation needs a neighbor beyond this chunk,
    // preventing clamped s1 which causes overproduction and audio artifacts
    if (srcIndex + 1 >= inputSamples && frac > 1e-10) {
      const tailStart = srcIndex * 2;
      const tail = pcm.subarray(tailStart);
      state.leftover = state.leftover ? Buffer.concat([tail, state.leftover]) : Buffer.from(tail);
      state.srcPosCarry = frac;
      state.inputSamplesConsumed += srcIndex;
      brokeForInterp = true;
      break;
    }

    const s0 = pcm.readInt16LE(srcIndex * 2);
    const s1Index = Math.min(srcIndex + 1, inputSamples - 1);
    const s1 = pcm.readInt16LE(s1Index * 2);
    const sample = Math.round(s0 + frac * (s1 - s0));
    outputSamples.push(clamp16(sample));
    srcPos += ratio;
  }

  if (!brokeForInterp) {
    state.srcPosCarry = srcPos - inputSamples;
    state.inputSamplesConsumed += inputSamples;
  }

  if (outputSamples.length === 0) {
    return Buffer.alloc(0);
  }

  const resampled = Buffer.alloc(outputSamples.length * 2);
  for (let i = 0; i < outputSamples.length; i++) {
    resampled.writeInt16LE(outputSamples[i], i * 2);
  }

  return pcmToMulaw(resampled);
}

/**
 * Flush any remaining leftover byte from the stream state.
 * A single leftover byte cannot form a complete 16-bit sample, so it is discarded.
 * Returns an empty buffer (provided for API completeness).
 */
export function flushPcmToMulawStream(state: PcmToMulawStreamState): Buffer {
  state.leftover = null;
  return Buffer.alloc(0);
}

function linearToMulaw(sample: number): number {
  const BIAS = 132;
  const CLIP = 32635;

  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) {
    sample = -sample;
  }
  if (sample > CLIP) {
    sample = CLIP;
  }

  sample += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--) {
    expMask >>= 1;
  }

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}
