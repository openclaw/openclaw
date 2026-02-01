/**
 * Unified Voice Provider Interface
 *
 * Common interface for real-time voice providers:
 * - OpenAI Realtime API
 * - Google Gemini Live API
 *
 * Both support native voice-to-voice with low latency.
 */

import { EventEmitter } from "node:events";

// ============================================
// Provider Types
// ============================================

export type VoiceProviderType = "openai" | "gemini";

export interface VoiceProviderConfig {
  provider: VoiceProviderType;
  apiKey: string;
  /** Model to use */
  model?: string;
  /** Voice for TTS output */
  voice?: string;
  /** System instructions */
  instructions?: string;
  /** Language code (e.g., 'ko', 'en') */
  language?: string;
  /** Enable voice activity detection */
  enableVAD?: boolean;
  /** VAD sensitivity threshold (0.0 - 1.0) */
  vadThreshold?: number;
  /** Silence duration to end turn (ms) */
  silenceDurationMs?: number;
  /** Maximum session duration (ms) */
  maxDurationMs?: number;
  /** Custom endpoint URL (for proxies) */
  endpoint?: string;
}

// ============================================
// Audio Configuration
// ============================================

export interface AudioConfig {
  /** Sample rate in Hz */
  sampleRate: number;
  /** Bits per sample */
  bitsPerSample: 16 | 32;
  /** Number of channels */
  channels: 1 | 2;
  /** Audio codec */
  codec: "pcm" | "opus" | "g711_ulaw" | "g711_alaw";
}

/** OpenAI Realtime API audio config */
export const OPENAI_AUDIO_CONFIG: { input: AudioConfig; output: AudioConfig } = {
  input: { sampleRate: 24000, bitsPerSample: 16, channels: 1, codec: "pcm" },
  output: { sampleRate: 24000, bitsPerSample: 16, channels: 1, codec: "pcm" },
};

/** Gemini Live API audio config */
export const GEMINI_AUDIO_CONFIG: { input: AudioConfig; output: AudioConfig } = {
  input: { sampleRate: 16000, bitsPerSample: 16, channels: 1, codec: "pcm" },
  output: { sampleRate: 24000, bitsPerSample: 16, channels: 1, codec: "pcm" },
};

// ============================================
// Session & Events
// ============================================

export type SessionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "listening"
  | "thinking"
  | "speaking"
  | "interrupted"
  | "error"
  | "closed";

export interface VoiceSession {
  id: string;
  provider: VoiceProviderType;
  userId: string;
  status: SessionStatus;
  createdAt: Date;
  lastActivity: Date;
  turnCount: number;
  durationMs: number;
  stats: SessionStats;
}

export interface SessionStats {
  inputAudioBytes: number;
  outputAudioBytes: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number[];
  interruptions: number;
}

export interface VoiceProviderEvents {
  // Session lifecycle
  "session.created": (session: VoiceSession) => void;
  "session.connected": (session: VoiceSession) => void;
  "session.error": (error: Error, session: VoiceSession) => void;
  "session.closed": (reason: string, session: VoiceSession) => void;

  // User input
  "input.started": () => void;
  "input.audio": (chunk: Buffer) => void;
  "input.ended": () => void;
  "input.transcript": (text: string, isFinal: boolean) => void;

  // AI response
  "response.started": () => void;
  "response.audio": (chunk: Buffer) => void;
  "response.text": (text: string, isFinal: boolean) => void;
  "response.ended": () => void;
  "response.interrupted": () => void;

  // Tool/Function calls
  "tool.call": (name: string, args: unknown) => void;
  "tool.result": (name: string, result: unknown) => void;

  // Audio level (for visualizations)
  "audio.level": (level: number, direction: "input" | "output") => void;
}

// ============================================
// Tool Definition
// ============================================

export interface VoiceTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// ============================================
// Abstract Provider Class
// ============================================

/**
 * Abstract base class for voice providers
 */
export abstract class VoiceProvider extends EventEmitter {
  protected config: VoiceProviderConfig;
  protected session: VoiceSession | null = null;
  protected tools: VoiceTool[] = [];

  constructor(config: VoiceProviderConfig) {
    super();
    this.config = config;
  }

  /**
   * Get provider type
   */
  abstract getType(): VoiceProviderType;

  /**
   * Get audio configuration for this provider
   */
  abstract getAudioConfig(): { input: AudioConfig; output: AudioConfig };

  /**
   * Connect and start a new session
   */
  abstract connect(userId: string): Promise<VoiceSession>;

  /**
   * Disconnect and end session
   */
  abstract disconnect(): Promise<void>;

  /**
   * Send audio chunk to the provider
   */
  abstract sendAudio(chunk: Buffer): void;

  /**
   * Commit the audio buffer (trigger response)
   */
  abstract commitAudio(): void;

  /**
   * Send a text message (instead of audio)
   */
  abstract sendText(text: string): void;

  /**
   * Interrupt current response
   */
  abstract interrupt(): void;

  /**
   * Update session configuration
   */
  abstract updateConfig(config: Partial<VoiceProviderConfig>): void;

  /**
   * Register tools for function calling
   */
  registerTools(tools: VoiceTool[]): void {
    this.tools = tools;
  }

  /**
   * Send tool result back to the model
   */
  abstract sendToolResult(callId: string, result: unknown): void;

  /**
   * Get current session
   */
  getSession(): VoiceSession | null {
    return this.session;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.session?.status === "connected" ||
           this.session?.status === "listening" ||
           this.session?.status === "speaking";
  }

  /**
   * Get session duration in milliseconds
   */
  getDuration(): number {
    if (!this.session) return 0;
    return Date.now() - this.session.createdAt.getTime();
  }

  /**
   * Get average latency
   */
  getAverageLatency(): number {
    const latencies = this.session?.stats.latencyMs ?? [];
    if (latencies.length === 0) return 0;
    return latencies.reduce((a, b) => a + b, 0) / latencies.length;
  }

  /**
   * Create a new session object
   */
  protected createSession(userId: string): VoiceSession {
    return {
      id: `${this.getType()}-${userId}-${Date.now()}`,
      provider: this.getType(),
      userId,
      status: "connecting",
      createdAt: new Date(),
      lastActivity: new Date(),
      turnCount: 0,
      durationMs: 0,
      stats: {
        inputAudioBytes: 0,
        outputAudioBytes: 0,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: [],
        interruptions: 0,
      },
    };
  }

  /**
   * Update session status
   */
  protected updateStatus(status: SessionStatus): void {
    if (this.session) {
      this.session.status = status;
      this.session.lastActivity = new Date();
      this.session.durationMs = this.getDuration();
    }
  }
}

// ============================================
// Factory & Utilities
// ============================================

/**
 * Default configurations for each provider
 */
export const DEFAULT_PROVIDER_CONFIG: Record<VoiceProviderType, Partial<VoiceProviderConfig>> = {
  openai: {
    model: "gpt-4o-realtime-preview-2024-12-17",
    voice: "nova",
    enableVAD: true,
    vadThreshold: 0.5,
    silenceDurationMs: 500,
    maxDurationMs: 600000, // 10 minutes
  },
  gemini: {
    model: "gemini-2.5-flash-preview-native-audio-dialog",
    voice: "Puck", // Gemini voice options: Puck, Charon, Kore, Fenrir, Aoede
    enableVAD: true,
    vadThreshold: 0.5,
    silenceDurationMs: 500,
    maxDurationMs: 600000,
  },
};

/**
 * Korean-optimized voice settings
 */
export const KOREAN_VOICE_SETTINGS: Record<VoiceProviderType, Partial<VoiceProviderConfig>> = {
  openai: {
    voice: "nova", // Good Korean support
    instructions: `당신은 친절한 AI 비서입니다. 한국어로 자연스럽게 대화하세요.
간결하고 명확하게 대답하되, 너무 딱딱하지 않게 친근한 톤을 유지하세요.`,
    language: "ko",
  },
  gemini: {
    voice: "Kore", // Gemini's Korean-friendly voice
    instructions: `당신은 친절한 AI 비서입니다. 한국어로 자연스럽게 대화하세요.
간결하고 명확하게 대답하되, 너무 딱딱하지 않게 친근한 톤을 유지하세요.`,
    language: "ko",
  },
};

/**
 * Get provider-specific audio configuration
 */
export function getAudioConfig(provider: VoiceProviderType): { input: AudioConfig; output: AudioConfig } {
  switch (provider) {
    case "openai":
      return OPENAI_AUDIO_CONFIG;
    case "gemini":
      return GEMINI_AUDIO_CONFIG;
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

/**
 * Check if provider is available (API key configured)
 */
export function isProviderAvailable(provider: VoiceProviderType): boolean {
  switch (provider) {
    case "openai":
      return !!(process.env.OPENAI_API_KEY || process.env.MOLTBOT_OPENAI_API_KEY);
    case "gemini":
      return !!(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || process.env.MOLTBOT_GEMINI_API_KEY);
    default:
      return false;
  }
}

/**
 * Get available providers
 */
export function getAvailableProviders(): VoiceProviderType[] {
  const providers: VoiceProviderType[] = [];
  if (isProviderAvailable("openai")) providers.push("openai");
  if (isProviderAvailable("gemini")) providers.push("gemini");
  return providers;
}

/**
 * Format provider comparison for display
 */
export function formatProviderComparison(): string {
  return `🎙️ **실시간 음성 대화 제공자**

| 항목 | OpenAI Realtime | Gemini Live |
|------|-----------------|-------------|
| 모델 | gpt-4o-realtime | gemini-2.5-flash |
| 입력 | PCM 24kHz | PCM 16kHz |
| 출력 | PCM 24kHz | PCM 24kHz |
| 지연 | ~300ms | ~200ms |
| 한국어 | ✅ (nova) | ✅ (Kore) |
| 인터럽트 | ✅ | ✅ |
| 도구 호출 | ✅ | ✅ |
| 특징 | 안정성 우수 | 네이티브 오디오 |

**선택 기준:**
• 안정성 중요 → OpenAI
• 최저 지연 필요 → Gemini
• 비용 절감 → Gemini (더 저렴)`;
}
