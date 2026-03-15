/**
 * AIRI Bridge Protocol — WebSocket JSON messages between
 * OpenClaw gateway and AIRI avatar frontend.
 */

// ── Emotion & Animation ─────────────────────────────────────────────

export type AiriEmotion =
  | "neutral"
  | "happy"
  | "thinking"
  | "surprised"
  | "sad"
  | "speaking"
  | "listening";

export type AiriAction = "idle" | "wave" | "nod" | "shake" | "point" | "bow";

export type AiriAvatarState = "idle" | "listening" | "thinking" | "speaking";

// ── Messages: OpenClaw → AIRI ────────────────────────────────────────

export type AiriOutboundMessage =
  | AiriTextMessage
  | AiriSpeechChunk
  | AiriEmotionUpdate
  | AiriActionTrigger
  | AiriStatusUpdate
  | AiriConfigSync;

export type AiriTextMessage = {
  type: "airi:text";
  id: string;
  agentId: string;
  text: string;
  timestamp: string;
  /** Whether agent is still streaming (partial text) */
  streaming: boolean;
};

export type AiriSpeechChunk = {
  type: "airi:speech";
  id: string;
  /** base64-encoded audio data */
  audio: string;
  format: "mp3" | "opus" | "pcm";
  sampleRate: number;
  /** true if this is the last chunk */
  final: boolean;
};

export type AiriEmotionUpdate = {
  type: "airi:emotion";
  emotion: AiriEmotion;
  intensity: number;
};

export type AiriActionTrigger = {
  type: "airi:action";
  action: AiriAction;
};

export type AiriStatusUpdate = {
  type: "airi:status";
  avatarState: AiriAvatarState;
  agentId?: string;
  connected: boolean;
};

export type AiriConfigSync = {
  type: "airi:config";
  avatar: {
    type: "vrm" | "live2d";
    modelUrl?: string;
  };
  agentName?: string;
  agentAvatar?: string;
};

// ── Messages: AIRI → OpenClaw ────────────────────────────────────────

export type AiriInboundMessage =
  | AiriUserText
  | AiriUserSpeech
  | AiriUserAction;

export type AiriUserText = {
  type: "airi:user:text";
  text: string;
  timestamp: string;
};

export type AiriUserSpeech = {
  type: "airi:user:speech";
  /** base64-encoded audio */
  audio: string;
  format: "pcm" | "opus" | "webm";
  sampleRate: number;
};

export type AiriUserAction = {
  type: "airi:user:action";
  action: "start_listening" | "stop_listening" | "interrupt";
};

// ── Helpers ──────────────────────────────────────────────────────────

export function isAiriInboundMessage(msg: unknown): msg is AiriInboundMessage {
  if (!msg || typeof msg !== "object") return false;
  const typed = msg as { type?: string };
  return typeof typed.type === "string" && typed.type.startsWith("airi:user:");
}

export function isAiriOutboundMessage(msg: unknown): msg is AiriOutboundMessage {
  if (!msg || typeof msg !== "object") return false;
  const typed = msg as { type?: string };
  return (
    typeof typed.type === "string" &&
    typed.type.startsWith("airi:") &&
    !typed.type.startsWith("airi:user:")
  );
}
