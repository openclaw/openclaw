/**
 * Shared types for the wake word detection subsystem.
 *
 * The wake word pipeline gates Discord voice STT behind a trigger phrase
 * ("hey calvin", "openclaw", etc.) using a three-state machine:
 *
 *   LISTENING_FOR_WAKE  →  CAPTURING_UTTERANCE  →  PROCESSING
 *        ↑                                            │
 *        └────────────────────────────────────────────┘
 */

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export type WakeWordState = "listening" | "capturing" | "processing";

// ---------------------------------------------------------------------------
// Sidecar protocol — binary framing on stdin, JSON lines on stdout
// ---------------------------------------------------------------------------

/**
 * Binary message types sent from Node to the Python sidecar on stdin.
 *
 * Wire format:  [type: 1 byte] [length: 4 bytes big-endian] [payload]
 *
 * - AUDIO (0x01): payload is raw 16 kHz, 16-bit, mono PCM bytes.
 * - CONFIGURE (0x02): payload is UTF-8 JSON (SidecarConfigurePayload).
 */
export const SIDECAR_MSG_AUDIO = 0x01;
export const SIDECAR_MSG_CONFIGURE = 0x02;

/** Header size for binary stdin frames: 1 (type) + 4 (length). */
export const SIDECAR_HEADER_SIZE = 5;

/** JSON payload for a CONFIGURE message. */
export type SidecarConfigurePayload = {
  triggers: string[];
  confidence?: number;
  /** Path to a custom openWakeWord model file (.onnx). */
  modelPath?: string;
};

/**
 * JSON-line messages emitted by the sidecar on stdout.
 */
export type SidecarDetectionEvent = {
  type: "detection";
  trigger: string;
  confidence: number;
  /** Unix timestamp (ms) when the detection occurred. */
  timestamp: number;
};

export type SidecarReadyEvent = {
  type: "ready";
};

export type SidecarErrorEvent = {
  type: "error";
  message: string;
};

export type SidecarEvent = SidecarDetectionEvent | SidecarReadyEvent | SidecarErrorEvent;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type WakeWordEngine = "openwakeword";

export type DiscordVoiceWakeWordConfig = {
  /** Enable wake word gating for voice capture (default: false). */
  enabled?: boolean;
  /** Wake word engine to use (default: "openwakeword"). */
  engine?: WakeWordEngine;
  /** Trigger phrases the engine listens for. Falls back to global voicewake triggers if unset. */
  triggers?: string[];
  /** Minimum detection confidence (0.0–1.0, default: 0.7). */
  confidence?: number;
  /** Path to the Python interpreter for the sidecar (default: "python3"). */
  pythonPath?: string;
  /** Path to a custom openWakeWord model file (.onnx). */
  modelPath?: string;
  /**
   * Rolling lookback buffer duration in seconds (default: 1.5).
   * Audio from this window is prepended to the capture buffer when the
   * wake word fires, compensating for detection latency.
   */
  lookbackSeconds?: number;
  /**
   * Hard timeout in seconds for utterance capture after wake word detection
   * (default: 30). When hit, the partial utterance is sent to STT with a
   * log warning.
   */
  captureTimeoutSeconds?: number;
  /**
   * Minimum post-strip transcript length to send to the agent (default: 2).
   * Transcripts shorter than this after wake word removal are discarded.
   */
  minCommandLength?: number;
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const WAKE_WORD_DEFAULTS = {
  engine: "openwakeword" as const,
  confidence: 0.7,
  pythonPath: "python3",
  lookbackSeconds: 1.5,
  captureTimeoutSeconds: 30,
  minCommandLength: 2,
} as const;
