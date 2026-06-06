import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  RealtimeTranscriptionProviderConfig,
  RealtimeTranscriptionProviderPlugin,
  RealtimeTranscriptionSession,
} from "openclaw/plugin-sdk/realtime-transcription";
import { isInboundCallAllowed } from "../allowlist.js";
import { resolveVoiceCallEffectiveConfig, type VoiceCallConfig } from "../config.js";
import type { CoreAgentDeps, CoreConfig } from "../core-bridge.js";
import type { CallManager } from "../manager.js";
import {
  MsteamsMediaStream,
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
import type { VoiceCallProvider } from "./base.js";

export interface MsteamsProviderOptions {
  port?: number;
  bindAddress?: string;
  path?: string;
  sharedSecret?: string;
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
}

/** A sampled inbound video frame the agent can "look" at (camera or screen-share). */
export interface MsteamsVideoFrame {
  /** Base64-encoded image (JPEG) ready to attach to a vision model. */
  dataBase64: string;
  /** MIME type, e.g. "image/jpeg". */
  mime: string;
  width: number;
  height: number;
  /** Worker capture timestamp (epoch ms). */
  ts: number;
}

/** PCM 16 kHz, 16-bit mono — the wire format both directions of the Teams bridge. */
const MSTEAMS_SAMPLE_RATE_HZ = 16_000;
const FRAME_DURATION_MS = 20;
const BYTES_PER_SAMPLE = 2;
/** 16000 Hz * 0.02 s * 2 bytes = 640 bytes per 20 ms mono frame. */
const FRAME_BYTES = (MSTEAMS_SAMPLE_RATE_HZ / 1000) * FRAME_DURATION_MS * BYTES_PER_SAMPLE;

/** Cap the pre-connect audio buffer at ~5 s of 20 ms frames to bound memory. */
const MAX_PRECONNECT_FRAMES = 250;

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

  constructor(options: MsteamsProviderOptions) {
    const { port, bindAddress, path, sharedSecret, logger } = options;
    this.logger = logger;
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
  }

  /**
   * Stop the underlying WebSocket server. Called from the voice-call runtime's
   * teardown path. No-op if the provider was constructed without a full config.
   */
  async stop(): Promise<void> {
    for (const providerCallId of Array.from(this.calls.keys())) {
      this.teardownCall(providerCallId, { closeSession: true, reason: "shutdown" });
    }
    for (const [providerCallId, realtimeCall] of Array.from(this.realtimeCalls.entries())) {
      this.realtimeCalls.delete(providerCallId);
      realtimeCall.close();
    }
    await this.mediaStream?.stop();
  }

  // ---------------------------------------------------------------------------
  // WebSocket lifecycle wiring.
  // ---------------------------------------------------------------------------

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
      const realtimeCall = createMsteamsRealtimeCall({ session, deps: this.realtimeDeps });
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

    const sttSession = this.transcription.provider.createSession({
      cfg: this.transcription.cfg,
      providerConfig: this.transcription.providerConfig,
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
      internalCallId: record.callId,
      session,
      sttSession,
      ttsAbort: null,
      outboundSeq: 0,
      outboundTimestampMs: 0,
      turnId: 0,
      recordingActive: session.recordingStatus === "active",
      pendingAudio: [],
    };
    // Register state BEFORE `call.answered` so the greeting's playTts can find it.
    this.calls.set(providerCallId, state);

    void sttSession
      .connect()
      .then(() => this.flushPendingAudio(providerCallId))
      .catch((err: unknown) => {
        this.logger?.error(
          `MsteamsProvider: STT connect failed for ${providerCallId} — ${describeError(err)}`,
        );
        // No transcription path means the caller would sit in silence; tear the
        // call down (hang up the worker session) instead of leaving it open.
        this.failCall(providerCallId, "stt-connect-failed");
      });

    this.manager.processEvent(this.buildEvent(providerCallId, { type: "call.answered", from, to }));
    this.logger?.info(
      `MsteamsProvider: session.start callId=${providerCallId} threadId=${session.threadId} caller.aadId=${from}`,
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
  }): void {
    if (this.requireRecordingStatus() && !this.recordingActiveByCall.get(info.callId)) {
      return;
    }
    const frames = this.latestVideoFrames.get(info.callId) ?? {};
    frames[info.source] = {
      dataBase64: info.dataBase64,
      mime: info.mime,
      width: info.width,
      height: info.height,
      ts: info.ts,
    };
    this.latestVideoFrames.set(info.callId, frames);
    this.logger?.debug?.(
      `MsteamsProvider: video.frame ${info.callId} ${info.source} ${info.width}x${info.height}`,
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
    this.manager.processEvent({
      id: `msteams-speech-${providerCallId}-${Date.now()}`,
      type: "call.speech",
      callId: state.internalCallId,
      providerCallId,
      timestamp: Date.now(),
      transcript: trimmed,
      isFinal: true,
    });
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

    const result = await generateVoiceResponse({
      voiceConfig: effectiveConfig,
      coreConfig,
      agentRuntime,
      callId: state.internalCallId,
      sessionKey: call.sessionKey,
      from: call.from,
      transcript: call.transcript,
      userMessage,
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
    const realtimeCall = this.realtimeCalls.get(info.callId);
    if (realtimeCall) {
      this.realtimeCalls.delete(info.callId);
      realtimeCall.close();
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

  /** Abort playback, close the STT session, and drop per-call state. */
  private teardownCall(
    providerCallId: string,
    options: { closeSession: boolean; reason?: string },
  ): MsteamsCallState | undefined {
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

  async initiateCall(_input: InitiateCallInput): Promise<InitiateCallResult> {
    // Outbound calls (OpenClaw asking the worker to dial into a meeting) are not
    // supported — the msteams provider is inbound-only.
    throw new Error("MsteamsProvider.initiateCall is not supported (inbound-only)");
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

    // msteams-tts.ts synthesizes and resamples to PCM 16 kHz mono.
    const pcm16k = await this.ttsProvider.synthesizePcm16k(input.text);
    if (abort.signal.aborted) {
      return;
    }
    if (pcm16k.length === 0) {
      throw new Error("MsteamsProvider.playTts: TTS produced no audio");
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
      state.session.send({
        type: "audio.frame",
        seq: state.outboundSeq,
        timestampMs: state.outboundTimestampMs,
        payloadBase64: frame.toString("base64"),
      });
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
    // manager can reap stale persisted entries on restart.
    if (this.calls.has(input.providerCallId)) {
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
