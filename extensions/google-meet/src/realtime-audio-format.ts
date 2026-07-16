import {
  convertPcmToMulaw8k,
  mulawToPcm,
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  resamplePcm,
} from "openclaw/plugin-sdk/realtime-voice";
import type { GoogleMeetConfig } from "./config.js";

export function resolveGoogleMeetRealtimeAudioFormat(config: GoogleMeetConfig) {
  return config.chrome.audioFormat === "g711-ulaw-8khz"
    ? REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ
    : REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ;
}

export function convertGoogleMeetBridgeAudioForStt(
  audio: Buffer,
  config: GoogleMeetConfig,
): Buffer {
  if (config.chrome.audioFormat === "g711-ulaw-8khz") {
    return audio;
  }
  return convertPcmToMulaw8k(audio, 24_000);
}

export function convertGoogleMeetTtsAudioForBridge(
  audio: Buffer,
  sampleRate: number,
  config: GoogleMeetConfig,
  outputFormat?: string,
): Buffer {
  const sourceFormat = sourceTelephonyTtsFormat(outputFormat);
  if (
    config.chrome.audioFormat === "g711-ulaw-8khz" &&
    sourceFormat === "mulaw" &&
    sampleRate === 8_000
  ) {
    return audio;
  }
  const pcm = decodeGoogleMeetTelephonyTtsAudio(audio, sourceFormat);
  return config.chrome.audioFormat === "g711-ulaw-8khz"
    ? convertPcmToMulaw8k(pcm, sampleRate)
    : resamplePcm(pcm, sampleRate, 24_000);
}

type GoogleMeetTelephonyTtsFormat = "pcm" | "mulaw" | "alaw";

function sourceTelephonyTtsFormat(outputFormat: string | undefined): GoogleMeetTelephonyTtsFormat {
  const normalized = outputFormat?.trim().toLowerCase().replaceAll("_", "-") ?? "";
  if (
    !normalized ||
    normalized === "pcm" ||
    normalized.startsWith("pcm-") ||
    normalized.includes("pcm16") ||
    normalized.includes("16bit-mono-pcm")
  ) {
    return "pcm";
  }
  if (
    normalized === "mulaw" ||
    normalized === "ulaw" ||
    normalized.includes("mu-law") ||
    normalized.includes("mulaw") ||
    normalized.includes("ulaw")
  ) {
    return "mulaw";
  }
  if (normalized === "alaw" || normalized.includes("a-law") || normalized.includes("alaw")) {
    return "alaw";
  }
  throw new Error(`Unsupported telephony TTS output format for Google Meet: ${outputFormat}`);
}

function decodeGoogleMeetTelephonyTtsAudio(
  audio: Buffer,
  sourceFormat: GoogleMeetTelephonyTtsFormat,
): Buffer {
  switch (sourceFormat) {
    case "pcm":
      return audio;
    case "mulaw":
      return mulawToPcm(audio);
    case "alaw":
      return alawToPcm(audio);
  }
  return unsupportedGoogleMeetTelephonyTtsFormat(sourceFormat);
}

function unsupportedGoogleMeetTelephonyTtsFormat(_format: never): never {
  throw new Error("Unsupported telephony TTS output format for Google Meet");
}

function alawToPcm(alaw: Buffer): Buffer {
  const pcm = Buffer.alloc(alaw.length * 2);
  for (let index = 0; index < alaw.length; index += 1) {
    pcm.writeInt16LE(alawByteToLinear(alaw[index] ?? 0), index * 2);
  }
  return pcm;
}

function alawByteToLinear(value: number): number {
  const aLaw = value ^ 0x55;
  const sign = aLaw & 0x80;
  const exponent = (aLaw & 0x70) >> 4;
  const mantissa = aLaw & 0x0f;
  const sample = exponent === 0 ? (mantissa << 4) + 8 : ((mantissa << 4) + 0x108) << (exponent - 1);
  return sign ? sample : -sample;
}
