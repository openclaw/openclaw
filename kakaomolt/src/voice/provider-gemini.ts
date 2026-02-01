/**
 * Gemini Live API Provider
 *
 * Real-time voice conversation using Google's Gemini Live API.
 * Native voice-to-voice without separate STT/TTS processing.
 *
 * Key features:
 * - Native audio dialog (gemini-2.5-flash-preview-native-audio-dialog)
 * - Input: 16kHz PCM 16-bit mono
 * - Output: 24kHz PCM 16-bit mono
 * - Server-side VAD
 * - Barge-in (interruption) support
 * - Tool/function calling
 *
 * @see https://ai.google.dev/gemini-api/docs/live
 */

import {
  VoiceProvider,
  type VoiceProviderConfig,
  type VoiceSession,
  type VoiceTool,
  type VoiceProviderType,
  type AudioConfig,
  GEMINI_AUDIO_CONFIG,
  DEFAULT_PROVIDER_CONFIG,
} from "./provider-interface.js";

// ============================================
// Gemini Live API Types
// ============================================

interface GeminiMessage {
  setup?: GeminiSetup;
  clientContent?: GeminiClientContent;
  realtimeInput?: GeminiRealtimeInput;
  toolResponse?: GeminiToolResponse;
}

interface GeminiSetup {
  model: string;
  generationConfig?: {
    responseModalities?: string[];
    speechConfig?: {
      voiceConfig?: {
        prebuiltVoiceConfig?: {
          voiceName: string;
        };
      };
    };
  };
  systemInstruction?: {
    parts: Array<{ text: string }>;
  };
  tools?: Array<{
    functionDeclarations: Array<{
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }>;
  }>;
}

interface GeminiClientContent {
  turns?: Array<{
    role: string;
    parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>;
  }>;
  turnComplete: boolean;
}

interface GeminiRealtimeInput {
  mediaChunks: Array<{
    mimeType: string;
    data: string;
  }>;
}

interface GeminiToolResponse {
  functionResponses: Array<{
    response: unknown;
    id: string;
  }>;
}

interface GeminiServerMessage {
  setupComplete?: Record<string, never>;
  serverContent?: {
    modelTurn?: {
      parts: Array<{
        text?: string;
        inlineData?: {
          mimeType: string;
          data: string;
        };
        functionCall?: {
          name: string;
          args: Record<string, unknown>;
          id: string;
        };
      }>;
    };
    turnComplete?: boolean;
    interrupted?: boolean;
  };
  toolCall?: {
    functionCalls: Array<{
      name: string;
      args: Record<string, unknown>;
      id: string;
    }>;
  };
  toolCallCancellation?: {
    ids: string[];
  };
}

// ============================================
// Gemini Provider Implementation
// ============================================

const GEMINI_LIVE_ENDPOINT = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent";

export class GeminiLiveProvider extends VoiceProvider {
  private ws: WebSocket | null = null;
  private pendingToolCalls: Map<string, { name: string; args: unknown }> = new Map();
  private responseStartTime: number = 0;
  private isSetupComplete = false;

  constructor(config: Partial<VoiceProviderConfig> & { apiKey: string }) {
    super({
      provider: "gemini",
      ...DEFAULT_PROVIDER_CONFIG.gemini,
      ...config,
    });
  }

  getType(): VoiceProviderType {
    return "gemini";
  }

  getAudioConfig(): { input: AudioConfig; output: AudioConfig } {
    return GEMINI_AUDIO_CONFIG;
  }

  async connect(userId: string): Promise<VoiceSession> {
    if (this.ws) {
      throw new Error("Already connected. Call disconnect() first.");
    }

    this.session = this.createSession(userId);
    this.emit("session.created", this.session);

    try {
      await this.initializeWebSocket();

      // Wait for setup complete
      await this.waitForSetup();

      this.updateStatus("connected");
      this.emit("session.connected", this.session);

      return this.session;
    } catch (err) {
      this.updateStatus("error");
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("session.error", error, this.session!);
      throw err;
    }
  }

  private async initializeWebSocket(): Promise<void> {
    const url = `${GEMINI_LIVE_ENDPOINT}?key=${this.config.apiKey}`;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.sendSetup();
        resolve();
      };

      this.ws.onerror = (event) => {
        const error = new Error(`Gemini WebSocket error: ${event}`);
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

  private sendSetup(): void {
    const setup: GeminiSetup = {
      model: `models/${this.config.model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: this.config.voice ?? "Kore",
            },
          },
        },
      },
    };

    // Add system instruction
    if (this.config.instructions) {
      setup.systemInstruction = {
        parts: [{ text: this.config.instructions }],
      };
    }

    // Add tools if registered
    if (this.tools.length > 0) {
      setup.tools = [
        {
          functionDeclarations: this.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        },
      ];
    }

    this.send({ setup });
  }

  private async waitForSetup(timeoutMs = 10000): Promise<void> {
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const checkSetup = () => {
        if (this.isSetupComplete) {
          resolve();
          return;
        }

        if (Date.now() - startTime > timeoutMs) {
          reject(new Error("Setup timeout"));
          return;
        }

        setTimeout(checkSetup, 100);
      };

      checkSetup();
    });
  }

  private handleMessage(data: unknown): void {
    try {
      const message = JSON.parse(String(data)) as GeminiServerMessage;

      // Setup complete
      if (message.setupComplete) {
        this.isSetupComplete = true;
        console.log("[gemini] Setup complete");
        return;
      }

      // Server content (response)
      if (message.serverContent) {
        this.handleServerContent(message.serverContent);
        return;
      }

      // Tool call
      if (message.toolCall) {
        for (const call of message.toolCall.functionCalls) {
          this.pendingToolCalls.set(call.id, { name: call.name, args: call.args });
          this.emit("tool.call", call.name, call.args);
        }
        return;
      }

      // Tool call cancellation
      if (message.toolCallCancellation) {
        for (const id of message.toolCallCancellation.ids) {
          this.pendingToolCalls.delete(id);
        }
        return;
      }
    } catch (err) {
      console.error("[gemini] Error handling message:", err);
    }
  }

  private handleServerContent(content: NonNullable<GeminiServerMessage["serverContent"]>): void {
    // Handle interruption
    if (content.interrupted) {
      this.updateStatus("interrupted");
      this.session!.stats.interruptions++;
      this.emit("response.interrupted");
      return;
    }

    // Handle model turn
    if (content.modelTurn?.parts) {
      for (const part of content.modelTurn.parts) {
        // Audio response
        if (part.inlineData?.mimeType.startsWith("audio/")) {
          if (this.session?.status !== "speaking") {
            this.responseStartTime = Date.now();
            this.updateStatus("speaking");
            this.emit("response.started");
          }

          const audioData = Buffer.from(part.inlineData.data, "base64");
          this.session!.stats.outputAudioBytes += audioData.length;
          this.emit("response.audio", audioData);
        }

        // Text response (transcript)
        if (part.text) {
          this.emit("response.text", part.text, false);
        }

        // Function call
        if (part.functionCall) {
          this.pendingToolCalls.set(part.functionCall.id, {
            name: part.functionCall.name,
            args: part.functionCall.args,
          });
          this.emit("tool.call", part.functionCall.name, part.functionCall.args);
        }
      }
    }

    // Turn complete
    if (content.turnComplete) {
      if (this.responseStartTime > 0) {
        const latency = Date.now() - this.responseStartTime;
        this.session!.stats.latencyMs.push(latency);
        this.responseStartTime = 0;
      }

      this.session!.turnCount++;
      this.updateStatus("connected");
      this.emit("response.ended");
    }
  }

  private handleClose(reason: string): void {
    this.ws = null;
    this.isSetupComplete = false;

    if (this.session) {
      this.session.status = "closed";
      this.session.durationMs = this.getDuration();
    }

    this.emit("session.closed", reason, this.session!);
  }

  sendAudio(chunk: Buffer): void {
    if (!this.ws || !this.isSetupComplete) {
      return;
    }

    // Update stats
    if (this.session) {
      this.session.stats.inputAudioBytes += chunk.length;
      this.session.lastActivity = new Date();
    }

    // Update status
    if (this.session?.status === "connected") {
      this.updateStatus("listening");
      this.emit("input.started");
    }

    // Send as realtime input
    const message: GeminiMessage = {
      realtimeInput: {
        mediaChunks: [
          {
            mimeType: "audio/pcm;rate=16000",
            data: chunk.toString("base64"),
          },
        ],
      },
    };

    this.send(message);
    this.emit("input.audio", chunk);
  }

  commitAudio(): void {
    // Gemini uses VAD, so committing is done by sending end_of_turn
    if (!this.ws || !this.isSetupComplete) return;

    const message: GeminiMessage = {
      clientContent: {
        turnComplete: true,
      },
    };

    this.send(message);
    this.emit("input.ended");
  }

  sendText(text: string): void {
    if (!this.ws || !this.isSetupComplete) return;

    const message: GeminiMessage = {
      clientContent: {
        turns: [
          {
            role: "user",
            parts: [{ text }],
          },
        ],
        turnComplete: true,
      },
    };

    this.send(message);
    this.emit("input.transcript", text, true);
  }

  interrupt(): void {
    // Gemini handles interruption through the client sending new audio
    // while the model is speaking (barge-in)
    if (this.session?.status === "speaking") {
      this.updateStatus("interrupted");
      this.session.stats.interruptions++;
      this.emit("response.interrupted");
    }
  }

  updateConfig(config: Partial<VoiceProviderConfig>): void {
    this.config = { ...this.config, ...config };

    // If connected, need to reconnect to apply changes
    if (this.ws && this.isSetupComplete) {
      console.log("[gemini] Config updated. Reconnect to apply changes.");
    }
  }

  sendToolResult(callId: string, result: unknown): void {
    if (!this.ws || !this.isSetupComplete) return;

    const message: GeminiMessage = {
      toolResponse: {
        functionResponses: [
          {
            id: callId,
            response: result,
          },
        ],
      },
    };

    this.send(message);
    this.pendingToolCalls.delete(callId);

    const call = this.pendingToolCalls.get(callId);
    if (call) {
      this.emit("tool.result", call.name, result);
    }
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.isSetupComplete = false;

    if (this.session) {
      this.session.status = "closed";
      this.session.durationMs = this.getDuration();
    }
  }

  private send(message: GeminiMessage): void {
    if (!this.ws) {
      throw new Error("Not connected");
    }

    this.ws.send(JSON.stringify(message));
  }
}

// ============================================
// Factory Function
// ============================================

/**
 * Create a Gemini Live provider instance
 */
export function createGeminiProvider(config: Partial<VoiceProviderConfig> = {}): GeminiLiveProvider {
  const apiKey = config.apiKey ??
    process.env.GOOGLE_API_KEY ??
    process.env.GEMINI_API_KEY ??
    process.env.MOLTBOT_GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("Gemini API key not found. Set GOOGLE_API_KEY or GEMINI_API_KEY.");
  }

  return new GeminiLiveProvider({ ...config, apiKey });
}

/**
 * Check if Gemini Live API is available
 */
export function isGeminiAvailable(): boolean {
  return !!(
    process.env.GOOGLE_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.MOLTBOT_GEMINI_API_KEY
  );
}
