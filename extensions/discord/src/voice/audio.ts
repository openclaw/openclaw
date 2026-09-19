import { spawn } from "node:child_process";
import { Duplex, type Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import {
  Application,
  createDecoder as createLibopusDecoder,
  createEncoder as createLibopusEncoder,
  type OpusDecoderHandle as LibopusDecoder,
  type OpusEncoderHandle as LibopusEncoder,
} from "libopus-wasm";
import { resolveFfmpegBin } from "openclaw/plugin-sdk/media-runtime";
import { createStreamingPcmResampler } from "openclaw/plugin-sdk/realtime-voice";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { tempWorkspace, resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BIT_DEPTH = 16;
export const VOICE_WAV_HEADER_BYTES = 44;
const FFMPEG_ERROR_OUTPUT_BYTES = 8_192;
const DISCORD_OPUS_FRAME_SIZE = 960;
const DISCORD_OPUS_MAX_DECODE_FRAME_SIZE = (SAMPLE_RATE * 120) / 1_000;
const DISCORD_OPUS_ENCODE_BATCH_FRAMES = 8;
const DISCORD_OPUS_FRAME_BYTES = DISCORD_OPUS_FRAME_SIZE * CHANNELS * (BIT_DEPTH / 8);
const FFMPEG_PCM_ARGUMENTS = [
  "-analyzeduration",
  "0",
  "-loglevel",
  "error",
  "-vn",
  "-sn",
  "-dn",
  "-f",
  "s16le",
  "-ar",
  String(SAMPLE_RATE),
  "-ac",
  String(CHANNELS),
];

type OpusDecodeCallbacks = {
  onError?: (err: unknown) => void;
  onVerbose: (message: string) => void;
  onWarn: (message: string) => void;
};

type StreamCallback = (error?: Error | null) => void;

let warnedOpusMissing = false;

function buildWavBuffer(chunks: readonly Buffer[]): Buffer {
  const pcmBytes = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const blockAlign = (CHANNELS * BIT_DEPTH) / 8;
  const byteRate = SAMPLE_RATE * blockAlign;
  const wav = Buffer.allocUnsafe(VOICE_WAV_HEADER_BYTES + pcmBytes);
  const header = wav.subarray(0, VOICE_WAV_HEADER_BYTES);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmBytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BIT_DEPTH, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmBytes, 40);
  let offset = VOICE_WAV_HEADER_BYTES;
  for (const chunk of chunks) {
    offset += chunk.copy(wav, offset);
  }
  return wav;
}

export function createDiscordOpusEncodeStream(): DiscordOpusEncodeStream {
  return new DiscordOpusEncodeStream();
}

export function createDiscordOpusPlaybackStream(input: Readable | string): Readable {
  const inputSource = typeof input === "string" ? input : "pipe:0";
  const ffmpeg = spawn(resolveFfmpegBin(), ["-i", inputSource, ...FFMPEG_PCM_ARGUMENTS, "pipe:1"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const opusStream = createDiscordOpusEncodeStream();
  const stderr = Buffer.alloc(FFMPEG_ERROR_OUTPUT_BYTES);
  let stderrBytes = 0;
  let ffmpegClosed = false;
  const killFfmpeg = (signal: NodeJS.Signals = "SIGTERM") => {
    if (!ffmpegClosed && !ffmpeg.killed) {
      ffmpeg.kill(signal);
    }
  };

  ffmpeg.stderr.on("data", (chunk: Buffer) => {
    if (stderrBytes < FFMPEG_ERROR_OUTPUT_BYTES) {
      stderrBytes += chunk.copy(stderr, stderrBytes, 0, FFMPEG_ERROR_OUTPUT_BYTES - stderrBytes);
    }
  });

  ffmpeg.once("error", (err) => {
    opusStream.destroy(err);
  });
  ffmpeg.once("close", (code, signal) => {
    ffmpegClosed = true;
    if (code && code !== 0) {
      // A byte cap can end inside a code point; omit that partial suffix instead of emitting U+FFFD.
      const stderrText = new StringDecoder("utf8").write(stderr.subarray(0, stderrBytes)).trim();
      const suffix = stderrText ? `: ${stderrText}` : "";
      opusStream.destroy(new Error(`ffmpeg exited with code ${code}${suffix}`));
      return;
    }
    if (signal) {
      opusStream.destroy(new Error(`ffmpeg exited with signal ${signal}`));
    }
  });

  // Both readable child pipes need listeners; an unhandled stream error terminates Node.
  for (const readable of [ffmpeg.stdout, ffmpeg.stderr]) {
    readable.on("error", (err) => {
      // A broken output pipe cannot drain usefully; force termination so a
      // blocked ffmpeg process cannot outlive the failed playback stream.
      killFfmpeg("SIGKILL");
      opusStream.destroy(err);
    });
  }
  ffmpeg.stdin.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code !== "EPIPE") {
      opusStream.destroy(err);
    }
  });
  ffmpeg.stdout.pipe(opusStream);
  opusStream.once("close", () => {
    if (!opusStream.readableEnded) {
      killFfmpeg();
    }
  });
  if (typeof input !== "string") {
    input.on("error", (err) => {
      ffmpeg.stdin.destroy(err);
      opusStream.destroy(err);
    });
    input.pipe(ffmpeg.stdin);
  } else {
    ffmpeg.stdin.end();
  }
  return opusStream;
}

class DiscordOpusEncodeStream extends Duplex {
  #partialFrame = Buffer.alloc(DISCORD_OPUS_FRAME_BYTES);
  #partialBytes = 0;
  #pending: { chunk: Buffer; offset: number; done: StreamCallback } | undefined;
  #scheduled: NodeJS.Immediate | undefined;
  #readBlocked = false;
  #partialFlushRequested = false;
  #encoder!: LibopusEncoder;
  readonly #packetPcmBytes = new WeakMap<Buffer, number>();

  constructor() {
    super({ readableObjectMode: true });
  }

  override _construct(done: StreamCallback): void {
    // Node defers writes and destruction until construction settles, so a late
    // encoder is released by _destroy without processing cancelled playback.
    void createLibopusEncoder({
      application: Application.Audio,
      channels: CHANNELS,
      sampleRate: SAMPLE_RATE,
    }).then(
      (encoder) => {
        this.#encoder = encoder;
        done();
      },
      (err: unknown) => done(err instanceof Error ? err : new Error(formatErrorMessage(err))),
    );
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: StreamCallback): void {
    this.#pending = { chunk, offset: 0, done };
    this.#schedule();
  }

  override _read(): void {
    this.#readBlocked = false;
    this.#schedule();
  }

  #schedule(): void {
    if (this.destroyed || this.#scheduled || this.#readBlocked || !this.#pending) {
      return;
    }
    this.#scheduled = setImmediate(() => {
      this.#scheduled = undefined;
      this.#encodeBatch();
    });
  }

  #encodeBatch(): void {
    const pending = this.#pending;
    if (!pending || this.destroyed) {
      return;
    }
    try {
      for (let count = 0; count < DISCORD_OPUS_ENCODE_BATCH_FRAMES; count += 1) {
        const remainingBytes = pending.chunk.length - pending.offset;
        if (this.#partialBytes > 0 || remainingBytes < DISCORD_OPUS_FRAME_BYTES) {
          const copied = pending.chunk.copy(
            this.#partialFrame,
            this.#partialBytes,
            pending.offset,
            pending.offset + DISCORD_OPUS_FRAME_BYTES - this.#partialBytes,
          );
          pending.offset += copied;
          this.#partialBytes += copied;
          if (this.#partialBytes < DISCORD_OPUS_FRAME_BYTES) {
            // Own incomplete frames before releasing the caller's write buffer.
            this.#pending = undefined;
            pending.done();
            this.#flushRequestedPartialFrame();
            return;
          }
          this.#partialBytes = 0;
          this.#readBlocked = !this.#encodeFrame(this.#partialFrame);
        } else {
          const frame = pending.chunk.subarray(
            pending.offset,
            pending.offset + DISCORD_OPUS_FRAME_BYTES,
          );
          pending.offset += DISCORD_OPUS_FRAME_BYTES;
          this.#readBlocked = !this.#encodeFrame(frame);
        }
        if (this.destroyed || this.#readBlocked) {
          return;
        }
      }
      this.#schedule();
    } catch (err) {
      this.#pending = undefined;
      pending.done(err instanceof Error ? err : new Error(formatErrorMessage(err)));
    }
  }

  override _final(done: StreamCallback): void {
    try {
      this.flushPartialFrame();
      this.push(null);
      done();
    } catch (err) {
      done(err instanceof Error ? err : new Error(formatErrorMessage(err)));
    }
  }

  flushPartialFrameWhenReady(): void {
    this.#partialFlushRequested = true;
    if (this.#partialBytes > 0) {
      this.#flushRequestedPartialFrame();
    }
  }

  #flushRequestedPartialFrame(): void {
    if (!this.#partialFlushRequested || this.#pending || this.writableLength > 0) {
      return;
    }
    this.#partialFlushRequested = false;
    try {
      this.flushPartialFrame();
    } catch (error) {
      this.destroy(error instanceof Error ? error : new Error(formatErrorMessage(error)));
    }
  }

  flushPartialFrame(): boolean {
    // Never insert padding ahead of PCM that is still waiting to be encoded.
    if (this.destroyed || this.#pending || this.#partialBytes === 0) {
      return false;
    }
    const pcmBytes = this.#partialBytes;
    this.#partialFrame.fill(0, pcmBytes);
    this.#partialBytes = 0;
    this.#readBlocked = !this.#encodeFrame(this.#partialFrame, pcmBytes);
    return true;
  }

  takePcmBytes(packet: Buffer): number {
    const bytes = this.#packetPcmBytes.get(packet) ?? 0;
    this.#packetPcmBytes.delete(packet);
    return bytes;
  }

  override _destroy(err: Error | null, done: StreamCallback): void {
    this.#encoder?.free();
    clearImmediate(this.#scheduled);
    this.#scheduled = undefined;
    this.#partialFlushRequested = false;
    const pending = this.#pending;
    this.#pending = undefined;
    pending?.done(err ?? new Error("Discord Opus encoder was destroyed"));
    this.#partialBytes = 0;
    this.#partialFrame = Buffer.alloc(0);
    done(err);
  }

  #encodeFrame(frame: Buffer, pcmBytes = frame.length): boolean {
    const packet = Buffer.from(this.#encoder.encode(frame, { frameSize: DISCORD_OPUS_FRAME_SIZE }));
    this.#packetPcmBytes.set(packet, pcmBytes);
    return this.push(packet);
  }
}

function pcmInt16ToBuffer(pcm: Int16Array): Buffer {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

export async function decodeOpusStreamChunks(
  stream: Readable,
  params: OpusDecodeCallbacks & {
    onChunk: (pcm48kStereo: Buffer, packet: Buffer) => void | Promise<void>;
  },
): Promise<void> {
  try {
    for await (const { pcm, packet } of decodeOpusFrames(stream, params)) {
      await params.onChunk(pcm, packet);
    }
  } catch (err) {
    params.onError?.(err);
  }
}

async function* decodeOpusFrames(
  stream: Readable,
  params: OpusDecodeCallbacks,
): AsyncGenerator<{ pcm: Buffer; packet: Buffer }> {
  let decoder: LibopusDecoder;
  try {
    decoder = await createLibopusDecoder({ channels: CHANNELS, sampleRate: SAMPLE_RATE });
  } catch (err) {
    params.onError?.(err);
    if (!warnedOpusMissing) {
      warnedOpusMissing = true;
      params.onWarn(
        `discord voice: no usable opus decoder available (libopus-wasm: ${formatErrorMessage(err)}); cannot decode voice audio`,
      );
    }
    return;
  }
  params.onVerbose("opus decoder: libopus-wasm");
  try {
    for await (const chunk of stream) {
      if (!chunk || !(chunk instanceof Buffer) || chunk.length === 0) {
        continue;
      }
      const decoded = decoder.decode(chunk, { maxFrameSize: DISCORD_OPUS_MAX_DECODE_FRAME_SIZE });
      if (decoded.length > 0) {
        yield { pcm: pcmInt16ToBuffer(decoded), packet: chunk };
      }
    }
  } catch (err) {
    params.onError?.(err);
    if (shouldLogVerbose()) {
      logVerbose(`discord voice: opus decode failed: ${formatErrorMessage(err)}`);
    }
  } finally {
    decoder.free();
  }
}

export function createDiscordPcmToRealtimeConverter() {
  const resampler = createStreamingPcmResampler(SAMPLE_RATE, 24_000);
  let trailingFrame = Buffer.alloc(0);
  return {
    process(pcm: Buffer): Buffer {
      const input = trailingFrame.length > 0 ? Buffer.concat([trailingFrame, pcm]) : pcm;
      const completeBytes = input.length - (input.length % 4);
      trailingFrame = Buffer.from(input.subarray(completeBytes));
      const mono = Buffer.alloc(completeBytes / 2);
      for (let offset = 0; offset < completeBytes; offset += 4) {
        mono.writeInt16LE(
          Math.round((input.readInt16LE(offset) + input.readInt16LE(offset + 2)) / 2),
          offset / 2,
        );
      }
      return resampler.process(mono);
    },
    flush(): Buffer {
      trailingFrame = Buffer.alloc(0);
      return resampler.flush();
    },
  };
}

function duplicateMonoChannels(mono: Buffer): Buffer {
  const stereo = Buffer.alloc(mono.length * 2);
  for (let offset = 0; offset < mono.length; offset += 2) {
    const sample = mono.readInt16LE(offset);
    stereo.writeInt16LE(sample, offset * 2);
    stereo.writeInt16LE(sample, offset * 2 + 2);
  }
  return stereo;
}

export function createRealtimePcmToDiscordConverter() {
  let resampler = createStreamingPcmResampler(24_000, SAMPLE_RATE);
  let history = Buffer.alloc(0);
  let trailingByte = Buffer.alloc(0);
  let replayBytes = 0;
  let flushed = false;
  const takeOutput = (pcm: Buffer): Buffer => {
    const skippedBytes = Math.min(replayBytes, pcm.length);
    replayBytes -= skippedBytes;
    return duplicateMonoChannels(pcm.subarray(skippedBytes));
  };
  return {
    process(pcm: Buffer): Buffer {
      const input = trailingByte.length > 0 ? Buffer.concat([trailingByte, pcm]) : pcm;
      const completeBytes = input.length - (input.length % 2);
      const completePcm = input.subarray(0, completeBytes);
      trailingByte = Buffer.from(input.subarray(completeBytes));
      // The fixed 2x conversion needs 15 preceding samples; keep 32 for replay.
      history = Buffer.concat([history, completePcm.subarray(-64)]).subarray(-64);
      return takeOutput(resampler.process(completePcm));
    },
    drain(): Buffer {
      if (flushed) {
        return Buffer.alloc(0);
      }
      // Only a real playback gap permits right-edge approximation. Re-seeding
      // retains the filter history without exposing a transport policy in the SDK.
      const output = takeOutput(resampler.flush());
      resampler = createStreamingPcmResampler(24_000, SAMPLE_RATE);
      replayBytes = history.length * 2 - resampler.process(history).length;
      return output;
    },
    flush(): Buffer {
      flushed = true;
      trailingByte = Buffer.alloc(0);
      history = Buffer.alloc(0);
      return takeOutput(resampler.flush());
    },
  };
}

export async function writeVoiceWavFile(
  chunks: readonly Buffer[],
): Promise<{ path: string; durationSeconds: number; cleanup: () => Promise<void> }> {
  // Snapshot borrowed PCM before workspace creation can suspend the receive owner.
  const wav = buildWavBuffer(chunks);
  const workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "discord-voice-",
  });
  try {
    const filePath = await workspace.write("segment.wav", wav);
    return {
      path: filePath,
      durationSeconds:
        (wav.length - VOICE_WAV_HEADER_BYTES) / ((BIT_DEPTH / 8) * CHANNELS * SAMPLE_RATE),
      cleanup: () => workspace[Symbol.asyncDispose](),
    };
  } catch (error) {
    await workspace.cleanup();
    throw error;
  }
}
