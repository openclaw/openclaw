// Mattermost plugin module implements PCM capture and STT audio preparation.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolveFfmpegBin } from "openclaw/plugin-sdk/media-runtime";

const AUDIO_SAMPLE_RATE = 48_000;
const AUDIO_CHANNELS = 2;
const FFMPEG_ERROR_BYTES = 8_192;

type VoiceCapture = {
  clearInactivePreRoll: () => void;
  push: (frame: Int16Array) => void;
  start: () => boolean;
  stop: () => Int16Array;
};

function joinFrames(frames: readonly Int16Array[]): Int16Array {
  const length = frames.reduce((total, frame) => total + frame.length, 0);
  const joined = new Int16Array(length);
  let offset = 0;
  for (const frame of frames) {
    joined.set(frame, offset);
    offset += frame.length;
  }
  return joined;
}

export function createVoiceCapture(params: {
  maxSpeechSamples: number;
  preRollFrames: number;
}): VoiceCapture {
  const preRoll: Int16Array[] = [];
  let speech: Int16Array[] = [];
  let speechSamples = 0;
  let active = false;

  return {
    clearInactivePreRoll() {
      if (!active) {
        preRoll.length = 0;
      }
    },
    push(frame) {
      if (frame.length === 0) {
        return;
      }
      const copy = Int16Array.from(frame);
      if (active) {
        const remainingSamples = params.maxSpeechSamples - speechSamples;
        if (remainingSamples <= 0) {
          return;
        }
        const bounded = copy.length > remainingSamples ? copy.slice(0, remainingSamples) : copy;
        speech.push(bounded);
        speechSamples += bounded.length;
        return;
      }
      preRoll.push(copy);
      if (preRoll.length > params.preRollFrames) {
        preRoll.shift();
      }
    },
    start() {
      if (active) {
        return false;
      }
      active = true;
      speech = preRoll.splice(0);
      speechSamples = speech.reduce((total, frame) => total + frame.length, 0);
      while (speechSamples > params.maxSpeechSamples) {
        const removed = speech.shift();
        speechSamples -= removed?.length ?? 0;
      }
      return true;
    },
    stop() {
      if (!active) {
        return new Int16Array();
      }
      active = false;
      const audio = joinFrames(speech);
      speech = [];
      speechSamples = 0;
      return audio;
    },
  };
}

export function downsampleStereo48kToMono16k(stereo: Int16Array): Int16Array {
  const outputFrames = Math.floor(stereo.length / 6);
  const mono = new Int16Array(outputFrames);
  for (let outputIndex = 0; outputIndex < outputFrames; outputIndex += 1) {
    const inputOffset = outputIndex * 6;
    let sum = 0;
    for (let sampleIndex = 0; sampleIndex < 6; sampleIndex += 1) {
      sum += stereo[inputOffset + sampleIndex] ?? 0;
    }
    mono[outputIndex] = Math.round(sum / 6);
  }
  return mono;
}

export function buildMonoWav(pcm: Int16Array, sampleRate: number): Buffer {
  const dataBytes = pcm.length * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < pcm.length; index += 1) {
    wav.writeInt16LE(pcm[index] ?? 0, 44 + index * 2);
  }
  return wav;
}

export function decodePcmWavToStereo48k(wav: Buffer): Buffer | undefined {
  if (
    wav.length < 12 ||
    wav.toString("ascii", 0, 4) !== "RIFF" ||
    wav.toString("ascii", 8, 12) !== "WAVE"
  ) {
    return undefined;
  }

  let channels: number | undefined;
  let sampleRate: number | undefined;
  let bitsPerSample: number | undefined;
  let audioFormat: number | undefined;
  let dataStart: number | undefined;
  let dataBytes: number | undefined;
  for (let offset = 12; offset + 8 <= wav.length; ) {
    const chunkId = wav.toString("ascii", offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const availableBytes = Math.max(0, Math.min(chunkSize, wav.length - chunkStart));
    if (chunkId === "fmt " && availableBytes >= 16) {
      audioFormat = wav.readUInt16LE(chunkStart);
      channels = wav.readUInt16LE(chunkStart + 2);
      sampleRate = wav.readUInt32LE(chunkStart + 4);
      bitsPerSample = wav.readUInt16LE(chunkStart + 14);
    } else if (chunkId === "data") {
      dataStart = chunkStart;
      dataBytes = availableBytes;
    }
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (
    audioFormat !== 1 ||
    bitsPerSample !== 16 ||
    !channels ||
    !sampleRate ||
    dataStart === undefined ||
    dataBytes === undefined
  ) {
    return undefined;
  }
  const inputFrames = Math.floor(dataBytes / (channels * 2));
  if (inputFrames === 0) {
    return Buffer.alloc(0);
  }

  const outputFrames = Math.max(1, Math.round((inputFrames * 48_000) / sampleRate));
  const stereo = Buffer.alloc(outputFrames * 4);
  const readSample = (frame: number, channel: number) =>
    wav.readInt16LE(dataStart + (frame * channels + Math.min(channel, channels - 1)) * 2);
  for (let outputFrame = 0; outputFrame < outputFrames; outputFrame += 1) {
    const sourcePosition = (outputFrame * sampleRate) / 48_000;
    const firstFrame = Math.min(Math.floor(sourcePosition), inputFrames - 1);
    const secondFrame = Math.min(firstFrame + 1, inputFrames - 1);
    const fraction = sourcePosition - firstFrame;
    for (let channel = 0; channel < 2; channel += 1) {
      const first = readSample(firstFrame, channel);
      const second = readSample(secondFrame, channel);
      stereo.writeInt16LE(
        Math.round(first + (second - first) * fraction),
        outputFrame * 4 + channel * 2,
      );
    }
  }
  return stereo;
}

export async function decodeAudioFileToStereo48k(filePath: string): Promise<Buffer> {
  const wav = decodePcmWavToStereo48k(await readFile(filePath));
  if (wav) {
    return wav;
  }
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      resolveFfmpegBin(),
      [
        "-i",
        filePath,
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
        String(AUDIO_SAMPLE_RATE),
        "-ac",
        String(AUDIO_CHANNELS),
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(0, FFMPEG_ERROR_BYTES);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
        return;
      }
      const status = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
      reject(new Error(`ffmpeg exited with ${status}${detail}`));
    });
  });
}
