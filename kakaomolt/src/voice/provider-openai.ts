/**
 * OpenAI Realtime API Provider
 *
 * Real-time voice conversation using OpenAI's Realtime API.
 *
 * Key features:
 * - Model: gpt-4o-realtime-preview
 * - Audio: 24kHz PCM 16-bit mono (input & output)
 * - Server-side VAD
 * - Barge-in (interruption) support
 * - Tool/function calling
 *
 * @see https://platform.openai.com/docs/guides/realtime
 */

import {
  VoiceProvider,
  type VoiceProviderConfig,
  type VoiceSession,
  type VoiceProviderType,
  type AudioConfig,
  OPENAI_AUDIO_CONFIG,
  DEFAULT_PROVIDER_CONFIG,
} from "./provider-interface.js";

// ============================================
// OpenAI Realtime API Types
// ============================================

interface OpenAIMessage {
  type: string;
  [key: string]: unknown;
}

interface SessionUpdateMessage extends OpenAIMessage {
  type: "session.update";
  session: {
    modalities?: string[];
    instructions?: string;
    voice?: string;
    input_audio_format?: "pcm16" | "g711_ulaw" | "g711_alaw";
    output_audio_format?: "pcm16" | "g711_ulaw" | "g711_alaw";
    input_audio_transcription?: {
      model: string;
    };
    turn_detection?: {
      type: "server_vad";
      threshold: number;
      prefix_padding_ms: number;
      silence_duration_ms: number;
    } | null;
    tools?: Array<{
      type: "function";
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }>;
  };
}

interface InputAudioBufferAppend extends OpenAIMessage {
  type: "input_audio_buffer.append";
  audio: string;
}

interface InputAudioBufferCommit extends OpenAIMessage {
  type: "input_audio_buffer.commit";
}

interface InputAudioBufferClear extends OpenAIMessage {
  type: "input_audio_buffer.clear";
}

interface ConversationItemCreate extends OpenAIMessage {
  type: "conversation.item.create";
  item: {
    type: "message";
    role: "user";
    content: Array<{
      type: "input_text";
      text: string;
    }>;
  };
}

interface ResponseCreate extends OpenAIMessage {
  type: "response.create";
  response?: {
    modalities?: string[];
    instructions?: string;
  };
}

interface ResponseCancel extends OpenAIMessage {
  type: "response.cancel";
}

// ============================================
// OpenAI Provider Implementation
// ============================================

const OPENAI_REALTIME_ENDPOINT = "wss://api.openai.com/v1/realtime";

export class OpenAIRealtimeProvider extends VoiceProvider {
  private ws: WebSocket | null = null;
  private pendingToolCalls: Map<string, { name: string; args: unknown }> = new Map();
  private responseStartTime: number = 0;
  private isSessionReady = false;

  constructor(config: Partial<VoiceProviderConfig> & { apiKey: string }) {
    super({
      provider: "openai",
      ...DEFAULT_PROVIDER_CONFIG.openai,
      ...config,
    });
  }

  getType(): VoiceProviderType {
    return "openai";
  }

  getAudioConfig(): { input: AudioConfig; output: AudioConfig } {
    return OPENAI_AUDIO_CONFIG;
  }

  async connect(userId: string): Promise<VoiceSession> {
    if (this.ws) {
      throw new Error("Already connected. Call disconnect() first.");
    }

    this.session = this.createSession(userId);
    this.emit("session.created", this.session);

    try {
      await this.initializeWebSocket();
      return this.session;
    } catch (err) {
      this.updateStatus("error");
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("session.error", error, this.session!);
      throw err;
    }
  }

  private async initializeWebSocket(): Promise<void> {
    const url = `${OPENAI_REALTIME_ENDPOINT}?model=${this.config.model}`;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      } as WebSocketOptions);

      this.ws.onopen = () => {
        this.sendSessionUpdate();
        resolve();
      };

      this.ws.onerror = (event) => {
        const error = new Error(`OpenAI WebSocket error: ${event}`);
        reject(error);
      };

      this.ws.onclose = (event) => {
        this.handleClose(event.reason ?? "Connection closed");
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };
    });
  }

  private sendSessionUpdate(): void {
    const message: SessionUpdateMessage = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: this.config.instructions,
        voice: this.config.voice,
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        input_audio_transcription: {
          model: "whisper-1",
        },
        turn_detection: this.config.enableVAD
          ? {
              type: "server_vad",
              threshold: this.config.vadThreshold ?? 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: this.config.silenceDurationMs ?? 500,
            }
          : null,
      },
    };

    // Add tools if registered
    if (this.tools.length > 0) {
      message.session.tools = this.tools.map((tool) => ({
        type: "function" as const,
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
    }

    this.send(message);
  }

  private handleMessage(data: unknown): void {
    try {
      const message = JSON.parse(String(data)) as OpenAIMessage;

      switch (message.type) {
        case "session.created":
          console.log("[openai] Session created");
          break;

        case "session.updated":
          this.isSessionReady = true;
          this.updateStatus("connected");
          this.emit("session.connected", this.session!);
          break;

        case "input_audio_buffer.speech_started":
          this.updateStatus("listening");
          this.emit("input.started");
          break;

        case "input_audio_buffer.speech_stopped":
          this.emit("input.ended");
          break;

        case "input_audio_buffer.committed":
          // Audio committed, waiting for response
          break;

        case "conversation.item.input_audio_transcription.completed":
          this.emit(
            "input.transcript",
            (message as { transcript: string }).transcript,
            true,
          );
          break;

        case "response.created":
          this.responseStartTime = Date.now();
          this.updateStatus("thinking");
          break;

        case "response.output_item.added":
          // New output item added
          break;

        case "response.audio.delta":
          if (this.session?.status !== "speaking") {
            this.updateStatus("speaking");
            this.emit("response.started");
          }

          const audioData = Buffer.from(
            (message as { delta: string }).delta,
            "base64",
          );
          this.session!.stats.outputAudioBytes += audioData.length;
          this.emit("response.audio", audioData);
          break;

        case "response.audio_transcript.delta":
          this.emit(
            "response.text",
            (message as { delta: string }).delta,
            false,
          );
          break;

        case "response.audio_transcript.done":
          this.emit(
            "response.text",
            (message as { transcript: string }).transcript,
            true,
          );
          break;

        case "response.function_call_arguments.done":
          const funcCall = message as {
            name: string;
            arguments: string;
            call_id: string;
          };
          this.pendingToolCalls.set(funcCall.call_id, {
            name: funcCall.name,
            args: JSON.parse(funcCall.arguments),
          });
          this.emit(
            "tool.call",
            funcCall.name,
            JSON.parse(funcCall.arguments),
          );
          break;

        case "response.done":
          if (this.responseStartTime > 0) {
            const latency = Date.now() - this.responseStartTime;
            this.session!.stats.latencyMs.push(latency);
            this.responseStartTime = 0;
          }

          this.session!.turnCount++;
          this.updateStatus("connected");
          this.emit("response.ended");

          // Extract token usage
          const usage = (message as { response?: { usage?: { input_tokens: number; output_tokens: number } } }).response?.usage;
          if (usage) {
            this.session!.stats.inputTokens += usage.input_tokens;
            this.session!.stats.outputTokens += usage.output_tokens;
          }
          break;

        case "response.cancelled":
          this.updateStatus("interrupted");
          this.session!.stats.interruptions++;
          this.emit("response.interrupted");
          break;

        case "error":
          const error = new Error(
            (message as { error: { message: string } }).error.message,
          );
          this.emit("session.error", error, this.session!);
          break;

        default:
          // Log unknown message types for debugging
          if (!message.type.startsWith("rate_limits")) {
            console.log(`[openai] Unhandled message type: ${message.type}`);
          }
      }
    } catch (err) {
      console.error("[openai] Error handling message:", err);
    }
  }

  private handleClose(reason: string): void {
    this.ws = null;
    this.isSessionReady = false;

    if (this.session) {
      this.session.status = "closed";
      this.session.durationMs = this.getDuration();
    }

    this.emit("session.closed", reason, this.session!);
  }

  sendAudio(chunk: Buffer): void {
    if (!this.ws || !this.isSessionReady) {
      return;
    }

    // Update stats
    if (this.session) {
      this.session.stats.inputAudioBytes += chunk.length;
      this.session.lastActivity = new Date();
    }

    const message: InputAudioBufferAppend = {
      type: "input_audio_buffer.append",
      audio: chunk.toString("base64"),
    };

    this.send(message);
    this.emit("input.audio", chunk);
  }

  commitAudio(): void {
    if (!this.ws || !this.isSessionReady) return;

    const message: InputAudioBufferCommit = {
      type: "input_audio_buffer.commit",
    };

    this.send(message);
    this.emit("input.ended");

    // Trigger response
    const responseMessage: ResponseCreate = {
      type: "response.create",
    };
    this.send(responseMessage);
  }

  sendText(text: string): void {
    if (!this.ws || !this.isSessionReady) return;

    // Add text message to conversation
    const itemMessage: ConversationItemCreate = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text,
          },
        ],
      },
    };

    this.send(itemMessage);
    this.emit("input.transcript", text, true);

    // Trigger response
    const responseMessage: ResponseCreate = {
      type: "response.create",
    };
    this.send(responseMessage);
  }

  interrupt(): void {
    if (!this.ws || !this.isSessionReady) return;

    // Cancel current response
    const message: ResponseCancel = {
      type: "response.cancel",
    };

    this.send(message);

    // Clear input buffer
    const clearMessage: InputAudioBufferClear = {
      type: "input_audio_buffer.clear",
    };
    this.send(clearMessage);

    this.updateStatus("interrupted");
    this.session!.stats.interruptions++;
    this.emit("response.interrupted");
  }

  updateConfig(config: Partial<VoiceProviderConfig>): void {
    this.config = { ...this.config, ...config };

    // If connected, send session update
    if (this.ws && this.isSessionReady) {
      this.sendSessionUpdate();
    }
  }

  sendToolResult(callId: string, result: unknown): void {
    if (!this.ws || !this.isSessionReady) return;

    const message: OpenAIMessage = {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result),
      },
    };

    this.send(message);

    const call = this.pendingToolCalls.get(callId);
    if (call) {
      this.emit("tool.result", call.name, result);
      this.pendingToolCalls.delete(callId);
    }

    // Trigger response after tool result
    const responseMessage: ResponseCreate = {
      type: "response.create",
    };
    this.send(responseMessage);
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.isSessionReady = false;

    if (this.session) {
      this.session.status = "closed";
      this.session.durationMs = this.getDuration();
    }
  }

  private send(message: OpenAIMessage): void {
    if (!this.ws) {
      throw new Error("Not connected");
    }

    this.ws.send(JSON.stringify(message));
  }
}

// WebSocket options type for Node.js compatibility
interface WebSocketOptions {
  headers?: Record<string, string>;
}

// ============================================
// Factory Function
// ============================================

/**
 * Create an OpenAI Realtime provider instance
 */
export function createOpenAIProvider(config: Partial<VoiceProviderConfig> = {}): OpenAIRealtimeProvider {
  const apiKey = config.apiKey ??
    process.env.OPENAI_API_KEY ??
    process.env.MOLTBOT_OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OpenAI API key not found. Set OPENAI_API_KEY.");
  }

  return new OpenAIRealtimeProvider({ ...config, apiKey });
}

/**
 * Check if OpenAI Realtime API is available
 */
export function isOpenAIAvailable(): boolean {
  return !!(
    process.env.OPENAI_API_KEY ||
    process.env.MOLTBOT_OPENAI_API_KEY
  );
}
