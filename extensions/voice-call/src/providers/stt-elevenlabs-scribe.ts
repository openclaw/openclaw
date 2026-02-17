/**
 * ElevenLabs Scribe v2 Realtime STT Provider
 *
 * Uses ElevenLabs Scribe v2 Realtime WebSocket API for streaming transcription with:
 * - Server-side VAD for turn detection
 * - Low-latency streaming transcription (~150ms)
 * - Partial and committed transcript callbacks
 * - Mu-law 8kHz input from Twilio (converted to PCM 16kHz for Scribe)
 */

import WebSocket from "ws";
import type { RealtimeSTTSession } from "./stt-openai-realtime.js";

/**
 * Configuration for ElevenLabs Scribe STT.
 */
export interface ElevenLabsScribeSTTConfig {
  /** ElevenLabs API key */
  apiKey: string;
  /** Model ID (default: scribe_v2_realtime) */
  model?: string;
  /** Language code for transcription (default: auto-detect) */
  languageCode?: string;
  /** VAD silence threshold in seconds (default: 1.0) */
  vadSilenceThresholdSecs?: number;
  /** VAD threshold 0-1 (default: 0.4) */
  vadThreshold?: number;
}

/**
 * Provider factory for ElevenLabs Scribe Realtime STT sessions.
 */
export class ElevenLabsScribeSTTProvider {
  readonly name = "elevenlabs-scribe";
  private apiKey: string;
  private model: string;
  private languageCode?: string;
  private vadSilenceThresholdSecs: number;
  private vadThreshold: number;

  constructor(config: ElevenLabsScribeSTTConfig) {
    if (!config.apiKey) {
      throw new Error("ElevenLabs API key required for Scribe STT");
    }
    this.apiKey = config.apiKey;
    this.model = config.model || "scribe_v2_realtime";
    this.languageCode = config.languageCode;
    this.vadSilenceThresholdSecs = config.vadSilenceThresholdSecs ?? 0.3;
    this.vadThreshold = config.vadThreshold ?? 0.5;
  }

  /**
   * Create a new realtime transcription session.
   */
  createSession(): RealtimeSTTSession {
    return new ElevenLabsScribeSTTSession(
      this.apiKey,
      this.model,
      this.languageCode,
      this.vadSilenceThresholdSecs,
      this.vadThreshold,
    );
  }
}

// --------------------------------------------------------------------------
// Mu-law → PCM 16-bit conversion (G.711 decoding)
// --------------------------------------------------------------------------

const MULAW_DECODE_TABLE = new Int16Array(256);
(function buildMulawTable() {
  for (let i = 0; i < 256; i++) {
    const mu = ~i & 0xff;
    const sign = mu & 0x80;
    const exponent = (mu >> 4) & 0x07;
    const mantissa = mu & 0x0f;
    let sample = ((mantissa << 3) + 132) << exponent;
    sample -= 132;
    MULAW_DECODE_TABLE[i] = sign ? -sample : sample;
  }
})();

/**
 * Decode mu-law 8kHz audio to PCM 16-bit 16kHz (upsample 2x with linear interpolation).
 * Scribe expects PCM 16kHz; Twilio sends mu-law 8kHz.
 */
function mulawTopcm16k(mulaw: Buffer): Buffer {
  const inputSamples = mulaw.length;
  // Decode mu-law to 16-bit PCM at 8kHz
  const pcm8k = new Int16Array(inputSamples);
  for (let i = 0; i < inputSamples; i++) {
    pcm8k[i] = MULAW_DECODE_TABLE[mulaw[i]];
  }

  // Upsample 8kHz → 16kHz with linear interpolation (2x)
  const outputSamples = inputSamples * 2;
  const output = Buffer.alloc(outputSamples * 2); // 16-bit = 2 bytes per sample

  for (let i = 0; i < inputSamples; i++) {
    const s0 = pcm8k[i];
    const s1 = i + 1 < inputSamples ? pcm8k[i + 1] : s0;

    // Original sample
    output.writeInt16LE(s0, i * 4);
    // Interpolated sample
    output.writeInt16LE(Math.round((s0 + s1) / 2), i * 4 + 2);
  }

  return output;
}

// --------------------------------------------------------------------------
// Scribe WebSocket session
// --------------------------------------------------------------------------

class ElevenLabsScribeSTTSession implements RealtimeSTTSession {
  private static readonly MAX_RECONNECT_ATTEMPTS = 5;
  private static readonly RECONNECT_DELAY_MS = 1000;

  private ws: WebSocket | null = null;
  private connected = false;
  private closed = false;
  private reconnectAttempts = 0;
  private onTranscriptCallback: ((transcript: string) => void) | null = null;
  private onPartialCallback: ((partial: string) => void) | null = null;
  private onSpeechStartCallback: (() => void) | null = null;
  private speechActive = false;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly languageCode: string | undefined,
    private readonly vadSilenceThresholdSecs: number,
    private readonly vadThreshold: number,
  ) {}

  async connect(): Promise<void> {
    this.closed = false;
    this.reconnectAttempts = 0;
    return this.doConnect();
  }

  private async doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        model_id: this.model,
        commit_strategy: "vad",
        vad_silence_threshold_secs: String(this.vadSilenceThresholdSecs),
        vad_threshold: String(this.vadThreshold),
        audio_format: "pcm_16000",
      });
      if (this.languageCode) {
        params.set("language_code", this.languageCode);
      }

      const url = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params.toString()}`;

      this.ws = new WebSocket(url, {
        headers: {
          "xi-api-key": this.apiKey,
        },
      });

      this.ws.on("open", () => {
        console.log("[ScribeSTT] WebSocket connected");
        this.connected = true;
        this.reconnectAttempts = 0;
        // Scribe auto-starts on connection; session_started event confirms config
        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        try {
          const event = JSON.parse(data.toString());
          this.handleEvent(event);
        } catch (e) {
          console.error("[ScribeSTT] Failed to parse event:", e);
        }
      });

      this.ws.on("error", (error) => {
        console.error("[ScribeSTT] WebSocket error:", error);
        if (!this.connected) {
          reject(error);
        }
      });

      this.ws.on("close", (code, reason) => {
        console.log(
          `[ScribeSTT] WebSocket closed (code: ${code}, reason: ${reason?.toString() || "none"})`,
        );
        this.connected = false;

        if (!this.closed) {
          void this.attemptReconnect();
        }
      });

      setTimeout(() => {
        if (!this.connected) {
          // Clean up the WebSocket to avoid orphaned connections
          try {
            this.ws?.close();
          } catch {
            // ignore close errors during timeout cleanup
          }
          reject(new Error("Scribe STT connection timeout"));
        }
      }, 10000);
    });
  }

  private async attemptReconnect(): Promise<void> {
    if (this.closed) {
      return;
    }

    if (this.reconnectAttempts >= ElevenLabsScribeSTTSession.MAX_RECONNECT_ATTEMPTS) {
      console.error(
        `[ScribeSTT] Max reconnect attempts (${ElevenLabsScribeSTTSession.MAX_RECONNECT_ATTEMPTS}) reached`,
      );
      return;
    }

    this.reconnectAttempts++;
    const delay = ElevenLabsScribeSTTSession.RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempts - 1);
    console.log(
      `[ScribeSTT] Reconnecting ${this.reconnectAttempts}/${ElevenLabsScribeSTTSession.MAX_RECONNECT_ATTEMPTS} in ${delay}ms...`,
    );

    await new Promise((resolve) => setTimeout(resolve, delay));

    if (this.closed) {
      return;
    }

    try {
      await this.doConnect();
      console.log("[ScribeSTT] Reconnected successfully");
    } catch (error) {
      console.error("[ScribeSTT] Reconnect failed:", error);
    }
  }

  private handleEvent(event: {
    message_type: string;
    text?: string;
    session_id?: string;
    type?: string;
  }): void {
    switch (event.message_type) {
      case "session_started":
        console.log(`[ScribeSTT] Session started: ${event.session_id ?? "unknown"}`);
        break;

      case "partial_transcript":
        if (event.text) {
          // Scribe sends partial transcripts as speech is detected
          if (!this.speechActive) {
            this.speechActive = true;
            this.onSpeechStartCallback?.();
          }
          this.onPartialCallback?.(event.text);
        }
        break;

      case "committed_transcript":
      case "committed_transcript_with_timestamps":
        if (event.text) {
          console.log(`[ScribeSTT] Transcript: ${event.text}`);
          this.onTranscriptCallback?.(event.text);
        }
        this.speechActive = false;
        break;

      case "vad_event":
        if (event.type === "speech_start" && !this.speechActive) {
          this.speechActive = true;
          console.log("[ScribeSTT] Speech started");
          this.onSpeechStartCallback?.();
        } else if (event.type === "speech_end") {
          this.speechActive = false;
        }
        break;

      case "error":
        console.error("[ScribeSTT] Error:", event);
        break;
    }
  }

  /**
   * Send mu-law 8kHz audio from Twilio.
   * Converts to PCM 16kHz for Scribe, then sends as base64.
   */
  sendAudio(muLawData: Buffer): void {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    // Convert mu-law 8kHz → PCM 16kHz for Scribe
    const pcm16k = mulawTopcm16k(muLawData);

    this.ws.send(
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: pcm16k.toString("base64"),
        sample_rate: 16000,
      }),
    );
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

  async waitForTranscript(timeoutMs = 30000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.onTranscriptCallback = null;
        reject(new Error("Transcript timeout"));
      }, timeoutMs);

      this.onTranscriptCallback = (transcript) => {
        clearTimeout(timeout);
        this.onTranscriptCallback = null;
        resolve(transcript);
      };
    });
  }

  close(): void {
    this.closed = true;
    if (this.ws) {
      // Send end_of_stream before closing
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ message_type: "end_of_stream" }));
      }
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
