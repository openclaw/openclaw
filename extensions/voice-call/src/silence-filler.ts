/**
 * Silence filler — plays ambient SFX (typing, processing) during long pauses
 * to signal the agent is working (e.g., tool calls, slow LLM responses).
 *
 * Usage:
 *   const filler = new SilenceFiller(mediaStreamHandler, { thresholdMs: 3000 });
 *   filler.start(streamSid);  // call after TTS finishes
 *   filler.stop(streamSid);   // call before next TTS plays
 *   filler.dispose();         // cleanup on call end
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MediaStreamHandler } from "./media-stream.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.resolve(__dirname, "..", "assets");

export interface SilenceFillerConfig {
  /** Milliseconds of silence before filler starts (default: 3500) */
  thresholdMs?: number;
  /** Which SFX set to use (default: "typing") */
  sfxSet?: "typing" | "processing";
  /** Enable/disable (default: true) */
  enabled?: boolean;
  /** Volume reduction: skip every Nth byte pair to reduce loudness (default: 2 = -6dB) */
  volumeReduction?: number;
}

interface StreamState {
  timer: ReturnType<typeof setTimeout> | null;
  playing: boolean;
  abortController: AbortController | null;
}

// Pre-loaded SFX buffers (lazy, loaded once)
let sfxCache: Map<string, Buffer> | null = null;

function loadSfx(): Map<string, Buffer> {
  if (sfxCache) {
    return sfxCache;
  }
  sfxCache = new Map();

  const files = ["typing.raw", "processing.raw"];
  for (const file of files) {
    const filePath = path.join(ASSETS_DIR, file);
    if (fs.existsSync(filePath)) {
      sfxCache.set(file.replace(".raw", ""), fs.readFileSync(filePath));
    }
  }
  return sfxCache;
}

/**
 * Reduce volume of mu-law audio by attenuating samples.
 * Mu-law is logarithmic, so we blend toward the mu-law silence value (0xFF).
 */
function attenuate(buf: Buffer, factor: number): Buffer {
  if (factor <= 1) {
    return buf;
  }
  const out = Buffer.alloc(buf.length);
  const silence = 0xff; // mu-law silence
  for (let i = 0; i < buf.length; i++) {
    // Linear interpolation toward silence
    out[i] = Math.round(buf[i] + (silence - buf[i]) * (1 - 1 / factor));
  }
  return out;
}

export class SilenceFiller {
  private handler: MediaStreamHandler;
  private config: Required<SilenceFillerConfig>;
  private streams = new Map<string, StreamState>();

  constructor(handler: MediaStreamHandler, config?: SilenceFillerConfig) {
    this.handler = handler;
    this.config = {
      thresholdMs: config?.thresholdMs ?? 3500,
      sfxSet: config?.sfxSet ?? "typing",
      enabled: config?.enabled ?? true,
      volumeReduction: config?.volumeReduction ?? 1,
    };
  }

  /**
   * Start monitoring silence for a stream.
   * Call this after TTS finishes or when waiting for a response.
   */
  start(streamSid: string): void {
    if (!this.config.enabled) {
      return;
    }
    this.stop(streamSid); // Clear any existing timer

    const state: StreamState = {
      timer: setTimeout(() => this.playFiller(streamSid), this.config.thresholdMs),
      playing: false,
      abortController: null,
    };
    this.streams.set(streamSid, state);
  }

  /**
   * Stop the filler for a stream (call before real TTS plays).
   */
  stop(streamSid: string): void {
    const state = this.streams.get(streamSid);
    if (!state) {
      return;
    }

    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.abortController) {
      state.abortController.abort();
      state.abortController = null;
    }
    if (state.playing) {
      this.handler.clearAudio(streamSid);
      state.playing = false;
    }
    this.streams.delete(streamSid);
  }

  /**
   * Clean up all streams.
   */
  dispose(): void {
    for (const streamSid of this.streams.keys()) {
      this.stop(streamSid);
    }
  }

  private async playFiller(streamSid: string): Promise<void> {
    const state = this.streams.get(streamSid);
    if (!state) {
      return;
    }

    const sfx = loadSfx();
    const clips = this.config.sfxSet === "processing" ? ["processing"] : ["typing"];

    const clip = clips[Math.floor(Math.random() * clips.length)];
    let audio = clip ? sfx.get(clip) : undefined;
    if (!audio) {
      return;
    }

    // Attenuate so it's clearly background, not competing with speech
    if (this.config.volumeReduction > 1) {
      audio = attenuate(audio, this.config.volumeReduction);
    }

    state.playing = true;
    state.abortController = new AbortController();
    const signal = state.abortController.signal;

    const CHUNK_SIZE = 640; // 80ms at 8kHz
    const CHUNK_DELAY_MS = 80;

    try {
      // Play the clip, then loop with a gap
      let offset = 0;
      while (!signal.aborted) {
        const chunk = audio.subarray(offset, offset + CHUNK_SIZE);
        if (chunk.length === 0) {
          // End of clip — pause briefly, pick another clip, restart
          await new Promise((r) => setTimeout(r, 500));
          if (signal.aborted) {
            break;
          }

          const nextClip = clips[Math.floor(Math.random() * clips.length)];
          let nextAudio = nextClip ? sfx.get(nextClip) : undefined;
          if (nextAudio && this.config.volumeReduction > 1) {
            nextAudio = attenuate(nextAudio, this.config.volumeReduction);
          }
          if (nextAudio) {
            audio = nextAudio;
          }
          offset = 0;
          continue;
        }

        this.handler.sendAudio(streamSid, chunk);
        offset += CHUNK_SIZE;
        await new Promise((r) => setTimeout(r, CHUNK_DELAY_MS));
      }
    } catch {
      // Aborted or stream closed — expected
    } finally {
      state.playing = false;
    }
  }
}
