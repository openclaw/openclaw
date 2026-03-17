import crypto from "node:crypto";
import { getHeader } from "../http-headers.js";
import { escapeXml } from "../voice-mapping.js";
import { reconstructWebhookUrl, verifyPlivoWebhook } from "../webhook-security.js";
import { guardedJsonApiRequest } from "./shared/guarded-json-api.js";
function createPlivoRequestDedupeKey(ctx) {
  const nonceV3 = getHeader(ctx.headers, "x-plivo-signature-v3-nonce");
  if (nonceV3) {
    return `plivo:v3:${nonceV3}`;
  }
  const nonceV2 = getHeader(ctx.headers, "x-plivo-signature-v2-nonce");
  if (nonceV2) {
    return `plivo:v2:${nonceV2}`;
  }
  return `plivo:fallback:${crypto.createHash("sha256").update(ctx.rawBody).digest("hex")}`;
}
class PlivoProvider {
  constructor(config, options = {}) {
    this.name = "plivo";
    // Best-effort mapping between create-call request UUID and call UUID.
    this.requestUuidToCallUuid = /* @__PURE__ */ new Map();
    // Used for transfer URLs and GetInput action URLs.
    this.callIdToWebhookUrl = /* @__PURE__ */ new Map();
    this.callUuidToWebhookUrl = /* @__PURE__ */ new Map();
    this.pendingSpeakByCallId = /* @__PURE__ */ new Map();
    this.pendingListenByCallId = /* @__PURE__ */ new Map();
    if (!config.authId) {
      throw new Error("Plivo Auth ID is required");
    }
    if (!config.authToken) {
      throw new Error("Plivo Auth Token is required");
    }
    this.authId = config.authId;
    this.authToken = config.authToken;
    this.baseUrl = `https://api.plivo.com/v1/Account/${this.authId}`;
    this.apiHost = new URL(this.baseUrl).hostname;
    this.options = options;
  }
  async apiRequest(params) {
    const { method, endpoint, body, allowNotFound } = params;
    return await guardedJsonApiRequest({
      url: `${this.baseUrl}${endpoint}`,
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.authId}:${this.authToken}`).toString("base64")}`,
        "Content-Type": "application/json"
      },
      body,
      allowNotFound,
      allowedHostnames: [this.apiHost],
      auditContext: "voice-call.plivo.api",
      errorPrefix: "Plivo API error"
    });
  }
  verifyWebhook(ctx) {
    const result = verifyPlivoWebhook(ctx, this.authToken, {
      publicUrl: this.options.publicUrl,
      skipVerification: this.options.skipVerification,
      allowedHosts: this.options.webhookSecurity?.allowedHosts,
      trustForwardingHeaders: this.options.webhookSecurity?.trustForwardingHeaders,
      trustedProxyIPs: this.options.webhookSecurity?.trustedProxyIPs,
      remoteIP: ctx.remoteAddress
    });
    if (!result.ok) {
      console.warn(`[plivo] Webhook verification failed: ${result.reason}`);
    }
    return {
      ok: result.ok,
      reason: result.reason,
      isReplay: result.isReplay,
      verifiedRequestKey: result.verifiedRequestKey
    };
  }
  parseWebhookEvent(ctx, options) {
    const flow = typeof ctx.query?.flow === "string" ? ctx.query.flow.trim() : "";
    const parsed = this.parseBody(ctx.rawBody);
    if (!parsed) {
      return { events: [], statusCode: 400 };
    }
    const callUuid = parsed.get("CallUUID") || void 0;
    if (callUuid) {
      const webhookBase = this.baseWebhookUrlFromCtx(ctx);
      if (webhookBase) {
        this.callUuidToWebhookUrl.set(callUuid, webhookBase);
      }
    }
    if (flow === "xml-speak") {
      const callId = this.getCallIdFromQuery(ctx);
      const pending = callId ? this.pendingSpeakByCallId.get(callId) : void 0;
      if (callId) {
        this.pendingSpeakByCallId.delete(callId);
      }
      const xml = pending ? PlivoProvider.xmlSpeak(pending.text, pending.locale) : PlivoProvider.xmlKeepAlive();
      return {
        events: [],
        providerResponseBody: xml,
        providerResponseHeaders: { "Content-Type": "text/xml" },
        statusCode: 200
      };
    }
    if (flow === "xml-listen") {
      const callId = this.getCallIdFromQuery(ctx);
      const pending = callId ? this.pendingListenByCallId.get(callId) : void 0;
      if (callId) {
        this.pendingListenByCallId.delete(callId);
      }
      const actionUrl = this.buildActionUrl(ctx, {
        flow: "getinput",
        callId
      });
      const xml = actionUrl && callId ? PlivoProvider.xmlGetInputSpeech({
        actionUrl,
        language: pending?.language
      }) : PlivoProvider.xmlKeepAlive();
      return {
        events: [],
        providerResponseBody: xml,
        providerResponseHeaders: { "Content-Type": "text/xml" },
        statusCode: 200
      };
    }
    const callIdFromQuery = this.getCallIdFromQuery(ctx);
    const dedupeKey = options?.verifiedRequestKey ?? createPlivoRequestDedupeKey(ctx);
    const event = this.normalizeEvent(parsed, callIdFromQuery, dedupeKey);
    return {
      events: event ? [event] : [],
      providerResponseBody: flow === "answer" || flow === "getinput" ? PlivoProvider.xmlKeepAlive() : PlivoProvider.xmlEmpty(),
      providerResponseHeaders: { "Content-Type": "text/xml" },
      statusCode: 200
    };
  }
  normalizeEvent(params, callIdOverride, dedupeKey) {
    const callUuid = params.get("CallUUID") || "";
    const requestUuid = params.get("RequestUUID") || "";
    if (requestUuid && callUuid) {
      this.requestUuidToCallUuid.set(requestUuid, callUuid);
    }
    const direction = params.get("Direction");
    const from = params.get("From") || void 0;
    const to = params.get("To") || void 0;
    const callStatus = params.get("CallStatus");
    const baseEvent = {
      id: crypto.randomUUID(),
      dedupeKey,
      callId: callIdOverride || callUuid || requestUuid,
      providerCallId: callUuid || requestUuid || void 0,
      timestamp: Date.now(),
      direction: direction === "inbound" ? "inbound" : direction === "outbound" ? "outbound" : void 0,
      from,
      to
    };
    const digits = params.get("Digits");
    if (digits) {
      return { ...baseEvent, type: "call.dtmf", digits };
    }
    const transcript = PlivoProvider.extractTranscript(params);
    if (transcript) {
      return {
        ...baseEvent,
        type: "call.speech",
        transcript,
        isFinal: true
      };
    }
    if (callStatus === "ringing") {
      return { ...baseEvent, type: "call.ringing" };
    }
    if (callStatus === "in-progress") {
      return { ...baseEvent, type: "call.answered" };
    }
    if (callStatus === "completed" || callStatus === "busy" || callStatus === "no-answer" || callStatus === "failed") {
      return {
        ...baseEvent,
        type: "call.ended",
        reason: callStatus === "completed" ? "completed" : callStatus === "busy" ? "busy" : callStatus === "no-answer" ? "no-answer" : "failed"
      };
    }
    if (params.get("Event") === "StartApp" && callUuid) {
      return { ...baseEvent, type: "call.answered" };
    }
    return null;
  }
  async initiateCall(input) {
    const webhookUrl = new URL(input.webhookUrl);
    webhookUrl.searchParams.set("provider", "plivo");
    webhookUrl.searchParams.set("callId", input.callId);
    const answerUrl = new URL(webhookUrl);
    answerUrl.searchParams.set("flow", "answer");
    const hangupUrl = new URL(webhookUrl);
    hangupUrl.searchParams.set("flow", "hangup");
    this.callIdToWebhookUrl.set(input.callId, input.webhookUrl);
    const ringTimeoutSec = this.options.ringTimeoutSec ?? 30;
    const result = await this.apiRequest({
      method: "POST",
      endpoint: "/Call/",
      body: {
        from: PlivoProvider.normalizeNumber(input.from),
        to: PlivoProvider.normalizeNumber(input.to),
        answer_url: answerUrl.toString(),
        answer_method: "POST",
        hangup_url: hangupUrl.toString(),
        hangup_method: "POST",
        // Plivo's API uses `hangup_on_ring` for outbound ring timeout.
        hangup_on_ring: ringTimeoutSec
      }
    });
    const requestUuid = Array.isArray(result.request_uuid) ? result.request_uuid[0] : result.request_uuid;
    if (!requestUuid) {
      throw new Error("Plivo call create returned no request_uuid");
    }
    return { providerCallId: requestUuid, status: "initiated" };
  }
  async hangupCall(input) {
    const callUuid = this.requestUuidToCallUuid.get(input.providerCallId);
    if (callUuid) {
      await this.apiRequest({
        method: "DELETE",
        endpoint: `/Call/${callUuid}/`,
        allowNotFound: true
      });
      return;
    }
    await this.apiRequest({
      method: "DELETE",
      endpoint: `/Call/${input.providerCallId}/`,
      allowNotFound: true
    });
    await this.apiRequest({
      method: "DELETE",
      endpoint: `/Request/${input.providerCallId}/`,
      allowNotFound: true
    });
  }
  resolveCallContext(params) {
    const callUuid = this.requestUuidToCallUuid.get(params.providerCallId) ?? params.providerCallId;
    const webhookBase = this.callUuidToWebhookUrl.get(callUuid) || this.callIdToWebhookUrl.get(params.callId);
    if (!webhookBase) {
      throw new Error("Missing webhook URL for this call (provider state missing)");
    }
    if (!callUuid) {
      throw new Error(`Missing Plivo CallUUID for ${params.operation}`);
    }
    return { callUuid, webhookBase };
  }
  async transferCallLeg(params) {
    const transferUrl = new URL(params.webhookBase);
    transferUrl.searchParams.set("provider", "plivo");
    transferUrl.searchParams.set("flow", params.flow);
    transferUrl.searchParams.set("callId", params.callId);
    await this.apiRequest({
      method: "POST",
      endpoint: `/Call/${params.callUuid}/`,
      body: {
        legs: "aleg",
        aleg_url: transferUrl.toString(),
        aleg_method: "POST"
      }
    });
  }
  async playTts(input) {
    const { callUuid, webhookBase } = this.resolveCallContext({
      providerCallId: input.providerCallId,
      callId: input.callId,
      operation: "playTts"
    });
    this.pendingSpeakByCallId.set(input.callId, {
      text: input.text,
      locale: input.locale
    });
    await this.transferCallLeg({
      callUuid,
      webhookBase,
      callId: input.callId,
      flow: "xml-speak"
    });
  }
  async startListening(input) {
    const { callUuid, webhookBase } = this.resolveCallContext({
      providerCallId: input.providerCallId,
      callId: input.callId,
      operation: "startListening"
    });
    this.pendingListenByCallId.set(input.callId, {
      language: input.language
    });
    await this.transferCallLeg({
      callUuid,
      webhookBase,
      callId: input.callId,
      flow: "xml-listen"
    });
  }
  async stopListening(_input) {
  }
  async getCallStatus(input) {
    const terminalStatuses = /* @__PURE__ */ new Set([
      "completed",
      "busy",
      "failed",
      "timeout",
      "no-answer",
      "cancel",
      "machine",
      "hangup"
    ]);
    try {
      const data = await guardedJsonApiRequest({
        url: `${this.baseUrl}/Call/${input.providerCallId}/`,
        method: "GET",
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.authId}:${this.authToken}`).toString("base64")}`
        },
        allowNotFound: true,
        allowedHostnames: [this.apiHost],
        auditContext: "plivo-get-call-status",
        errorPrefix: "Plivo get call status error"
      });
      if (!data) {
        return { status: "not-found", isTerminal: true };
      }
      const status = data.call_status ?? "unknown";
      return { status, isTerminal: terminalStatuses.has(status) };
    } catch {
      return { status: "error", isTerminal: false, isUnknown: true };
    }
  }
  static normalizeNumber(numberOrSip) {
    const trimmed = numberOrSip.trim();
    if (trimmed.toLowerCase().startsWith("sip:")) {
      return trimmed;
    }
    return trimmed.replace(/[^\d+]/g, "");
  }
  static xmlEmpty() {
    return `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
  }
  static xmlKeepAlive() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Wait length="300" />
</Response>`;
  }
  static xmlSpeak(text, locale) {
    const language = locale || "en-US";
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak language="${escapeXml(language)}">${escapeXml(text)}</Speak>
  <Wait length="300" />
</Response>`;
  }
  static xmlGetInputSpeech(params) {
    const language = params.language || "en-US";
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <GetInput inputType="speech" method="POST" action="${escapeXml(params.actionUrl)}" language="${escapeXml(language)}" executionTimeout="30" speechEndTimeout="1" redirect="false">
  </GetInput>
  <Wait length="300" />
</Response>`;
  }
  getCallIdFromQuery(ctx) {
    const callId = typeof ctx.query?.callId === "string" && ctx.query.callId.trim() ? ctx.query.callId.trim() : void 0;
    return callId || void 0;
  }
  buildActionUrl(ctx, opts) {
    const base = this.baseWebhookUrlFromCtx(ctx);
    if (!base) {
      return null;
    }
    const u = new URL(base);
    u.searchParams.set("provider", "plivo");
    u.searchParams.set("flow", opts.flow);
    if (opts.callId) {
      u.searchParams.set("callId", opts.callId);
    }
    return u.toString();
  }
  baseWebhookUrlFromCtx(ctx) {
    try {
      const u = new URL(
        reconstructWebhookUrl(ctx, {
          allowedHosts: this.options.webhookSecurity?.allowedHosts,
          trustForwardingHeaders: this.options.webhookSecurity?.trustForwardingHeaders,
          trustedProxyIPs: this.options.webhookSecurity?.trustedProxyIPs,
          remoteIP: ctx.remoteAddress
        })
      );
      return `${u.origin}${u.pathname}`;
    } catch {
      return null;
    }
  }
  parseBody(rawBody) {
    try {
      return new URLSearchParams(rawBody);
    } catch {
      return null;
    }
  }
  static extractTranscript(params) {
    const candidates = [
      "Speech",
      "Transcription",
      "TranscriptionText",
      "SpeechResult",
      "RecognizedSpeech",
      "Text"
    ];
    for (const key of candidates) {
      const value = params.get(key);
      if (value && value.trim()) {
        return value.trim();
      }
    }
    return null;
  }
}
export {
  PlivoProvider
};
