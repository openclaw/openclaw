/**
 * Deepgram Nova STT Provider
 *
 * Uses Deepgram's live streaming WebSocket API for real-time transcription with:
 * - Direct mu-law audio support (encoding=mulaw, sample_rate=8000)
 * - Server-side endpointing for utterance boundary detection
 * - Low-latency streaming transcription (<300ms)
 * - Partial transcript callbacks for real-time UI updates
 *
 * No SDK dependency — uses raw WebSocket (same pattern as OpenAI Realtime provider).
 * Deepgram SDK v6 has known gotchas (context manager, string params, blocking listener)
 * that are avoided entirely by using the WebSocket API directly.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import type { STTProvider, RealtimeSTTSession } from "./stt-openai-realtime.js";

const DG_DEBUG_LOG = path.join(os.homedir(), ".openclaw", "voice-debug.log");
function dgDebug(msg: string): void {
  const line = `[${new Date().toISOString()}] [DeepgramSTT] ${msg}\n`;
  try { fs.appendFileSync(DG_DEBUG_LOG, line); } catch { /* ignore */ }
}

/**
 * Configuration for Deepgram STT.
 */
export interface DeepgramSTTConfig {
  /** Deepgram API key */
  apiKey: string;
  /** Model to use (default: nova-3) */
  model?: string;
  /** Endpointing silence duration in ms (default: 800) */
  endpointingMs?: number;
  /** Language code (default: en) */
  language?: string;
  /** Enable smart formatting (punctuation, numerals, etc.) */
  smartFormat?: boolean;
  /** Custom vocabulary terms for improved accuracy (up to 100) */
  keywords?: string[];
  /** Audio encoding sent to Deepgram (default: mulaw). Set to linear16 when transcoding from G722. */
  encoding?: string;
  /** Sample rate of audio sent to Deepgram (default: 8000). Set to 16000 for G722-decoded PCM. */
  sampleRate?: number;
}

/**
 * Provider factory for Deepgram STT sessions.
 */
export class DeepgramSTTProvider implements STTProvider {
  readonly name = "deepgram";
  private apiKey: string;
  private model: string;
  private endpointingMs: number;
  private language: string;
  private smartFormat: boolean;
  private keywords: string[];
  private encoding: string;
  private sampleRate: number;

  constructor(config: DeepgramSTTConfig) {
    if (!config.apiKey) {
      throw new Error("Deepgram API key required for STT");
    }
    this.apiKey = config.apiKey;
    this.model = config.model || "nova-3";
    this.endpointingMs = config.endpointingMs ?? 800;
    this.language = config.language || "en";
    this.smartFormat = config.smartFormat ?? true;
    this.keywords = config.keywords ?? [];
    this.encoding = config.encoding || "mulaw";
    this.sampleRate = config.sampleRate ?? 8000;
  }

  /**
   * Create a new Deepgram streaming transcription session.
   */
  createSession(): RealtimeSTTSession {
    return new DeepgramSTTSession(
      this.apiKey,
      this.model,
      this.endpointingMs,
      this.language,
      this.smartFormat,
      this.keywords,
      this.encoding,
      this.sampleRate,
    );
  }
}

/**
 * WebSocket-based session for Deepgram real-time speech-to-text.
 *
 * Deepgram live streaming protocol:
 * - Connect to wss://api.deepgram.com/v1/listen with query params
 * - Send raw audio bytes as binary WebSocket frames
 * - Receive JSON messages with transcript results
 * - Send empty byte message or CloseStream JSON to finalize
 */
class DeepgramSTTSession implements RealtimeSTTSession {
  private static readonly MAX_RECONNECT_ATTEMPTS = 5;
  private static readonly RECONNECT_DELAY_MS = 1000;

  private ws: WebSocket | null = null;
  private connected = false;
  private closed = false;
  private reconnectAttempts = 0;
  private pendingTranscript = "";
  private onTranscriptCallback: ((transcript: string) => void) | null = null;
  private onPartialCallback: ((partial: string) => void) | null = null;
  private onSpeechStartCallback: (() => void) | null = null;
  private speechActive = false;
  private _eventCount = 0;
  private _connectTimestamp = 0;
  private _audioBytesSent = 0;
  private _audioCapture: fs.WriteStream | null = null;
  private _keepAliveInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly endpointingMs: number,
    private readonly language: string,
    private readonly smartFormat: boolean,
    private readonly keywords: string[],
    private readonly encoding: string = "mulaw",
    private readonly sampleRate: number = 8000,
  ) {}

  async connect(): Promise<void> {
    this.closed = false;
    this.reconnectAttempts = 0;
    return this.doConnect();
  }

  private async doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Build query parameters for Deepgram live streaming API
      const params = new URLSearchParams({
        model: this.model,
        encoding: this.encoding,
        sample_rate: String(this.sampleRate),
        channels: "1",
        language: this.language,
        punctuate: "true",
        smart_format: String(this.smartFormat),
        endpointing: String(this.endpointingMs),
        utterance_end_ms: String(this.endpointingMs + 400),
        interim_results: "true",
        vad_events: "true",
      });

      // Add keyword boosting if configured
      for (const kw of this.keywords) {
        params.append("keywords", kw);
      }

      const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Token ${this.apiKey}`,
        },
      });

      dgDebug(`Connecting to Deepgram: model=${this.model} encoding=${this.encoding} sample_rate=${this.sampleRate}`);

      this.ws.on("open", () => {
        dgDebug("WebSocket connected to Deepgram");
        this.connected = true;
        this._connectTimestamp = Date.now();
        this._audioBytesSent = 0;
        this._eventCount = 0;
        this.reconnectAttempts = 0;

        // Start audio capture if DEEPGRAM_CAPTURE_AUDIO is set
        if (process.env.DEEPGRAM_CAPTURE_AUDIO === "1") {
          const capturePath = path.join(os.homedir(), ".openclaw", `deepgram-capture-${Date.now()}.mulaw`);
          this._audioCapture = fs.createWriteStream(capturePath);
          dgDebug(`Audio capture started: ${capturePath}`);
        }

        // KeepAlive: send every 8 seconds to prevent session dormancy
        this._keepAliveInterval = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try { this.ws.send(JSON.stringify({ type: "KeepAlive" })); } catch { /* ignore */ }
          }
        }, 8000);

        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        try {
          const event = JSON.parse(data.toString());
          this._eventCount++;
          // Log ALL events for first 30 seconds to capture the full picture
          const elapsed = Date.now() - this._connectTimestamp;
          if (elapsed < 30000 || this._eventCount <= 10) {
            const alt = event.channel?.alternatives?.[0];
            dgDebug(`Event #${this._eventCount} @${elapsed}ms: type=${event.type} is_final=${event.is_final} speech_final=${event.speech_final} transcript="${alt?.transcript?.slice(0, 80) || ""}" audio_sent=${this._audioBytesSent}`);
          }
          this.handleEvent(event);
        } catch (e) {
          dgDebug(`Failed to parse event: ${e}`);
        }
      });

      this.ws.on("error", (error) => {
        dgDebug(`WebSocket error: ${error}`);
        if (!this.connected) {
          reject(error);
        }
      });

      this.ws.on("close", (code, reason) => {
        dgDebug(`WebSocket closed (code: ${code}, reason: ${reason?.toString() || "none"})`);
        this.connected = false;

        if (!this.closed) {
          void this.attemptReconnect();
        }
      });

      setTimeout(() => {
        if (!this.connected) {
          reject(new Error("Deepgram STT connection timeout"));
        }
      }, 10000);
    });
  }

  private async attemptReconnect(): Promise<void> {
    if (this.closed) {
      return;
    }

    if (this.reconnectAttempts >= DeepgramSTTSession.MAX_RECONNECT_ATTEMPTS) {
      console.error(
        `[DeepgramSTT] Max reconnect attempts (${DeepgramSTTSession.MAX_RECONNECT_ATTEMPTS}) reached`,
      );
      return;
    }

    this.reconnectAttempts++;
    const delay = DeepgramSTTSession.RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempts - 1);
    console.log(
      `[DeepgramSTT] Reconnecting ${this.reconnectAttempts}/${DeepgramSTTSession.MAX_RECONNECT_ATTEMPTS} in ${delay}ms...`,
    );

    await new Promise((resolve) => setTimeout(resolve, delay));

    if (this.closed) {
      return;
    }

    try {
      await this.doConnect();
      console.log("[DeepgramSTT] Reconnected successfully");
    } catch (error) {
      console.error("[DeepgramSTT] Reconnect failed:", error);
    }
  }

  /**
   * Handle Deepgram streaming events.
   *
   * Deepgram sends these event types:
   * - Results with is_final=false: interim/partial results
   * - Results with is_final=true: final results for an utterance segment
   * - Results with speech_final=true: end of a full utterance (after endpointing)
   * - SpeechStarted: VAD detected speech beginning
   * - UtteranceEnd: silence detected after speech (endpointing boundary)
   * - Metadata: connection metadata
   * - Error: error messages
   */
  private handleEvent(event: DeepgramEvent): void {
    switch (event.type) {
      case "Results": {
        const alt = event.channel?.alternatives?.[0];
        if (!alt) break;

        const transcript = alt.transcript?.trim();
        if (!transcript) break;

        if (!event.is_final) {
          // Interim result — update partial transcript
          dgDebug(`Partial: "${transcript}"`);
          this.onPartialCallback?.(transcript);
        } else if (event.speech_final) {
          // Final result with speech_final=true: full utterance complete
          dgDebug(`FINAL transcript (speech_final): "${transcript}"`);
          this.speechActive = false;
          this.pendingTranscript = "";
          this.onTranscriptCallback?.(transcript);
        } else {
          // Final result but not speech_final: accumulate for multi-segment utterances
          this.pendingTranscript += (this.pendingTranscript ? " " : "") + transcript;
          dgDebug(`Accumulating: "${this.pendingTranscript}"`);
          this.onPartialCallback?.(this.pendingTranscript);
        }
        break;
      }

      case "SpeechStarted":
        if (!this.speechActive) {
          dgDebug("Speech started (VAD)");
          this.speechActive = true;
          this.pendingTranscript = "";
          this.onSpeechStartCallback?.();
        }
        break;

      case "UtteranceEnd":
        // Endpointing detected silence — flush any accumulated transcript
        dgDebug(`UtteranceEnd (pending="${this.pendingTranscript}")`);
        if (this.pendingTranscript) {
          dgDebug(`FINAL transcript (utterance_end): "${this.pendingTranscript}"`);
          this.onTranscriptCallback?.(this.pendingTranscript);
          this.pendingTranscript = "";
        }
        this.speechActive = false;
        break;

      case "Metadata":
        dgDebug(`Connected: request_id=${event.request_id} model=${event.model_info?.name || "?"}`);
        break;

      case "Error":
        dgDebug(`ERROR: ${event.message ?? JSON.stringify(event)}`);
        break;

      default:
        dgDebug(`Unknown event type: ${event.type}`);
        break;
    }
  }

  /**
   * Send raw mu-law audio data to Deepgram.
   * Deepgram accepts raw binary audio frames — no wrapping needed.
   */
  sendAudio(muLawData: Buffer): void {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    // Log first frame hex for format verification
    if (this._audioBytesSent === 0 && muLawData.length > 0) {
      const hexBytes = Array.from(muLawData.slice(0, 8)).map(b => "0x" + b.toString(16).padStart(2, "0")).join(", ");
      dgDebug(`First audio frame: ${muLawData.length} bytes, first 8: [${hexBytes}]`);
    }
    this._audioBytesSent += muLawData.length;
    // Capture audio to disk if enabled
    if (this._audioCapture) {
      this._audioCapture.write(muLawData);
    }
    this.ws.send(muLawData);
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
    // Clean up keepalive
    if (this._keepAliveInterval) {
      clearInterval(this._keepAliveInterval);
      this._keepAliveInterval = null;
    }
    // Clean up audio capture
    if (this._audioCapture) {
      this._audioCapture.end();
      this._audioCapture = null;
      dgDebug(`Audio capture ended (${this._audioBytesSent} bytes sent to Deepgram)`);
    }
    if (this.ws) {
      // Send CloseStream message to gracefully close the Deepgram session
      if (this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ type: "CloseStream" }));
        } catch {
          // Ignore send errors during close
        }
      }
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    dgDebug(`Session closed: ${this._eventCount} events received, ${this._audioBytesSent} audio bytes sent`);
  }

  isConnected(): boolean {
    return this.connected;
  }
}

/**
 * Deepgram streaming event types.
 */
interface DeepgramEvent {
  type: "Results" | "SpeechStarted" | "UtteranceEnd" | "Metadata" | "Error";
  /** Results events */
  channel?: {
    alternatives?: Array<{
      transcript?: string;
      confidence?: number;
      words?: Array<{
        word: string;
        start: number;
        end: number;
        confidence: number;
      }>;
    }>;
  };
  is_final?: boolean;
  speech_final?: boolean;
  /** Metadata events */
  request_id?: string;
  model_info?: { name?: string };
  /** Error events */
  message?: string;
}
