/**
 * Per-speaker streaming STT pipeline for Teams live voice.
 *
 * Manages one streaming recognizer per active speaker (up to 4 concurrent
 * per Microsoft's unmixed audio spec). Supports:
 *
 * - Partial hypothesis callbacks (for early understanding / UI display)
 * - Final transcript callbacks (for agent pipeline)
 * - Own-voice suppression (skip bot's own speaker ID)
 * - Configurable providers: OpenAI Realtime, Deepgram, Whisper file-based
 *
 * For the initial implementation, this uses file-based Whisper transcription
 * as the "streaming" path (segment-at-a-time). True streaming (partial
 * hypotheses, low-latency) will be added when the OpenAI Realtime or
 * Deepgram provider integration is built.
 */

import { OwnVoiceFilter } from "./own-voice-filter.js";
import type { UnmixedAudioSegment } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PartialTranscriptCallback = (
  text: string,
  speakerId: number,
  aadUserId: string,
) => void;

export type FinalTranscriptCallback = (
  text: string,
  speakerId: number,
  aadUserId: string,
  displayName: string | undefined,
) => void;

export type StreamingSTTConfig = {
  provider: string;
  silenceDurationMs: number;
  minSegmentSeconds: number;
};

// ---------------------------------------------------------------------------
// StreamingSTTSession — one per active speaker
// ---------------------------------------------------------------------------

export class StreamingSTTSession {
  readonly speakerId: number;
  readonly aadUserId: string;
  readonly displayName: string | undefined;

  private partialCallbacks: PartialTranscriptCallback[] = [];
  private finalCallbacks: FinalTranscriptCallback[] = [];
  private destroyed = false;

  constructor(speakerId: number, aadUserId: string, displayName: string | undefined) {
    this.speakerId = speakerId;
    this.aadUserId = aadUserId;
    this.displayName = displayName;
  }

  /** Register a callback for partial transcript hypotheses. */
  onPartialTranscript(cb: PartialTranscriptCallback): void {
    this.partialCallbacks.push(cb);
  }

  /** Register a callback for final (silence-terminated) transcripts. */
  onFinalTranscript(cb: FinalTranscriptCallback): void {
    this.finalCallbacks.push(cb);
  }

  /**
   * Emit a final transcript (called by the audio pipeline after
   * Whisper transcription of a completed segment).
   */
  emitFinalTranscript(text: string): void {
    if (this.destroyed) return;
    for (const cb of this.finalCallbacks) {
      cb(text, this.speakerId, this.aadUserId, this.displayName);
    }
  }

  /** Emit a partial transcript hypothesis. */
  emitPartialTranscript(text: string): void {
    if (this.destroyed) return;
    for (const cb of this.partialCallbacks) {
      cb(text, this.speakerId, this.aadUserId);
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.partialCallbacks = [];
    this.finalCallbacks = [];
  }
}

// ---------------------------------------------------------------------------
// StreamingSTTManager — manages all per-speaker sessions for a call
// ---------------------------------------------------------------------------

export class StreamingSTTManager {
  private sessions = new Map<number, StreamingSTTSession>();
  private ownVoiceFilter = new OwnVoiceFilter();
  private config: StreamingSTTConfig;

  constructor(config: StreamingSTTConfig) {
    this.config = config;
  }

  /** Register the bot's own speaker ID for own-voice suppression. */
  registerBotSpeakerId(speakerId: number): void {
    this.ownVoiceFilter.registerBotSpeakerId(speakerId);
  }

  /**
   * Get or create a per-speaker STT session.
   * Returns undefined if the speaker is the bot's own voice.
   */
  getOrCreateSession(segment: UnmixedAudioSegment): StreamingSTTSession | undefined {
    // Own-voice suppression
    if (this.ownVoiceFilter.shouldSuppress(segment.speakerId)) {
      return undefined;
    }

    let session = this.sessions.get(segment.speakerId);
    if (!session) {
      session = new StreamingSTTSession(segment.speakerId, segment.aadUserId, segment.displayName);
      this.sessions.set(segment.speakerId, session);
    }
    return session;
  }

  /** Remove a speaker's session (e.g. when they leave the call). */
  async removeSession(speakerId: number): Promise<void> {
    const session = this.sessions.get(speakerId);
    if (session) {
      await session.destroy();
      this.sessions.delete(speakerId);
    }
  }

  /** Destroy all sessions (call cleanup). */
  async destroyAll(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.destroy();
    }
    this.sessions.clear();
    this.ownVoiceFilter.clear();
  }

  /** Get the count of active speaker sessions. */
  get activeSessionCount(): number {
    return this.sessions.size;
  }
}
