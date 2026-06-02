import crypto from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
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
  SendDtmfInput,
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
import type { TwilioProviderOptions } from "./twilio.types.js";
import { TwilioApiError, twilioApiRequest } from "./twilio/api.js";
import { decideTwimlResponse, readTwimlRequestView } from "./twilio/twiml-policy.js";
import { verifyTwilioProviderWebhook } from "./twilio/webhook.js";
export type { TwilioProviderOptions } from "./twilio.types.js";

const TWILIO_CALL_NOT_IN_PROGRESS_CODE = 21220;
const TWILIO_CALL_UPDATE_RETRY_DELAYS_MS = [250, 750] as const;

function isTwilioCallNotInProgressError(err: unknown): boolean {
  return err instanceof TwilioApiError && err.twilioCode === TWILIO_CALL_NOT_IN_PROGRESS_CODE;
}

function createTwilioRequestDedupeKey(ctx: WebhookContext, verifiedRequestKey?: string): string {
  if (verifiedRequestKey) {
    return verifiedRequestKey;
  }

  // Before signature verification succeeds, derive idempotency from the actual
  // request facts we route on; Twilio's raw idempotency header is not enough
  // because query tokens select the OpenClaw call/turn.
  const signature = getHeader(ctx.headers, "x-twilio-signature") ?? "";
  const params = new URLSearchParams(ctx.rawBody);
  const callSid = params.get("CallSid") ?? "";
  const callStatus = params.get("CallStatus") ?? "";
  const direction = params.get("Direction") ?? "";
  const callId = normalizeOptionalString(ctx.query?.callId) ?? "";
  const flow = normalizeOptionalString(ctx.query?.flow) ?? "";
  const turnToken = normalizeOptionalString(ctx.query?.turnToken) ?? "";
  return `twilio:fallback:${crypto
    .createHash("sha256")
    .update(
      `${signature}\n${callSid}\n${callStatus}\n${direction}\n${callId}\n${flow}\n${turnToken}\n${ctx.rawBody}`,
    )
    .digest("hex")}`;
}

type StreamSendResult = {
  sent: boolean;
};

type TwilioProviderConfig = {
  accountSid?: string;
  authToken?: string;
};

/** Twilio Voice provider for REST call control, TwiML callback routing, and media streams. */
export class TwilioProvider implements VoiceCallProvider {
  readonly name = "twilio" as const;

  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly baseUrl: string;
  private readonly callWebhookUrls = new Map<string, string>();
  private readonly options: TwilioProviderOptions;

  /** Provider-visible webhook origin used for signature verification and generated stream URLs. */
  private currentPublicUrl: string | null = null;

  /** Optional streaming TTS adapter used before falling back to TwiML redirects. */
  private ttsProvider: TelephonyTtsProvider | null = null;

  /** Optional media bridge used to enqueue outbound audio to live Twilio streams. */
  private mediaStreamHandler: MediaStreamHandler | null = null;

  /** Current Twilio streamSid per callSid; outbound media/clear/mark frames require it. */
  private callStreamMap = new Map<string, string>();
  /** Per-call stream tokens validated before accepting Twilio media websocket starts. */
  private streamAuthTokens = new Map<string, string>();

  /** One-shot TwiML payloads consumed by initial notify-mode callbacks. */
  private readonly twimlStorage = new Map<string, string>();
  /** Notify-mode call ids that should not be upgraded into streaming conversations. */
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

  constructor(config: TwilioProviderConfig, options: TwilioProviderOptions = {}) {
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

  /** Updates the externally reachable webhook origin after tunnel/exposure setup. */
  setPublicUrl(url: string): void {
    this.currentPublicUrl = url;
  }

  /** Returns the public origin currently used for generated callbacks and stream URLs. */
  getPublicUrl(): string | null {
    return this.currentPublicUrl;
  }

  /** Injects the telephony TTS adapter used for live media-stream playback. */
  setTTSProvider(provider: TelephonyTtsProvider): void {
    this.ttsProvider = provider;
  }

  /** Injects the media stream bridge that owns outbound audio queueing and barge-in clears. */
  setMediaStreamHandler(handler: MediaStreamHandler): void {
    this.mediaStreamHandler = handler;
  }

  /** Associates a Twilio stream SID with a call SID so later playback can target the socket. */
  registerCallStream(callSid: string, streamSid: string): void {
    this.callStreamMap.set(callSid, streamSid);
  }

  /** Returns whether a live stream is registered for the Twilio call SID. */
  hasRegisteredStream(callSid: string): boolean {
    return this.callStreamMap.has(callSid);
  }

  /** Removes a stream mapping, preserving newer reconnect streams when an old stop arrives late. */
  unregisterCallStream(callSid: string, streamSid?: string): void {
    const currentStreamSid = this.callStreamMap.get(callSid);
    if (!currentStreamSid) {
      if (!streamSid) {
        this.activeStreamCalls.delete(callSid);
      }
      return;
    }
    if (streamSid && currentStreamSid !== streamSid) {
      // Twilio can deliver a stop for an older stream after reconnecting the
      // same call; keep the newer stream registered so playback is not severed.
      return;
    }
    this.callStreamMap.delete(callSid);
    this.activeStreamCalls.delete(callSid);
  }

  /** True when TwiML should connect new calls to the media stream bridge instead of static TwiML. */
  isConversationStreamConnectEnabled(): boolean {
    return Boolean(this.mediaStreamHandler && this.getStreamUrl());
  }

  /** Validates a one-time media-stream token before accepting Twilio's websocket start frame. */
  isValidStreamToken(callSid: string, token?: string): boolean {
    const expected = this.streamAuthTokens.get(callSid);
    if (!expected || !token) {
      return false;
    }
    return safeEqualSecret(expected, token);
  }

  /**
   * Clear TTS queue for a call (barge-in).
   * Used when user starts speaking to interrupt current TTS playback.
   */
  clearTtsQueue(callSid: string, reason = "unspecified"): void {
    const streamSid = this.callStreamMap.get(callSid);
    if (!streamSid || !this.mediaStreamHandler) {
      return;
    }
    this.mediaStreamHandler.clearTtsQueue(streamSid, reason);
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

  private async updateLiveCallTwiml(
    providerCallId: string,
    twiml: string,
    operation: string,
  ): Promise<void> {
    for (const retryDelayMs of TWILIO_CALL_UPDATE_RETRY_DELAYS_MS) {
      try {
        await this.apiRequest(`/Calls/${providerCallId}.json`, { Twiml: twiml });
        return;
      } catch (err) {
        if (!isTwilioCallNotInProgressError(err)) {
          throw err;
        }
        // Twilio can acknowledge answer/status webhooks before the Calls API
        // accepts live TwiML updates for that SID. Short retries bridge that
        // provider race without hiding real API failures.
        console.warn(
          `[voice-call] Twilio ${operation} update hit call state race (21220); retrying in ${retryDelayMs}ms`,
        );
        await sleep(retryDelayMs);
      }
    }
    await this.apiRequest(`/Calls/${providerCallId}.json`, { Twiml: twiml });
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
      const callIdFromQuery = normalizeOptionalString(ctx.query?.callId);
      const turnTokenFromQuery = normalizeOptionalString(ctx.query?.turnToken);
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

  private static parseConfidence(value: string | null): number {
    const trimmed = value?.trim();
    if (!trimmed || !/^\d+(?:\.\d+)?$/.test(trimmed)) {
      return 0.9;
    }
    return Number(trimmed);
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
        confidence: TwilioProvider.parseConfidence(params.get("Confidence")),
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
      // Terminal status callbacks are the last provider-owned cleanup point for
      // stream credentials when local hangup did not initiate the call ending.
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
      // Stored notify/pre-connect TwiML is single-use; replaying it on later
      // callbacks would restart setup digits instead of entering conversation.
      this.deleteStoredTwiml(decision.consumeStoredTwimlCallId);
    }
    if (decision.activateStreamCallSid) {
      // activeStreamCalls is the admission lock for inbound calls before the
      // WebSocket start event has registered a stream SID.
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
      default:
        return TwilioProvider.EMPTY_TWIML;
    }
  }

  consumeInitialTwiML(ctx: WebhookContext): string | null {
    const view = readTwimlRequestView(ctx);
    if (!view.callIdFromQuery || view.isStatusCallback) {
      return null;
    }
    const storedTwiml = this.twimlStorage.get(view.callIdFromQuery);
    if (!storedTwiml) {
      return null;
    }
    const kind = this.notifyCalls.has(view.callIdFromQuery) ? "notify" : "pre-connect";
    this.deleteStoredTwiml(view.callIdFromQuery);
    console.log(
      `[voice-call] Twilio initial TwiML consumed for call ${view.callIdFromQuery} (kind=${kind}, callSid=${view.callSid ?? "unknown"})`,
    );
    return storedTwiml;
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
    // Keep the token stable for the call: Twilio may fetch TwiML more than once
    // before the WebSocket "start" frame carries customParameters.token.
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
    // Keep the token in URL state until getStreamConnectXml moves it into a
    // Twilio <Parameter>; Twilio drops WebSocket query strings on connect.
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
   * If preConnectTwiml is provided, the first webhook request receives that
   * TwiML before normal dynamic TwiML resumes.
   */
  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    const url = new URL(input.webhookUrl);
    url.searchParams.set("callId", input.callId);

    // Create separate URL for status callbacks (required by Twilio)
    const statusUrl = new URL(input.webhookUrl);
    statusUrl.searchParams.set("callId", input.callId);
    statusUrl.searchParams.set("type", "status"); // Differentiate from TwiML requests

    if (!input.inlineTwiml && input.preConnectTwiml) {
      this.twimlStorage.set(input.callId, input.preConnectTwiml);
      console.log(
        `[voice-call] Stored Twilio initial TwiML for call ${input.callId} (kind=pre-connect)`,
      );
    }

    const params: Record<string, string | string[]> = {
      To: input.to,
      From: input.from,
      StatusCallback: statusUrl.toString(),
      StatusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      Timeout: "30",
    };

    if (input.inlineTwiml) {
      params.Twiml = input.inlineTwiml;
      console.log(
        `[voice-call] Sending direct Twilio initial TwiML for call ${input.callId} (kind=notify)`,
      );
    } else {
      params.Url = url.toString();
    }

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
   * 1. Core TTS + Media Streams: when an active stream exists, stream playback is required.
   *    If telephony TTS is unavailable in that state, playback fails rather than mixing paths.
   * 2. TwiML <Say>: fallback only when there is no active stream for the call.
   */
  async playTts(input: PlayTtsInput): Promise<void> {
    const streamSid = this.callStreamMap.get(input.providerCallId);
    if (streamSid) {
      if (!this.ttsProvider || !this.mediaStreamHandler) {
        throw new Error(
          "Telephony TTS unavailable while media stream is active; refusing TwiML fallback",
        );
      }

      try {
        await this.playTtsViaStream(input.text, streamSid);
        return;
      } catch (err) {
        console.warn(
          `[voice-call] Telephony TTS failed:`,
          err instanceof Error ? err.message : err,
        );
        throw err instanceof Error ? err : new Error(String(err));
      }
    }

    // Fall back to TwiML <Say> only when no active stream exists.
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

    await this.updateLiveCallTwiml(input.providerCallId, twiml, "playTts");
  }

  async sendDtmf(input: SendDtmfInput): Promise<void> {
    const webhookUrl = this.callWebhookUrls.get(input.providerCallId);
    if (!webhookUrl) {
      throw new Error("Missing webhook URL for this call (provider state not initialized)");
    }

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play digits="${escapeXml(input.digits)}" />
  <Redirect method="POST">${escapeXml(webhookUrl)}</Redirect>
</Response>`;

    // Redirect back to the stored webhook URL so the call returns to normal
    // dynamic TwiML after Twilio finishes playing the DTMF sequence.
    await this.updateLiveCallTwiml(input.providerCallId, twiml, "sendDtmf");
  }

  /**
   * Play TTS via core TTS and Twilio Media Streams.
   * Generates audio with core TTS, converts to mu-law, and streams via WebSocket.
   * Uses a queue to serialize playback and prevent overlapping audio.
   */
  private async playTtsViaStream(text: string, streamSid: string): Promise<void> {
    if (!this.ttsProvider || !this.mediaStreamHandler) {
      throw new Error("TTS provider and media stream handler required");
    }

    // Stream audio in 20ms chunks (160 bytes at 8kHz mu-law)
    const CHUNK_SIZE = 160;
    const CHUNK_DELAY_MS = 20;
    const SILENCE_CHUNK = Buffer.alloc(CHUNK_SIZE, 0xff);

    const handler = this.mediaStreamHandler;
    const ttsProvider = this.ttsProvider;

    const normalizeSendResult = (raw: unknown): StreamSendResult => {
      if (!raw || typeof raw !== "object") {
        return { sent: true };
      }
      const typed = raw as {
        sent?: unknown;
      };
      return {
        // Older handlers returned void; treat that as success while allowing
        // newer handlers to report dropped frames or marks explicitly.
        sent: typed.sent === undefined ? true : Boolean(typed.sent),
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

    await handler.queueTts(streamSid, async (signal) => {
      const sendKeepAlive = () => {
        sendAudioChunk(SILENCE_CHUNK);
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
      const synthTimeoutMs = ttsProvider.synthesisTimeoutMs;
      try {
        const synthPromise = ttsProvider.synthesizeForTelephony(text);
        const timeoutPromise = new Promise<Buffer>((_, reject) => {
          synthTimeout = setTimeout(() => {
            reject(new Error(`Telephony TTS synthesis timed out after ${synthTimeoutMs}ms`));
          }, synthTimeoutMs);
        });
        muLawAudio = await Promise.race([synthPromise, timeoutPromise]);
      } finally {
        if (synthTimeout) {
          clearTimeout(synthTimeout);
        }
        clearInterval(keepAlive);
      }

      if (muLawAudio.length === 0) {
        throw new Error("Telephony TTS produced no audio");
      }

      let chunkAttempts = 0;
      let chunkDelivered = 0;
      let nextChunkDueAt = Date.now() + CHUNK_DELAY_MS;
      for (const chunk of chunkAudio(muLawAudio, CHUNK_SIZE)) {
        if (signal.aborted) {
          break;
        }
        chunkAttempts += 1;
        const chunkResult = sendAudioChunk(chunk);
        if (chunkResult.sent) {
          chunkDelivered += 1;
        }

        // Drift-corrected pacing: schedule against an absolute clock to avoid cumulative delay.
        const waitMs = nextChunkDueAt - Date.now();
        if (waitMs > 0) {
          await new Promise((resolve) => {
            setTimeout(resolve, Math.ceil(waitMs));
          });
        }
        nextChunkDueAt += CHUNK_DELAY_MS;
        if (signal.aborted) {
          break;
        }
      }

      let markSent = true;
      if (!signal.aborted) {
        // Send a mark to track when audio finishes
        markSent = sendPlaybackMark(`tts-${Date.now()}`).sent;
      }

      if (!signal.aborted && chunkAttempts > 0 && (chunkDelivered === 0 || !markSent)) {
        const failures: string[] = [];
        if (chunkDelivered === 0) {
          failures.push("no audio chunks delivered");
        }
        if (!markSent) {
          failures.push("completion mark not delivered");
        }
        throw new Error(`Telephony stream playback failed: ${failures.join("; ")}`);
      }
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

    await this.updateLiveCallTwiml(input.providerCallId, twiml, "startListening");
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

interface TwilioCallResponse {
  sid: string;
  status: string;
  direction: string;
  from: string;
  to: string;
  uri: string;
}
