import fs from "node:fs/promises";
import { createRequire } from "node:module";
import type { Readable } from "node:stream";
import { resamplePcm } from "openclaw/plugin-sdk/realtime-voice";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { tempWorkspace, resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";

const require = createRequire(import.meta.url);

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BIT_DEPTH = 16;

type OpusDecoder = {
  decode: (buffer: Buffer) => Buffer | Promise<Buffer>;
  free?: () => Promise<void> | void;
};

type OpusDecoderFactory = {
  load: () => OpusDecoder | Promise<OpusDecoder>;
  name: string;
};

type OpusDecoderPreference = "native" | "opusscript" | "wasm";

let warnedOpusMissing = false;
let cachedOpusDecoderFactory: OpusDecoderFactory | null | "unresolved" = "unresolved";

function buildWavBuffer(pcm: Buffer): Buffer {
  const blockAlign = (CHANNELS * BIT_DEPTH) / 8;
  const byteRate = SAMPLE_RATE * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
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
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function resolveOpusDecoderFactories(): OpusDecoderFactory[] {
  const wasmFactory: OpusDecoderFactory = {
    name: "opus-decoder",
    load: async () => {
      const { OpusDecoder } = require("opus-decoder") as {
        OpusDecoder: new (options: {
          channels: number;
          forceStereo: boolean;
          sampleRate: number;
        }) => {
          decodeFrame: (buffer: Buffer) => {
            channelData: readonly Float32Array[];
            errors?: readonly { message?: string }[];
            samplesDecoded: number;
          };
          free: () => Promise<void> | void;
          ready: Promise<void>;
        };
      };
      const decoder = new OpusDecoder({
        channels: CHANNELS,
        forceStereo: true,
        sampleRate: SAMPLE_RATE,
      });
      await decoder.ready;
      return {
        decode: (buffer) => {
          const decoded = decoder.decodeFrame(buffer);
          if (decoded.errors?.length) {
            throw new Error(
              decoded.errors.map((error) => error.message ?? "opus decode failed").join("; "),
            );
          }
          return convertFloat32StereoToPcm(decoded.channelData, decoded.samplesDecoded);
        },
        free: () => decoder.free(),
      };
    },
  };
  const nativeFactory: OpusDecoderFactory = {
    name: "@discordjs/opus",
    load: () => {
      const DiscordOpus = require("@discordjs/opus") as {
        OpusEncoder: new (
          sampleRate: number,
          channels: number,
        ) => {
          decode: (buffer: Buffer) => Buffer;
        };
      };
      return new DiscordOpus.OpusEncoder(SAMPLE_RATE, CHANNELS);
    },
  };
  const opusscriptFactory: OpusDecoderFactory = {
    name: "opusscript",
    load: () => {
      const OpusScript = require("opusscript") as {
        new (sampleRate: number, channels: number, application: number): OpusDecoder;
        Application: { AUDIO: number };
      };
      return new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
    },
  };
  const preference = resolveOpusDecoderPreference();
  if (preference === "native") {
    return [nativeFactory];
  }
  if (preference === "opusscript") {
    return [opusscriptFactory];
  }
  return [wasmFactory, nativeFactory];
}

export function resolveOpusDecoderPreference(
  value = process.env.OPENCLAW_DISCORD_OPUS_DECODER,
): OpusDecoderPreference {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "native" || normalized === "@discordjs/opus") {
    return "native";
  }
  if (normalized === "opusscript") {
    return "opusscript";
  }
  return "wasm";
}

async function createOpusDecoder(params: {
  onWarn: (message: string) => void;
}): Promise<{ decoder: OpusDecoder; name: string } | null> {
  if (cachedOpusDecoderFactory === null) {
    return null;
  }
  const factories =
    cachedOpusDecoderFactory === "unresolved"
      ? resolveOpusDecoderFactories()
      : [cachedOpusDecoderFactory];
  const failures: string[] = [];

  for (const factory of factories) {
    try {
      const decoder = await factory.load();
      cachedOpusDecoderFactory = factory;
      return { decoder, name: factory.name };
    } catch (err) {
      failures.push(`${factory.name}: ${formatErrorMessage(err)}`);
    }
  }

  cachedOpusDecoderFactory = null;
  if (!warnedOpusMissing) {
    warnedOpusMissing = true;
    params.onWarn(
      `discord voice: no usable opus decoder available (${failures.join("; ")}); cannot decode voice audio`,
    );
  }
  return null;
}

function convertFloat32StereoToPcm(
  channels: readonly Float32Array[],
  samplesDecoded: number,
): Buffer {
  const left = channels[0];
  if (!left || samplesDecoded <= 0) {
    return Buffer.alloc(0);
  }
  const right = channels[1] ?? left;
  const pcm = Buffer.alloc(samplesDecoded * CHANNELS * 2);
  for (let index = 0; index < samplesDecoded; index += 1) {
    const frameOffset = index * CHANNELS * 2;
    pcm.writeInt16LE(floatToInt16(left[index] ?? 0), frameOffset);
    pcm.writeInt16LE(floatToInt16(right[index] ?? left[index] ?? 0), frameOffset + 2);
  }
  return pcm;
}

function floatToInt16(value: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(value * 32767)));
}

export async function decodeOpusStream(
  stream: Readable,
  params: {
    onError?: (err: unknown) => void;
    onVerbose: (message: string) => void;
    onWarn: (message: string) => void;
  },
): Promise<Buffer> {
  const selected = await createOpusDecoder({ onWarn: params.onWarn });
  if (!selected) {
    return Buffer.alloc(0);
  }
  params.onVerbose(`opus decoder: ${selected.name}`);
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of stream) {
      if (!chunk || !(chunk instanceof Buffer) || chunk.length === 0) {
        continue;
      }
      const decoded = await selected.decoder.decode(chunk);
      if (decoded && decoded.length > 0) {
        chunks.push(Buffer.from(decoded));
      }
    }
  } catch (err) {
    params.onError?.(err);
    if (shouldLogVerbose()) {
      logVerbose(`discord voice: opus decode failed: ${formatErrorMessage(err)}`);
    }
  } finally {
    await selected.decoder.free?.();
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
}

export async function decodeOpusStreamChunks(
  stream: Readable,
  params: {
    onChunk: (pcm48kStereo: Buffer) => void;
    onError?: (err: unknown) => void;
    onVerbose: (message: string) => void;
    onWarn: (message: string) => void;
  },
): Promise<void> {
  const selected = await createOpusDecoder({ onWarn: params.onWarn });
  if (!selected) {
    return;
  }
  params.onVerbose(`opus decoder: ${selected.name}`);
  try {
    for await (const chunk of stream) {
      if (!chunk || !(chunk instanceof Buffer) || chunk.length === 0) {
        continue;
      }
      const decoded = await selected.decoder.decode(chunk);
      if (decoded && decoded.length > 0) {
        params.onChunk(Buffer.from(decoded));
      }
    }
  } catch (err) {
    params.onError?.(err);
    if (shouldLogVerbose()) {
      logVerbose(`discord voice: opus decode failed: ${formatErrorMessage(err)}`);
    }
  } finally {
    await selected.decoder.free?.();
  }
}

export function convertDiscordPcm48kStereoToRealtimePcm24kMono(pcm: Buffer): Buffer {
  const frameCount = Math.floor(pcm.length / 4);
  if (frameCount === 0) {
    return Buffer.alloc(0);
  }
  const mono48k = Buffer.alloc(frameCount * 2);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const offset = frame * 4;
    const left = pcm.readInt16LE(offset);
    const right = pcm.readInt16LE(offset + 2);
    mono48k.writeInt16LE(Math.round((left + right) / 2), frame * 2);
  }
  return resamplePcm(mono48k, SAMPLE_RATE, 24_000);
}

export function convertRealtimePcm24kMonoToDiscordPcm48kStereo(pcm: Buffer): Buffer {
  const mono48k = resamplePcm(pcm, 24_000, SAMPLE_RATE);
  const sampleCount = Math.floor(mono48k.length / 2);
  if (sampleCount === 0) {
    return Buffer.alloc(0);
  }
  const stereo = Buffer.alloc(sampleCount * 4);
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const sample = mono48k.readInt16LE(sampleIndex * 2);
    const offset = sampleIndex * 4;
    stereo.writeInt16LE(sample, offset);
    stereo.writeInt16LE(sample, offset + 2);
  }
  return stereo;
}

function estimateDurationSeconds(pcm: Buffer): number {
  const bytesPerSample = (BIT_DEPTH / 8) * CHANNELS;
  if (bytesPerSample <= 0) {
    return 0;
  }
  return pcm.length / (bytesPerSample * SAMPLE_RATE);
}

export async function writeVoiceWavFile(
  pcm: Buffer,
): Promise<{ path: string; durationSeconds: number }> {
  const workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "discord-voice-",
  });
  const wav = buildWavBuffer(pcm);
  const filePath = await workspace.write("segment.wav", wav);
  scheduleTempCleanup(workspace.dir);
  return { path: filePath, durationSeconds: estimateDurationSeconds(pcm) };
}

function scheduleTempCleanup(tempDir: string, delayMs: number = 30 * 60 * 1000): void {
  const timer = setTimeout(() => {
    fs.rm(tempDir, { recursive: true, force: true }).catch((err) => {
      if (shouldLogVerbose()) {
        logVerbose(`discord voice: temp cleanup failed for ${tempDir}: ${formatErrorMessage(err)}`);
      }
    });
  }, delayMs);
  timer.unref();
}
