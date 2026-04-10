import {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
  type LanguageCode,
} from "@aws-sdk/client-transcribe-streaming";
import { runFfmpeg } from "openclaw/plugin-sdk/media-runtime";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAwsClient } from "../shared/client-cache.js";

export type TranscribeParams = {
  buffer: Buffer;
  mime?: string;
  language?: string;
  region: string;
  timeoutMs: number;
};

function getTranscribeClient(region: string): TranscribeStreamingClient {
  return getAwsClient(`transcribe:${region}`, () => new TranscribeStreamingClient({ region }));
}

/** Supported Transcribe Streaming encodings. */
type TranscribeEncoding = "pcm" | "ogg-opus" | "flac";

/** MIME types that Transcribe Streaming accepts natively. */
const NATIVE_MIME_MAP: Record<string, TranscribeEncoding> = {
  "audio/ogg": "ogg-opus",
  "audio/opus": "ogg-opus",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/wav": "pcm",
  "audio/x-wav": "pcm",
  "audio/l16": "pcm",
  "audio/pcm": "pcm",
};

function resolveNativeEncoding(mime?: string): TranscribeEncoding | null {
  if (!mime) { return null; }
  const base = mime.split(";")[0].trim().toLowerCase();
  return NATIVE_MIME_MAP[base] ?? null;
}

/**
 * Convert unsupported audio formats (MP3, M4A, AAC, WebM, etc.) to PCM
 * via ffmpeg for Transcribe Streaming compatibility.
 * Returns { buffer, encoding, sampleRate } for the converted audio.
 */
async function convertToPcm(inputBuffer: Buffer, mime?: string): Promise<Buffer> {
  const tmpDir = os.tmpdir();
  const id = `transcribe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ext = mime?.includes("mp3") || mime?.includes("mpeg") ? ".mp3"
    : mime?.includes("m4a") || mime?.includes("mp4") ? ".m4a"
    : mime?.includes("webm") ? ".webm"
    : mime?.includes("aac") ? ".aac"
    : ".bin";
  const inputPath = path.join(tmpDir, `${id}${ext}`);
  const outputPath = path.join(tmpDir, `${id}.pcm`);

  try {
    await fs.writeFile(inputPath, inputBuffer);
    await runFfmpeg([
      "-i", inputPath,
      "-f", "s16le",        // signed 16-bit little-endian PCM
      "-ar", "16000",       // 16kHz sample rate
      "-ac", "1",           // mono
      "-y", outputPath,
    ]);
    return await fs.readFile(outputPath);
  } finally {
    await fs.unlink(inputPath).catch(() => {});
    await fs.unlink(outputPath).catch(() => {});
  }
}

/**
 * Resolve audio buffer and encoding for Transcribe Streaming.
 * Converts unsupported formats to PCM via ffmpeg.
 */
async function resolveAudioInput(buffer: Buffer, mime?: string): Promise<{
  audioBuffer: Buffer;
  encoding: TranscribeEncoding;
  sampleRate: number;
}> {
  const nativeEncoding = resolveNativeEncoding(mime);

  if (nativeEncoding) {
    if (nativeEncoding === "pcm") {
      // WAV/PCM files may have any sample rate — normalize to 16kHz via ffmpeg
      // rather than guessing. This avoids mismatched MediaSampleRateHertz errors.
      const pcmBuffer = await convertToPcm(buffer, mime);
      return { audioBuffer: pcmBuffer, encoding: "pcm", sampleRate: 16000 };
    }
    // OGG-Opus is always 48kHz, FLAC we pass through and let Transcribe detect
    const sampleRate = nativeEncoding === "ogg-opus" ? 48000 : 16000;
    return { audioBuffer: buffer, encoding: nativeEncoding, sampleRate };
  }

  // Unsupported format (MP3, M4A, AAC, WebM, etc.) — convert to PCM
  const pcmBuffer = await convertToPcm(buffer, mime);
  return { audioBuffer: pcmBuffer, encoding: "pcm", sampleRate: 16000 };
}

/**
 * Transcribe audio using Amazon Transcribe Streaming.
 * Automatically converts unsupported formats (MP3, M4A, WebM) to PCM via ffmpeg.
 */
export async function transcribeAudio(params: TranscribeParams): Promise<string> {
  const { buffer, mime, language, region, timeoutMs } = params;
  const client = getTranscribeClient(region);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const { audioBuffer, encoding, sampleRate } = await resolveAudioInput(buffer, mime);

    // Stream audio buffer in chunks
    async function* audioStream() {
      const chunkSize = 4096;
      for (let i = 0; i < audioBuffer.length; i += chunkSize) {
        yield { AudioEvent: { AudioChunk: audioBuffer.subarray(i, i + chunkSize) } };
      }
    }

    const command = new StartStreamTranscriptionCommand({
      LanguageCode: (language ?? "en-US") as LanguageCode,
      MediaEncoding: encoding,
      MediaSampleRateHertz: sampleRate,
      AudioStream: audioStream(),
    });

    const response = await client.send(command, { abortSignal: controller.signal });

    const transcripts: string[] = [];
    if (response.TranscriptResultStream) {
      for await (const event of response.TranscriptResultStream) {
        if (event.TranscriptEvent?.Transcript?.Results) {
          for (const result of event.TranscriptEvent.Transcript.Results) {
            if (!result.IsPartial && result.Alternatives?.[0]?.Transcript) {
              transcripts.push(result.Alternatives[0].Transcript);
            }
          }
        }
      }
    }

    const text = transcripts.join(" ").trim();
    if (!text) {
      throw new Error("Amazon Transcribe returned empty transcript");
    }

    return text;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : "UnknownError";
    throw new Error(
      `Amazon Transcribe failed (region=${region}, language=${language ?? "en-US"}): [${name}] ${message}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}
