import type { VoiceCallConfig } from "../../config.js";
import { alawToLinear, linearToAlaw, mulawToLinear } from "../../audio/g711.js";

export function g711ToPcm16Buffer(
  payload: Buffer,
  codec: NonNullable<VoiceCallConfig["asteriskAri"]>["codec"],
): Buffer {
  const pcm = Buffer.allocUnsafe(payload.length * 2);
  if (codec === "alaw") {
    for (let i = 0; i < payload.length; i++) {
      pcm.writeInt16LE(alawToLinear(payload[i] ?? 0), i * 2);
    }
    return pcm;
  }
  for (let i = 0; i < payload.length; i++) {
    pcm.writeInt16LE(mulawToLinear(payload[i] ?? 0), i * 2);
  }
  return pcm;
}

export function mulawToAlawBuffer(mulaw: Buffer): Buffer {
  const out = Buffer.allocUnsafe(mulaw.length);
  for (let i = 0; i < mulaw.length; i++) {
    out[i] = linearToAlaw(mulawToLinear(mulaw[i] ?? 0));
  }
  return out;
}

export function computeRms(pcm: Buffer): number {
  if (pcm.length < 2) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 2) {
    const sample = pcm.readInt16LE(i);
    sum += sample * sample;
  }
  const count = pcm.length / 2;
  return Math.sqrt(sum / Math.max(1, count));
}

export function pcmDurationMsFromBytes(bytes: number): number {
  return Math.round((bytes / 2 / 8000) * 1000);
}

export function buildWavFromPcm(pcm: Buffer, sampleRate = 8000): Buffer {
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, 4, "ascii");
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8, 4, "ascii");
  header.write("fmt ", 12, 4, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, 4, "ascii");
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}
