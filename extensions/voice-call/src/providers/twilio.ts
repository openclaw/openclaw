import crypto from "node:crypto";
import type { TwilioConfig, WebhookSecurityConfig } from "../config.js";
import { getHeader } from "../http-headers.js";
import type { MediaStreamHandler } from "../media-stream.js";
import { chunkAudio } from "../telephony-audio.js";
import type { TelephonyTtsProvider } from "../telephony-tts.js";
import type {
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
import { escapeXml, mapVoiceToPolly } from "../voice-mapping.js";
import type { VoiceCallProvider } from "./base.js";
import {
  isProviderStatusTerminal,
  mapProviderStatusToEndReason,
  normalizeProviderStatus,
} from "./shared/call-status.js";
import { guardedJsonApiRequest } from "./shared/guarded-json-api.js";
import { twilioApiRequest } from "./twilio/api.js";
import { decideTwimlResponse, readTwimlRequestView } from "./twilio/twiml-policy.js";
import { verifyTwilioProviderWebhook } from "./twilio/webhook.js";

type TwilioTtsTiming = {
  stage: string;
  callId?: string;
  providerCallId?: string;
  streamSid?: string;
  [key: string]: string | number | boolean | undefined;
};

type StreamQueueDiagnostics = {
  queueDepth: number;
  playing: boolean;
  hasActivePlayback: boolean;
};

type StreamSendResult = {
  sent: boolean;
  bufferedAfterBytes: number;
};

function logTwilioTtsTiming(entry: TwilioTtsTiming): void {
  console.log(
    `[voice-call][timing] ${JSON.stringify({
      component: "twilio-tts",
      ...entry,
    })}`,
  );
}

function createTwilioRequestDedupeKey(ctx: WebhookContext, verifiedRequestKey?: string): string {
  if (verifiedRequestKey) {
    return verifiedRequestKey;
  }

  const signature = getHeader(ctx.headers, "x-twilio-signature") ?? "";
  const params = new URLSearchParams(ctx.rawBody);
  const callSid = params.get("CallSid") ?? "";
  const callStatus = params.get("CallStatus") ?? "";
  const direction = params.get("Direction") ?? "";
  const callId = typeof ctx.query?.callId === "string" ? ctx.query.callId.trim() : "";
  const flow = typeof ctx.query?.flow === "string" ? ctx.query.flow.trim() : "";
  const turnToken = typeof ctx.query?.turnToken === "string" ? ctx.query.turnToken.trim() : "";
  return `twilio:fallback:${crypto
    .createHash("sha256")
    .update(
      `${signature}\n${callSid}\n${callStatus}\n${direction}\n${callId}\n${flow}\n${turnToken}\n${ctx.rawBody}`,
    )
    .digest("hex")}`;
}

/**
 * Twilio Voice API provider implementation.
 *
 * Uses Twilio Programmable Voice API with Media Streams for real-time
 * bidirectional audio streaming.
 *
 * @see https://www.twilio.com/docs/voice
 * @see https://www.twilio.com/docs/voice/media-streams
 */
export interface TwilioProviderOptions {
  /** Allow ngrok free tier compatibility mode (loopback only, less secure) */
  allowNgrokFreeTierLoopbackBypass?: boolean;
  /** Override public URL for signature verification */
  publicUrl?: string;
  /** Path for media stream WebSocket (e.g., /voice/stream) */
  streamPath?: string;
  /** Skip webhook signature verification (development only) */
  skipVerification?: boolean;
  /** Webhook security options (forwarded headers/allowlist) */
  webhookSecurity?: WebhookSecurityConfig;
}

export class TwilioProvider implements VoiceCallProvider {
  readonly name = "twilio" as const;
  private static readonly TTS_SYNTH_TIMEOUT_MS = 8000;

  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly baseUrl: string;
  private readonly callWebhookUrls = new Map<string, string>();
  private readonly options: TwilioProviderOptions;

  /** Current public webhook URL (set when tunnel starts or from config) */
  private currentPublicUrl: string | null = null;

  /** Optional telephony TTS provider for streaming TTS */
  private ttsProvider: TelephonyTtsProvider | null = null;

  /** Optional media stream handler for sending audio */
  private mediaStreamHandler: MediaStreamHandler | null = null;

  /** Map of call SID to stream SID for media streams */
  private callStreamMap = new Map<string, string>();
  /** Per-call tokens for media stream authentication */
  private streamAuthTokens = new Map<string, string>();

  /** Storage for TwiML content (for notify mode with URL-based TwiML) */
  private readonly twimlStorage = new Map<string, string>();
  /** Track notify-mode calls to avoid streaming on follow-up callbacks */
  private readonly notifyCalls = new Set<string>();
  private readonly activeStreamCalls = new Set<string>();

  /**
   * Delete stored TwiML for a given `callId`.
   *
   * We keep TwiML in-memory only long enough to satisfy the initial Twilio
   * webhook request (notify mode). Subsequent webhooks should not reuse it.
   */
  private deleteStoredTwiml(callId: string): void {
    this.twimlStorage.delete(callId);
    this.notifyCalls.delete(callId);
  }

  /**
   * Delete stored TwiML for a call, addressed by Twilio's provider call SID.
   *
   * This is used when we only have `providerCallId` (e.g. hangup).
   */
  private deleteStoredTwimlForProviderCall(providerCallId: string): void {
    const webhookUrl = this.callWebhookUrls.get(providerCallId);
    if (!webhookUrl) {
      return;
    }

    const callIdMatch = webhookUrl.match(/callId=([^&]+)/);
    if (!callIdMatch) {
      return;
    }

    this.deleteStoredTwiml(callIdMatch[1]);
    this.streamAuthTokens.delete(providerCallId);
  }

  constructor(config: TwilioConfig, options: TwilioProviderOptions = {}) {
    if (!config.accountSid) {
      throw new Error("Twilio Account SID is required");
    }
    if (!config.authToken) {
      throw new Error("Twilio Auth Token is required");
    }

    this.accountSid = config.accountSid;
    this.authToken = config.authToken;
    this.baseUrl = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}`;
    this.options = options;

    if (options.publicUrl) {
      this.currentPublicUrl = options.publicUrl;
    }
  }

  setPublicUrl(url: string): void {
    this.currentPublicUrl = url;
  }

  getPublicUrl(): string | null {
    return this.currentPublicUrl;
  }

  setTTSProvider(provider: TelephonyTtsProvider): void {
    this.ttsProvider = provider;
  }

  setMediaStreamHandler(handler: MediaStreamHandler): void {
    this.mediaStreamHandler = handler;
  }

  registerCallStream(callSid: string, streamSid: string): void {
    this.callStreamMap.set(callSid, streamSid);
  }

  hasRegisteredStream(callSid: string): boolean {
    return this.callStreamMap.has(callSid);
  }

  unregisterCallStream(callSid: string): void {
    this.callStreamMap.delete(callSid);
    this.activeStreamCalls.delete(callSid);
  }

  isValidStreamToken(callSid: string, token?: string): boolean {
    const expected = this.streamAuthTokens.get(callSid);
    if (!expected || !token) {
      return false;
    }
    if (expected.length !== token.length) {
      const dummy = Buffer.from(expected);
      crypto.timingSafeEqual(dummy, dummy);
      return false;
    }
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
  }

  /**
   * Clear TTS queue for a call (barge-in).
   * Used when user starts speaking to interrupt current TTS playback.
   */
  clearTtsQueue(callSid: string, reason = "unspecified"): void {
    const streamSid = this.callStreamMap.get(callSid);
    if (streamSid && this.mediaStreamHandler) {
      logTwilioTtsTiming({
        stage: "stream.queue.clear.request",
        providerCallId: callSid,
        streamSid,
        reason,
      });
      this.mediaStreamHandler.clearTtsQueue(streamSid, reason);
      return;
    }
    logTwilioTtsTiming({
      stage: "stream.queue.clear.skipped",
      providerCallId: callSid,
      reason,
      missingStreamSid: !streamSid,
      missingHandler: !this.mediaStreamHandler,
    });
  }

  /**
   * Make an authenticated request to the Twilio API.
   */
  private async apiRequest<T = unknown>(
    endpoint: string,
    params: Record<string, string | string[]>,
    options?: { allowNotFound?: boolean },
  ): Promise<T> {
    return await twilioApiRequest<T>({
      baseUrl: this.baseUrl,
      accountSid: this.accountSid,
      authToken: this.authToken,
      endpoint,
      body: params,
      allowNotFound: options?.allowNotFound,
    });
  }

  /**
   * Verify Twilio webhook signature using HMAC-SHA1.
   *
   * Handles reverse proxy scenarios (Tailscale, nginx, ngrok) by reconstructing
   * the public URL from forwarding headers.
   *
   * @see https://www.twilio.com/docs/usage/webhooks/webhooks-security
   */
  verifyWebhook(ctx: WebhookContext): WebhookVerificationResult {
    return verifyTwilioProviderWebhook({
      ctx,
      authToken: this.authToken,
      currentPublicUrl: this.currentPublicUrl,
      options: this.options,
    });
  }

  /**
   * Parse Twilio webhook event into normalized format.
   */
  parseWebhookEvent(
    ctx: WebhookContext,
    options?: WebhookParseOptions,
  ): ProviderWebhookParseResult {
    try {
      const params = new URLSearchParams(ctx.rawBody);
      const callIdFromQuery =
        typeof ctx.query?.callId === "string" && ctx.query.callId.trim()
          ? ctx.query.callId.trim()
          : undefined;
      const turnTokenFromQuery =
        typeof ctx.query?.turnToken === "string" && ctx.query.turnToken.trim()
          ? ctx.query.turnToken.trim()
          : undefined;
      const dedupeKey = createTwilioRequestDedupeKey(ctx, options?.verifiedRequestKey);
      const event = this.normalizeEvent(params, {
        callIdOverride: callIdFromQuery,
        dedupeKey,
        turnToken: turnTokenFromQuery,
      });

      // For Twilio, we must return TwiML. Most actions are driven by Calls API updates,
      // so the webhook response is typically a pause to keep the call alive.
      const twiml = this.generateTwimlResponse(ctx);

      return {
        events: event ? [event] : [],
        providerResponseBody: twiml,
        providerResponseHeaders: { "Content-Type": "application/xml" },
        statusCode: 200,
      };
    } catch {
      return { events: [], statusCode: 400 };
    }
  }

  /**
   * Parse Twilio direction to normalized format.
   */
  private static parseDirection(direction: string | null): "inbound" | "outbound" | undefined {
    if (direction === "inbound") {
      return "inbound";
    }
    if (direction === "outbound-api" || direction === "outbound-dial") {
      return "outbound";
    }
    return undefined;
  }

  /**
   * Convert Twilio webhook params to normalized event format.
   */
  private normalizeEvent(
    params: URLSearchParams,
    options?: {
      callIdOverride?: string;
      dedupeKey?: string;
      turnToken?: string;
    },
  ): NormalizedEvent | null {
    const callSid = params.get("CallSid") || "";
    const callIdOverride = options?.callIdOverride;

    const baseEvent = {
      id: crypto.randomUUID(),
      dedupeKey: options?.dedupeKey,
      callId: callIdOverride || callSid,
      providerCallId: callSid,
      timestamp: Date.now(),
      turnToken: options?.turnToken,
      direction: TwilioProvider.parseDirection(params.get("Direction")),
      from: params.get("From") || undefined,
      to: params.get("To") || undefined,
    };

    // Handle speech result (from <Gather>)
    const speechResult = params.get("SpeechResult");
    if (speechResult) {
      return {
        ...baseEvent,
        type: "call.speech",
        transcript: speechResult,
        isFinal: true,
        confidence: parseFloat(params.get("Confidence") || "0.9"),
      };
    }

    // Handle DTMF
    const digits = params.get("Digits");
    if (digits) {
      return { ...baseEvent, type: "call.dtmf", digits };
    }

    // Handle call status changes
    const callStatus = normalizeProviderStatus(params.get("CallStatus"));
    if (callStatus === "initiated") {
      return { ...baseEvent, type: "call.initiated" };
    }
    if (callStatus === "ringing") {
      return { ...baseEvent, type: "call.ringing" };
    }
    if (callStatus === "in-progress") {
      return { ...baseEvent, type: "call.answered" };
    }

    const endReason = mapProviderStatusToEndReason(callStatus);
    if (endReason) {
      this.streamAuthTokens.delete(callSid);
      this.activeStreamCalls.delete(callSid);
      if (callIdOverride) {
        this.deleteStoredTwiml(callIdOverride);
      }
      return { ...baseEvent, type: "call.ended", reason: endReason };
    }

    return null;
  }

  private static readonly EMPTY_TWIML =
    '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

  private static readonly PAUSE_TWIML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="30"/>
</Response>`;

  private static readonly QUEUE_TWIML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Please hold while we connect you.</Say>
  <Enqueue waitUrl="/voice/hold-music">hold-queue</Enqueue>
</Response>`;

  /**
   * Generate TwiML response for webhook.
   * When a call is answered, connects to media stream for bidirectional audio.
   */
  private generateTwimlResponse(ctx?: WebhookContext): string {
    if (!ctx) {
      return TwilioProvider.EMPTY_TWIML;
    }

    const view = readTwimlRequestView(ctx);
    const storedTwiml = view.callIdFromQuery
      ? this.twimlStorage.get(view.callIdFromQuery)
      : undefined;
    const decision = decideTwimlResponse({
      ...view,
      hasStoredTwiml: Boolean(storedTwiml),
      isNotifyCall: view.callIdFromQuery ? this.notifyCalls.has(view.callIdFromQuery) : false,
      hasActiveStreams: this.activeStreamCalls.size > 0,
      canStream: Boolean(view.callSid && this.getStreamUrl()),
    });

    if (decision.consumeStoredTwimlCallId) {
      this.deleteStoredTwiml(decision.consumeStoredTwimlCallId);
    }
    if (decision.activateStreamCallSid) {
      this.activeStreamCalls.add(decision.activateStreamCallSid);
    }

    switch (decision.kind) {
      case "stored":
        return storedTwiml ?? TwilioProvider.EMPTY_TWIML;
      case "queue":
        return TwilioProvider.QUEUE_TWIML;
      case "pause":
        return TwilioProvider.PAUSE_TWIML;
      case "stream": {
        const streamUrl = view.callSid ? this.getStreamUrlForCall(view.callSid) : null;
        return streamUrl ? this.getStreamConnectXml(streamUrl) : TwilioProvider.PAUSE_TWIML;
      }
      case "empty":
      default:
        return TwilioProvider.EMPTY_TWIML;
    }
  }

  /**
   * Get the WebSocket URL for media streaming.
   * Derives from the public URL origin + stream path.
   */
  private getStreamUrl(): string | null {
    if (!this.currentPublicUrl || !this.options.streamPath) {
      return null;
    }

    // Extract just the origin (host) from the public URL, ignoring any path
    const url = new URL(this.currentPublicUrl);
    const origin = url.origin;

    // Convert https:// to wss:// for WebSocket
    const wsOrigin = origin.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");

    // Append the stream path
    const path = this.options.streamPath.startsWith("/")
      ? this.options.streamPath
      : `/${this.options.streamPath}`;

    return `${wsOrigin}${path}`;
  }

  private getStreamAuthToken(callSid: string): string {
    const existing = this.streamAuthTokens.get(callSid);
    if (existing) {
      return existing;
    }
    const token = crypto.randomBytes(16).toString("base64url");
    this.streamAuthTokens.set(callSid, token);
    return token;
  }

  private getStreamUrlForCall(callSid: string): string | null {
    const baseUrl = this.getStreamUrl();
    if (!baseUrl) {
      return null;
    }
    const token = this.getStreamAuthToken(callSid);
    const url = new URL(baseUrl);
    url.searchParams.set("token", token);
    return url.toString();
  }

  /**
   * Generate TwiML to connect a call to a WebSocket media stream.
   * This enables bidirectional audio streaming for real-time STT/TTS.
   *
   * @param streamUrl - WebSocket URL (wss://...) for the media stream
   */
  getStreamConnectXml(streamUrl: string): string {
    // Extract token from URL and pass via <Parameter> instead of query string.
    // Twilio strips query params from WebSocket URLs, but delivers <Parameter>
    // values in the "start" message's customParameters field.
    const parsed = new URL(streamUrl);
    const token = parsed.searchParams.get("token");
    parsed.searchParams.delete("token");
    const cleanUrl = parsed.toString();

    const paramXml = token ? `\n      <Parameter name="token" value="${escapeXml(token)}" />` : "";

    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(cleanUrl)}">${paramXml}
    </Stream>
  </Connect>
</Response>`;
  }

  /**
   * Initiate an outbound call via Twilio API.
   * If inlineTwiml is provided, uses that directly (for notify mode).
   * Otherwise, uses webhook URL for dynamic TwiML.
   */
  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    const url = new URL(input.webhookUrl);
    url.searchParams.set("callId", input.callId);

    // Create separate URL for status callbacks (required by Twilio)
    const statusUrl = new URL(input.webhookUrl);
    statusUrl.searchParams.set("callId", input.callId);
    statusUrl.searchParams.set("type", "status"); // Differentiate from TwiML requests

    // Store TwiML content if provided (for notify mode)
    // We now serve it from the webhook endpoint instead of sending inline
    if (input.inlineTwiml) {
      this.twimlStorage.set(input.callId, input.inlineTwiml);
      this.notifyCalls.add(input.callId);
    }

    // Build request params - always use URL-based TwiML.
    // Twilio silently ignores `StatusCallback` when using the inline `Twiml` parameter.
    const params: Record<string, string | string[]> = {
      To: input.to,
      From: input.from,
      Url: url.toString(), // TwiML serving endpoint
      StatusCallback: statusUrl.toString(), // Separate status callback endpoint
      StatusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      Timeout: "30",
    };

    const result = await this.apiRequest<TwilioCallResponse>("/Calls.json", params);

    this.callWebhookUrls.set(result.sid, url.toString());

    return {
      providerCallId: result.sid,
      status: result.status === "queued" ? "queued" : "initiated",
    };
  }

  /**
   * Hang up a call via Twilio API.
   */
  async hangupCall(input: HangupCallInput): Promise<void> {
    this.deleteStoredTwimlForProviderCall(input.providerCallId);

    this.callWebhookUrls.delete(input.providerCallId);
    this.streamAuthTokens.delete(input.providerCallId);
    this.activeStreamCalls.delete(input.providerCallId);

    await this.apiRequest(
      `/Calls/${input.providerCallId}.json`,
      { Status: "completed" },
      { allowNotFound: true },
    );
  }

  /**
   * Play TTS audio via Twilio.
   *
   * Two modes:
   * 1. Core TTS + Media Streams: If TTS provider and media stream are available,
   *    generates audio via core TTS and streams it through WebSocket (preferred).
   * 2. TwiML <Say>: Falls back to Twilio's native TTS with Polly voices.
   *    Note: This may not work on all Twilio accounts.
   */
  async playTts(input: PlayTtsInput): Promise<void> {
    const startedAt = Date.now();

    // Try telephony TTS via media stream first (if configured)
    const streamSid = this.callStreamMap.get(input.providerCallId);
    const shouldAvoidTwimlFallback = Boolean(streamSid);
    logTwilioTtsTiming({
      stage: "play-tts.start",
      callId: input.callId,
      providerCallId: input.providerCallId,
      streamSid,
      textChars: input.text.length,
      hasTtsProvider: Boolean(this.ttsProvider),
      hasMediaStreamHandler: Boolean(this.mediaStreamHandler),
    });

    if (this.ttsProvider && this.mediaStreamHandler && streamSid) {
      try {
        await this.playTtsViaStream(input.text, streamSid, {
          callId: input.callId,
          providerCallId: input.providerCallId,
        });
        logTwilioTtsTiming({
          stage: "play-tts.done",
          callId: input.callId,
          providerCallId: input.providerCallId,
          streamSid,
          mode: "stream",
          elapsedMs: Date.now() - startedAt,
        });
        return;
      } catch (err) {
        logTwilioTtsTiming({
          stage: "play-tts.error",
          callId: input.callId,
          providerCallId: input.providerCallId,
          streamSid,
          mode: "stream",
          elapsedMs: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err),
        });
        console.warn(
          `[voice-call] Telephony TTS failed:`,
          err instanceof Error ? err.message : err,
        );
        throw err instanceof Error ? err : new Error(String(err));
      }
    }

    if (shouldAvoidTwimlFallback) {
      logTwilioTtsTiming({
        stage: "play-tts.error",
        callId: input.callId,
        providerCallId: input.providerCallId,
        streamSid,
        mode: "stream",
        elapsedMs: Date.now() - startedAt,
        error: "twiml-fallback-blocked-active-stream",
      });
      throw new Error(
        "Cannot use TwiML fallback while media stream is active; telephony TTS is unavailable",
      );
    }

    // Fall back to TwiML <Say> (may not work on all accounts)
    const webhookUrl = this.callWebhookUrls.get(input.providerCallId);
    if (!webhookUrl) {
      throw new Error("Missing webhook URL for this call (provider state not initialized)");
    }

    console.warn(
      "[voice-call] Using TwiML <Say> fallback - telephony TTS not configured or media stream not active",
    );

    const pollyVoice = mapVoiceToPolly(input.voice);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${pollyVoice}" language="${input.locale || "en-US"}">${escapeXml(input.text)}</Say>
  <Gather input="speech" speechTimeout="auto" action="${escapeXml(webhookUrl)}" method="POST">
    <Say>.</Say>
  </Gather>
</Response>`;

    await this.apiRequest(`/Calls/${input.providerCallId}.json`, {
      Twiml: twiml,
    });
    logTwilioTtsTiming({
      stage: "play-tts.done",
      callId: input.callId,
      providerCallId: input.providerCallId,
      mode: "twiml-fallback",
      elapsedMs: Date.now() - startedAt,
    });
  }

  /**
   * Play TTS via core TTS and Twilio Media Streams.
   * Generates audio with core TTS, converts to mu-law, and streams via WebSocket.
   * Uses a queue to serialize playback and prevent overlapping audio.
   */
  private async playTtsViaStream(
    text: string,
    streamSid: string,
    context?: { callId?: string; providerCallId?: string },
  ): Promise<void> {
    if (!this.ttsProvider || !this.mediaStreamHandler) {
      throw new Error("TTS provider and media stream handler required");
    }

    // Stream audio in 20ms chunks (160 bytes at 8kHz mu-law)
    const CHUNK_SIZE = 160;
    const CHUNK_DELAY_MS = 20;
    const SILENCE_CHUNK = Buffer.alloc(CHUNK_SIZE, 0xff);

    const handler = this.mediaStreamHandler;
    const ttsProvider = this.ttsProvider;
    const getQueueDiagnostics = (): StreamQueueDiagnostics => {
      const diagnosticsGetter = (handler as { getTtsDiagnostics?: (sid: string) => unknown })
        .getTtsDiagnostics;
      if (typeof diagnosticsGetter !== "function") {
        return { queueDepth: 0, playing: false, hasActivePlayback: false };
      }

      const raw = diagnosticsGetter.call(handler, streamSid);
      if (!raw || typeof raw !== "object") {
        return { queueDepth: 0, playing: false, hasActivePlayback: false };
      }

      const diagnostics = raw as {
        queueDepth?: unknown;
        playing?: unknown;
        hasActivePlayback?: unknown;
      };
      return {
        queueDepth:
          typeof diagnostics.queueDepth === "number" && Number.isFinite(diagnostics.queueDepth)
            ? diagnostics.queueDepth
            : 0,
        playing: Boolean(diagnostics.playing),
        hasActivePlayback: Boolean(diagnostics.hasActivePlayback),
      };
    };

    const normalizeSendResult = (raw: unknown): StreamSendResult => {
      if (!raw || typeof raw !== "object") {
        return { sent: true, bufferedAfterBytes: 0 };
      }
      const typed = raw as {
        sent?: unknown;
        bufferedAfterBytes?: unknown;
      };
      return {
        sent: typed.sent === undefined ? true : Boolean(typed.sent),
        bufferedAfterBytes:
          typeof typed.bufferedAfterBytes === "number" && Number.isFinite(typed.bufferedAfterBytes)
            ? typed.bufferedAfterBytes
            : 0,
      };
    };

    const sendAudioChunk = (audio: Buffer): StreamSendResult => {
      const raw = (handler as { sendAudio: (sid: string, chunk: Buffer) => unknown }).sendAudio(
        streamSid,
        audio,
      );
      return normalizeSendResult(raw);
    };

    const sendPlaybackMark = (name: string): StreamSendResult => {
      const raw = (handler as { sendMark: (sid: string, markName: string) => unknown }).sendMark(
        streamSid,
        name,
      );
      return normalizeSendResult(raw);
    };

    const queuedAt = Date.now();
    const queueSnapshotAtWait = getQueueDiagnostics();
    logTwilioTtsTiming({
      stage: "stream.queue.wait",
      callId: context?.callId,
      providerCallId: context?.providerCallId,
      streamSid,
      queueDepth: queueSnapshotAtWait.queueDepth,
      queuePlaying: queueSnapshotAtWait.playing,
      queueHasActivePlayback: queueSnapshotAtWait.hasActivePlayback,
    });
    await handler.queueTts(streamSid, async (signal) => {
      const dequeuedAt = Date.now();
      const queueSnapshotAtDequeue = getQueueDiagnostics();
      logTwilioTtsTiming({
        stage: "stream.queue.dequeue",
        callId: context?.callId,
        providerCallId: context?.providerCallId,
        streamSid,
        queueWaitMs: dequeuedAt - queuedAt,
        queueDepth: queueSnapshotAtDequeue.queueDepth,
        queuePlaying: queueSnapshotAtDequeue.playing,
        queueHasActivePlayback: queueSnapshotAtDequeue.hasActivePlayback,
      });
      let keepAliveSent = 0;
      let keepAliveDropped = 0;
      let keepAliveMaxBufferedAfterBytes = 0;
      const sendKeepAlive = () => {
        const result = sendAudioChunk(SILENCE_CHUNK);
        if (!result.sent) {
          keepAliveDropped += 1;
          return;
        }
        keepAliveSent += 1;
        keepAliveMaxBufferedAfterBytes = Math.max(
          keepAliveMaxBufferedAfterBytes,
          result.bufferedAfterBytes,
        );
      };
      sendKeepAlive();
      const keepAlive = setInterval(() => {
        if (!signal.aborted) {
          sendKeepAlive();
        }
      }, CHUNK_DELAY_MS);

      // Generate audio with core TTS (returns mu-law at 8kHz)
      let muLawAudio: Buffer;
      let synthTimeout: ReturnType<typeof setTimeout> | null = null;
      const synthStartedAt = Date.now();
      try {
        const synthPromise = ttsProvider.synthesizeForTelephony(text);
        const timeoutPromise = new Promise<Buffer>((_, reject) => {
          synthTimeout = setTimeout(() => {
            reject(
              new Error(
                `Telephony TTS synthesis timed out after ${TwilioProvider.TTS_SYNTH_TIMEOUT_MS}ms`,
              ),
            );
          }, TwilioProvider.TTS_SYNTH_TIMEOUT_MS);
        });
        muLawAudio = await Promise.race([synthPromise, timeoutPromise]);
        logTwilioTtsTiming({
          stage: "stream.synth.done",
          callId: context?.callId,
          providerCallId: context?.providerCallId,
          streamSid,
          elapsedMs: Date.now() - synthStartedAt,
          audioBytes: muLawAudio.length,
        });
      } finally {
        if (synthTimeout) {
          clearTimeout(synthTimeout);
        }
        clearInterval(keepAlive);
        logTwilioTtsTiming({
          stage: "stream.keepalive.done",
          callId: context?.callId,
          providerCallId: context?.providerCallId,
          streamSid,
          keepAliveSent,
          keepAliveDropped,
          keepAliveMaxBufferedAfterBytes,
        });
      }

      const playbackStartedAt = Date.now();
      let chunkCount = 0;
      let bytesSent = 0;
      let sendFailures = 0;
      let maxBufferedAfterBytes = 0;
      let minChunkIntervalMs = Number.POSITIVE_INFINITY;
      let maxChunkIntervalMs = 0;
      let totalChunkIntervalMs = 0;
      let chunkIntervalSamples = 0;
      let previousChunkSentAt: number | null = null;
      let minTimerDelayMs = Number.POSITIVE_INFINITY;
      let maxTimerDelayMs = 0;
      let totalTimerDelayMs = 0;
      let timerDelaySamples = 0;
      let timerDelayOverrunCount = 0;
      let scheduleBehindCount = 0;
      let maxScheduleBehindMs = 0;
      let totalScheduleBehindMs = 0;
      let nextChunkDueAt = playbackStartedAt + CHUNK_DELAY_MS;
      for (const chunk of chunkAudio(muLawAudio, CHUNK_SIZE)) {
        if (signal.aborted) {
          break;
        }
        const chunkSentAt = Date.now();
        if (previousChunkSentAt !== null) {
          const intervalMs = chunkSentAt - previousChunkSentAt;
          minChunkIntervalMs = Math.min(minChunkIntervalMs, intervalMs);
          maxChunkIntervalMs = Math.max(maxChunkIntervalMs, intervalMs);
          totalChunkIntervalMs += intervalMs;
          chunkIntervalSamples += 1;
        }
        previousChunkSentAt = chunkSentAt;
        chunkCount += 1;
        bytesSent += chunk.length;
        const sendResult = sendAudioChunk(chunk);
        if (!sendResult.sent) {
          sendFailures += 1;
        }
        maxBufferedAfterBytes = Math.max(maxBufferedAfterBytes, sendResult.bufferedAfterBytes);

        // Drift-corrected pacing: schedule against an absolute clock to avoid cumulative delay.
        const waitMs = nextChunkDueAt - Date.now();
        if (waitMs > 0) {
          const timerStartedAt = Date.now();
          await new Promise((resolve) => setTimeout(resolve, Math.ceil(waitMs)));
          const timerDelayMs = Date.now() - timerStartedAt;
          minTimerDelayMs = Math.min(minTimerDelayMs, timerDelayMs);
          maxTimerDelayMs = Math.max(maxTimerDelayMs, timerDelayMs);
          totalTimerDelayMs += timerDelayMs;
          timerDelaySamples += 1;
          if (timerDelayMs > CHUNK_DELAY_MS + 5) {
            timerDelayOverrunCount += 1;
          }
        } else if (waitMs < -1) {
          const behindMs = Math.abs(waitMs);
          scheduleBehindCount += 1;
          maxScheduleBehindMs = Math.max(maxScheduleBehindMs, behindMs);
          totalScheduleBehindMs += behindMs;
        }
        nextChunkDueAt += CHUNK_DELAY_MS;
        if (signal.aborted) {
          break;
        }
      }

      let markSent = false;
      let markBufferedAfterBytes = 0;
      if (!signal.aborted) {
        // Send a mark to track when audio finishes
        const markResult = sendPlaybackMark(`tts-${Date.now()}`);
        markSent = markResult.sent;
        markBufferedAfterBytes = markResult.bufferedAfterBytes;
      }
      const playbackElapsedMs = Date.now() - playbackStartedAt;
      const expectedPlaybackMs = chunkCount * CHUNK_DELAY_MS;
      logTwilioTtsTiming({
        stage: "stream.playback.done",
        callId: context?.callId,
        providerCallId: context?.providerCallId,
        streamSid,
        elapsedMs: playbackElapsedMs,
        expectedPlaybackMs,
        pacingDriftMs: playbackElapsedMs - expectedPlaybackMs,
        chunkCount,
        bytesSent,
        sendFailures,
        maxBufferedAfterBytes,
        minChunkIntervalMs: Number.isFinite(minChunkIntervalMs) ? minChunkIntervalMs : undefined,
        maxChunkIntervalMs: chunkIntervalSamples > 0 ? maxChunkIntervalMs : undefined,
        avgChunkIntervalMs:
          chunkIntervalSamples > 0
            ? Number((totalChunkIntervalMs / chunkIntervalSamples).toFixed(2))
            : undefined,
        minTimerDelayMs: Number.isFinite(minTimerDelayMs) ? minTimerDelayMs : undefined,
        maxTimerDelayMs: timerDelaySamples > 0 ? maxTimerDelayMs : undefined,
        avgTimerDelayMs:
          timerDelaySamples > 0
            ? Number((totalTimerDelayMs / timerDelaySamples).toFixed(2))
            : undefined,
        timerDelayOverrunCount,
        scheduleBehindCount,
        maxScheduleBehindMs: scheduleBehindCount > 0 ? maxScheduleBehindMs : undefined,
        avgScheduleBehindMs:
          scheduleBehindCount > 0
            ? Number((totalScheduleBehindMs / scheduleBehindCount).toFixed(2))
            : undefined,
        markSent,
        markBufferedAfterBytes,
        aborted: signal.aborted,
      });
    });
    const queueSnapshotAtDone = getQueueDiagnostics();
    logTwilioTtsTiming({
      stage: "stream.queue.done",
      callId: context?.callId,
      providerCallId: context?.providerCallId,
      streamSid,
      elapsedMs: Date.now() - queuedAt,
      queueDepth: queueSnapshotAtDone.queueDepth,
      queuePlaying: queueSnapshotAtDone.playing,
      queueHasActivePlayback: queueSnapshotAtDone.hasActivePlayback,
    });
  }

  /**
   * Start listening for speech via Twilio <Gather>.
   */
  async startListening(input: StartListeningInput): Promise<void> {
    const webhookUrl = this.callWebhookUrls.get(input.providerCallId);
    if (!webhookUrl) {
      throw new Error("Missing webhook URL for this call (provider state not initialized)");
    }

    const actionUrl = new URL(webhookUrl);
    if (input.turnToken) {
      actionUrl.searchParams.set("turnToken", input.turnToken);
    }

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" speechTimeout="auto" language="${input.language || "en-US"}" action="${escapeXml(actionUrl.toString())}" method="POST">
  </Gather>
</Response>`;

    await this.apiRequest(`/Calls/${input.providerCallId}.json`, {
      Twiml: twiml,
    });
  }

  /**
   * Stop listening - for Twilio this is a no-op as <Gather> auto-ends.
   */
  async stopListening(_input: StopListeningInput): Promise<void> {
    // Twilio's <Gather> automatically stops on speech end
    // No explicit action needed
  }

  async getCallStatus(input: GetCallStatusInput): Promise<GetCallStatusResult> {
    try {
      const data = await guardedJsonApiRequest<{ status?: string }>({
        url: `${this.baseUrl}/Calls/${input.providerCallId}.json`,
        method: "GET",
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64")}`,
        },
        allowNotFound: true,
        allowedHostnames: ["api.twilio.com"],
        auditContext: "twilio-get-call-status",
        errorPrefix: "Twilio get call status error",
      });

      if (!data) {
        return { status: "not-found", isTerminal: true };
      }

      const status = normalizeProviderStatus(data.status);
      return { status, isTerminal: isProviderStatusTerminal(status) };
    } catch {
      // Transient error — keep the call and rely on timer fallback
      return { status: "error", isTerminal: false, isUnknown: true };
    }
  }
}

// -----------------------------------------------------------------------------
// Twilio-specific types
// -----------------------------------------------------------------------------

interface TwilioCallResponse {
  sid: string;
  status: string;
  direction: string;
  from: string;
  to: string;
  uri: string;
}
