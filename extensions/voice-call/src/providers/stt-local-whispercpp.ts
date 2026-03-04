/**
 * Local Whisper.cpp STT Provider
 *
 * Minimal, dependency-light STT implementation intended for Twilio Media Streams:
 * - Accepts mu-law 8kHz audio frames from Twilio
 * - Performs lightweight energy-based VAD to segment utterances
 * - Runs whisper.cpp CLI on finalized segments to get text
 *
 * This is designed to replace OpenAI Realtime STT when you can't/won't use an API key.
 */

import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { RealtimeSTTSession } from "./stt-openai-realtime.js";

export type LocalWhisperCppConfig = {
  /** Path to whisper.cpp CLI binary (e.g. whisper-cli or main). */
  binPath: string;
  /** Path to ggml model file (e.g. ggml-small.bin). */
  modelPath: string;
  /** Language code (e.g. zh, en). */
  language?: string;
  /** Threads for whisper.cpp (best-effort; not all CLIs support this). */
  threads?: number;
  /** Max buffered utterance length (ms) to avoid runaway memory on bad VAD. */
  maxUtteranceMs?: number;
  /** Extra CLI args appended after standard args. */
  extraArgs?: string[];
  /** VAD threshold from 0..1 (mapped internally to a sensible amplitude threshold). */
  vadThreshold?: number;
  /** Silence duration in ms to finalize an utterance. */
  silenceDurationMs?: number;
};

export class LocalWhisperCppSTTProvider {
  readonly name = "local-whispercpp";

  constructor(private readonly cfg: LocalWhisperCppConfig) {
    if (!cfg.binPath) {
      throw new Error("Local whisper.cpp binPath required");
    }
    if (!cfg.modelPath) {
      throw new Error("Local whisper.cpp modelPath required");
    }
  }

  createSession(): RealtimeSTTSession {
    return new LocalWhisperCppSTTSession(this.cfg);
  }
}

class LocalWhisperCppSTTSession implements RealtimeSTTSession {
  private connected = false;
  private closed = false;

  private onTranscriptCallback: ((t: string) => void) | null = null;
  private onPartialCallback: ((t: string) => void) | null = null;
  private onSpeechStartCallback: (() => void) | null = null;

  private inSpeech = false;
  private silenceMs = 0;
  private utteranceMs = 0;
  private pcm16kChunks: Buffer[] = [];

  private transcriptQueue: string[] = [];
  private transcriptWaiters: Array<(t: string) => void> = [];

  private transcribeInFlight: Promise<void> | null = null;

  constructor(private readonly cfg: LocalWhisperCppConfig) {}

  async connect(): Promise<void> {
    // Best-effort: validate binary/model paths early.
    await access(this.cfg.binPath);
    await access(this.cfg.modelPath);
    this.connected = true;
  }

  isConnected(): boolean {
    return this.connected;
  }

  onPartial(callback: (partial: string) => void): void {
    this.onPartialCallback = callback;
  }

  onTranscript(callback: (transcript: string) => void): void {
    this.onTranscriptCallback = callback;
  }

  onSpeechStart(callback: () => void): void {
    this.onSpeechStartCallback = callback;
  }

  sendAudio(muLaw8k: Buffer): void {
    if (this.closed) {
      return;
    }

    // If a transcription is running, we still accept audio but cap memory.
    // This keeps the session responsive under heavy load.

    const pcm8k = mulawToPcm16le(muLaw8k);

    // Map the config's 0..1 knob into a practical amplitude threshold for G.711 audio.
    // Speech energy here is typically in the ~0.01-0.08 range.
    const vadKnob = clamp01(this.cfg.vadThreshold ?? 0.5);
    const ampThreshold = 0.005 + vadKnob * 0.06;

    const amp = meanAbsPcm16le(pcm8k);

    const frameMs = (muLaw8k.length / 8000) * 1000;

    if (amp >= ampThreshold) {
      if (!this.inSpeech) {
        this.inSpeech = true;
        this.silenceMs = 0;
        this.utteranceMs = 0;
        this.pcm16kChunks = [];
        this.onSpeechStartCallback?.();
      }
      this.silenceMs = 0;

      // Upsample 8k -> 16k for Whisper input (simple x2 duplication).
      const pcm16k = upsamplePcm16le_8k_to_16k(pcm8k);
      this.pcm16kChunks.push(pcm16k);
      this.utteranceMs += frameMs;
    } else if (this.inSpeech) {
      // Keep trailing silence so the last word isn't clipped.
      const pcm16k = upsamplePcm16le_8k_to_16k(pcm8k);
      this.pcm16kChunks.push(pcm16k);

      this.silenceMs += frameMs;
      this.utteranceMs += frameMs;

      const silenceDurationMs = this.cfg.silenceDurationMs ?? 800;
      const maxUtteranceMs = this.cfg.maxUtteranceMs ?? 20_000;

      if (this.utteranceMs >= maxUtteranceMs || this.silenceMs >= silenceDurationMs) {
        const utterance = Buffer.concat(this.pcm16kChunks);
        this.inSpeech = false;
        this.silenceMs = 0;
        this.utteranceMs = 0;
        this.pcm16kChunks = [];

        // Fire and forget; callback delivery happens async.
        this.transcribeInFlight = this.transcribe(utterance).catch((err) => {
          console.warn("[LocalWhisperSTT] transcription failed:", err);
        });
      }
    }

    // No true partials in this MVP.
    void this.onPartialCallback;
  }

  async waitForTranscript(timeoutMs = 30000): Promise<string> {
    if (this.transcriptQueue.length > 0) {
      return this.transcriptQueue.shift()!;
    }

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove the waiter if it still exists.
        const idx = this.transcriptWaiters.indexOf(resolve);
        if (idx >= 0) {
          this.transcriptWaiters.splice(idx, 1);
        }
        reject(new Error("Transcript timeout"));
      }, timeoutMs);

      const wrappedResolve = (t: string) => {
        clearTimeout(timer);
        resolve(t);
      };

      this.transcriptWaiters.push(wrappedResolve);
    });
  }

  close(): void {
    this.closed = true;
    this.connected = false;

    // Best-effort: finalize pending utterance.
    if (this.inSpeech && this.pcm16kChunks.length > 0) {
      const utterance = Buffer.concat(this.pcm16kChunks);
      this.inSpeech = false;
      this.pcm16kChunks = [];
      void this.transcribe(utterance).catch(() => {
        // Ignore on close.
      });
    }
  }

  private async transcribe(pcm16kMono16le: Buffer): Promise<void> {
    if (this.closed) {
      return;
    }

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-voicecall-whisper-"));
    const wavPath = path.join(tmpDir, "utterance.wav");

    try {
      const wav = makeWavPcm16le({ pcm: pcm16kMono16le, sampleRate: 16000, channels: 1 });
      await writeFile(wavPath, wav);

      const transcript = await runWhisperCpp({
        binPath: this.cfg.binPath,
        modelPath: this.cfg.modelPath,
        language: this.cfg.language ?? "zh",
        threads: this.cfg.threads,
        wavPath,
        extraArgs: this.cfg.extraArgs,
      });

      const cleaned = transcript.trim();
      if (!cleaned) {
        return;
      }

      this.onTranscriptCallback?.(cleaned);

      if (this.transcriptWaiters.length > 0) {
        const waiter = this.transcriptWaiters.shift()!;
        waiter(cleaned);
      } else {
        this.transcriptQueue.push(cleaned);
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }
}

async function runWhisperCpp(params: {
  binPath: string;
  modelPath: string;
  language: string;
  threads?: number;
  wavPath: string;
  extraArgs?: string[];
}): Promise<string> {
  const args: string[] = [];

  // whisper.cpp CLI variants commonly support: -m <model> -f <file> -l <lang>
  args.push("-m", params.modelPath);
  args.push("-f", params.wavPath);
  args.push("-l", params.language);

  if (typeof params.threads === "number") {
    // Some builds use -t for threads.
    args.push("-t", String(params.threads));
  }

  if (params.extraArgs?.length) {
    args.push(...params.extraArgs);
  }

  return new Promise<string>((resolve, reject) => {
    const child = spawn(params.binPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, WHISPER_PRINT_PROGRESS: "0" },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (d) => {
      stdout += d;
    });

    child.stderr.on("data", (d) => {
      stderr += d;
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`whisper.cpp exited ${code}: ${stderr.trim() || "no stderr"}`));
        return;
      }

      // Heuristic parsing: remove timestamp prefixes and known noise.
      const lines = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .filter((l) => !l.startsWith("whisper_"))
        .filter((l) => !l.startsWith("["));

      // If the CLI prints timestamped lines like: [00:00.000 --> 00:02.000] text
      const cleaned = lines
        .map((l) => l.replace(/^\[[^\]]+\]\s*/, ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      resolve(cleaned);
    });
  });
}

function clamp01(v: number): number {
  if (Number.isNaN(v)) {
    return 0;
  }
  return Math.max(0, Math.min(1, v));
}

function meanAbsPcm16le(pcm: Buffer): number {
  // Returns mean absolute amplitude in 0..1.
  let sum = 0;
  const samples = pcm.length / 2;
  for (let i = 0; i < pcm.length; i += 2) {
    const s = pcm.readInt16LE(i);
    sum += Math.abs(s);
  }
  return samples > 0 ? sum / samples / 32768 : 0;
}

function mulawToPcm16le(muLaw: Buffer): Buffer {
  const out = Buffer.allocUnsafe(muLaw.length * 2);
  for (let i = 0; i < muLaw.length; i++) {
    const s = muLawDecodeSample(muLaw[i]!);
    out.writeInt16LE(s, i * 2);
  }
  return out;
}

function muLawDecodeSample(uVal: number): number {
  // Standard G.711 mu-law decode.
  uVal = ~uVal & 0xff;
  const sign = uVal & 0x80;
  const exponent = (uVal >> 4) & 0x07;
  const mantissa = uVal & 0x0f;
  let sample = ((mantissa << 4) + 0x08) << (exponent + 3);
  sample -= 0x84;
  return sign ? -sample : sample;
}

function upsamplePcm16le_8k_to_16k(pcm8k: Buffer): Buffer {
  // Simple x2 upsample by duplication: s0,s0,s1,s1,...
  const samples8k = pcm8k.length / 2;
  const out = Buffer.allocUnsafe(samples8k * 2 * 2);
  for (let i = 0; i < samples8k; i++) {
    const s = pcm8k.readInt16LE(i * 2);
    out.writeInt16LE(s, i * 4);
    out.writeInt16LE(s, i * 4 + 2);
  }
  return out;
}

function makeWavPcm16le(params: { pcm: Buffer; sampleRate: number; channels: number }): Buffer {
  const { pcm, sampleRate, channels } = params;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}
