/**
 * Types for MS Teams voice/call support.
 *
 * Mirrors the session and result patterns from Discord voice
 * (extensions/discord/src/voice/manager.ts) but adapted for the
 * Teams media-worker architecture where .NET owns the call lifecycle
 * and TS acts as the AI/orchestration plane.
 */

import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";

// ---------------------------------------------------------------------------
// Compliance
// ---------------------------------------------------------------------------

/**
 * Compliance state for a call session.
 *
 * Microsoft requires calling `updateRecordingStatus` before any media data
 * can be persisted or derived (e.g. transcription). No audio leaves the
 * .NET media worker until compliance reaches "active".
 */
export type ComplianceState = "awaiting" | "active" | "denied";

// ---------------------------------------------------------------------------
// Capability tiers
// ---------------------------------------------------------------------------

/**
 * The negotiated capability tier for the msteams voice subsystem.
 *
 * - `live_voice`      — Worker reachable + permissions + compliance OK.
 * - `transcript_mode` — No worker, but Graph transcript permissions available.
 * - `text_only`       — Neither worker nor transcript permissions.
 */
export type TeamsVoiceCapabilityTier = "live_voice" | "transcript_mode" | "text_only";

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

export type TeamsParticipant = {
  /** Azure AD object ID of the user. */
  aadUserId: string;
  /** Display name (may be undefined for phone-dial-in). */
  displayName?: string;
  /** Whether the participant is currently muted. */
  isMuted: boolean;
  /** Whether the participant is in the meeting lobby. */
  isInLobby: boolean;
};

// ---------------------------------------------------------------------------
// Call sessions
// ---------------------------------------------------------------------------

export type TeamsCallState =
  | "joining"
  | "awaiting_compliance"
  | "established"
  | "hold"
  | "terminating"
  | "terminated";

export type TeamsCallSession = {
  /** Internal UUID assigned by the TS manager. */
  callId: string;
  /** Graph API call resource ID returned by the .NET worker after join. */
  graphCallId: string;
  /** Teams meeting join URL (if joined via URL). */
  joinUrl?: string;
  /** Session lifecycle state. */
  state: TeamsCallState;
  /** Recording compliance state — hard gate for audio processing. */
  complianceState: ComplianceState;
  /** Current call participants keyed by AAD user ID. */
  participants: Map<string, TeamsParticipant>;
  /**
   * Active speaker mapping.
   * Key = ActiveSpeakerId from unmixed audio buffers (uint32).
   * Value = AAD user ID.
   */
  activeSpeakers: Map<number, string>;
  /** Resolved agent route for this session (channel: "msteams"). */
  route: ResolvedAgentRoute;
  /** Serialized playback queue — ensures ordered TTS output. */
  playbackQueue: Promise<void>;
  /** Timestamp when the join was initiated. */
  createdAt: number;
  /** Timestamp when the call reached "established" state. */
  establishedAt?: number;
  /** gRPC address of the .NET media worker that owns this call. */
  workerAddress: string;
};

// ---------------------------------------------------------------------------
// Operation results
// ---------------------------------------------------------------------------

export type VoiceOperationResult = {
  ok: boolean;
  message: string;
  callId?: string;
};

// ---------------------------------------------------------------------------
// gRPC bridge event types (TS-side representations of proto messages)
// ---------------------------------------------------------------------------

export type ComplianceEvent = {
  type: "compliance";
  callId: string;
  status: ComplianceState;
};

export type ParticipantEvent = {
  type: "participant";
  callId: string;
  action: "joined" | "left" | "muted" | "unmuted";
  aadUserId: string;
  displayName?: string;
};

export type StateEvent = {
  type: "state";
  callId: string;
  state: "establishing" | "established" | "terminated";
  reason?: string;
};

export type QoEEvent = {
  type: "qoe";
  callId: string;
  speakerId: number;
  packetLoss: number;
  jitterMs: number;
};

export type ErrorEvent = {
  type: "error";
  callId: string;
  message: string;
  recoverable: boolean;
};

export type CallEvent = ComplianceEvent | ParticipantEvent | StateEvent | QoEEvent | ErrorEvent;

// ---------------------------------------------------------------------------
// Unmixed audio segment (received from .NET worker via gRPC)
// ---------------------------------------------------------------------------

export type UnmixedAudioSegment = {
  callId: string;
  /** ActiveSpeakerId from the unmixed audio buffer. */
  speakerId: number;
  /** Resolved AAD object ID of the speaker. */
  aadUserId: string;
  /** Display name of the speaker. */
  displayName?: string;
  /** Duration of the audio segment in milliseconds. */
  durationMs: number;
  /** Raw PCM data: 16kHz, mono, 16-bit signed. */
  pcmData: Uint8Array;
  /** True if this segment was terminated by silence detection. */
  isFinal: boolean;
};
