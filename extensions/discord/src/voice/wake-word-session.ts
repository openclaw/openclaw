/**
 * Per-user wake word session — manages the state machine, rolling lookback
 * buffer, utterance capture, and silence detection.
 *
 * State machine:
 *
 *   LISTENING_FOR_WAKE  →  CAPTURING_UTTERANCE  →  PROCESSING
 *        ↑                                            │
 *        └────────────────────────────────────────────┘
 *
 * User routing is handled entirely Node-side. The sidecar is a stateless
 * audio pipe that does not know which Discord user is speaking.
 */

import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { computeRmsEnergy } from "./audio-utils.js";
import { downsample48kStereoTo16kMono } from "./audio-resampler.js";
import type { WakeWordSidecar } from "./wake-word-sidecar.js";
import type { WakeWordState, SidecarDetectionEvent } from "./wake-word-types.js";
import { WAKE_WORD_DEFAULTS } from "./wake-word-types.js";

const logger = createSubsystemLogger("discord/voice/wake-session");

const SAMPLE_RATE_48K = 48_000;
const CHANNELS_STEREO = 2;
const BYTES_PER_SAMPLE_STEREO = 4; // 2 bytes × 2 channels

export type WakeWordSessionConfig = {
  /** Rolling lookback buffer duration in seconds (default: 1.5). */
  lookbackSeconds?: number;
  /** Silence gap in ms that ends utterance capture (default: 1000). */
  silenceDurationMs?: number;
  /** Minimum RMS energy for speech detection (default: 300). */
  minRmsEnergy?: number;
  /** Hard capture timeout in seconds (default: 30). */
  captureTimeoutSeconds?: number;
  /** Minimum post-strip command length to send (default: 2). */
  minCommandLength?: number;
  /** Trigger phrases (for stripping from transcript). */
  triggers?: string[];
};

export type WakeWordSessionCallbacks = {
  /** Called when a complete utterance is ready for STT. Receives the 48kHz stereo PCM buffer. */
  onUtterance: (pcm: Buffer) => void;
  /** Called when the wake word is detected (for barge-in, chimes, etc.). */
  onWakeDetected?: () => void;
};

export class WakeWordSession {
  private state: WakeWordState = "listening";
  private readonly sidecar: WakeWordSidecar;
  private readonly callbacks: WakeWordSessionCallbacks;

  // Lookback buffer — circular buffer of recent 48kHz stereo PCM.
  private readonly lookbackBuffer: Buffer;
  private readonly lookbackCapacity: number;
  private lookbackWritePos = 0;
  private lookbackFilled = 0;

  // Capture buffer — accumulates 48kHz stereo PCM after wake word detection.
  private captureChunks: Buffer[] = [];
  private captureTotalBytes = 0;

  // Silence detection state.
  private consecutiveSilentChunks = 0;
  private captureStartedAt = 0;
  private captureTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  /** Wall-clock timer that fires when silence exceeds the threshold. */
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSpeechAt = 0;

  // Config.
  private readonly silenceDurationMs: number;
  private readonly minRmsEnergy: number;
  private readonly captureTimeoutSeconds: number;
  private readonly minCommandLength: number;
  private readonly triggers: string[];

  constructor(params: {
    sidecar: WakeWordSidecar;
    config?: WakeWordSessionConfig;
    callbacks: WakeWordSessionCallbacks;
  }) {
    this.sidecar = params.sidecar;
    this.callbacks = params.callbacks;

    const cfg = params.config ?? {};
    const lookbackSec = cfg.lookbackSeconds ?? WAKE_WORD_DEFAULTS.lookbackSeconds;
    this.lookbackCapacity = Math.ceil(
      lookbackSec * SAMPLE_RATE_48K * CHANNELS_STEREO * 2, // 2 bytes per sample
    );
    this.lookbackBuffer = Buffer.alloc(this.lookbackCapacity);

    this.silenceDurationMs = cfg.silenceDurationMs ?? 1_000;
    this.minRmsEnergy = cfg.minRmsEnergy ?? 300;
    this.captureTimeoutSeconds = cfg.captureTimeoutSeconds ?? WAKE_WORD_DEFAULTS.captureTimeoutSeconds;
    this.minCommandLength = cfg.minCommandLength ?? WAKE_WORD_DEFAULTS.minCommandLength;
    this.triggers = cfg.triggers ?? [];
  }

  /**
   * Feed a chunk of decoded 48kHz stereo PCM from Discord into the session.
   * This drives the state machine — audio is routed to the sidecar and/or
   * capture buffer depending on the current state.
   */
  feedAudio(pcm48kStereo: Buffer): void {
    if (pcm48kStereo.length === 0) {
      return;
    }

    switch (this.state) {
      case "listening":
        this.handleListeningAudio(pcm48kStereo);
        break;
      case "capturing":
        this.handleCapturingAudio(pcm48kStereo);
        break;
      case "processing":
        // Discard audio while processing. The session returns to listening
        // once the manager finishes STT + agent invocation.
        break;
    }
  }

  /**
   * Notify the session that the wake word was detected by the sidecar.
   */
  handleDetection(_event: SidecarDetectionEvent): void {
    if (this.state !== "listening") {
      return;
    }

    if (shouldLogVerbose()) {
      logVerbose("discord voice wake: detection fired, transitioning to capturing");
    }

    this.state = "capturing";
    this.captureChunks = [];
    this.captureTotalBytes = 0;
    this.consecutiveSilentChunks = 0;
    this.captureStartedAt = Date.now();
    this.lastSpeechAt = Date.now();

    // Prepend the lookback buffer to capture so we don't lose audio
    // that arrived during detection latency.
    const lookback = this.drainLookbackBuffer();
    if (lookback.length > 0) {
      this.captureChunks.push(lookback);
      this.captureTotalBytes += lookback.length;
    }

    // Start the hard capture timeout.
    this.captureTimeoutTimer = setTimeout(() => {
      this.captureTimeoutTimer = null;
      if (this.state === "capturing") {
        logger.warn(
          `wake word capture hit ${this.captureTimeoutSeconds}s hard timeout, sending partial utterance`,
        );
        this.finishCapture();
      }
    }, this.captureTimeoutSeconds * 1_000);
    this.captureTimeoutTimer.unref();

    this.callbacks.onWakeDetected?.();
  }

  /**
   * Transition to processing state. Called by the manager after finishCapture
   * delivers the utterance. The session stays in "processing" until
   * returnToListening() is called.
   */
  transitionToProcessing(): void {
    this.state = "processing";
  }

  /**
   * Return the session to the listening state after processing completes.
   */
  returnToListening(): void {
    this.state = "listening";
    this.captureChunks = [];
    this.captureTotalBytes = 0;
    this.consecutiveSilentChunks = 0;
    this.clearCaptureTimeout();
    this.clearSilenceTimer();
  }

  /**
   * Get the current state of the session.
   */
  getState(): WakeWordState {
    return this.state;
  }

  /**
   * Clean up resources.
   */
  destroy(): void {
    this.clearCaptureTimeout();
    this.clearSilenceTimer();
    this.captureChunks = [];
  }

  /**
   * Strip wake word trigger phrases from the beginning of a transcript.
   *
   * Port of the matching logic from Swabble/Sources/SwabbleKit/WakeWordGate.swift.
   * For Discord we do text-only matching (no segment timing) since the STT
   * transcript doesn't include word-level timestamps in the basic pipeline.
   */
  stripWakeWord(transcript: string): string {
    const lower = transcript.toLowerCase().trim();
    let bestMatch = "";

    for (const trigger of this.triggers) {
      const triggerLower = trigger.toLowerCase().trim();
      if (lower.startsWith(triggerLower) && triggerLower.length > bestMatch.length) {
        bestMatch = triggerLower;
      }
    }

    if (!bestMatch) {
      return transcript.trim();
    }

    // Remove trigger + any trailing punctuation/whitespace.
    let rest = transcript.slice(bestMatch.length);
    rest = rest.replace(/^[\s,.:;!?]+/, "");
    return rest.trim();
  }

  /**
   * Check whether a post-strip transcript is long enough to send to the agent.
   */
  isCommandValid(stripped: string): boolean {
    return stripped.length >= this.minCommandLength;
  }

  // ---------------------------------------------------------------------------
  // Internal — listening state
  // ---------------------------------------------------------------------------

  private handleListeningAudio(pcm48kStereo: Buffer): void {
    // Push into the rolling lookback buffer.
    this.pushToLookback(pcm48kStereo);

    // Downsample and forward to the sidecar for wake word detection.
    const pcm16kMono = downsample48kStereoTo16kMono(pcm48kStereo);
    if (pcm16kMono.length > 0) {
      this.sidecar.sendAudio(pcm16kMono);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — capturing state
  // ---------------------------------------------------------------------------

  private handleCapturingAudio(pcm48kStereo: Buffer): void {
    // Accumulate full-fidelity audio for STT.
    this.captureChunks.push(pcm48kStereo);
    this.captureTotalBytes += pcm48kStereo.length;

    const rms = computeRmsEnergy(pcm48kStereo);

    if (rms >= this.minRmsEnergy) {
      // Speech detected — reset silence tracking.
      this.consecutiveSilentChunks = 0;
      this.lastSpeechAt = Date.now();
      this.clearSilenceTimer();
    } else {
      this.consecutiveSilentChunks++;

      // Start a wall-clock silence timer if one isn't already running.
      // This handles the case where Discord stops sending audio packets
      // during true silence — the timer fires even without new chunks.
      if (!this.silenceTimer) {
        this.silenceTimer = setTimeout(() => {
          this.silenceTimer = null;
          if (this.state === "capturing") {
            const silenceMs = Date.now() - this.lastSpeechAt;
            logger.info(
              `wake capture: silence timer fired (${silenceMs}ms since last speech), finishing capture`,
            );
            this.finishCapture();
          }
        }, this.silenceDurationMs);
        this.silenceTimer.unref();
      }
    }
  }

  private finishCapture(): void {
    this.clearCaptureTimeout();

    if (this.captureChunks.length === 0) {
      this.returnToListening();
      return;
    }

    const pcm = Buffer.concat(this.captureChunks);
    this.captureChunks = [];
    this.captureTotalBytes = 0;

    // Transition to processing — the manager will call returnToListening()
    // when STT + agent invocation completes.
    this.transitionToProcessing();
    this.callbacks.onUtterance(pcm);
  }

  // ---------------------------------------------------------------------------
  // Internal — lookback buffer (circular)
  // ---------------------------------------------------------------------------

  private pushToLookback(pcm: Buffer): void {
    if (pcm.length >= this.lookbackCapacity) {
      // Chunk is larger than the entire buffer — just keep the tail.
      pcm.copy(this.lookbackBuffer, 0, pcm.length - this.lookbackCapacity);
      this.lookbackWritePos = 0;
      this.lookbackFilled = this.lookbackCapacity;
      return;
    }

    const remaining = this.lookbackCapacity - this.lookbackWritePos;
    if (pcm.length <= remaining) {
      pcm.copy(this.lookbackBuffer, this.lookbackWritePos);
    } else {
      // Wrap around.
      pcm.copy(this.lookbackBuffer, this.lookbackWritePos, 0, remaining);
      pcm.copy(this.lookbackBuffer, 0, remaining);
    }
    this.lookbackWritePos = (this.lookbackWritePos + pcm.length) % this.lookbackCapacity;
    this.lookbackFilled = Math.min(this.lookbackFilled + pcm.length, this.lookbackCapacity);
  }

  private drainLookbackBuffer(): Buffer {
    if (this.lookbackFilled === 0) {
      return Buffer.alloc(0);
    }

    let result: Buffer;
    if (this.lookbackFilled < this.lookbackCapacity) {
      // Buffer hasn't wrapped yet — data starts at 0.
      result = Buffer.from(this.lookbackBuffer.subarray(0, this.lookbackFilled));
    } else {
      // Buffer is full and may have wrapped.
      const readStart = this.lookbackWritePos; // oldest data
      const firstPart = this.lookbackBuffer.subarray(readStart, this.lookbackCapacity);
      const secondPart = this.lookbackBuffer.subarray(0, readStart);
      result = Buffer.concat([firstPart, secondPart]);
    }

    // Reset the buffer.
    this.lookbackWritePos = 0;
    this.lookbackFilled = 0;

    return result;
  }

  // ---------------------------------------------------------------------------
  // Internal — cleanup
  // ---------------------------------------------------------------------------

  private clearCaptureTimeout(): void {
    if (this.captureTimeoutTimer) {
      clearTimeout(this.captureTimeoutTimer);
      this.captureTimeoutTimer = null;
    }
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }
}
