import crypto from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  RealtimeTranscriptionProviderConfig,
  RealtimeTranscriptionProviderPlugin,
  RealtimeTranscriptionSession,
} from "openclaw/plugin-sdk/realtime-transcription";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { isInboundCallAllowed } from "../allowlist.js";
import { resolveVoiceCallEffectiveConfig, type VoiceCallConfig } from "../config.js";
import type { CoreAgentDeps, CoreConfig } from "../core-bridge.js";
import { inferEmotion } from "../expression.js";
import {
  type GroupCallGateConfig,
  resolveGroupCallGateConfig,
  shouldRespondToGroupTurn,
} from "../group-call-gate.js";
import type { CallManager } from "../manager.js";
import {
  MsteamsMediaStream,
  MSTEAMS_PCM_SAMPLE_RATE_HZ,
  type MsteamsLogger,
  type MsteamsRecordingStatus,
  type MsteamsSession,
} from "../msteams-media-stream.js";
import {
  createMsteamsRealtimeCall,
  type MsteamsRealtimeCall,
  type MsteamsRealtimeDeps,
} from "../msteams-realtime.js";
import type { MsteamsTtsProvider } from "../msteams-tts.js";
import { describeMsteamsVideoFrameOwner, type MsteamsVideoFrame } from "../msteams-video-frame.js";
import { generateVoiceResponse } from "../response-generator.js";
import { chunkAudio } from "../telephony-audio.js";
import type {
  EndReason,
  GetCallStatusInput,
  GetCallStatusResult,
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  NormalizedEvent,
  PlayTtsInput,
  ProviderWebhookParseResult,
  StartListeningInput,
  StopListeningInput,
  WebhookContext,
  WebhookParseOptions,
  WebhookVerificationResult,
} from "../types.js";
import { estimateVisemes } from "../viseme-estimate.js";
import { VisionBudget } from "../vision-budget.js";
import type { VoiceCallProvider } from "./base.js";

export interface MsteamsProviderOptions {
  port?: number;
  bindAddress?: string;
  path?: string;
  sharedSecret?: string;
  /** Outbound calling: ask the worker to place a Teams call to a user. */
  outbound?: {
    enabled: boolean;
    workerBaseUrl?: string;
    tenantId?: string;
    answerTimeoutMs?: number;
  };
  logger?: MsteamsLogger;
}

/** Resolved realtime-transcription provider plus the config needed per session. */
interface MsteamsTranscriptionDeps {
  provider: RealtimeTranscriptionProviderPlugin;
  providerConfig: RealtimeTranscriptionProviderConfig;
  cfg?: OpenClawConfig;
}

/** Host dependencies needed to generate agent responses for a turn. */
interface MsteamsResponseRuntime {
  coreConfig: CoreConfig;
  agentRuntime: CoreAgentDeps;
  voiceConfig: VoiceCallConfig;
}

/** Per-call bridge state, keyed by the Teams callId (== providerCallId). */
interface MsteamsCallState {
  providerCallId: string;
  /** Internal CallManager call id (UUID) for this Teams call. */
  internalCallId: string;
  session: MsteamsSession;
  sttSession: RealtimeTranscriptionSession;
  /** Aborts the in-flight TTS playback (barge-in / hangup). */
  ttsAbort: AbortController | null;
  /** Monotonic outbound audio.frame sequence number for this call. */
  outboundSeq: number;
  /** Monotonic outbound presentation timestamp (ms) for this call. */
  outboundTimestampMs: number;
  /** Current assistant turn id (used for assistant.cancel on barge-in). */
  turnId: number;
  /** Teams recording status — transcripts are only persisted while this is true. */
  recordingActive: boolean;
  /** Caller audio captured before the STT session finished connecting. */
  pendingAudio: Buffer[];
  /** Last video frame (bytes) already attached to a streaming turn, to skip re-sending it unchanged. */
  lastVisionFrame?: string;
  /** Human participants on the call (excludes the bot). >= 2 ⇒ group/meeting; default 1 (1:1). */
  humanCount: number;
  /** Epoch ms of the last turn that addressed the bot, for the group-call follow-up window. */
  lastAddressedAt?: number;
}

/** PCM 16 kHz, 16-bit mono — the wire format both directions of the Teams bridge. */
const MSTEAMS_SAMPLE_RATE_HZ = MSTEAMS_PCM_SAMPLE_RATE_HZ;
const FRAME_DURATION_MS = 20;
const BYTES_PER_SAMPLE = 2;
/** 16000 Hz * 0.02 s * 2 bytes = 640 bytes per 20 ms mono frame. */
const FRAME_BYTES = (MSTEAMS_SAMPLE_RATE_HZ / 1000) * FRAME_DURATION_MS * BYTES_PER_SAMPLE;

/** Cap the pre-connect audio buffer at ~5 s of 20 ms frames to bound memory. */
const MAX_PRECONNECT_FRAMES = 250;

/**
 * Default safety-net wait (ms) for a placed outbound call's media WebSocket to attach before
 * finalizing the CallRecord, so an unanswered / failed-to-connect call doesn't leak a pending entry
 * or a perpetually-"active" CallRecord. Overridable via `msteams.outbound.answerTimeoutMs`. 120s is
 * comfortably longer than a typical Teams ring-to-answer (~30-60s before missed/voicemail), so it
 * fires only on a genuinely dead placement, not a slow answer.
 */
const OUTBOUND_ANSWER_TIMEOUT_DEFAULT_MS = 120_000;

/**
 * How long a timed-out outbound callId is remembered (so a late callee answer is closed instead of
 * mistaken for a fresh inbound call). After this it self-expires, so the Set can't grow unbounded
 * from calls that never connect late. Comfortably longer than any realistic late-answer window.
 */
const OUTBOUND_TIMED_OUT_RETENTION_MS = 5 * 60_000;

/**
 * Microsoft Teams voice-call provider.
 *
 * Unlike Twilio/Telnyx/Plivo, Teams calls do not arrive on the voice-call
 * webhook plane. An external Windows-side bridge worker owns the Graph calling
 * notification endpoint and opens a per-call WebSocket to OpenClaw when a call
 * is answered. The real transport lives in `MsteamsMediaStream`; this provider
 * wires that transport into the existing voice-call machinery (CallManager,
 * realtime transcription, response generation, telephony TTS), mirroring the
 * streaming Twilio provider but speaking PCM 16 kHz instead of mu-law 8 kHz.
 */
export class MsteamsProvider implements VoiceCallProvider {
  readonly name = "msteams" as const;

  private readonly logger?: MsteamsLogger;

  // Bound only when port + path + sharedSecret are all provided. Without it
  // the provider is still usable for typecheck / runtime construction, but the
  // WebSocket server never listens — useful for unit tests and disabled-mode.
  private readonly mediaStream?: MsteamsMediaStream;

  private manager: CallManager | null = null;
  private transcription: MsteamsTranscriptionDeps | null = null;
  private ttsProvider: MsteamsTtsProvider | null = null;
  private responseRuntime: MsteamsResponseRuntime | null = null;

  // When set, calls are bridged to a realtime speech-to-speech model instead of
  // the STT -> agent -> TTS pipeline (the low-latency path).
  private realtimeDeps: MsteamsRealtimeDeps | null = null;

  private readonly calls = new Map<string, MsteamsCallState>();
  private readonly realtimeCalls = new Map<string, MsteamsRealtimeCall>();

  /**
   * Latest sampled inbound video frame per call+source, so the agent can "look" at what the caller
   * is showing (camera / screen-share). Recording-gated and path-agnostic (works for both the
   * streaming and realtime paths). Only the most recent frame per source is kept.
   */
  private readonly latestVideoFrames = new Map<
    string,
    { camera?: MsteamsVideoFrame; screenshare?: MsteamsVideoFrame }
  >();
  /** Recording-active state per call (both paths), used to gate inbound video like audio. */
  private readonly recordingActiveByCall = new Map<string, boolean>();

  /** Per-call vision spend cap (streaming frame attach). Lazily built from config. */
  private visionBudgetInstance: VisionBudget | null = null;

  /** Shared secret (also used to sign the outbound place-call request). */
  private readonly sharedSecret?: string;
  /** Outbound calling config (worker base URL + tenant + optional answer timeout). */
  private readonly outbound?: {
    enabled: boolean;
    workerBaseUrl?: string;
    tenantId?: string;
    answerTimeoutMs?: number;
  };
  /**
   * Calls OpenClaw placed via the worker, keyed by the worker/Graph callId it
   * returned, awaiting their media WebSocket `session.start` to attach.
   */
  private readonly pendingOutbound = new Map<
    string,
    { internalCallId: string; from: string; to: string; message?: string }
  >();
  /**
   * Outbound calls bridged via the realtime path (providerCallId -> internal
   * callId). Realtime calls don't otherwise touch CallManager, so this lets
   * session.end finalize the CallRecord that manager.initiateCall created.
   */
  private readonly outboundRealtimeInternalIds = new Map<string, string>();

  /** No-answer timers per placed outbound call; cleared when the media WS attaches. */
  private readonly pendingOutboundTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * CallIds whose outbound placement timed out (CallRecord already finalized as ended). Guards a
   * late callee answer from being mistaken for a fresh inbound call. Cleared on late-connect or end.
   */
  private readonly timedOutOutbound = new Set<string>();
  /** Auto-expiry timers for {@link timedOutOutbound} entries, so the Set can't grow without bound. */
  private readonly timedOutOutboundExpiry = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: MsteamsProviderOptions) {
    const { port, bindAddress, path, sharedSecret, outbound, logger } = options;
    this.logger = logger;
    this.sharedSecret = sharedSecret;
    this.outbound = outbound;
    if (port !== undefined && path && sharedSecret) {
      this.mediaStream = new MsteamsMediaStream({
        port,
        bindAddress,
        path,
        sharedSecret,
        logger,
        onSessionStart: (session) => this.handleSessionStart(session),
        onSessionEnd: (info) => this.handleSessionEnd(info),
        onAudioFrame: (frame) => this.handleAudioFrame(frame),
        onVideoFrame: (frame) => this.handleVideoFrame(frame),
        onParticipants: (info) => this.handleParticipants(info),
        onRecordingStatus: (info) => this.handleRecordingStatus(info),
      });
    } else {
      logger?.warn(
        "MsteamsProvider: msteams.port / msteams.path / msteams.sharedSecret not all set; WebSocket server not started",
      );
    }
  }

  /**
   * Bind the Teams bridge WebSocket server. Called from the voice-call runtime's
   * startup path and awaited, so a failed bind aborts runtime initialization
   * (and is cleaned up) instead of being swallowed. No-op when the provider was
   * constructed without a complete config (e.g. unit tests).
   */
  async start(): Promise<void> {
    if (!this.mediaStream) {
      this.logger?.warn(
        "MsteamsProvider: start() called without a complete config; WebSocket server not started",
      );
      return;
    }
    await this.mediaStream.start();
  }

  // ---------------------------------------------------------------------------
  // Dependency injection (called by the runtime, mirroring Twilio's setters).
  // ---------------------------------------------------------------------------

  setCallManager(manager: CallManager): void {
    this.manager = manager;
  }

  setTranscriptionProvider(
    provider: RealtimeTranscriptionProviderPlugin,
    providerConfig: RealtimeTranscriptionProviderConfig,
    cfg?: OpenClawConfig,
  ): void {
    this.transcription = { provider, providerConfig, cfg };
  }

  setTtsProvider(provider: MsteamsTtsProvider): void {
    this.ttsProvider = provider;
  }

  setResponseRuntime(runtime: MsteamsResponseRuntime): void {
    this.responseRuntime = runtime;
  }

  /**
   * Enable realtime (speech-to-speech) mode. When set, each Teams call is bridged
   * directly to the realtime model rather than the STT -> agent -> TTS pipeline.
   */
  setRealtimeRuntime(deps: MsteamsRealtimeDeps): void {
    this.realtimeDeps = deps;
    // Share ONE VisionBudget across streaming + realtime so handleSessionEnd's release() frees both
    // paths' per-call windows (previously the realtime budget's callId entries leaked forever).
    if (deps.visionBudget) {
      this.visionBudgetInstance = deps.visionBudget;
    }
  }

  /**
   * Stop the underlying WebSocket server. Called from the voice-call runtime's
   * teardown path. No-op if the provider was constructed without a full config.
   */
  async stop(): Promise<void> {
    for (const providerCallId of Array.from(this.calls.keys())) {
      this.teardownCall(providerCallId, { closeSession: true, reason: "shutdown" });
    }
    for (const providerCallId of Array.from(this.realtimeCalls.keys())) {
      this.disposeRealtimeCall(providerCallId);
    }
    // Cancel any outstanding outbound timers so they can't fire after teardown.
    for (const providerCallId of Array.from(this.pendingOutboundTimers.keys())) {
      this.clearOutboundTimer(providerCallId);
    }
    for (const providerCallId of Array.from(this.timedOutOutboundExpiry.keys())) {
      this.clearTimedOutOutbound(providerCallId);
    }
    await this.mediaStream?.stop();
  }

  // ---------------------------------------------------------------------------
  // WebSocket lifecycle wiring.
  // ---------------------------------------------------------------------------

  /**
   * Create the streaming STT session + per-call state, register it in {@link calls}, and start
   * connect() — flushing pre-connect audio on success, tearing the call down on failure. Shared by
   * the inbound and outbound session-start paths (callers differ only in the internal call id).
   * Requires {@link transcription} to be wired (callers guard this before calling).
   */
  private createStreamingCallState(
    session: MsteamsSession,
    providerCallId: string,
    internalCallId: string,
  ): void {
    const transcription = this.transcription;
    if (!transcription) {
      return;
    }
    const sttSession = transcription.provider.createSession({
      cfg: transcription.cfg,
      providerConfig: transcription.providerConfig,
      onPartial: (partial) => {
        this.logger?.debug?.(`MsteamsProvider: partial ${providerCallId} chars=${partial.length}`);
      },
      onTranscript: (transcript) => this.handleTranscript(providerCallId, transcript),
      onSpeechStart: () => this.handleSpeechStart(providerCallId),
      onError: (error) => {
        this.logger?.warn(`MsteamsProvider: STT error ${providerCallId} — ${error.message}`);
      },
    });

    const state: MsteamsCallState = {
      providerCallId,
      internalCallId,
      session,
      sttSession,
      ttsAbort: null,
      outboundSeq: 0,
      outboundTimestampMs: 0,
      turnId: 0,
      recordingActive: session.recordingStatus === "active",
      pendingAudio: [],
      humanCount: 1,
    };
    this.calls.set(providerCallId, state);

    void sttSession
      .connect()
      .then(() => this.flushPendingAudio(providerCallId))
      .catch((err: unknown) => {
        this.logger?.error(
          `MsteamsProvider: STT connect failed for ${providerCallId} — ${describeError(err)}`,
        );
        // No transcription path means the caller would sit in silence; tear the call down
        // (hang up the worker session) instead of leaving it open.
        this.failCall(providerCallId, "stt-connect-failed");
      });
  }

  private handleSessionStart(session: MsteamsSession): void {
    const providerCallId = session.callId;
    // Caller identity drives both the inbound-policy check and the session key
    // (per-phone memory). Prefer the Teams AAD object id; when it is absent fall
    // back to a per-call-unique value rather than a shared literal so distinct
    // anonymous callers never collide into one session (cross-caller memory
    // bleed) or match an allowlist as a generic caller.
    const from = session.caller.aadId ?? `teams:${providerCallId}`;
    // Seed the recording gate for inbound video from the session's initial status.
    this.recordingActiveByCall.set(providerCallId, session.recordingStatus === "active");

    // Outbound: a call WE placed is connecting back. Attach it to the existing
    // CallRecord (created by manager.initiateCall) instead of registering a new
    // inbound call, and skip inbound-policy (we initiated it).
    const pending = this.pendingOutbound.get(providerCallId);
    if (pending) {
      this.pendingOutbound.delete(providerCallId);
      this.clearOutboundTimer(providerCallId);
      this.handleOutboundSessionStart(session, pending);
      return;
    }

    // A placed outbound call whose no-answer timer already fired (CallRecord finalized as ended).
    // If the callee answers late, don't treat the media WS as a fresh inbound call — close it.
    if (this.clearTimedOutOutbound(providerCallId)) {
      this.logger?.warn(
        `MsteamsProvider: late connect for timed-out outbound call ${providerCallId}; closing (already finalized)`,
      );
      session.close("timed-out");
      return;
    }

    // Realtime mode: bridge the call straight to the speech-to-speech model.
    // It does not route through CallManager, so the inbound-call policy is
    // enforced here (mirroring the manager check the streaming path relies on).
    if (this.realtimeDeps) {
      if (this.realtimeCalls.has(providerCallId)) {
        this.logger?.warn(
          `MsteamsProvider: duplicate realtime session.start for ${providerCallId}`,
        );
        return;
      }
      if (
        !isInboundCallAllowed(this.realtimeDeps.inboundPolicy, this.realtimeDeps.allowFrom, from)
      ) {
        this.logger?.warn(
          `MsteamsProvider: realtime call ${providerCallId} rejected by inbound policy (from=${from})`,
        );
        session.close("rejected");
        return;
      }
      const realtimeCall = createMsteamsRealtimeCall({
        session,
        deps: {
          ...this.realtimeDeps,
          // Per-call accessor for the look_at_screen vision tool (inbound video only).
          getLatestFrame: (source) => this.getLatestVideoFrame(providerCallId, source),
        },
      });
      this.realtimeCalls.set(providerCallId, realtimeCall);
      this.logger?.info(
        `MsteamsProvider: realtime session.start callId=${providerCallId} threadId=${session.threadId} caller.aadId=${session.caller.aadId ?? "teams"}`,
      );
      return;
    }

    if (!this.manager || !this.transcription) {
      this.logger?.error(
        `MsteamsProvider: session.start for ${providerCallId} before dependencies were wired; closing`,
      );
      session.close("not-ready");
      return;
    }
    if (this.calls.has(providerCallId)) {
      this.logger?.warn(`MsteamsProvider: duplicate session.start for ${providerCallId}`);
      return;
    }

    const to = this.responseRuntime?.voiceConfig.fromNumber ?? "msteams";

    // Register the call with the manager. `call.initiated` creates the record
    // (subject to inbound policy); `call.answered` starts timers and triggers
    // the configured initial greeting via provider.playTts.
    this.manager.processEvent(
      this.buildEvent(providerCallId, { type: "call.initiated", from, to }),
    );
    const record = this.manager.getCallByProviderCallId(providerCallId);
    if (!record) {
      this.logger?.warn(
        `MsteamsProvider: call ${providerCallId} was not registered (rejected by inbound policy?); closing`,
      );
      session.close("rejected");
      return;
    }

    // Registers state in this.calls BEFORE `call.answered` so the greeting's playTts can find it.
    this.createStreamingCallState(session, providerCallId, record.callId);

    this.manager.processEvent(this.buildEvent(providerCallId, { type: "call.answered", from, to }));
    this.logger?.info(
      `MsteamsProvider: session.start callId=${providerCallId} threadId=${session.threadId} caller.aadId=${from}`,
    );
  }

  /**
   * Attach an outbound call (one OpenClaw placed via the worker) when its media
   * WebSocket connects. The CallRecord already exists (manager.initiateCall), so
   * we wire STT/TTS state and emit `call.answered` — which drives the manager's
   * initial-message delivery (notify mode) or conversation start.
   */
  private handleOutboundSessionStart(
    session: MsteamsSession,
    pending: { internalCallId: string; from: string; to: string; message?: string },
  ): void {
    const providerCallId = session.callId;

    // Realtime mode: bridge straight to the speech-to-speech model, opening the
    // call by speaking the delivered result, then conversing.
    if (this.realtimeDeps) {
      this.handleOutboundRealtimeSessionStart(session, pending);
      return;
    }

    if (!this.manager || !this.transcription) {
      this.logger?.error(
        `MsteamsProvider: outbound session.start for ${providerCallId} before dependencies were wired; closing`,
      );
      session.close("not-ready");
      return;
    }
    if (this.calls.has(providerCallId)) {
      this.logger?.warn(`MsteamsProvider: duplicate outbound session.start for ${providerCallId}`);
      return;
    }

    this.createStreamingCallState(session, providerCallId, pending.internalCallId);

    // The CallRecord exists in "initiated"; mark it answered so the manager speaks
    // the initial message (notify) or starts the conversation.
    this.manager.processEvent(
      this.buildEvent(providerCallId, {
        type: "call.answered",
        from: pending.from,
        to: pending.to,
      }),
    );
    this.logger?.info(
      `MsteamsProvider: outbound session.start callId=${providerCallId} attached to internal ${pending.internalCallId}`,
    );
  }

  /**
   * Attach an outbound call on the realtime (speech-to-speech) path. The model
   * opens the call by speaking the delivered result (via greeting), then converses.
   * The CallRecord (from manager.initiateCall) is transitioned to answered without
   * the manager re-speaking; session.end finalizes it.
   */
  private handleOutboundRealtimeSessionStart(
    session: MsteamsSession,
    pending: { internalCallId: string; from: string; to: string; message?: string },
  ): void {
    const providerCallId = session.callId;
    if (!this.realtimeDeps) {
      session.close("not-ready");
      return;
    }
    if (this.realtimeCalls.has(providerCallId)) {
      this.logger?.warn(
        `MsteamsProvider: duplicate outbound realtime session.start for ${providerCallId}`,
      );
      return;
    }

    const greetingInstructions = pending.message
      ? `This is an OUTBOUND callback you placed to deliver a result the caller already asked for — the work is ALREADY DONE. The moment the caller answers, state this result to them directly as a finished answer. Do NOT say you will look it up, work on it, or call back; it is already complete. Deliver exactly this: "${pending.message}". Then briefly ask if they need anything else.`
      : this.realtimeDeps.greetingInstructions;
    const realtimeCall = createMsteamsRealtimeCall({
      session,
      deps: {
        ...this.realtimeDeps,
        greetingInstructions,
        // Wire vision on outbound realtime too (parity with inbound) so look_at_screen works if the
        // callee shares video on the call-back.
        getLatestFrame: (source) => this.getLatestVideoFrame(providerCallId, source),
      },
    });
    this.realtimeCalls.set(providerCallId, realtimeCall);
    this.outboundRealtimeInternalIds.set(providerCallId, pending.internalCallId);

    // The realtime model speaks the message itself (via the greeting), so clear the queued initial
    // message so the manager's answered hook does not also TTS-speak it. This deliberately REPLACES
    // the streaming notify-mode auto-hangup (speakInitialMessage -> notifyHangupDelaySec -> endCall)
    // with a conversational delivery (state the result, then offer follow-up). The call then ends via
    // the normal lifecycle — caller hangup (session.end) or the manager's idle timeout — both of which
    // now tear down the realtime bridge AND hang up the Teams call through teardownCall().
    const record = this.manager?.getCall(pending.internalCallId);
    if (record?.metadata) {
      delete record.metadata.initialMessage;
    }
    this.manager?.processEvent(
      this.buildEvent(providerCallId, {
        type: "call.answered",
        from: pending.from,
        to: pending.to,
      }),
    );
    this.logger?.info(
      `MsteamsProvider: outbound realtime session.start callId=${providerCallId} attached to internal ${pending.internalCallId}`,
    );
  }

  private handleAudioFrame(frame: { callId: string; payload: Buffer }): void {
    const realtimeCall = this.realtimeCalls.get(frame.callId);
    if (realtimeCall) {
      realtimeCall.pushAudio(frame.payload);
      return;
    }
    const state = this.calls.get(frame.callId);
    if (!state) {
      return;
    }
    // Microsoft Media Access API: caller audio is media-derived data and must not
    // be uploaded to the (external) STT provider before Teams recording status is
    // active. Drop pre-recording frames rather than buffering them across the
    // recording boundary, so STT never processes audio captured before recording.
    if (this.requireRecordingStatus() && !state.recordingActive) {
      return;
    }
    // PCM 16 kHz passes straight through (provider configured for pcm_16000).
    if (state.sttSession.isConnected()) {
      state.sttSession.sendAudio(frame.payload);
      return;
    }
    // Recording is active but the STT socket is still connecting: buffer a bounded
    // amount of opening audio so the caller's first words are not lost; flushed on
    // connect. Only recording-active frames ever reach this buffer.
    if (state.pendingAudio.length < MAX_PRECONNECT_FRAMES) {
      state.pendingAudio.push(frame.payload);
    }
  }

  /**
   * Roster size changed: track the human count so the streaming group-call gate knows 1:1 vs
   * meeting. NOTE: this only updates the streaming call state. The realtime path's gate is
   * instruction-based (the bridge exposes no response-suppress hook) and its instructions are fixed
   * at session start, so it can't act on a live count mid-call — by design it relies on the model's
   * "stay silent unless addressed" instruction rather than the roster size. Streaming is deterministic.
   */
  private handleParticipants(info: { callId: string; count: number }): void {
    const state = this.calls.get(info.callId);
    if (state) {
      state.humanCount = info.count;
    }
    this.logger?.debug?.(
      `MsteamsProvider: participants ${info.callId} humanCount=${info.count}` +
        (info.count >= 2 ? " (group)" : " (1:1)"),
    );
  }

  /** Effective group-call gate config (shared resolver applies the schema defaults). */
  private groupCallGateConfig(): GroupCallGateConfig {
    return resolveGroupCallGateConfig(this.responseRuntime?.voiceConfig.msteams?.groupCall);
  }

  /** Per-call vision spend cap (built once from config; 0 = unlimited). */
  private visionBudget(): VisionBudget {
    this.visionBudgetInstance ??= new VisionBudget(
      this.responseRuntime?.voiceConfig.msteams?.maxVisionPerMinute ?? 30,
    );
    return this.visionBudgetInstance;
  }

  /**
   * Buffer the latest inbound video frame per source so the agent can "look" at it on demand.
   * Recording-gated (Media Access API): video is media-derived data and must not be processed
   * before Teams recording is active. Only the most recent frame per source is retained.
   */
  private handleVideoFrame(info: {
    callId: string;
    source: "camera" | "screenshare";
    width: number;
    height: number;
    mime: string;
    dataBase64: string;
    ts: number;
    participantId?: string;
    participantName?: string;
  }): void {
    if (this.requireRecordingStatus() && !this.recordingActiveByCall.get(info.callId)) {
      return;
    }
    const frames = this.latestVideoFrames.get(info.callId) ?? {};
    frames[info.source] = {
      source: info.source,
      dataBase64: info.dataBase64,
      mime: info.mime,
      width: info.width,
      height: info.height,
      ts: info.ts,
      participantId: info.participantId,
      participantName: info.participantName,
    };
    this.latestVideoFrames.set(info.callId, frames);
    this.logger?.debug?.(
      `MsteamsProvider: video.frame ${info.callId} ${info.source} ${info.width}x${info.height}` +
        (info.participantName ? ` from ${info.participantName}` : ""),
    );
  }

  /**
   * The latest inbound video frame for a call. With no `source`, prefers screen-share over camera
   * (the share is usually what the caller is asking about). Undefined if none captured yet.
   */
  getLatestVideoFrame(
    providerCallId: string,
    source?: "camera" | "screenshare",
  ): MsteamsVideoFrame | undefined {
    const frames = this.latestVideoFrames.get(providerCallId);
    if (!frames) {
      return undefined;
    }
    if (source) {
      return frames[source];
    }
    return frames.screenshare ?? frames.camera;
  }

  /** Whether the Teams recording-status gate is enforced (default true). */
  private requireRecordingStatus(): boolean {
    return this.responseRuntime?.voiceConfig.msteams?.requireRecordingStatus ?? true;
  }

  /** Flush any caller audio captured while the STT session was still connecting. */
  private flushPendingAudio(providerCallId: string): void {
    const state = this.calls.get(providerCallId);
    if (!state || !state.sttSession.isConnected()) {
      return;
    }
    // Never flush buffered audio to STT while the recording gate is closed.
    if (this.requireRecordingStatus() && !state.recordingActive) {
      return;
    }
    const buffered = state.pendingAudio;
    state.pendingAudio = [];
    for (const frame of buffered) {
      state.sttSession.sendAudio(frame);
    }
  }

  /** Track Teams recording status so transcript persistence can be gated on it. */
  private handleRecordingStatus(info: { callId: string; status: MsteamsRecordingStatus }): void {
    const active = info.status === "active";
    this.recordingActiveByCall.set(info.callId, active);
    const state = this.calls.get(info.callId);
    if (state) {
      state.recordingActive = active;
      this.logger?.info(`MsteamsProvider: recording.status ${info.callId} = ${info.status}`);
    }
    // Realtime calls live in a separate map; keep their recording gate in sync so
    // the consult tool + background task respect the Media Access API too.
    const realtimeCall = this.realtimeCalls.get(info.callId);
    if (realtimeCall) {
      realtimeCall.setRecordingActive(active);
      this.logger?.info(
        `MsteamsProvider: recording.status ${info.callId} = ${info.status} (realtime)`,
      );
    }
  }

  private handleTranscript(providerCallId: string, transcript: string): void {
    const trimmed = transcript.trim();
    if (!trimmed) {
      return;
    }
    const state = this.calls.get(providerCallId);
    if (!state || !this.manager) {
      return;
    }
    // Microsoft Media Access API: media-derived data must not be persisted or
    // processed before the worker has set Teams recording status. Drop
    // transcripts until recording is confirmed active (operator can opt out via
    // msteams.requireRecordingStatus=false).
    if (this.requireRecordingStatus() && !state.recordingActive) {
      this.logger?.warn(
        `MsteamsProvider: dropping transcript for ${providerCallId} — Teams recording status not active`,
      );
      return;
    }
    // Always record the utterance (keeps the conversation transcript so the agent has heard prior
    // turns once it is addressed) — the gate only decides whether to REPLY.
    this.manager.processEvent({
      id: `msteams-speech-${providerCallId}-${Date.now()}`,
      type: "call.speech",
      callId: state.internalCallId,
      providerCallId,
      timestamp: Date.now(),
      transcript: trimmed,
      isFinal: true,
    });
    // Group-call gate: in a meeting, stay quiet until addressed by name (mirrors the chat @mention
    // gate). 1:1 calls always respond.
    const now = Date.now();
    const gate = shouldRespondToGroupTurn({
      transcript: trimmed,
      isGroup: state.humanCount >= 2,
      config: this.groupCallGateConfig(),
      lastAddressedAt: state.lastAddressedAt,
      now,
    });
    if (gate.addressed) {
      state.lastAddressedAt = now;
    }
    if (!gate.respond) {
      this.logger?.debug?.(
        `MsteamsProvider: group-call gate suppressed reply on ${providerCallId} (${state.humanCount} humans, not addressed)`,
      );
      return;
    }
    void this.respond(state, trimmed).catch((err: unknown) => {
      this.logger?.warn(
        `MsteamsProvider: failed to respond on ${providerCallId} — ${describeError(err)}`,
      );
    });
  }

  /**
   * Generate an agent reply by composing the existing exported helpers
   * (`generateVoiceResponse` + `manager.speak`), rather than duplicating the
   * webhook's `handleInboundResponse`.
   */
  private async respond(state: MsteamsCallState, userMessage: string): Promise<void> {
    if (!this.manager || !this.responseRuntime) {
      return;
    }
    const call = this.manager.getCall(state.internalCallId);
    if (!call) {
      return;
    }
    const { coreConfig, agentRuntime, voiceConfig } = this.responseRuntime;
    const numberRouteKey =
      typeof call.metadata?.numberRouteKey === "string" ? call.metadata.numberRouteKey : call.to;
    const effectiveConfig = resolveVoiceCallEffectiveConfig(voiceConfig, numberRouteKey).config;

    // Inbound vision (streaming path): when the caller is sharing video, attach the latest frame
    // so the agent can answer visual questions in the same turn (the realtime path uses the
    // look_at_screen tool; the streaming agent runs per-turn, so we attach the frame directly).
    // getLatestVideoFrame only returns recording-gated frames, so this is off until recording is active.
    // Rate-limit: only attach the frame when it changed since the last turn — a static screen isn't
    // re-sent every turn (the agent retains it in context), bounding image cost.
    const frame = this.getLatestVideoFrame(state.providerCallId);
    let images: Array<{ type: "image"; data: string; mimeType: string }> | undefined;
    let userMessageForModel = userMessage;
    // Attach the latest (changed) frame so the agent is visually aware each turn — bounded by the
    // per-call vision budget so continuous perception can't run up unbounded model cost.
    if (
      frame &&
      frame.dataBase64 !== state.lastVisionFrame &&
      this.visionBudget().tryConsume(state.providerCallId, Date.now())
    ) {
      images = [{ type: "image", data: frame.dataBase64, mimeType: frame.mime }];
      state.lastVisionFrame = frame.dataBase64;
      // Tell the model whose tile it is (group calls): without attribution the agent can't reason
      // about "who is saying what". Best-effort — omitted for anonymous/guest/1:1 frames.
      const owner = describeMsteamsVideoFrameOwner(frame);
      if (owner) {
        userMessageForModel = `[Attached image is ${owner}]\n${userMessage}`;
      }
    }

    const result = await generateVoiceResponse({
      voiceConfig: effectiveConfig,
      coreConfig,
      agentRuntime,
      callId: state.internalCallId,
      sessionKey: call.sessionKey,
      from: call.from,
      transcript: call.transcript,
      userMessage: userMessageForModel,
      images,
    });

    if (result.error) {
      this.logger?.warn(`MsteamsProvider: response generation error: ${result.error}`);
      return;
    }
    if (result.text) {
      await this.manager.speak(state.internalCallId, result.text);
    }
  }

  /** Barge-in: stop in-flight playback and tell the worker to flush its buffer. */
  private handleSpeechStart(providerCallId: string): void {
    const state = this.calls.get(providerCallId);
    if (!state) {
      return;
    }
    state.ttsAbort?.abort();
    state.ttsAbort = null;
    state.session.send({ type: "assistant.cancel", turnId: state.turnId });
  }

  private handleSessionEnd(info: { callId: string; reason: string }): void {
    this.latestVideoFrames.delete(info.callId);
    this.recordingActiveByCall.delete(info.callId);
    this.visionBudgetInstance?.release(info.callId);
    this.clearOutboundTimer(info.callId);
    this.clearTimedOutOutbound(info.callId);
    // Outbound realtime calls have a CallRecord (manager.initiateCall); read it before disposal
    // clears the mapping, then finalize it. Caller-driven session.end passes no close reason.
    const internalCallId = this.outboundRealtimeInternalIds.get(info.callId);
    if (this.disposeRealtimeCall(info.callId)) {
      if (internalCallId && this.manager) {
        this.manager.processEvent({
          id: `msteams-ended-${info.callId}-${Date.now()}`,
          type: "call.ended",
          callId: internalCallId,
          providerCallId: info.callId,
          timestamp: Date.now(),
          reason: mapEndReason(info.reason),
        });
      }
      return;
    }
    const state = this.teardownCall(info.callId, { closeSession: false });
    if (!state || !this.manager) {
      return;
    }
    this.manager.processEvent({
      id: `msteams-ended-${info.callId}-${Date.now()}`,
      type: "call.ended",
      callId: state.internalCallId,
      providerCallId: info.callId,
      timestamp: Date.now(),
      reason: mapEndReason(info.reason),
    });
  }

  /**
   * Close + forget a realtime call's bridge and its outbound CallRecord mapping.
   * Pass a `reason` to also hang up the Teams worker session (manager-driven hangup);
   * omit it for a caller-driven `session.end` that is already closing. Returns the
   * disposed call, or undefined if no realtime call was registered for the id.
   */
  private disposeRealtimeCall(
    providerCallId: string,
    reason?: string,
  ): MsteamsRealtimeCall | undefined {
    const realtimeCall = this.realtimeCalls.get(providerCallId);
    if (!realtimeCall) {
      return undefined;
    }
    this.realtimeCalls.delete(providerCallId);
    this.outboundRealtimeInternalIds.delete(providerCallId);
    realtimeCall.close(reason);
    return realtimeCall;
  }

  /** Abort playback, close the STT session, and drop per-call state. */
  private teardownCall(
    providerCallId: string,
    options: { closeSession: boolean; reason?: string },
  ): MsteamsCallState | undefined {
    // Realtime calls have no streaming `this.calls` state, so close + remove the realtime bridge here:
    // a manager-driven hangup (idle timeout, notify auto-hangup, explicit endCall) must tear down the
    // realtime session and hang up the Teams call too — not only inbound/streaming sessions.
    this.disposeRealtimeCall(
      providerCallId,
      options.closeSession ? (options.reason ?? "completed") : undefined,
    );
    const state = this.calls.get(providerCallId);
    if (!state) {
      return undefined;
    }
    this.calls.delete(providerCallId);
    state.ttsAbort?.abort();
    state.ttsAbort = null;
    try {
      state.sttSession.close();
    } catch (err) {
      this.logger?.warn(
        `MsteamsProvider: error closing STT for ${providerCallId} — ${describeError(err)}`,
      );
    }
    if (options.closeSession) {
      state.session.close(options.reason ?? "completed");
    }
    return state;
  }

  /**
   * Tear down a call that cannot proceed (e.g. STT failed to connect): close the
   * worker session and notify the CallManager so the call does not linger as
   * active with no media path.
   *
   * Streaming-only: the sole caller is createStreamingCallState's STT-connect
   * failure. Realtime calls have no STT session and never reach here — if that
   * ever changes, fire call.ended for them directly (teardownCall returns
   * undefined for realtime, so the !state guard below would swallow the notify).
   */
  private failCall(providerCallId: string, reason: string): void {
    const state = this.teardownCall(providerCallId, { closeSession: true, reason });
    if (!state || !this.manager) {
      return;
    }
    this.manager.processEvent({
      id: `msteams-failed-${providerCallId}-${Date.now()}`,
      type: "call.ended",
      callId: state.internalCallId,
      providerCallId,
      timestamp: Date.now(),
      reason: mapEndReason(reason),
    });
  }

  /** Clear (and forget) the no-answer timer for a placed outbound call. */
  private clearOutboundTimer(providerCallId: string): void {
    const timer = this.pendingOutboundTimers.get(providerCallId);
    if (timer) {
      clearTimeout(timer);
      this.pendingOutboundTimers.delete(providerCallId);
    }
  }

  /** Forget a timed-out outbound callId and cancel its pending auto-expiry timer. */
  private clearTimedOutOutbound(providerCallId: string): boolean {
    const timer = this.timedOutOutboundExpiry.get(providerCallId);
    if (timer) {
      clearTimeout(timer);
      this.timedOutOutboundExpiry.delete(providerCallId);
    }
    return this.timedOutOutbound.delete(providerCallId);
  }

  /**
   * A placed outbound call never connected back within the timeout (no answer,
   * declined, or the worker failed after returning a callId). Drop the pending
   * entry and finalize the CallRecord so the call doesn't linger as active.
   */
  private finalizeUnansweredOutbound(providerCallId: string): void {
    this.pendingOutboundTimers.delete(providerCallId);
    const pending = this.pendingOutbound.get(providerCallId);
    if (!pending) {
      return;
    }
    this.pendingOutbound.delete(providerCallId);
    // Remember it briefly so a late callee answer isn't mistaken for a fresh inbound call, but
    // self-expire so the Set can't grow without bound from calls that never connect late.
    this.timedOutOutbound.add(providerCallId);
    const expiry = setTimeout(
      () => this.clearTimedOutOutbound(providerCallId),
      OUTBOUND_TIMED_OUT_RETENTION_MS,
    );
    expiry.unref?.(); // don't keep the process alive just for this cleanup
    this.timedOutOutboundExpiry.set(providerCallId, expiry);
    this.logger?.warn(
      `MsteamsProvider: outbound call ${providerCallId} did not connect within ${this.outbound?.answerTimeoutMs ?? OUTBOUND_ANSWER_TIMEOUT_DEFAULT_MS}ms; finalizing`,
    );
    if (this.manager) {
      this.manager.processEvent({
        id: `msteams-noanswer-${providerCallId}-${Date.now()}`,
        type: "call.ended",
        callId: pending.internalCallId,
        providerCallId,
        timestamp: Date.now(),
        reason: mapEndReason("outbound no-answer timeout"),
      });
    }
  }

  private buildEvent(
    providerCallId: string,
    fields: { type: "call.initiated" | "call.answered"; from: string; to: string },
  ): NormalizedEvent {
    return {
      id: `msteams-${fields.type}-${providerCallId}-${Date.now()}`,
      type: fields.type,
      callId: providerCallId,
      providerCallId,
      timestamp: Date.now(),
      direction: "inbound",
      from: fields.from,
      to: fields.to,
    };
  }

  // ---------------------------------------------------------------------------
  // VoiceCallProvider surface.
  // ---------------------------------------------------------------------------

  verifyWebhook(_ctx: WebhookContext): WebhookVerificationResult {
    // Teams does not use the voice-call webhook plane — accept by default so
    // the manager does not reject incoming traffic. Real auth lives on the
    // WebSocket upgrade (see `MsteamsMediaStream`).
    return { ok: true };
  }

  parseWebhookEvent(
    _ctx: WebhookContext,
    _options?: WebhookParseOptions,
  ): ProviderWebhookParseResult {
    // No webhook events to parse — the WS provides the lifecycle.
    return { events: [], statusCode: 204 };
  }

  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    if (!this.outbound?.enabled) {
      throw new Error(
        "MsteamsProvider.initiateCall: outbound calling is disabled (set msteams.outbound.enabled)",
      );
    }
    const workerBaseUrl = this.outbound.workerBaseUrl;
    if (!workerBaseUrl) {
      throw new Error(
        "MsteamsProvider.initiateCall: msteams.outbound.workerBaseUrl is not configured",
      );
    }
    if (!this.sharedSecret) {
      throw new Error("MsteamsProvider.initiateCall: msteams.sharedSecret is not configured");
    }
    // `to` carries the target user's AAD object id (optionally prefixed "user:").
    const userObjectId = input.to.replace(/^user:/i, "").trim();
    const tenantId = this.outbound.tenantId;
    if (!userObjectId) {
      throw new Error("MsteamsProvider.initiateCall: target userObjectId (to) is required");
    }
    if (!tenantId) {
      throw new Error("MsteamsProvider.initiateCall: msteams.outbound.tenantId is not configured");
    }

    // HMAC over `${timestampMs}.${userObjectId}` (same scheme as the WS handshake).
    const timestampMs = Date.now();
    const signature = crypto
      .createHmac("sha256", this.sharedSecret)
      .update(`${timestampMs}.${userObjectId}`)
      .digest("hex");
    const url = `${workerBaseUrl.replace(/\/+$/, "")}/api/calls`;

    // Use the SSRF-guarded fetch (required for channel/plugin network calls). The worker is
    // operator-configured trusted infra, typically co-located on loopback (e.g. 127.0.0.1:9440),
    // so private/loopback targets must be permitted.
    const { response, release } = await fetchWithSsrFGuard({
      url,
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openclawteamsbridge-timestamp": String(timestampMs),
          "x-openclawteamsbridge-signature": signature,
        },
        body: JSON.stringify({ userObjectId, tenantId }),
      },
      policy: { allowedHostnames: [new URL(url).hostname], allowPrivateNetwork: true },
    }).catch((err: unknown) => {
      throw new Error(
        `MsteamsProvider.initiateCall: request to worker failed — ${describeError(err)}`,
        { cause: err },
      );
    });

    let workerCallId: string | undefined;
    try {
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `MsteamsProvider.initiateCall: worker returned ${response.status} ${response.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`,
        );
      }
      const payload = (await response.json().catch(() => ({}))) as { callId?: string };
      workerCallId = payload.callId;
    } finally {
      await release();
    }
    if (!workerCallId) {
      throw new Error("MsteamsProvider.initiateCall: worker response did not include a callId");
    }

    // Remember the placed call; its media WS `session.start` (same callId) attaches it.
    this.pendingOutbound.set(workerCallId, {
      internalCallId: input.callId,
      from: input.from,
      to: input.to,
      message: input.message,
    });
    // No-answer guard: if the call never connects back (busy, declined, offline),
    // finalize the CallRecord after the configured timeout so it doesn't linger as active.
    const noAnswerTimer = setTimeout(
      () => this.finalizeUnansweredOutbound(workerCallId),
      this.outbound?.answerTimeoutMs ?? OUTBOUND_ANSWER_TIMEOUT_DEFAULT_MS,
    );
    noAnswerTimer.unref?.();
    this.pendingOutboundTimers.set(workerCallId, noAnswerTimer);
    this.logger?.info(
      `MsteamsProvider: outbound call placed callId=${workerCallId} -> ${userObjectId}`,
    );
    return { providerCallId: workerCallId, status: "initiated" };
  }

  async hangupCall(input: HangupCallInput): Promise<void> {
    // Manager-initiated hangup: stop playback, send AssistantCancel-equivalent
    // close, and tear down. The manager finalizes the call record itself.
    this.teardownCall(input.providerCallId, { closeSession: true, reason: input.reason });
  }

  async playTts(input: PlayTtsInput): Promise<void> {
    const state = this.calls.get(input.providerCallId);
    if (!state) {
      throw new Error(`MsteamsProvider.playTts: no active session for ${input.providerCallId}`);
    }
    if (!this.ttsProvider) {
      throw new Error("MsteamsProvider.playTts: TTS provider not configured");
    }

    // Supersede any in-flight playback for this call (e.g. rapid responses).
    state.ttsAbort?.abort();
    const abort = new AbortController();
    state.ttsAbort = abort;
    state.turnId += 1;

    // CVI Phase 6b: cue the avatar's emotion from the reply text before audio starts, so the face
    // shapes its mouth (smile/frown/surprise) as it begins talking. Best-effort — the worker ignores
    // an unknown tag, and a failed send must never block playback.
    try {
      const emotion = inferEmotion(input.text);
      this.logger?.debug?.(
        `MsteamsProvider: expression cue '${emotion}' for ${state.providerCallId}`,
      );
      state.session.send({ type: "expression", emotion });
    } catch {
      // non-fatal: expression is a cosmetic cue
    }

    // msteams-tts.ts synthesizes and resamples to PCM 16 kHz mono.
    const pcm16k = await this.ttsProvider.synthesizePcm16k(input.text);
    if (abort.signal.aborted) {
      return;
    }
    if (pcm16k.length === 0) {
      throw new Error("MsteamsProvider.playTts: TTS produced no audio");
    }

    // CVI Phase 5 (spike): send an estimated viseme timeline just ahead of the audio so the avatar can
    // shape its mouth per sound (blended over RMS openness). 16-bit mono @ 16 kHz → 2 bytes/sample.
    // Best-effort/cosmetic — the worker falls back to RMS-only if this is absent or it's an older worker.
    try {
      const durationMs = (pcm16k.length / BYTES_PER_SAMPLE / MSTEAMS_SAMPLE_RATE_HZ) * 1000;
      const marks = estimateVisemes(input.text, durationMs);
      if (marks.length > 0) {
        this.logger?.debug?.(
          `MsteamsProvider: speech.marks ${marks.length} visemes for ${state.providerCallId}`,
        );
        state.session.send({ type: "speech.marks", ts: 0, marks });
      }
    } catch {
      // non-fatal: viseme marks are a cosmetic lip-shape hint
    }

    await this.streamPcmFrames(state, pcm16k, abort.signal);

    if (state.ttsAbort === abort) {
      state.ttsAbort = null;
    }
  }

  /**
   * Chunk PCM into 20 ms / 640-byte frames and send them to the worker with
   * drift-corrected pacing, mirroring Twilio's `playTtsViaStream`. Uses an
   * absolute clock so cumulative scheduling jitter does not accumulate.
   */
  private async streamPcmFrames(
    state: MsteamsCallState,
    pcm: Buffer,
    signal: AbortSignal,
  ): Promise<void> {
    let nextFrameDueAt = Date.now() + FRAME_DURATION_MS;
    for (const frame of chunkAudio(pcm, FRAME_BYTES)) {
      if (signal.aborted) {
        return;
      }
      // The worker socket can close mid-playback (caller hangs up between frames). `session.send`
      // drops the frame silently and returns false rather than throwing, so make the failure visible:
      // abort playback so playTts/speak finalize the turn instead of advancing seq/timestamps and
      // reporting the audio as delivered on a dead socket.
      const delivered = state.session.send({
        type: "audio.frame",
        seq: state.outboundSeq,
        timestampMs: state.outboundTimestampMs,
        payloadBase64: frame.toString("base64"),
      });
      if (!delivered) {
        this.logger?.warn(
          `MsteamsProvider: audio.frame dropped for ${state.providerCallId} — Teams socket closed; aborting playback`,
        );
        throw new Error(
          `msteams audio send failed for ${state.providerCallId}: session socket closed`,
        );
      }
      state.outboundSeq += 1;
      state.outboundTimestampMs += FRAME_DURATION_MS;

      const waitMs = nextFrameDueAt - Date.now();
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      nextFrameDueAt += FRAME_DURATION_MS;
    }
  }

  async startListening(_input: StartListeningInput): Promise<void> {
    // No-op: caller audio is already streaming over the WS into the STT session
    // for the lifetime of the call.
  }

  async stopListening(_input: StopListeningInput): Promise<void> {
    // No-op: the WS keeps streaming; there is no per-turn listen gate.
  }

  async getCallStatus(input: GetCallStatusInput): Promise<GetCallStatusResult> {
    // Status is driven by the WS lifecycle, not by webhook polling. Report
    // active while a session exists; otherwise treat as terminal so the
    // manager can reap stale persisted entries on restart. Outbound realtime
    // calls live only in `realtimeCalls` (no streaming `calls` entry), so check
    // both — else an active realtime callback is reaped as terminal on restore.
    if (this.calls.has(input.providerCallId) || this.realtimeCalls.has(input.providerCallId)) {
      return { status: "in-progress", isTerminal: false };
    }
    return { status: "completed", isTerminal: true };
  }
}

function mapEndReason(reason: string): EndReason {
  const normalized = reason.toLowerCase();
  if (normalized.includes("timeout")) {
    return "timeout";
  }
  if (normalized.includes("error") || normalized.includes("fail")) {
    return "error";
  }
  // Worker-driven session.end is a caller hangup in the common case.
  return "hangup-user";
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
