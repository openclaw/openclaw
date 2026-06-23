/**
 * Microsoft Teams realtime voice bridge.
 *
 * When `realtime.enabled` is set for the msteams provider, a Teams call is wired
 * directly to a speech-to-speech realtime model (e.g. OpenAI / Azure OpenAI
 * Realtime) instead of the STT -> agent -> TTS pipeline. This is the low-latency
 * path: the model listens, thinks, and speaks in one streaming session.
 *
 * Audio crosses the existing msteams WebSocket as PCM 16 kHz, 16-bit mono. The
 * realtime model speaks PCM 16-bit mono at 24 kHz, so we resample on both legs:
 *   caller  16 kHz -> 24 kHz -> model
 *   model   24 kHz -> 16 kHz -> caller
 * The Windows worker reframes the downlink PCM into 20 ms / 640-byte frames, so
 * we can forward arbitrary-length chunks as a single `audio.frame`.
 *
 * The model owns conversation/VAD/turn-taking and answers small talk directly.
 * For anything that needs work (lookups, actions, tools) it calls
 * `openclaw_agent_consult`, which runs the full OpenClaw agent and returns a
 * speakable result; a short "working on it" filler covers longer agent runs.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  buildRealtimeVoiceAgentConsultWorkingResponse,
  consultRealtimeVoiceAgent,
  createRealtimeVoiceBridgeSession,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  resamplePcm,
  resolveRealtimeVoiceAgentConsultToolsAllow,
  type RealtimeVoiceAgentConsultToolPolicy,
  type RealtimeVoiceAgentConsultTranscriptEntry,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceProviderConfig,
  type RealtimeVoiceProviderPlugin,
  type RealtimeVoiceTool,
  type RealtimeVoiceToolCallEvent,
} from "openclaw/plugin-sdk/realtime-voice";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import type { VoiceCallConfig } from "./config.js";
import type { CoreAgentDeps } from "./core-bridge.js";
import { inferEmotion } from "./expression.js";
import { type GroupCallGateConfig, isAddressed } from "./group-call-gate.js";
import { buildMinutesDocx, type MinutesTranscriptEntry } from "./meeting-minutes-docx.js";
import {
  MSTEAMS_PCM_SAMPLE_RATE_HZ,
  type MsteamsLogger,
  type MsteamsSession,
} from "./msteams-media-stream.js";
import {
  MSTEAMS_AGENT_TASK_TOOL,
  MSTEAMS_AGENT_TASK_TOOL_NAME,
  MSTEAMS_ASYNC_TASK_ACK,
  MSTEAMS_ASYNC_TASK_ACK_CALL,
  MSTEAMS_ASYNC_TASK_NO_TARGET,
  MSTEAMS_LOOK_BUDGETED,
  MSTEAMS_LOOK_NO_FRAME,
  MSTEAMS_LOOK_TOOL,
  MSTEAMS_LOOK_TOOL_NAME,
  MSTEAMS_MINUTES_TOOL,
  MSTEAMS_MINUTES_TOOL_NAME,
  MSTEAMS_REALTIME_CONSULT_SYSTEM_PROMPT,
  MSTEAMS_REALTIME_LOOK_SYSTEM_PROMPT,
  MSTEAMS_REALTIME_SHOW_SYSTEM_PROMPT,
  MSTEAMS_RECORDING_BLOCKED,
  MSTEAMS_SHOW_TOOL,
  MSTEAMS_SHOW_TOOL_NAME,
} from "./msteams-realtime-tools.js";
import { describeMsteamsVideoFrameOwner, type MsteamsVideoFrame } from "./msteams-video-frame.js";
import { resolveRealtimeFastContextConsult } from "./realtime-fast-context.js";
import { resolveVoiceResponseModel } from "./response-model.js";
import { readArgText } from "./utils.js";
import { isVerbalInterrupt } from "./verbal-interrupt.js";
import type { VisionBudget } from "./vision-budget.js";

/** Teams bridge wire format. */
const MSTEAMS_SAMPLE_RATE_HZ = MSTEAMS_PCM_SAMPLE_RATE_HZ;
/** OpenAI/Azure realtime PCM format. */
const REALTIME_SAMPLE_RATE_HZ = 24_000;
/** Cap the consult transcript context so it cannot grow without bound on long calls. */
const MAX_TRANSCRIPT_ENTRIES = 40;
/**
 * Cap one coalesced transcript entry. Without it, a long same-speaker run (an hour of a group call
 * heard as one "user" stream) coalesces into a single ever-growing entry that the entry-count cap
 * never trims. A fragment that would exceed this starts a new entry instead.
 */
const MAX_TRANSCRIPT_ENTRY_CHARS = 1_000;

/**
 * Notify-mode delivery: once the model finishes its first turn, treat its audio as drained after this
 * much silence (no frames sent), so a notify auto-hangup waits for the spoken result to finish instead
 * of clipping it on a fixed timer.
 */
const NOTIFY_AUDIO_QUIET_MS = 1000;

/**
 * Half-duplex echo guard window: while our own audio is (or was within this window) playing on the
 * call, the caller leg can carry it back as acoustic echo. We drop that caller input to the realtime
 * model so its server-VAD does not answer our own voice — unless it is loud enough to be a barge-in.
 */
export const ECHO_SUPPRESSION_WINDOW_MS = 600;
/** Normalized RMS above which caller input during our playback is treated as a real barge-in, not echo. */
export const ECHO_BARGE_IN_RMS = 0.04;

/** RMS loudness of 16-bit little-endian mono PCM, normalized to roughly 0..1. */
export function pcm16Rms(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < samples; i += 1) {
    const sample = pcm.readInt16LE(i * 2) / 32768;
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples);
}

/**
 * Parse the recap consult's structured-summary text into headed sections for the deterministic docx.
 * The consult is asked to return plain headed sections ("### Heading" lines followed by "- item"
 * lines); we tolerate "## "/"# "/"**Heading**" headings and "*"/"•" bullets, and treat any non-bullet
 * prose under a heading as its own item so a section is never silently dropped. Empty sections (no
 * items) are omitted by the docx builder. This runs in code so the artifact is deterministic — the
 * model only supplies the prose, never the document bytes.
 */
export function parseMinutesSections(text: string): Array<{ heading: string; items: string[] }> {
  const sections: Array<{ heading: string; items: string[] }> = [];
  let current: { heading: string; items: string[] } | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const headingMatch = /^#{1,6}\s+(.*\S)\s*$/.exec(line) ?? /^\*\*(.+?)\*\*:?\s*$/.exec(line);
    if (headingMatch?.[1]) {
      current = { heading: headingMatch[1].replace(/:$/, "").trim(), items: [] };
      sections.push(current);
      continue;
    }
    const bulletMatch = /^(?:[-*•]|\d+[.)])\s+(.*\S)\s*$/.exec(line);
    const item = bulletMatch?.[1] ?? line;
    if (!current) {
      current = { heading: "Summary", items: [] };
      sections.push(current);
    }
    current.items.push(item);
  }
  return sections;
}

/**
 * Half-duplex echo guard predicate shared by the realtime and streaming paths: while our own audio is
 * audible on the call (until `playbackActiveUntil` + the playout window), caller input below the
 * barge-in RMS is treated as our voice echoing back and dropped, so the agent never answers itself —
 * while a genuinely loud interruption still passes through as a barge-in.
 *
 * `allowBargeIn: false` drops the loudness exception and suppresses ALL in-window input. This is used
 * for the opening greeting (before the caller's first real turn): on a speakerphone the bot's own
 * greeting echoes back loud enough to clear the barge-in RMS, so the model's server-VAD hears it,
 * interrupts itself, and re-greets — an echo loop with the caller silent. Until the caller has
 * actually spoken once, any in-window input is echo, so no barge-in is allowed; normal RMS barge-in
 * resumes for the rest of the call.
 */
export function shouldSuppressEcho(
  pcm16k: Buffer,
  playbackActiveUntil: number,
  opts?: {
    suppressInputDuringPlayback?: boolean;
    echoSuppressionWindowMs?: number;
    echoBargeInRms?: number;
    allowBargeIn?: boolean;
  },
): boolean {
  if (opts?.suppressInputDuringPlayback === false) {
    return false;
  }
  const inPlaybackWindow =
    Date.now() <
    playbackActiveUntil + (opts?.echoSuppressionWindowMs ?? ECHO_SUPPRESSION_WINDOW_MS);
  if (!inPlaybackWindow) {
    return false;
  }
  // Before the caller's first real turn, treat every in-window frame as echo (no loudness exception).
  if (opts?.allowBargeIn === false) {
    return true;
  }
  return pcm16Rms(pcm16k) < (opts?.echoBargeInRms ?? ECHO_BARGE_IN_RMS);
}

/** A short, single-line tile caption from the agent's image summary (empty → undefined). */
export function toTileCaption(text: string | undefined): string | undefined {
  const trimmed = text?.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > 140 ? `${trimmed.slice(0, 139)}…` : trimmed;
}

/**
 * CVI Phase 4 — backstop interval for the ambient vision poll. The primary trigger is now
 * {@link MsteamsRealtimeCall.notifyInboundFrame}, pushed on scene change as frames arrive; this timer
 * just catches anything missed. Only fires when the frame changed and the vision budget allows, so a
 * static screen costs nothing; the budget (`maxVisionPerMinute`) is the real cap on a changing screen.
 */
const REALTIME_VISION_PUSH_INTERVAL_MS = 6000;

/** Max bytes for an agent-produced image we'll display (safety bound). */
const MSTEAMS_MAX_DISPLAY_IMAGE_BYTES = 4_000_000;

/** Keyframes attached to a history-scope look_at_screen (one budgeted vision consult reads them all). */
const MSTEAMS_LOOK_HISTORY_FRAMES = 6;

/** Per-image hold time when show_to_caller produces more than one image (slideshow pacing). */
const DISPLAY_SLIDESHOW_MS = 4_000;
/** Non-final slideshow frames are held this much past the pacing delay so send latency can't open a
 * one-frame gap (avatar flash) between consecutive slides. */
const DISPLAY_SLIDESHOW_OVERLAP_MS = 500;

/** show_to_caller produces an image (browse + screenshot / generate), which needs more than the
 *  quick-reply budget; the model plays a "working on it" filler while it runs. */
const MSTEAMS_SHOW_TIMEOUT_MS = 90_000;

/** MIME for an image by file/URL extension (query string stripped), or null for non-images. */
function mimeForImageExtension(pathOrUrl: string): string | null {
  const ext = (pathOrUrl.split(/[?#]/)[0] ?? "").toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return null;
  }
}

/**
 * Append the group-call gate as a model instruction. The realtime bridge owns turn-taking and
 * exposes no response-suppression hook, so the gate is enforced by telling the model to stay silent
 * in a meeting until addressed by name. Inert when the gate is off or has no wake phrases.
 */
/**
 * Roster-aware presence (#20): tell the model who it's talking to so it can greet the caller by
 * name and address participants by name. The caller's display name comes from the Teams roster
 * (worker → session.caller); per-utterance speaker labels already arrive as a "Name:" transcript
 * prefix, so this preamble just teaches the model to use them.
 */
function rosterClause(callerName: string | undefined): string | undefined {
  const name = callerName?.trim();
  if (!name) {
    return undefined;
  }
  return [
    `CALLER IDENTITY: You are speaking with ${name}. Greet them by their first name once, warmly`,
    "and briefly, then continue naturally — do not repeat their name every turn. In a group call,",
    'each caller turn is prefixed with the speaker\'s name (e.g. "Sara: ..."); use those names to',
    "address people directly when it helps, but never read the prefix aloud as part of your reply.",
  ].join(" ");
}

/**
 * Bilingual mode (#19): pin Arabic↔English language behavior. The realtime model already mirrors
 * languages, but this makes it explicit and adds on-request translation between the two.
 */
function bilingualClause(bilingual: boolean | undefined): string | undefined {
  if (!bilingual) {
    return undefined;
  }
  return [
    "BILINGUAL (Arabic / English): Detect the language the caller is speaking — Arabic or English —",
    "and always reply in that same language, matching dialect and register. If the caller switches",
    "language mid-call, switch with them. When asked to translate, translate accurately between",
    "Arabic and English and read out only the translation.",
  ].join(" ");
}

function groupGateClause(gate: GroupCallGateConfig | undefined): string | undefined {
  const phrases = gate?.wakePhrases?.filter((p) => p.trim().length > 0) ?? [];
  if (!gate?.requireAddress || phrases.length === 0) {
    return undefined;
  }
  const names = phrases.map((p) => `"${p}"`).join(", ");
  return [
    "GROUP-CALL ETIQUETTE: If more than one person is on this call (a group meeting), do NOT reply",
    `unless someone addresses you by name (${names}) or clearly directs a question to you. When you`,
    "are not addressed, stay silent and just listen — do not narrate, acknowledge, or interject.",
    "Once addressed, you may continue a short back-and-forth until the topic moves on. In a",
    "one-on-one call (only you and one person), respond normally to everything.",
  ].join(" ");
}

/** Append each non-empty clause to the base instructions, separated by blank lines. */
function appendClauses(
  base: string | undefined,
  ...clauses: (string | undefined)[]
): string | undefined {
  const parts = [base, ...clauses].filter((c): c is string => c != null && c.trim().length > 0);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export interface MsteamsRealtimeDeps {
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
  cfg?: OpenClawConfig;
  /** System instructions for the realtime model. */
  instructions?: string;
  /** Instruction used to open the call (model speaks first). Empty/undefined = silent join. */
  greetingInstructions?: string;
  /**
   * Speak the greeting only once recording goes active (i.e. the callee actually ANSWERED), not when
   * the realtime session connects. Required for outbound call-backs: the bridge connects while the
   * phone is still ringing, so greeting-on-ready delivers the result to a not-yet-connected callee.
   */
  greetingOnRecordingActive?: boolean;
  /** Notify mode: invoked once after the model finishes its first response (outbound result delivery). */
  onDeliveryComplete?: () => void;
  /** Realtime tools exposed to the model (e.g. openclaw_agent_consult). */
  tools?: RealtimeVoiceTool[];
  /** Inbound-call policy applied before bridging (mirrors the streaming path). */
  inboundPolicy?: "disabled" | "allowlist" | "pairing" | "open";
  /** Allowlist of caller ids honored when inboundPolicy is "allowlist"/"pairing". */
  allowFrom?: string[];
  /**
   * Require active Teams recording status before the agent may process or persist
   * call audio (the consult tool and the background task). Default true. Mirrors
   * the streaming path's `msteams.requireRecordingStatus` (Media Access API).
   */
  requireRecordingStatus?: boolean;

  // --- openclaw_agent_consult wiring (the agent actually does the work) ---
  /** Host agent runtime used to run the OpenClaw agent behind the consult tool. */
  agentRuntime?: CoreAgentDeps;
  /** Full voice config (for agentId, realtime.{toolPolicy,fastContext,consult*}, responseTimeoutMs). */
  voiceConfig?: VoiceCallConfig;
  /** Consult tool policy; controls which agent tools the consult run may use. */
  toolPolicy?: RealtimeVoiceAgentConsultToolPolicy;
  /**
   * Latest sampled inbound video frame (camera / screen-share) for the `look_at_screen` tool, so
   * the agent can describe what the caller is showing. Provided by the provider; undefined disables
   * the tool. Uses the shared `MsteamsVideoFrame` type (type-only import → no runtime cycle).
   */
  getLatestFrame?: (source?: "camera" | "screenshare") => MsteamsVideoFrame | undefined;
  /** Scene-change keyframes from earlier in the call, oldest first (retroactive vision). */
  getFrameHistory?: (limit?: number) => MsteamsVideoFrame[];

  /**
   * Half-duplex echo guard (default ON): while assistant audio is playing, drop caller-leg input to
   * the realtime model unless it is loud enough to be a genuine barge-in — so the model does not
   * answer our own voice echoing back off the caller's device, while the caller can still interrupt.
   * Set false to disable.
   */
  suppressInputDuringPlayback?: boolean;
  /** Echo guard playout window (ms); default {@link ECHO_SUPPRESSION_WINDOW_MS}. */
  echoSuppressionWindowMs?: number;
  /** Echo guard barge-in RMS gate (0..1); default {@link ECHO_BARGE_IN_RMS}. */
  echoBargeInRms?: number;

  /**
   * Group-call gate. The realtime model owns turn-taking, so (unlike the deterministic streaming
   * gate) this is applied as an instruction: in a meeting the model is told to stay silent until
   * addressed by name. Undefined / requireAddress=false ⇒ respond normally.
   */
  groupCallGate?: GroupCallGateConfig;

  /** Per-call vision spend cap shared across calls (look_at_screen). Undefined = unlimited. */
  visionBudget?: VisionBudget;

  logger?: MsteamsLogger;
}

/** A single Teams call bridged to the realtime model. */
export interface MsteamsRealtimeCall {
  /** Forward one inbound PCM 16 kHz frame from the caller into the model. */
  pushAudio(pcm16k: Buffer): void;
  /**
   * Signal that a new inbound video frame is available (scene change). Pushes it to the model right
   * away if it changed and the vision budget allows — so the model sees changes promptly instead of
   * waiting for the ambient backstop poll.
   */
  notifyInboundFrame(): void;
  /** Live human participant count (excludes the bot); drives the deterministic group-call gate. */
  setHumanCount(count: number): void;
  /** A DTMF key the caller pressed; surfaced to the model as a user message so it can run IVR flows. */
  notifyDtmf(digit: string): void;
  /** Active speaker's display name (unmixed-audio worker) — labels caller transcript turns. */
  setCurrentSpeaker(name: string | undefined): void;
  /** Update Teams recording status (gates the consult tool + background task). */
  setRecordingActive(active: boolean): void;
  /**
   * Tear down the realtime session. Pass a `reason` for a manager-driven hangup (idle timeout, notify
   * auto-hangup, explicit endCall) to ALSO close the Teams worker session so the call actually ends;
   * omit it for a caller-driven `session.end` (the session is already closing).
   */
  close(reason?: string): void;
}

/**
 * Create and connect a realtime bridge for one Teams call. Inbound caller audio
 * is fed via {@link MsteamsRealtimeCall.pushAudio}; model audio is sent back over
 * the provided {@link MsteamsSession} as `audio.frame` messages, and barge-in is
 * surfaced as `assistant.cancel` so the worker flushes its playback queue.
 */
export function createMsteamsRealtimeCall(params: {
  session: MsteamsSession;
  deps: MsteamsRealtimeDeps;
}): MsteamsRealtimeCall {
  const { session, deps } = params;
  const { logger } = deps;
  const callId = session.callId;
  // Realtime subagent memory key honors the voice-call `sessionScope` (matching the streaming path):
  // "per-phone" (default) keys by the caller's Teams AAD id so the same caller's memory carries across
  // calls; "per-call" keys by callId. An anonymous caller (no aadId) falls back to per-call so distinct
  // anonymous callers never collide into one session.
  // `||` (not `??`): the session.start schema permits an empty-string aadId, which would otherwise
  // survive the fallback and collapse every such caller into ONE consult session key — cross-caller
  // memory bleed. (the media-stream boundary also normalizes blanks to null.)
  const sessionScopeId =
    deps.voiceConfig?.sessionScope === "per-call"
      ? callId
      : deps.voiceConfig?.sessionScope === "per-thread"
        ? session.threadId?.trim() || session.caller.aadId || callId
        : session.caller.aadId || callId;

  let outboundSeq = 0;
  let outboundTimestampMs = 0;
  let turnId = 0;
  let closed = false;
  let deliveryComplete = false;
  const callStartedAt = Date.now();
  /**
   * Estimated epoch ms when the audio we've sent finishes PLAYING on the call. The realtime model
   * generates audio faster than realtime and the worker queues it for playout, so send-time is NOT
   * play-time; summing each chunk's PCM duration tracks the playout clock the worker follows. Keyed
   * off this (not last-send time) so the echo guard and notify drain cover the WHOLE spoken reply.
   */
  let playbackEndAt = 0;
  /**
   * Teams recording status. Gates the consult tool + background task so the agent
   * never processes or persists call audio before Graph `updateRecordingStatus`
   * is active (Media Access API). Seeded from `session.start`, updated by
   * `recording.status` via {@link MsteamsRealtimeCall.setRecordingActive}.
   */
  let recordingActive = session.recordingStatus === "active";
  /** Whether the recording-status gate is enforced (default true). */
  const requireRecordingStatus = deps.requireRecordingStatus !== false;
  /** True when the agent must NOT process/persist call audio yet. */
  const recordingGateBlocks = (): boolean => requireRecordingStatus && !recordingActive;

  /** Rolling consult context built from the model's final transcripts. */
  const transcript: RealtimeVoiceAgentConsultTranscriptEntry[] = [];

  /**
   * Vision rate-limit: cache the last look_at_screen answer keyed by the exact frame bytes, so
   * repeated "what's on my screen?" on an unchanged frame returns instantly without re-running the
   * (expensive) vision agent. A new frame (changed screen) misses the cache and re-runs.
   */
  let lastLookData: string | undefined;
  let lastLookText: string | undefined;

  /** Phase 4 proactive vision: the last frame bytes pushed into the session (skip unchanged), + timer. */
  const lastPushedFrameData: { camera?: string; screenshare?: string } = {};
  let visionPushTimer: ReturnType<typeof setInterval> | undefined;
  /** Phase 6b: last emotion cued to the worker, so we only send on change (early + self-correcting). */
  let lastSentExpression: string | undefined;
  let thinking = false;
  // Deterministic group-call gate state (mirrors the streaming path's per-call fields): in a meeting
  // the bot speaks only when the last caller turn addressed it; 1:1 calls are never gated.
  let humanCount = 1;
  let lastAddressedAt: number | undefined;
  // Group-call "speak only when addressed" gate is active only in a meeting with a usable wake phrase.
  // Egress is TIME-WINDOWED off lastAddressedAt + followUpWindowMs (not a latched boolean), so a missed,
  // partial, or echo-suppressed wake transcript can no longer strand the bot permanently silent.
  // (bugfix: group-meeting wake failure)
  const groupGateActive =
    deps.groupCallGate != null &&
    deps.groupCallGate.requireAddress &&
    deps.groupCallGate.wakePhrases.some((p) => p.trim().length > 0);
  /** Active speaker (unmixed-audio worker); labels the caller turn the model transcribes next. */
  let currentSpeakerName: string | undefined;
  /** Outbound greeting fires once, on answer (setRecordingActive); guards against a re-trigger. */
  let greetingTriggered = false;
  /**
   * True once the caller has actually spoken (first non-empty "user" transcript). Until then the echo
   * guard allows no barge-in, so the bot's own opening greeting echoing back on a speakerphone can't
   * trigger the model into a re-greeting loop while the caller is silent.
   */
  let callerTurnStarted = false;

  /** Speaker of the most recent "user" transcript entry, so coalescing never crosses speakers. */
  let lastUserEntrySpeaker: string | undefined;

  function recordTranscript(role: "user" | "assistant", text: string, speaker?: string): void {
    // Media Access API: never retain media-derived transcript text before Teams
    // recording status is active. Otherwise pre-recording turns would sit in the
    // buffer and be sent to the agent once consult/task run after recording flips
    // active. Dropping here keeps the consult context recording-active-only.
    if (recordingGateBlocks()) {
      return;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    // Coalesce consecutive fragments from the same speaker so one spoken turn is a single context
    // entry (avoids feeding the agent half-sentences) — but never across SPEAKERS (merging would
    // attribute everyone's words to the first "Name:" prefix in a group call) and never past the
    // per-entry cap (one entry would otherwise grow unbounded and defeat the entry-count cap).
    const last = transcript.at(-1);
    const sameSpeaker = role !== "user" || speaker === lastUserEntrySpeaker;
    if (
      last &&
      last.role === role &&
      sameSpeaker &&
      last.text.length + trimmed.length < MAX_TRANSCRIPT_ENTRY_CHARS
    ) {
      last.text = `${last.text} ${trimmed}`.trim();
    } else {
      transcript.push({ role, text: trimmed });
    }
    if (role === "user") {
      lastUserEntrySpeaker = speaker;
    }
    if (transcript.length > MAX_TRANSCRIPT_ENTRIES) {
      transcript.splice(0, transcript.length - MAX_TRANSCRIPT_ENTRIES);
    }
  }

  const consultToolPolicy: RealtimeVoiceAgentConsultToolPolicy =
    deps.toolPolicy ?? deps.voiceConfig?.realtime.toolPolicy ?? "none";
  // Consult agent identity, hoisted once per call — previously recomputed verbatim in five
  // handlers (consult / look / show / background task / recap).
  const consultAgentId = deps.voiceConfig?.agentId ?? "main";
  const consultSessionKey = `agent:${consultAgentId}:subagent:msteams:${sessionScopeId}`;
  // Async background tasks deliver their result via the agent's `message` tool,
  // which is only available under the "owner" tool policy.
  const asyncTasksEnabled =
    Boolean(deps.agentRuntime && deps.voiceConfig && deps.cfg) && consultToolPolicy === "owner";
  // Vision: expose the look_at_screen tool when the agent runtime + a frame source are available
  // AND the tool policy permits tools at all — read-only vision is off under "none", on under
  // "safe-read-only" and "owner". (The ambient frame push is independent continuous-vision context.)
  const visionEnabled =
    Boolean(deps.agentRuntime && deps.voiceConfig && deps.cfg && deps.getLatestFrame) &&
    consultToolPolicy !== "none";
  // show_to_caller is a CORE call feature (put a screenshot/image on the bot's video tile). It runs a
  // CONTROLLED single-image production consult that pins its OWN "owner" tool policy internally (see
  // handleShow → toolPolicy:"owner"), so the call-wide conversational toolPolicy does NOT need to be
  // "owner" to expose it. Gate it like vision: available under "safe-read-only" (the default) and
  // "owner", off only under "none" (a deliberately locked-down call). Previously it required the whole
  // call to be "owner", so under the default policy the model was never offered the tool and replied
  // "I can't share". (bugfix: screen-share "I can't share")
  const showEnabled =
    Boolean(deps.agentRuntime && deps.voiceConfig && deps.cfg) && consultToolPolicy !== "none";
  const bridgeTools = [
    ...(deps.tools ?? []),
    ...(asyncTasksEnabled ? [MSTEAMS_AGENT_TASK_TOOL] : []),
    ...(visionEnabled ? [MSTEAMS_LOOK_TOOL] : []),
    ...(showEnabled ? [MSTEAMS_SHOW_TOOL] : []),
    // On-demand minutes deliver via the agent's message tool (owner policy), like background tasks.
    ...(asyncTasksEnabled && session.caller.aadId ? [MSTEAMS_MINUTES_TOOL] : []),
  ];

  /**
   * Shared consult invocation for the consult / look_at_screen / background-task handlers: resolves
   * the agent model + thinking level and calls consultRealtimeVoiceAgent with the common Teams
   * params. Each handler supplies only what differs (run id, args, surface, prompt, tool policy, and
   * optional images / fastMode / timeout). agentId + sessionKey are passed in because the consult
   * handler also uses them for its fast-context path.
   */
  const runMsteamsConsult = (opts: {
    agentRuntime: CoreAgentDeps;
    voiceConfig: VoiceCallConfig;
    cfg: OpenClawConfig;
    agentId: string;
    sessionKey: string;
    runIdPrefix: string;
    args: unknown;
    surface: string;
    extraSystemPrompt: string;
    toolPolicy: RealtimeVoiceAgentConsultToolPolicy;
    images?: Array<{ type: "image"; data: string; mimeType: string }>;
    fastMode?: boolean;
    timeoutMs?: number;
    trustLocalMedia?: boolean;
    /** Lock delivery (and any fallback) to an explicit target — used by the recap so 1:1 minutes
     *  go to the caller and never default to the operator's chat. */
    deliveryContext?: {
      channel?: string;
      to?: string;
      accountId?: string;
      threadId?: string | number;
    };
  }) => {
    const { provider: agentProvider, model } = resolveVoiceResponseModel({
      voiceConfig: opts.voiceConfig,
      agentRuntime: opts.agentRuntime,
    });
    const thinkLevel =
      opts.voiceConfig.realtime.consultThinkingLevel ??
      opts.agentRuntime.resolveThinkingDefault({ cfg: opts.cfg, provider: agentProvider, model });
    return consultRealtimeVoiceAgent({
      cfg: opts.cfg,
      agentRuntime: opts.agentRuntime,
      logger: { warn: (message) => logger?.warn(message) },
      agentId: opts.agentId,
      sessionKey: opts.sessionKey,
      messageProvider: "voice",
      lane: "voice",
      runIdPrefix: opts.runIdPrefix,
      args: opts.args,
      ...(opts.images ? { images: opts.images } : {}),
      transcript: [...transcript],
      surface: opts.surface,
      userLabel: "Caller",
      assistantLabel: "Agent",
      questionSourceLabel: "caller",
      provider: agentProvider,
      model,
      thinkLevel,
      fastMode: opts.fastMode ?? opts.voiceConfig.realtime.consultFastMode,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.trustLocalMedia ? { trustLocalMedia: true } : {}),
      ...(opts.deliveryContext ? { deliveryContext: opts.deliveryContext } : {}),
      toolsAllow: resolveRealtimeVoiceAgentConsultToolsAllow(opts.toolPolicy),
      extraSystemPrompt: opts.extraSystemPrompt,
    });
  };

  const realtime = createRealtimeVoiceBridgeSession({
    provider: deps.provider,
    cfg: deps.cfg,
    providerConfig: deps.providerConfig,
    audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
    instructions: appendClauses(
      deps.instructions,
      rosterClause(session.caller.displayName ?? undefined),
      bilingualClause(deps.voiceConfig?.msteams?.bilingual),
      groupGateClause(deps.groupCallGate),
    ),
    initialGreetingInstructions: deps.greetingInstructions,
    // Outbound call-backs greet on ANSWER (setRecordingActive), not on connect — the bridge is ready
    // while the phone still rings, so greeting-on-ready would deliver the result to nobody.
    triggerGreetingOnReady: Boolean(deps.greetingInstructions) && !deps.greetingOnRecordingActive,
    autoRespondToAudio: true,
    interruptResponseOnInputAudio: true,
    tools: bridgeTools,
    audioSink: {
      isOpen: () => !closed,
      sendAudio: (pcm24k: Buffer) => {
        if (closed || pcm24k.length === 0) {
          return;
        }
        // Deterministic group-gate enforcement (audio egress): in a meeting, drop the model's reply
        // audio unless we are within the follow-up window of the last time the bot was addressed.
        // Computing this from time (not a stored flag) means a fragmented/echo-suppressed "hey
        // assistant" can still reopen the gate, and the gate self-heals instead of latching closed.
        if (humanCount >= 2 && groupGateActive) {
          const g = deps.groupCallGate!;
          const now = Date.now();
          if (lastAddressedAt === undefined || now - lastAddressedAt > g.followUpWindowMs) {
            return;
          }
          // Hold the window open while the bot is actively speaking so a long reply isn't cut mid-
          // sentence, and the caller gets a fresh follow-up window measured from when it stops.
          lastAddressedAt = now;
        }
        const pcm16k = resamplePcm(pcm24k, REALTIME_SAMPLE_RATE_HZ, MSTEAMS_SAMPLE_RATE_HZ);
        // 16 kHz × 16-bit mono = 32 bytes/ms; extend the playout estimate by this chunk's duration.
        playbackEndAt = Math.max(playbackEndAt, Date.now()) + pcm16k.length / 32;
        session.send({
          type: "audio.frame",
          seq: outboundSeq,
          timestampMs: outboundTimestampMs,
          payloadBase64: pcm16k.toString("base64"),
        });
        outboundSeq += 1;
        // 16-bit mono: 2 bytes/sample.
        outboundTimestampMs += Math.round((pcm16k.length / 2 / MSTEAMS_SAMPLE_RATE_HZ) * 1000);
      },
      clearAudio: () => {
        // Barge-in: the model truncated its turn — tell the worker to flush the
        // audio it has already queued for playback so the caller isn't talked over.
        turnId += 1;
        session.send({ type: "assistant.cancel", turnId });
        // The flush stops playout immediately, so the playout estimate collapses to "now".
        playbackEndAt = Date.now();
      },
    },
    onTranscript: (role, text, isFinal) => {
      // First real caller speech ends the opening echo-only window — restore normal RMS barge-in.
      if (role === "user" && text.trim().length > 0) {
        callerTurnStarted = true;
      }
      // Open the group-gate window the moment the wake phrase is heard — on PARTIAL transcripts too,
      // not only final — so a fragmented/echo-clipped "hey assistant" still wakes the bot in a meeting.
      if (
        role === "user" &&
        groupGateActive &&
        text.trim().length > 0 &&
        isAddressed(text, deps.groupCallGate!.wakePhrases)
      ) {
        lastAddressedAt = Date.now();
      }
      // CVI Phase 6b: cue emotion as EARLY as possible — on the FIRST assistant transcript chunk of a
      // turn (partial or final), not only the final — so the face isn't neutral while a happy/sad reply
      // is already being spoken. De-duped on the inferred emotion so unchanged cues aren't spammed, and
      // it self-corrects if later text shifts the emotion (e.g. "sorry … but that's great!").
      if (role === "assistant" && !closed && !thinking) {
        const emotion = inferEmotion(text);
        if (emotion !== lastSentExpression) {
          lastSentExpression = emotion;
          logger?.debug?.(`MsteamsRealtime: expression cue '${emotion}' for ${callId}`);
          try {
            session.send({ type: "expression", emotion });
          } catch {
            // non-fatal
          }
        }
      }
      if (isFinal) {
        // Unmixed-audio attribution: prefix the caller turn with the speaker who was active while
        // it was spoken, so consults and meeting minutes can attribute per person.
        recordTranscript(
          role,
          role === "user" && currentSpeakerName ? `${currentSpeakerName}: ${text}` : text,
          currentSpeakerName,
        );
        // Deterministic verbal interrupt ("stop" / "hold on" / "never mind"): flush the worker's
        // playback queue immediately instead of waiting for the model's own interruption handling —
        // the model is mid-generation when these arrive, so this is what makes the cut feel instant.
        if (
          role === "user" &&
          Date.now() < playbackEndAt &&
          isVerbalInterrupt(text, deps.groupCallGate?.wakePhrases)
        ) {
          logger?.debug?.(`MsteamsRealtime: verbal interrupt on ${callId} — flushing playback`);
          turnId += 1;
          try {
            session.send({ type: "assistant.cancel", turnId });
          } catch {
            // non-fatal: the model-side interruption still applies
          }
          playbackEndAt = Date.now();
        }
        // (Group-gate wake detection now runs on ALL transcripts above — partial and final — and the
        // egress gate is time-windowed, so no per-final-turn latch update is needed here.)
        // Notify mode (outbound result callback): after the model's first finished response, wait for
        // its audio to drain before signalling delivery-complete so the hangup never clips the result.
        if (role === "assistant" && !deliveryComplete && deps.onDeliveryComplete) {
          deliveryComplete = true;
          watchAudioDrainThenSignal();
        }
      }
    },
    onToolCall: (event, rtSession) => {
      if (event.name === MSTEAMS_AGENT_TASK_TOOL_NAME) {
        handleAsyncTask(event, rtSession);
        return;
      }
      const handler =
        event.name === MSTEAMS_MINUTES_TOOL_NAME
          ? handleMinutes
          : event.name === MSTEAMS_LOOK_TOOL_NAME
            ? handleLook
            : event.name === MSTEAMS_SHOW_TOOL_NAME
              ? handleShow
              : event.name === REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME
                ? handleConsult
                : undefined;
      if (!handler) {
        // An operator-configured custom tool (deps.tools) was advertised to the model but has no
        // handler here. Answer SOMETHING — a tool call with no submitToolResult stalls the model's
        // turn forever and the caller sits in silence.
        logger?.warn(`MsteamsRealtime: no handler for tool '${event.name}' on ${callId}`);
        rtSession.submitToolResult(event.callId, {
          text: `The tool "${event.name}" is not available on this call.`,
        });
        return;
      }
      // These tools keep the caller waiting — show a "thinking" face until the result lands
      // (cleared via finally regardless of success/error; the result speech then re-cues the emotion).
      setThinking(true);
      void handler(event, rtSession).finally(() => setThinking(false));
    },
    onError: (error) => {
      logger?.warn(`MsteamsRealtime: bridge error — ${error.message}`);
    },
    onClose: () => {
      // The realtime provider's WS dropped (model-side failure, network loss). Funnel through the
      // same teardown as a hangup — INCLUDING closing the Teams worker session — or the caller is
      // stranded in silence on a call that close(reason) can no longer end (its `closed` early-return
      // would skip session.close forever).
      closeCall("realtime-closed");
    },
  });

  /**
   * CVI Phase 4: push the latest inbound frame into the realtime session as ambient context so the
   * model is continuously visually aware — not only when the caller invokes `look_at_screen`. Skips
   * when nothing changed, before recording is active, or when over the vision budget. No forced
   * response: the model uses the frame on its next natural turn.
   */
  function pushLatestFrameToModel(): void {
    if (closed || recordingGateBlocks() || !deps.getLatestFrame) {
      return;
    }
    // Push BOTH sources the caller is sharing (screen-share first, then camera) so the model is
    // simultaneously aware of, e.g., the person on camera AND their screen — not just one. Per-source
    // change-check skips a static source; each push draws from the shared per-call vision budget.
    for (const source of ["screenshare", "camera"] as const) {
      const frame = deps.getLatestFrame(source);
      if (!frame || frame.dataBase64 === lastPushedFrameData[source]) {
        continue; // no frame for this source, or unchanged since the last push
      }
      if (deps.visionBudget && !deps.visionBudget.tryConsume(callId, Date.now())) {
        break; // over the per-call vision budget — stop for this round
      }
      const label = source === "camera" ? "camera" : "screen-share";
      logger?.debug?.(`MsteamsRealtime: ambient vision push (${label}) for ${callId}`);
      try {
        const owner = describeMsteamsVideoFrameOwner(frame);
        realtime.sendImage({
          dataBase64: frame.dataBase64,
          mime: frame.mime,
          text: owner ? `Live ${label} — ${owner}.` : `Live ${label} of the call.`,
        });
        // Latch only AFTER a successful send: latching first marked a failed push as "already
        // pushed", so the frame was lost (never retried by the backstop) while its budget hit
        // stayed spent — starving look_at_screen.
        lastPushedFrameData[source] = frame.dataBase64;
      } catch (err) {
        deps.visionBudget?.refund(callId);
        logger?.debug?.(
          `MsteamsRealtime: vision push failed for ${callId} — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Notify mode: after the model's first finished turn, wait until its audio has drained (no frames
   * sent for {@link NOTIFY_AUDIO_QUIET_MS}) before signalling delivery-complete, so a caller-side
   * hangup never clips the spoken result. Polls on a short timer; stops if the call closes.
   */
  function watchAudioDrainThenSignal(): void {
    const check = (): void => {
      if (closed) {
        return;
      }
      // Quiet tail measured from the PLAYOUT end (playbackEndAt), not last send — the model streams
      // audio faster than realtime, so the result may still be playing long after the last chunk.
      const dueAt = playbackEndAt + NOTIFY_AUDIO_QUIET_MS;
      if (Date.now() >= dueAt) {
        deps.onDeliveryComplete?.();
        return;
      }
      const t = setTimeout(check, Math.max(50, dueAt - Date.now()));
      t.unref?.();
    };
    const t = setTimeout(check, NOTIFY_AUDIO_QUIET_MS);
    t.unref?.();
  }

  /**
   * CVI Phase 6c: while a tool keeps the caller waiting (consult / look / show), cue a "thinking" face
   * and suppress the reply-emotion cue so it persists; cleared when the result lands, after which the
   * result speech re-cues the real emotion.
   */
  function setThinking(on: boolean): void {
    if (on === thinking || closed) {
      return;
    }
    thinking = on;
    try {
      if (on) {
        session.send({ type: "expression", emotion: "thinking" });
        lastSentExpression = "thinking";
      } else if (lastSentExpression === "thinking") {
        // The model may stay silent after a tool result (no transcript to re-cue an emotion), so
        // reset to neutral here or the face would stick mid-think forever.
        session.send({ type: "expression", emotion: "neutral" });
        lastSentExpression = "neutral";
      }
    } catch {
      // non-fatal: expression is a cosmetic cue
    }
  }

  if (deps.getLatestFrame) {
    visionPushTimer = setInterval(pushLatestFrameToModel, REALTIME_VISION_PUSH_INTERVAL_MS);
    // Don't keep the process alive for this cosmetic-awareness timer.
    visionPushTimer.unref?.();
  }

  /** Deps + identity every agent-running tool handler needs, resolved non-null by the guard. */
  interface GuardedConsultDeps {
    agentRuntime: CoreAgentDeps;
    voiceConfig: VoiceCallConfig;
    cfg: OpenClawConfig;
    agentId: string;
    sessionKey: string;
    toolPolicy: RealtimeVoiceAgentConsultToolPolicy;
  }

  /**
   * Shared guards for the agent-running tool handlers (consult / look_at_screen / show_to_caller /
   * post_meeting_minutes): the Media-Access-API recording gate, the wired-deps check, and uniform
   * error reporting live in ONE place — review B10 existed precisely because one handler restated
   * (and partially missed) this boilerplate. The wrapped handler receives the resolved deps plus a
   * sendWorkingFiller() it calls once its own cheap pre-checks (cache, budget, frame presence)
   * pass, so the caller is not left in silence during a full agent run.
   */
  function withConsultGuards(opts: {
    label: string;
    unavailableText: string;
    errorText: string;
    /** Also require a frame source (look_at_screen). */
    requireFrameSource?: boolean;
    handler: (params: {
      event: RealtimeVoiceToolCallEvent;
      rtSession: RealtimeVoiceBridgeSession;
      consult: GuardedConsultDeps;
      sendWorkingFiller: () => void;
    }) => Promise<void>;
  }): (event: RealtimeVoiceToolCallEvent, rtSession: RealtimeVoiceBridgeSession) => Promise<void> {
    return async (event, rtSession) => {
      // Media Access API: never run the agent over call-derived audio/video before recording is active.
      if (recordingGateBlocks()) {
        logger?.debug?.(
          `MsteamsRealtime: ${opts.label} refused for ${callId} — recording not active`,
        );
        rtSession.submitToolResult(event.callId, MSTEAMS_RECORDING_BLOCKED);
        return;
      }
      const { agentRuntime, voiceConfig, cfg } = deps;
      if (
        !agentRuntime ||
        !voiceConfig ||
        !cfg ||
        (opts.requireFrameSource && !deps.getLatestFrame)
      ) {
        rtSession.submitToolResult(event.callId, { text: opts.unavailableText });
        return;
      }
      try {
        await opts.handler({
          event,
          rtSession,
          consult: {
            agentRuntime,
            voiceConfig,
            cfg,
            agentId: consultAgentId,
            sessionKey: consultSessionKey,
            toolPolicy: deps.toolPolicy ?? voiceConfig.realtime.toolPolicy,
          },
          sendWorkingFiller: () => {
            if (rtSession.bridge?.supportsToolResultContinuation) {
              rtSession.submitToolResult(
                event.callId,
                buildRealtimeVoiceAgentConsultWorkingResponse("caller"),
                { willContinue: true },
              );
            }
          },
        });
      } catch (err) {
        logger?.warn(
          `MsteamsRealtime: ${opts.label} failed for ${callId} — ${err instanceof Error ? err.message : String(err)}`,
        );
        rtSession.submitToolResult(event.callId, { text: opts.errorText });
      }
    };
  }

  /** Run the OpenClaw agent for an openclaw_agent_consult call and speak the result. */
  const handleConsult = withConsultGuards({
    label: "consult",
    unavailableText: "The assistant agent is not available right now.",
    errorText: "Sorry, I ran into a problem while working on that.",
    handler: async ({ event, rtSession, consult, sendWorkingFiller }) => {
      // Fast path: answer from memory/session context without a full agent run.
      const fastContext = await resolveRealtimeFastContextConsult({
        cfg: consult.cfg,
        agentId: consult.agentId,
        sessionKey: consult.sessionKey,
        config: consult.voiceConfig.realtime.fastContext,
        args: event.args,
        logger: { debug: (message) => logger?.debug?.(message) },
      });
      if (fastContext.handled) {
        rtSession.submitToolResult(event.callId, fastContext.result);
        return;
      }

      // Slower path: a full agent run.
      sendWorkingFiller();
      const result = await runMsteamsConsult({
        ...consult,
        runIdPrefix: `voice-realtime-consult:${callId}`,
        args: event.args,
        surface: "a live Microsoft Teams call",
        extraSystemPrompt: MSTEAMS_REALTIME_CONSULT_SYSTEM_PROMPT,
        timeoutMs: consult.voiceConfig.responseTimeoutMs,
      });
      rtSession.submitToolResult(event.callId, result);
    },
  });

  /**
   * post_meeting_minutes (#18/#22): ack on the call, then build+post the minutes .docx detached via
   * the same deterministic recap path so mid-call minutes are a real Word document too.
   */
  const handleMinutes = withConsultGuards({
    label: "minutes",
    unavailableText: "I can't post minutes from this call right now.",
    errorText: "Sorry, I had trouble posting the minutes.",
    handler: async ({ event, rtSession }) => {
      rtSession.submitToolResult(event.callId, {
        text: "Minutes are being written and posted to the Teams chat now.",
      });
      await runMeetingRecap();
    },
  });

  /** Run a vision-capable agent over the latest inbound video frame and speak the answer. */
  const handleLook = withConsultGuards({
    label: "look",
    unavailableText: "The assistant can't look at video right now.",
    errorText: "Sorry, I had trouble seeing that.",
    requireFrameSource: true,
    handler: async ({ event, rtSession, consult, sendWorkingFiller }) => {
      const sourceArg = readArgText(event.args, "source");
      const source = sourceArg === "camera" || sourceArg === "screenshare" ? sourceArg : undefined;
      // Retroactive vision: scope "history" reviews the recent scene-change keyframes (oldest first)
      // so the caller can ask about EARLIER shared content ("what did the previous slide say?").
      const historyScope = readArgText(event.args, "scope") === "history";
      const historyFrames = historyScope
        ? (deps.getFrameHistory?.(MSTEAMS_LOOK_HISTORY_FRAMES) ?? [])
        : [];
      const frame = historyScope ? historyFrames.at(-1) : deps.getLatestFrame?.(source);
      if (!frame) {
        rtSession.submitToolResult(event.callId, MSTEAMS_LOOK_NO_FRAME);
        return;
      }

      // Rate-limit: the same frame was already described → return the cached answer without a re-run.
      // History runs skip the cache (the question targets different frames each time).
      if (!historyScope && lastLookData === frame.dataBase64 && lastLookText) {
        logger?.debug?.(`MsteamsRealtime: look cache hit for ${callId} (unchanged frame)`);
        rtSession.submitToolResult(event.callId, { text: lastLookText });
        return;
      }

      // Cost cap: a changed frame means a fresh (expensive) vision run — gate it on the vision budget.
      if (deps.visionBudget && !deps.visionBudget.tryConsume(callId, Date.now())) {
        logger?.debug?.(`MsteamsRealtime: look over vision budget for ${callId}`);
        rtSession.submitToolResult(event.callId, MSTEAMS_LOOK_BUDGETED);
        return;
      }

      sendWorkingFiller();
      const lookFrames = historyScope ? historyFrames : [frame];
      const result = await runMsteamsConsult({
        ...consult,
        runIdPrefix: `voice-realtime-look:${callId}`,
        args: event.args,
        images: lookFrames.map((f) => ({
          type: "image" as const,
          data: f.dataBase64,
          mimeType: f.mime,
        })),
        surface: historyScope
          ? `a live Microsoft Teams call — the attached images are scene-change keyframes from earlier in the call, oldest first: ${lookFrames
              .map((f, i) => {
                const owner = describeMsteamsVideoFrameOwner(f);
                const age = Math.max(0, Math.round((Date.now() - f.ts) / 1000));
                return `image ${i + 1} (~${age}s ago${owner ? `, ${owner}` : ""})`;
              })
              .join("; ")}`
          : (() => {
              const owner = describeMsteamsVideoFrameOwner(frame);
              return owner
                ? `a live Microsoft Teams call — the attached image is ${owner}`
                : "a live Microsoft Teams call (a participant is sharing video)";
            })(),
        extraSystemPrompt: MSTEAMS_REALTIME_LOOK_SYSTEM_PROMPT,
        timeoutMs: consult.voiceConfig.responseTimeoutMs,
      });
      // Cache only LIVE looks. A history run answers about EARLIER keyframes; caching it under the
      // current frame's bytes would make later live looks on a static screen return the history
      // answer instead of describing what is on screen now.
      if (!historyScope) {
        lastLookData = frame.dataBase64;
        lastLookText = result.text;
      }
      rtSession.submitToolResult(event.callId, result);
    },
  });

  /** Load an agent-produced image — a local file (readFile) or a remote URL (SSRF-guarded fetch). */
  async function loadDisplayImage(
    pathOrUrl: string,
  ): Promise<{ bytes: Buffer; mime: string } | null> {
    if (/^https?:\/\//i.test(pathOrUrl)) {
      // Remote URL (e.g. an uploaded screenshot). Public hosts only; the guard blocks private/loopback.
      try {
        const { response, release } = await fetchWithSsrFGuard({
          url: pathOrUrl,
          init: { method: "GET" },
          policy: {},
          timeoutMs: 15_000,
        });
        try {
          if (!response.ok) {
            return null;
          }
          const contentType =
            (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
          const mime = contentType.startsWith("image/")
            ? contentType
            : mimeForImageExtension(pathOrUrl);
          if (!mime) {
            return null;
          }
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.length === 0 || bytes.length > MSTEAMS_MAX_DISPLAY_IMAGE_BYTES) {
            return null;
          }
          return { bytes, mime };
        } finally {
          void release?.();
        }
      } catch {
        return null;
      }
    }
    // Local file produced by the agent's own tool run.
    const mime = mimeForImageExtension(pathOrUrl);
    if (!mime) {
      return null;
    }
    try {
      const bytes = await readFile(pathOrUrl);
      if (bytes.length === 0 || bytes.length > MSTEAMS_MAX_DISPLAY_IMAGE_BYTES) {
        return null;
      }
      return { bytes, mime };
    } catch {
      return null;
    }
  }

  /** Show agent-produced images (local files or remote URLs) on the outbound tile (Phase 8). */
  async function forwardDisplayImages(mediaPaths: string[], caption?: string): Promise<number> {
    type LoadedImage = NonNullable<Awaited<ReturnType<typeof loadDisplayImage>>>;
    const images: LoadedImage[] = [];
    for (const pathOrUrl of mediaPaths) {
      const img = await loadDisplayImage(pathOrUrl);
      if (img) {
        images.push(img);
      } else {
        logger?.debug?.(
          `MsteamsRealtime: skipped non-displayable media ${pathOrUrl} for ${callId}`,
        );
      }
    }
    const [first, ...rest] = images;
    if (!first) {
      return 0;
    }

    const sequence = rest.length > 0;
    const sendOne = (img: LoadedImage, isLast: boolean): void => {
      try {
        logger?.debug?.(
          `MsteamsRealtime: display.image (${img.mime}, ${img.bytes.length}B${caption ? ", captioned" : ""}) for ${callId}`,
        );
        session.send({
          type: "display.image",
          dataBase64: img.bytes.toString("base64"),
          mime: img.mime,
          // PiP by default (#17): the image rides as an inset over the live avatar instead of a
          // fullscreen takeover, keeping the bot visibly present. An older worker ignores the
          // field and shows fullscreen — same behavior as before.
          mode: "overlay",
          // Hold each non-final slideshow frame for a fixed beat (plus overlap, so the next frame
          // lands before this one expires); the last keeps the worker default.
          ...(sequence && !isLast
            ? { durationMs: DISPLAY_SLIDESHOW_MS + DISPLAY_SLIDESHOW_OVERLAP_MS }
            : {}),
          ...(caption ? { caption } : {}),
        });
      } catch (err) {
        logger?.debug?.(
          `MsteamsRealtime: display.image send failed for ${callId} — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };

    sendOne(first, !sequence);
    if (sequence) {
      // Pace the remaining frames on the tile without blocking the spoken reply; stop if the call ends.
      void (async () => {
        for (const [idx, img] of rest.entries()) {
          await sleep(DISPLAY_SLIDESHOW_MS);
          if (closed) {
            return;
          }
          sendOne(img, idx === rest.length - 1);
        }
      })();
    }
    return images.length;
  }

  /**
   * show_to_caller (CVI Phase 8): run the agent to PRODUCE an image (screenshot / generated image) and
   * display it on the bot's video tile. Reuses the consult path; the produced trusted-local media is
   * read and sent as `display.image`. The agent is told not to also message it to chat.
   */
  const handleShow = withConsultGuards({
    label: "show",
    unavailableText: "I can't show images on this call.",
    errorText: "Sorry, I had trouble showing that.",
    handler: async ({ event, rtSession, consult, sendWorkingFiller }) => {
      sendWorkingFiller();
      // show_to_caller sends { request }; the consult contract expects question/prompt/query/task,
      // so map request -> question (otherwise the consult throws "question required").
      const showRequest =
        event.args &&
        typeof event.args === "object" &&
        typeof (event.args as { request?: unknown }).request === "string"
          ? (event.args as { request: string }).request
          : undefined;
      const result = await runMsteamsConsult({
        ...consult,
        runIdPrefix: `voice-realtime-show:${callId}`,
        args: showRequest ? { question: showRequest } : event.args,
        surface:
          "a live Microsoft Teams video call — show the caller an image on the bot's video tile",
        extraSystemPrompt: MSTEAMS_REALTIME_SHOW_SYSTEM_PROMPT,
        toolPolicy: "owner", // needs the screenshot / image-generation tools
        timeoutMs: Math.max(consult.voiceConfig.responseTimeoutMs, MSTEAMS_SHOW_TIMEOUT_MS),
        // show is a controlled, single-image production run — trust the local image it produces
        // (general consults leave this false, so an arbitrary local path is never displayed).
        trustLocalMedia: true,
      });
      const shown = await forwardDisplayImages(result.mediaPaths ?? [], toTileCaption(result.text));
      rtSession.submitToolResult(event.callId, {
        text:
          shown > 0
            ? result.text || "I'm showing it on your screen now."
            : result.text || "Sorry, I couldn't produce an image to show.",
      });
    },
  });

  /**
   * A long task: acknowledge on the call immediately, then run the OpenClaw agent
   * in the background. The call can end while it works; the agent delivers the
   * result to the caller's Teams chat via the `message` tool when done.
   */
  function handleAsyncTask(
    event: RealtimeVoiceToolCallEvent,
    rtSession: RealtimeVoiceBridgeSession,
  ): void {
    // Media Access API: a background task processes + persists call audio and
    // delivers it to Teams chat, so it must not start before recording is active.
    if (recordingGateBlocks()) {
      logger?.debug?.(`MsteamsRealtime: task refused for ${callId} — recording not active`);
      rtSession.submitToolResult(event.callId, MSTEAMS_RECORDING_BLOCKED);
      return;
    }
    // A background task's only delivery channel is the caller's Teams chat
    // (message tool -> user:<aadId>). Without an aadId there is nowhere to
    // deliver, so refuse the task instead of acking a delivery we can't fulfill
    // and silently dropping the result.
    if (!session.caller.aadId) {
      logger?.warn(`MsteamsRealtime: task refused for ${callId} — no caller.aadId delivery target`);
      rtSession.submitToolResult(event.callId, MSTEAMS_ASYNC_TASK_NO_TARGET);
      return;
    }
    const task = readArgText(event.args, "task") ?? readArgText(event.args, "question");
    const deliverVia = readArgText(event.args, "deliverVia") === "call" ? "call" : "message";
    // No task text means nothing will run: refuse instead of acking a delivery that never
    // happens (the caller would wait for a result that silently never arrives).
    if (!task) {
      logger?.warn(`MsteamsRealtime: task refused for ${callId} — no task text in tool args`);
      rtSession.submitToolResult(event.callId, {
        text: "I didn't catch what the task is — please tell me again what you'd like me to do.",
      });
      return;
    }
    // Ack immediately so the model speaks the "I'll reach you" line and the call
    // is free to continue or hang up.
    rtSession.submitToolResult(
      event.callId,
      deliverVia === "call" ? MSTEAMS_ASYNC_TASK_ACK_CALL : MSTEAMS_ASYNC_TASK_ACK,
    );
    // Detached: not awaited and not cancelled on call teardown.
    void runAsyncTask(task, deliverVia);
  }

  async function runAsyncTask(task: string, deliverVia: "message" | "call"): Promise<void> {
    const { agentRuntime, voiceConfig, cfg } = deps;
    if (!agentRuntime || !voiceConfig || !cfg) {
      return;
    }
    const aadId = session.caller.aadId ?? undefined;
    const deliveryTarget = aadId ? `user:${aadId}` : undefined;

    const deliveryInstruction = !deliveryTarget
      ? "This task was delegated from a Microsoft Teams voice call and runs in the background; deliver the final result to the caller when complete."
      : deliverVia === "call"
        ? `This task was delegated from a live Microsoft Teams voice call and now runs in the background; the caller is no longer on the line. FIRST actually complete the task and determine the final answer. THEN deliver it by invoking the voice_call tool exactly once: action "initiate_call", to "${deliveryTarget}", mode "notify". CRITICAL: the caller hears ONLY your "message" and has NO memory of what they asked — so "message" must be a COMPLETE, STANDALONE spoken result that both restates the topic AND gives the answer in one breath. Good: "Here's the Dubai time you asked for — it's 5:41 PM." Bad (do NOT do this): a greeting, a question, "I'm calling about your request", "let me check", an empty/placeholder value, or a bare answer with no context. If you genuinely could not determine the answer, set "message" to a clear one-sentence explanation of what went wrong instead. Place the call exactly once.`
        : `This task was delegated from a live Microsoft Teams voice call and now runs in the background; the caller is no longer waiting on the line. Complete the task, then deliver the final result to the caller by calling the message tool exactly once with action "send", channel "msteams", target "${deliveryTarget}". Keep the delivered message concise.`;

    try {
      await runMsteamsConsult({
        agentRuntime,
        voiceConfig,
        cfg,
        agentId: consultAgentId,
        sessionKey: consultSessionKey,
        runIdPrefix: `voice-realtime-task:${callId}`,
        args: { question: task },
        surface: "a Microsoft Teams voice call (background task)",
        extraSystemPrompt: `${MSTEAMS_REALTIME_CONSULT_SYSTEM_PROMPT} ${deliveryInstruction}`,
        toolPolicy: consultToolPolicy,
        fastMode: false,
      });
      logger?.debug?.(`MsteamsRealtime: background task complete for ${callId}`);
    } catch (err) {
      logger?.warn(
        `MsteamsRealtime: background task failed for ${callId} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Meeting recap (#18/#22): after the call ends, run a detached agent over the call transcript and
   * post minutes to the caller's Teams chat (1:1) or the meeting thread (group). Per-person
   * attribution is real: caller turns are speaker-prefixed ("<Name>: …") from unmixed audio, so the
   * attributed transcript in the .docx is built deterministically in code. The model only authors the
   * summary prose; the document bytes and the delivery are driven by us.
   */
  async function runMeetingRecap(): Promise<void> {
    const { agentRuntime, voiceConfig, cfg } = deps;
    if (!agentRuntime || !voiceConfig || !cfg) {
      return;
    }
    const aadId = session.caller.aadId;
    const durationMin = Math.max(1, Math.round((Date.now() - callStartedAt) / 60_000));
    const callerName = session.caller.displayName ?? "the caller";
    const lines = transcript
      .map((t) => `${t.role === "assistant" ? "Assistant" : "Caller side"}: ${t.text}`)
      .join("\n");
    // Compute the delivery target ONCE and LOCK the agent run's delivery context to it, so 1:1 minutes
    // go to the caller (user:<aadId>) and a group recap to the meeting thread — and a failed/absent DM
    // reference can never fall back to the operator's own chat. (bugfix: minutes to wrong recipient)
    const isGroupRecap = humanCount >= 2 && Boolean(session.threadId?.trim());
    const recapTarget = isGroupRecap ? `conversation:${session.threadId.trim()}` : `user:${aadId}`;
    const deliveryContext = { channel: "msteams", to: recapTarget } as const;
    try {
      logger?.info(`MsteamsRealtime: posting meeting recap for ${callId}`);
      // Step 1 — the model AUTHORS the summary prose only (it does NOT write files or send anything).
      const summary = await runMsteamsConsult({
        agentRuntime,
        voiceConfig,
        cfg,
        agentId: consultAgentId,
        sessionKey: consultSessionKey,
        runIdPrefix: `voice-realtime-recap:${callId}`,
        args: {
          question:
            `Write concise meeting minutes from this Microsoft Teams call transcript.\n` +
            `Call: with ${callerName}, ~${durationMin} min, ${humanCount} human participant(s).\n` +
            `Transcript (most recent ${transcript.length} turns; "Caller side" may include multiple ` +
            `people. Some caller turns begin with "Name:" — that is real speaker attribution from ` +
            `unmixed audio; attribute statements and action items ONLY via those prefixes, and ` +
            `never guess attribution for unprefixed turns):\n${lines}`,
        },
        surface: "a Microsoft Teams call that just ended (meeting recap)",
        extraSystemPrompt:
          `${MSTEAMS_REALTIME_CONSULT_SYSTEM_PROMPT} Return ONLY the minutes as markdown with these ` +
          `headed sections, omitting empty ones: "### Key points", "### Decisions", "### Action ` +
          `items"; under each, one "- " bullet per item. Keep it brief and factual; no invented ` +
          `attribution. Do NOT write any files, do NOT call the message tool, and do NOT add any ` +
          `preamble or closing — your reply IS the minutes body.`,
        toolPolicy: consultToolPolicy,
        deliveryContext,
        fastMode: false,
      });
      const summaryText = summary.text?.trim() ?? "";

      // Step 2 — build the .docx DETERMINISTICALLY in code from the authored sections + the
      // speaker-prefixed transcript, and write it where the message tool can attach it. Best-effort:
      // on any failure we fall through to a text-only delivery (matching the prior error handling).
      const subtitle = `Call with ${callerName} — ~${durationMin} min, ${humanCount} human participant(s).`;
      let docxPath: string | undefined;
      try {
        const buffer = await buildMinutesDocx({
          title: "Meeting minutes",
          subtitle,
          sections: parseMinutesSections(summaryText),
          transcript: transcript.map(
            (t): MinutesTranscriptEntry => ({ role: t.role, text: t.text }),
          ),
        });
        // Prefer the agent's workspace dir (an allowed outbound-media local root). Fall back to the
        // OpenClaw-owned temp dir — NOT the host OS tmpdir — so the attachment stays within owned
        // roots and passes the messaging temp guard.
        let outDir = resolvePreferredOpenClawTmpDir();
        try {
          const workspaceDir = agentRuntime.resolveAgentWorkspaceDir(cfg, consultAgentId);
          if (workspaceDir) {
            await agentRuntime.ensureAgentWorkspace({ dir: workspaceDir });
            outDir = workspaceDir;
          }
        } catch {
          // keep the owned-temp fallback
        }
        docxPath = join(outDir, `meeting-minutes-${callId}.docx`);
        await writeFile(docxPath, buffer);
      } catch (err) {
        logger?.warn(
          `MsteamsRealtime: minutes docx build failed for ${callId}, sending text-only — ${err instanceof Error ? err.message : String(err)}`,
        );
        docxPath = undefined;
      }

      // Step 3 — DELIVER via the existing message tool on the LOCKED delivery context: send the
      // authored minutes body, attaching the prebuilt .docx (when available) as the media param. The
      // model performs only the mechanical send; it does not author the document or pick a recipient.
      const bodyForSend = summaryText || "Meeting minutes are attached.";
      const mediaInstruction = docxPath
        ? `Attach the local file at this absolute path as the message tool's media parameter on the ` +
          `SAME send: ${docxPath}. If the attachment fails, send the text-only message. `
        : "";
      await runMsteamsConsult({
        agentRuntime,
        voiceConfig,
        cfg,
        agentId: consultAgentId,
        sessionKey: consultSessionKey,
        runIdPrefix: `voice-realtime-recap-send:${callId}`,
        args: {
          question:
            `Deliver these meeting minutes verbatim. Do not rewrite, summarize, or add to them.\n\n` +
            bodyForSend,
        },
        surface: "delivering meeting minutes from a Microsoft Teams call that just ended",
        extraSystemPrompt:
          `${MSTEAMS_REALTIME_CONSULT_SYSTEM_PROMPT} Call the message tool exactly once with action ` +
          `"send", channel "msteams", target "${recapTarget}", and the provided minutes as the text. ` +
          mediaInstruction +
          `Do NOT send it to any other conversation; if that exact target cannot be reached, do not ` +
          `send. Do NOT author or edit the minutes content — send it as given.`,
        toolPolicy: consultToolPolicy,
        // Lock the run's delivery context to the caller/meeting thread so a missing DM reference can't
        // make the message tool fall back to the operator's default chat. (bugfix: minutes recipient)
        deliveryContext,
        // Trust the local docx we just produced so the message tool will attach it.
        trustLocalMedia: Boolean(docxPath),
        fastMode: false,
      });
    } catch (err) {
      logger?.warn(
        `MsteamsRealtime: meeting recap failed for ${callId} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Single teardown for every way the bridge can end: the returned `close` (caller hangup /
   * manager hangup), the provider's `onClose` (realtime WS dropped), and a failed `connect()`.
   * Passing a `reason` also closes the Teams worker session so the call actually ends; the
   * meeting recap and the vision timer are handled identically on every path.
   */
  function closeCall(reason?: string): void {
    if (closed) {
      return;
    }
    closed = true;
    // Meeting recap (#18/#22): on call end, post minutes to the caller's Teams chat. Opt-in via
    // msteams.meetingRecap; skipped for notify call-backs (a delivered result is not a meeting)
    // and for calls with no real conversation. Detached — teardown never waits on it.
    if (
      deps.voiceConfig?.msteams?.meetingRecap === true &&
      !deps.onDeliveryComplete &&
      recordingActive &&
      session.caller.aadId &&
      transcript.length >= 4
    ) {
      void runMeetingRecap();
    }
    if (visionPushTimer) {
      clearInterval(visionPushTimer);
      visionPushTimer = undefined;
    }
    try {
      realtime.close();
    } catch {
      // best-effort teardown
    }
    // A manager-driven hangup or bridge-side failure passes a reason — also close the Teams worker
    // session so the call actually ends. A caller-driven session.end passes none (the session is
    // already closing).
    if (reason !== undefined) {
      try {
        session.close(reason);
      } catch {
        // best-effort teardown
      }
    }
  }

  void realtime.connect().catch((err: unknown) => {
    logger?.error(
      `MsteamsRealtime: connect failed — ${err instanceof Error ? err.message : String(err)}`,
    );
    // The model never came up; close the Teams session so the worker hangs up
    // cleanly instead of leaving the caller in silence.
    closeCall("realtime-unavailable");
  });

  return {
    pushAudio: (pcm16k: Buffer) => {
      if (closed || pcm16k.length === 0) {
        return;
      }
      // Recording gate: do not forward caller audio to the realtime provider until the
      // call's recording status is active (Microsoft Media Access API obligation, matching
      // the streaming path and every other media-derived path here). No-op when
      // requireRecordingStatus is false.
      if (recordingGateBlocks()) {
        return;
      }
      // Half-duplex echo guard (on by default): while our own audio is playing OUT on the call (the
      // playout estimate, not last-send — the model streams faster than realtime), the caller leg can
      // carry it back as acoustic echo; feeding that to the model's server-VAD makes it answer itself.
      if (shouldSuppressEcho(pcm16k, playbackEndAt, { ...deps, allowBargeIn: callerTurnStarted })) {
        return;
      }
      const pcm24k = resamplePcm(pcm16k, MSTEAMS_SAMPLE_RATE_HZ, REALTIME_SAMPLE_RATE_HZ);
      realtime.sendAudio(pcm24k);
    },
    notifyInboundFrame: () => {
      pushLatestFrameToModel();
    },
    setHumanCount: (count: number) => {
      humanCount = count;
    },
    notifyDtmf: (digit: string) => {
      // Recording gate: DTMF tones are in-band, media-derived caller input, so they are subject to the
      // same Media Access API obligation as audio/video/transcripts — do not forward or record them to
      // the model before the call's recording status is active. No-op when requireRecordingStatus is off.
      if (recordingGateBlocks()) {
        return;
      }
      // Surface the keypress to the model as a user message so it can drive IVR-style flows
      // ("press 1 to…"). Recorded in the transcript like any caller turn.
      const text = `[The caller pressed the "${digit}" key on their phone keypad.]`;
      recordTranscript("user", text);
      realtime.sendUserMessage(text);
    },
    setCurrentSpeaker: (name: string | undefined) => {
      currentSpeakerName = name;
    },
    setRecordingActive: (active: boolean) => {
      recordingActive = active;
      // Outbound call-back: the callee has now ANSWERED — speak the deferred greeting (the delivered
      // result), so it isn't lost to a ringing phone and the model doesn't sit idle free-associating.
      if (
        active &&
        deps.greetingOnRecordingActive &&
        deps.greetingInstructions &&
        !greetingTriggered
      ) {
        greetingTriggered = true;
        try {
          realtime.triggerGreeting(deps.greetingInstructions);
        } catch (err) {
          logger?.warn(
            `MsteamsRealtime: deferred greeting failed for ${callId} — ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    },
    close: (reason?: string) => {
      closeCall(reason);
    },
  };
}
