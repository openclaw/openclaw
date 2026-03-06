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
  clearTtsQueue(callSid: string): void {
    const streamSid = this.callStreamMap.get(callSid);
    if (streamSid && this.mediaStreamHandler) {
      this.mediaStreamHandler.clearTtsQueue(streamSid);
    }
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
        const streamData = view.callSid ? this.getStreamUrlForCall(view.callSid) : null;
        return streamData
          ? this.getStreamConnectXml(streamData.url, streamData.token)
          : TwilioProvider.PAUSE_TWIML;
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

  private getStreamUrlForCall(callSid: string): { url: string; token: string } | null {
    const baseUrl = this.getStreamUrl();
    if (!baseUrl) {
      return null;
    }
    const token = this.getStreamAuthToken(callSid);
    // Twilio <Stream> does NOT forward query string parameters on the WebSocket URL.
    // The token is passed as a <Parameter> element inside the TwiML instead,
    // and arrives in the WebSocket start message's customParameters.
    return { url: baseUrl, token };
  }

  /**
   * Generate TwiML to connect a call to a WebSocket media stream.
   * This enables bidirectional audio streaming for real-time STT/TTS.
   *
   * @param streamUrl - WebSocket URL (wss://...) for the media stream
   */
  getStreamConnectXml(streamUrl: string, token?: string): string {
    if (token) {
      return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(streamUrl)}">
      <Parameter name="token" value="${escapeXml(token)}" />
    </Stream>
  </Connect>
</Response>`;
    }
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(streamUrl)}" />
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
    // Try telephony TTS via media stream first (if configured)
    const streamSid = this.callStreamMap.get(input.providerCallId);
    if (this.ttsProvider && this.mediaStreamHandler && streamSid) {
      try {
        await this.playTtsViaStream(input.text, streamSid);
        return;
      } catch (err) {
        console.warn(
          `[voice-call] Telephony TTS failed, falling back to Twilio <Say>:`,
          err instanceof Error ? err.message : err,
        );
        // Fall through to TwiML <Say> fallback
      }
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
  }

  /**
   * Play TTS via core TTS and Twilio Media Streams.
   * Prefers streaming TTS (sends audio chunks as they arrive from the provider)
   * for lower latency. Falls back to buffered synthesis when streaming is unavailable.
   * Uses a queue to serialize playback and prevent overlapping audio.
   */
  private async playTtsViaStream(text: string, streamSid: string): Promise<void> {
    if (!this.ttsProvider || !this.mediaStreamHandler) {
      throw new Error("TTS provider and media stream handler required");
    }

    // Use larger chunks (80ms = 640 bytes) to reduce per-chunk overhead
    const CHUNK_SIZE = 640;
    const CHUNK_DELAY_MS = 80;

    const handler = this.mediaStreamHandler;
    const ttsProvider = this.ttsProvider;

    await handler.queueTts(streamSid, async (signal) => {
      let totalBytesSent = 0;

      // Prefer streaming TTS for lower latency
      if (ttsProvider.streamForTelephony) {
        console.log(`[voice-call] Using streaming TTS for stream ${streamSid}`);
        let remainder: Buffer = Buffer.alloc(0);
        let audioSent = false;
        let abortListenerAttached = false;
        const onAbort = () => {
          console.log(`[voice-call] Streaming TTS aborted for stream ${streamSid}`);
        };

        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
          abortListenerAttached = true;
        }

        try {
          for await (const chunk of ttsProvider.streamForTelephony(text, signal)) {
            if (chunk.length > 0) {
              console.log(`[voice-call] Streaming TTS chunk received: ${chunk.length} bytes`);
            }
            if (signal.aborted) {
              break;
            }

            // Accumulate audio and send in paced chunks
            remainder = remainder.length > 0 ? Buffer.concat([remainder, chunk]) : chunk;

            while (remainder.length >= CHUNK_SIZE) {
              if (signal.aborted) {
                break;
              }
              handler.sendAudio(streamSid, remainder.subarray(0, CHUNK_SIZE));
              totalBytesSent += CHUNK_SIZE;
              audioSent = true;
              remainder = remainder.subarray(CHUNK_SIZE);
              await new Promise((resolve) => setTimeout(resolve, CHUNK_DELAY_MS));
            }
          }
        } catch (err) {
          if (audioSent) {
            // Partial audio already sent — do not fall back to <Say> which would
            // replay the entire text, causing a jarring double-response.
            console.warn(
              `[voice-call] Streaming TTS failed after partial audio sent; suppressing fallback:`,
              err instanceof Error ? err.message : err,
            );
            console.log(
              `[voice-call] TTS bytes sent to Twilio for stream ${streamSid}: ${totalBytesSent}`,
            );
            return;
          }
          throw err;
        } finally {
          if (abortListenerAttached) {
            signal.removeEventListener("abort", onAbort);
          }
        }

        // Send any remaining audio
        if (!signal.aborted && remainder.length > 0) {
          handler.sendAudio(streamSid, remainder);
          totalBytesSent += remainder.length;
        }
      } else {
        console.log(`[voice-call] Using buffered TTS for stream ${streamSid}`);
        // Fallback: generate full audio buffer, then chunk and send
        const muLawAudio = await ttsProvider.synthesizeForTelephony(text);
        for (const chunk of chunkAudio(muLawAudio, CHUNK_SIZE)) {
          if (signal.aborted) {
            break;
          }
          handler.sendAudio(streamSid, chunk);
          totalBytesSent += chunk.length;
          await new Promise((resolve) => setTimeout(resolve, CHUNK_DELAY_MS));
          if (signal.aborted) {
            break;
          }
        }
      }

      if (!signal.aborted) {
        console.log(
          `[voice-call] TTS bytes sent to Twilio for stream ${streamSid}: ${totalBytesSent}`,
        );
        handler.sendMark(streamSid, `tts-${Date.now()}`);
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
