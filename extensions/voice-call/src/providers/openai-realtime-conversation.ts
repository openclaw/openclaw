/**
 * OpenAI Realtime Conversation Provider
 *
 * Full conversation mode: Twilio audio → OpenAI Realtime (STT + LLM + TTS) → mu-law → Twilio.
 * - Eliminates the Pi agent LLM round-trip and all TTS synthesis
 * - Audio flows both directions over a single persistent WebSocket
 * - Sub-second response latency via server-side VAD and barge-in support
 */

import WebSocket from "ws";

/**
 * Configuration for OpenAI Realtime conversation mode.
 */
export interface RealtimeConversationConfig {
  /** OpenAI API key */
  apiKey: string;
  /** Realtime model to use (default: gpt-4o-realtime-preview) */
  model?: string;
  /** Voice for AI responses (default: alloy) */
  voice?: string;
  /** System prompt / instructions for the model */
  systemPrompt?: string;
  /** Silence duration in ms before considering speech ended (default: 800) */
  silenceDurationMs?: number;
  /** VAD threshold 0-1 (default: 0.5) */
  vadThreshold?: number;
}

/**
 * Session handle for a full-duplex conversation with OpenAI Realtime.
 */
export interface RealtimeConversationSession {
  /** Connect to the OpenAI Realtime WebSocket */
  connect(): Promise<void>;
  /** Send mu-law audio data (8kHz mono) from the caller */
  sendAudio(audio: Buffer): void;
  /** Register callback that fires for each audio delta from the AI (mu-law chunks) */
  onAudioDelta(callback: (chunk: Buffer) => void): void;
  /** Register callback when caller speech starts (use for barge-in) */
  onSpeechStart(callback: () => void): void;
  /** Register callback for partial caller transcript */
  onTranscriptDelta(callback: (partial: string) => void): void;
  /** Register callback for final caller transcript */
  onTranscriptDone(callback: (text: string) => void): void;
  /** Register callback for partial AI response transcript */
  onResponseTranscriptDelta(callback: (partial: string) => void): void;
  /** Register callback for final AI response transcript */
  onResponseTranscriptDone(callback: (text: string) => void): void;
  /** Close the session */
  close(): void;
  /** Check if session is currently connected */
  isConnected(): boolean;
  /**
   * Trigger the AI to speak first (e.g., for greeting the caller at call start).
   * If message is provided, instructs the AI to use that exact text.
   * Falls back to a natural greeting based on the session's system prompt.
   */
  triggerGreeting(message?: string): void;
}

/**
 * Provider factory for OpenAI Realtime conversation sessions.
 */
export class OpenAIRealtimeConversationProvider {
  readonly name = "openai-realtime-conversation";
  private apiKey: string;
  private model: string;
  private voice: string;
  private systemPrompt: string | undefined;
  private silenceDurationMs: number;
  private vadThreshold: number;

  constructor(config: RealtimeConversationConfig) {
    if (!config.apiKey) {
      throw new Error("OpenAI API key required for Realtime Conversation");
    }
    this.apiKey = config.apiKey;
    this.model = config.model || "gpt-4o-realtime-preview";
    this.voice = config.voice || "alloy";
    this.systemPrompt = config.systemPrompt;
    this.silenceDurationMs = config.silenceDurationMs ?? 800;
    this.vadThreshold = config.vadThreshold ?? 0.5;
  }

  createSession(): RealtimeConversationSession {
    return new OpenAIRealtimeConversationSession(
      this.apiKey,
      this.model,
      this.voice,
      this.systemPrompt,
      this.silenceDurationMs,
      this.vadThreshold,
    );
  }
}

/**
 * WebSocket-based full-duplex conversation session.
 */
class OpenAIRealtimeConversationSession implements RealtimeConversationSession {
  private static readonly MAX_RECONNECT_ATTEMPTS = 5;
  private static readonly RECONNECT_DELAY_MS = 1000;

  private ws: WebSocket | null = null;
  private connected = false;
  private closed = false;
  private reconnectAttempts = 0;

  private onAudioDeltaCallback: ((chunk: Buffer) => void) | null = null;
  private onSpeechStartCallback: (() => void) | null = null;
  private onTranscriptDeltaCallback: ((partial: string) => void) | null = null;
  private onTranscriptDoneCallback: ((text: string) => void) | null = null;
  private onResponseTranscriptDeltaCallback: ((partial: string) => void) | null = null;
  private onResponseTranscriptDoneCallback: ((text: string) => void) | null = null;

  /** Accumulates caller input transcript deltas */
  private pendingInputTranscript = "";
  /** Accumulates AI response transcript deltas */
  private pendingResponseTranscript = "";

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly voice: string,
    private readonly systemPrompt: string | undefined,
    private readonly silenceDurationMs: number,
    private readonly vadThreshold: number,
  ) {}

  async connect(): Promise<void> {
    this.closed = false;
    this.reconnectAttempts = 0;
    return this.doConnect();
  }

  private async doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.model)}`;

      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      this.ws.on("open", () => {
        console.log("[RealtimeConversation] WebSocket connected");
        this.connected = true;
        this.reconnectAttempts = 0;

        // Configure the session: bidirectional g711 ulaw, server VAD, optional system prompt
        const sessionUpdate: Record<string, unknown> = {
          modalities: ["text", "audio"],
          voice: this.voice,
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          input_audio_transcription: { model: "gpt-4o-transcribe" },
          turn_detection: {
            type: "server_vad",
            threshold: this.vadThreshold,
            silence_duration_ms: this.silenceDurationMs,
          },
        };

        if (this.systemPrompt) {
          sessionUpdate.instructions = this.systemPrompt;
        }

        this.sendEvent({ type: "session.update", session: sessionUpdate });
        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        try {
          const event = JSON.parse(data.toString()) as Record<string, unknown>;
          this.handleEvent(event);
        } catch (e) {
          console.error("[RealtimeConversation] Failed to parse event:", e);
        }
      });

      this.ws.on("error", (error) => {
        console.error("[RealtimeConversation] WebSocket error:", error);
        if (!this.connected) {
          reject(error);
        }
      });

      this.ws.on("close", (code, reason) => {
        console.log(
          `[RealtimeConversation] WebSocket closed (code: ${code}, reason: ${reason?.toString() || "none"})`,
        );
        this.connected = false;

        if (!this.closed) {
          void this.attemptReconnect();
        }
      });

      setTimeout(() => {
        if (!this.connected) {
          reject(new Error("Realtime Conversation connection timeout"));
        }
      }, 10000);
    });
  }

  private async attemptReconnect(): Promise<void> {
    if (this.closed) {
      return;
    }

    if (this.reconnectAttempts >= OpenAIRealtimeConversationSession.MAX_RECONNECT_ATTEMPTS) {
      console.error(
        `[RealtimeConversation] Max reconnect attempts (${OpenAIRealtimeConversationSession.MAX_RECONNECT_ATTEMPTS}) reached`,
      );
      return;
    }

    this.reconnectAttempts++;
    const delay =
      OpenAIRealtimeConversationSession.RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempts - 1);
    console.log(
      `[RealtimeConversation] Reconnecting ${this.reconnectAttempts}/${OpenAIRealtimeConversationSession.MAX_RECONNECT_ATTEMPTS} in ${delay}ms...`,
    );

    await new Promise((resolve) => setTimeout(resolve, delay));

    if (this.closed) {
      return;
    }

    try {
      await this.doConnect();
      console.log("[RealtimeConversation] Reconnected successfully");
    } catch (error) {
      console.error("[RealtimeConversation] Reconnect failed:", error);
    }
  }

  private handleEvent(event: Record<string, unknown>): void {
    const type = event.type as string;

    switch (type) {
      case "session.created":
      case "session.updated":
        console.log(`[RealtimeConversation] ${type}`);
        break;

      case "input_audio_buffer.speech_started":
        // Caller started speaking — trigger barge-in: cancel current AI response
        console.log("[RealtimeConversation] Speech started (barge-in)");
        this.sendEvent({ type: "response.cancel" });
        this.onSpeechStartCallback?.();
        break;

      case "input_audio_buffer.speech_stopped":
      case "input_audio_buffer.committed":
        console.log(`[RealtimeConversation] ${type}`);
        break;

      case "conversation.item.input_audio_transcription.delta":
        // Partial caller transcript
        if (event.delta) {
          this.pendingInputTranscript += event.delta as string;
          this.onTranscriptDeltaCallback?.(this.pendingInputTranscript);
        }
        break;

      case "conversation.item.input_audio_transcription.completed":
        // Final caller transcript
        if (event.transcript) {
          const text = event.transcript as string;
          console.log(`[RealtimeConversation] Caller: ${text}`);
          this.onTranscriptDoneCallback?.(text);
        }
        this.pendingInputTranscript = "";
        break;

      case "response.audio.delta":
        // AI audio chunk (base64 g711 ulaw) — decode and forward to Twilio
        if (event.delta) {
          const chunk = Buffer.from(event.delta as string, "base64");
          this.onAudioDeltaCallback?.(chunk);
        }
        break;

      case "response.audio.done":
        console.log("[RealtimeConversation] AI audio done");
        break;

      case "response.audio_transcript.delta":
        // Partial AI response transcript
        if (event.delta) {
          this.pendingResponseTranscript += event.delta as string;
          this.onResponseTranscriptDeltaCallback?.(this.pendingResponseTranscript);
        }
        break;

      case "response.audio_transcript.done":
        // Final AI response transcript
        if (event.transcript) {
          const text = event.transcript as string;
          console.log(`[RealtimeConversation] AI: ${text}`);
          this.onResponseTranscriptDoneCallback?.(text);
        }
        this.pendingResponseTranscript = "";
        break;

      case "response.done":
        console.log("[RealtimeConversation] Response done");
        break;

      case "error":
        console.error("[RealtimeConversation] Error:", event.error);
        break;
    }
  }

  private sendEvent(event: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  sendAudio(muLawData: Buffer): void {
    if (!this.connected) {
      return;
    }
    this.sendEvent({
      type: "input_audio_buffer.append",
      audio: muLawData.toString("base64"),
    });
  }

  onAudioDelta(callback: (chunk: Buffer) => void): void {
    this.onAudioDeltaCallback = callback;
  }

  onSpeechStart(callback: () => void): void {
    this.onSpeechStartCallback = callback;
  }

  onTranscriptDelta(callback: (partial: string) => void): void {
    this.onTranscriptDeltaCallback = callback;
  }

  onTranscriptDone(callback: (text: string) => void): void {
    this.onTranscriptDoneCallback = callback;
  }

  onResponseTranscriptDelta(callback: (partial: string) => void): void {
    this.onResponseTranscriptDeltaCallback = callback;
  }

  onResponseTranscriptDone(callback: (text: string) => void): void {
    this.onResponseTranscriptDoneCallback = callback;
  }

  close(): void {
    this.closed = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  triggerGreeting(message?: string): void {
    if (!this.connected) return;
    if (message) {
      // Use the message text as instructions for just this response so the AI says exactly that.
      this.sendEvent({
        type: "response.create",
        response: { instructions: `Begin the call by saying exactly: "${message}"` },
      });
    } else {
      this.sendEvent({ type: "response.create" });
    }
  }
}
