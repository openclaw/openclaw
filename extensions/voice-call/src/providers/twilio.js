import crypto from "node:crypto";
import { getHeader } from "../http-headers.js";
import { chunkAudio } from "../telephony-audio.js";
import { escapeXml, mapVoiceToPolly } from "../voice-mapping.js";
import {
  isProviderStatusTerminal,
  mapProviderStatusToEndReason,
  normalizeProviderStatus
} from "./shared/call-status.js";
import { guardedJsonApiRequest } from "./shared/guarded-json-api.js";
import { twilioApiRequest } from "./twilio/api.js";
import { decideTwimlResponse, readTwimlRequestView } from "./twilio/twiml-policy.js";
import { verifyTwilioProviderWebhook } from "./twilio/webhook.js";
function createTwilioRequestDedupeKey(ctx, verifiedRequestKey) {
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
  return `twilio:fallback:${crypto.createHash("sha256").update(
    `${signature}
${callSid}
${callStatus}
${direction}
${callId}
${flow}
${turnToken}
${ctx.rawBody}`
  ).digest("hex")}`;
}
class TwilioProvider {
  constructor(config, options = {}) {
    this.name = "twilio";
    this.callWebhookUrls = /* @__PURE__ */ new Map();
    /** Current public webhook URL (set when tunnel starts or from config) */
    this.currentPublicUrl = null;
    /** Optional telephony TTS provider for streaming TTS */
    this.ttsProvider = null;
    /** Optional media stream handler for sending audio */
    this.mediaStreamHandler = null;
    /** Map of call SID to stream SID for media streams */
    this.callStreamMap = /* @__PURE__ */ new Map();
    /** Per-call tokens for media stream authentication */
    this.streamAuthTokens = /* @__PURE__ */ new Map();
    /** Storage for TwiML content (for notify mode with URL-based TwiML) */
    this.twimlStorage = /* @__PURE__ */ new Map();
    /** Track notify-mode calls to avoid streaming on follow-up callbacks */
    this.notifyCalls = /* @__PURE__ */ new Set();
    this.activeStreamCalls = /* @__PURE__ */ new Set();
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
  /**
   * Delete stored TwiML for a given `callId`.
   *
   * We keep TwiML in-memory only long enough to satisfy the initial Twilio
   * webhook request (notify mode). Subsequent webhooks should not reuse it.
   */
  deleteStoredTwiml(callId) {
    this.twimlStorage.delete(callId);
    this.notifyCalls.delete(callId);
  }
  /**
   * Delete stored TwiML for a call, addressed by Twilio's provider call SID.
   *
   * This is used when we only have `providerCallId` (e.g. hangup).
   */
  deleteStoredTwimlForProviderCall(providerCallId) {
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
  setPublicUrl(url) {
    this.currentPublicUrl = url;
  }
  getPublicUrl() {
    return this.currentPublicUrl;
  }
  setTTSProvider(provider) {
    this.ttsProvider = provider;
  }
  setMediaStreamHandler(handler) {
    this.mediaStreamHandler = handler;
  }
  registerCallStream(callSid, streamSid) {
    this.callStreamMap.set(callSid, streamSid);
  }
  unregisterCallStream(callSid) {
    this.callStreamMap.delete(callSid);
    this.activeStreamCalls.delete(callSid);
  }
  isValidStreamToken(callSid, token) {
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
  clearTtsQueue(callSid) {
    const streamSid = this.callStreamMap.get(callSid);
    if (streamSid && this.mediaStreamHandler) {
      this.mediaStreamHandler.clearTtsQueue(streamSid);
    }
  }
  /**
   * Make an authenticated request to the Twilio API.
   */
  async apiRequest(endpoint, params, options) {
    return await twilioApiRequest({
      baseUrl: this.baseUrl,
      accountSid: this.accountSid,
      authToken: this.authToken,
      endpoint,
      body: params,
      allowNotFound: options?.allowNotFound
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
  verifyWebhook(ctx) {
    return verifyTwilioProviderWebhook({
      ctx,
      authToken: this.authToken,
      currentPublicUrl: this.currentPublicUrl,
      options: this.options
    });
  }
  /**
   * Parse Twilio webhook event into normalized format.
   */
  parseWebhookEvent(ctx, options) {
    try {
      const params = new URLSearchParams(ctx.rawBody);
      const callIdFromQuery = typeof ctx.query?.callId === "string" && ctx.query.callId.trim() ? ctx.query.callId.trim() : void 0;
      const turnTokenFromQuery = typeof ctx.query?.turnToken === "string" && ctx.query.turnToken.trim() ? ctx.query.turnToken.trim() : void 0;
      const dedupeKey = createTwilioRequestDedupeKey(ctx, options?.verifiedRequestKey);
      const event = this.normalizeEvent(params, {
        callIdOverride: callIdFromQuery,
        dedupeKey,
        turnToken: turnTokenFromQuery
      });
      const twiml = this.generateTwimlResponse(ctx);
      return {
        events: event ? [event] : [],
        providerResponseBody: twiml,
        providerResponseHeaders: { "Content-Type": "application/xml" },
        statusCode: 200
      };
    } catch {
      return { events: [], statusCode: 400 };
    }
  }
  /**
   * Parse Twilio direction to normalized format.
   */
  static parseDirection(direction) {
    if (direction === "inbound") {
      return "inbound";
    }
    if (direction === "outbound-api" || direction === "outbound-dial") {
      return "outbound";
    }
    return void 0;
  }
  /**
   * Convert Twilio webhook params to normalized event format.
   */
  normalizeEvent(params, options) {
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
      from: params.get("From") || void 0,
      to: params.get("To") || void 0
    };
    const speechResult = params.get("SpeechResult");
    if (speechResult) {
      return {
        ...baseEvent,
        type: "call.speech",
        transcript: speechResult,
        isFinal: true,
        confidence: parseFloat(params.get("Confidence") || "0.9")
      };
    }
    const digits = params.get("Digits");
    if (digits) {
      return { ...baseEvent, type: "call.dtmf", digits };
    }
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
  static {
    this.EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  }
  static {
    this.PAUSE_TWIML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="30"/>
</Response>`;
  }
  static {
    this.QUEUE_TWIML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Please hold while we connect you.</Say>
  <Enqueue waitUrl="/voice/hold-music">hold-queue</Enqueue>
</Response>`;
  }
  /**
   * Generate TwiML response for webhook.
   * When a call is answered, connects to media stream for bidirectional audio.
   */
  generateTwimlResponse(ctx) {
    if (!ctx) {
      return TwilioProvider.EMPTY_TWIML;
    }
    const view = readTwimlRequestView(ctx);
    const storedTwiml = view.callIdFromQuery ? this.twimlStorage.get(view.callIdFromQuery) : void 0;
    const decision = decideTwimlResponse({
      ...view,
      hasStoredTwiml: Boolean(storedTwiml),
      isNotifyCall: view.callIdFromQuery ? this.notifyCalls.has(view.callIdFromQuery) : false,
      hasActiveStreams: this.activeStreamCalls.size > 0,
      canStream: Boolean(view.callSid && this.getStreamUrl())
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
  getStreamUrl() {
    if (!this.currentPublicUrl || !this.options.streamPath) {
      return null;
    }
    const url = new URL(this.currentPublicUrl);
    const origin = url.origin;
    const wsOrigin = origin.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
    const path = this.options.streamPath.startsWith("/") ? this.options.streamPath : `/${this.options.streamPath}`;
    return `${wsOrigin}${path}`;
  }
  getStreamAuthToken(callSid) {
    const existing = this.streamAuthTokens.get(callSid);
    if (existing) {
      return existing;
    }
    const token = crypto.randomBytes(16).toString("base64url");
    this.streamAuthTokens.set(callSid, token);
    return token;
  }
  getStreamUrlForCall(callSid) {
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
  getStreamConnectXml(streamUrl) {
    const parsed = new URL(streamUrl);
    const token = parsed.searchParams.get("token");
    parsed.searchParams.delete("token");
    const cleanUrl = parsed.toString();
    const paramXml = token ? `
      <Parameter name="token" value="${escapeXml(token)}" />` : "";
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
  async initiateCall(input) {
    const url = new URL(input.webhookUrl);
    url.searchParams.set("callId", input.callId);
    const statusUrl = new URL(input.webhookUrl);
    statusUrl.searchParams.set("callId", input.callId);
    statusUrl.searchParams.set("type", "status");
    if (input.inlineTwiml) {
      this.twimlStorage.set(input.callId, input.inlineTwiml);
      this.notifyCalls.add(input.callId);
    }
    const params = {
      To: input.to,
      From: input.from,
      Url: url.toString(),
      // TwiML serving endpoint
      StatusCallback: statusUrl.toString(),
      // Separate status callback endpoint
      StatusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      Timeout: "30"
    };
    const result = await this.apiRequest("/Calls.json", params);
    this.callWebhookUrls.set(result.sid, url.toString());
    return {
      providerCallId: result.sid,
      status: result.status === "queued" ? "queued" : "initiated"
    };
  }
  /**
   * Hang up a call via Twilio API.
   */
  async hangupCall(input) {
    this.deleteStoredTwimlForProviderCall(input.providerCallId);
    this.callWebhookUrls.delete(input.providerCallId);
    this.streamAuthTokens.delete(input.providerCallId);
    this.activeStreamCalls.delete(input.providerCallId);
    await this.apiRequest(
      `/Calls/${input.providerCallId}.json`,
      { Status: "completed" },
      { allowNotFound: true }
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
  async playTts(input) {
    const streamSid = this.callStreamMap.get(input.providerCallId);
    if (this.ttsProvider && this.mediaStreamHandler && streamSid) {
      try {
        await this.playTtsViaStream(input.text, streamSid);
        return;
      } catch (err) {
        console.warn(
          `[voice-call] Telephony TTS failed, falling back to Twilio <Say>:`,
          err instanceof Error ? err.message : err
        );
      }
    }
    const webhookUrl = this.callWebhookUrls.get(input.providerCallId);
    if (!webhookUrl) {
      throw new Error("Missing webhook URL for this call (provider state not initialized)");
    }
    console.warn(
      "[voice-call] Using TwiML <Say> fallback - telephony TTS not configured or media stream not active"
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
      Twiml: twiml
    });
  }
  /**
   * Play TTS via core TTS and Twilio Media Streams.
   * Generates audio with core TTS, converts to mu-law, and streams via WebSocket.
   * Uses a queue to serialize playback and prevent overlapping audio.
   */
  async playTtsViaStream(text, streamSid) {
    if (!this.ttsProvider || !this.mediaStreamHandler) {
      throw new Error("TTS provider and media stream handler required");
    }
    const CHUNK_SIZE = 160;
    const CHUNK_DELAY_MS = 20;
    const handler = this.mediaStreamHandler;
    const ttsProvider = this.ttsProvider;
    await handler.queueTts(streamSid, async (signal) => {
      const muLawAudio = await ttsProvider.synthesizeForTelephony(text);
      for (const chunk of chunkAudio(muLawAudio, CHUNK_SIZE)) {
        if (signal.aborted) {
          break;
        }
        handler.sendAudio(streamSid, chunk);
        await new Promise((resolve) => setTimeout(resolve, CHUNK_DELAY_MS));
        if (signal.aborted) {
          break;
        }
      }
      if (!signal.aborted) {
        handler.sendMark(streamSid, `tts-${Date.now()}`);
      }
    });
  }
  /**
   * Start listening for speech via Twilio <Gather>.
   */
  async startListening(input) {
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
      Twiml: twiml
    });
  }
  /**
   * Stop listening - for Twilio this is a no-op as <Gather> auto-ends.
   */
  async stopListening(_input) {
  }
  async getCallStatus(input) {
    try {
      const data = await guardedJsonApiRequest({
        url: `${this.baseUrl}/Calls/${input.providerCallId}.json`,
        method: "GET",
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64")}`
        },
        allowNotFound: true,
        allowedHostnames: ["api.twilio.com"],
        auditContext: "twilio-get-call-status",
        errorPrefix: "Twilio get call status error"
      });
      if (!data) {
        return { status: "not-found", isTerminal: true };
      }
      const status = normalizeProviderStatus(data.status);
      return { status, isTerminal: isProviderStatusTerminal(status) };
    } catch {
      return { status: "error", isTerminal: false, isUnknown: true };
    }
  }
}
export {
  TwilioProvider
};
