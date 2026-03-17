import crypto from "node:crypto";
import { verifyTelnyxWebhook } from "../webhook-security.js";
import { guardedJsonApiRequest } from "./shared/guarded-json-api.js";
class TelnyxProvider {
  constructor(config, options = {}) {
    this.name = "telnyx";
    this.baseUrl = "https://api.telnyx.com/v2";
    this.apiHost = "api.telnyx.com";
    if (!config.apiKey) {
      throw new Error("Telnyx API key is required");
    }
    if (!config.connectionId) {
      throw new Error("Telnyx connection ID is required");
    }
    this.apiKey = config.apiKey;
    this.connectionId = config.connectionId;
    this.publicKey = config.publicKey;
    this.options = options;
  }
  /**
   * Make an authenticated request to the Telnyx API.
   */
  async apiRequest(endpoint, body, options) {
    return await guardedJsonApiRequest({
      url: `${this.baseUrl}${endpoint}`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body,
      allowNotFound: options?.allowNotFound,
      allowedHostnames: [this.apiHost],
      auditContext: "voice-call.telnyx.api",
      errorPrefix: "Telnyx API error"
    });
  }
  /**
   * Verify Telnyx webhook signature using Ed25519.
   */
  verifyWebhook(ctx) {
    const result = verifyTelnyxWebhook(ctx, this.publicKey, {
      skipVerification: this.options.skipVerification
    });
    return {
      ok: result.ok,
      reason: result.reason,
      isReplay: result.isReplay,
      verifiedRequestKey: result.verifiedRequestKey
    };
  }
  /**
   * Parse Telnyx webhook event into normalized format.
   */
  parseWebhookEvent(ctx, options) {
    try {
      const payload = JSON.parse(ctx.rawBody);
      const data = payload.data;
      if (!data || !data.event_type) {
        return { events: [], statusCode: 200 };
      }
      const event = this.normalizeEvent(data, options?.verifiedRequestKey);
      return {
        events: event ? [event] : [],
        statusCode: 200
      };
    } catch {
      return { events: [], statusCode: 400 };
    }
  }
  /**
   * Convert Telnyx event to normalized event format.
   */
  normalizeEvent(data, dedupeKey) {
    let callId = "";
    if (data.payload?.client_state) {
      try {
        callId = Buffer.from(data.payload.client_state, "base64").toString("utf8");
      } catch {
        callId = data.payload.client_state;
      }
    }
    if (!callId) {
      callId = data.payload?.call_control_id || "";
    }
    const baseEvent = {
      id: data.id || crypto.randomUUID(),
      dedupeKey,
      callId,
      providerCallId: data.payload?.call_control_id,
      timestamp: Date.now()
    };
    switch (data.event_type) {
      case "call.initiated":
        return { ...baseEvent, type: "call.initiated" };
      case "call.ringing":
        return { ...baseEvent, type: "call.ringing" };
      case "call.answered":
        return { ...baseEvent, type: "call.answered" };
      case "call.bridged":
        return { ...baseEvent, type: "call.active" };
      case "call.speak.started":
        return {
          ...baseEvent,
          type: "call.speaking",
          text: data.payload?.text || ""
        };
      case "call.transcription":
        return {
          ...baseEvent,
          type: "call.speech",
          transcript: data.payload?.transcription || "",
          isFinal: data.payload?.is_final ?? true,
          confidence: data.payload?.confidence
        };
      case "call.hangup":
        return {
          ...baseEvent,
          type: "call.ended",
          reason: this.mapHangupCause(data.payload?.hangup_cause)
        };
      case "call.dtmf.received":
        return {
          ...baseEvent,
          type: "call.dtmf",
          digits: data.payload?.digit || ""
        };
      default:
        return null;
    }
  }
  /**
   * Map Telnyx hangup cause to normalized end reason.
   * @see https://developers.telnyx.com/docs/api/v2/call-control/Call-Commands#hangup-causes
   */
  mapHangupCause(cause) {
    switch (cause) {
      case "normal_clearing":
      case "normal_unspecified":
        return "completed";
      case "originator_cancel":
        return "hangup-bot";
      case "call_rejected":
      case "user_busy":
        return "busy";
      case "no_answer":
      case "no_user_response":
        return "no-answer";
      case "destination_out_of_order":
      case "network_out_of_order":
      case "service_unavailable":
      case "recovery_on_timer_expire":
        return "failed";
      case "machine_detected":
      case "fax_detected":
        return "voicemail";
      case "user_hangup":
      case "subscriber_absent":
        return "hangup-user";
      default:
        if (cause) {
          console.warn(`[telnyx] Unknown hangup cause: ${cause}`);
        }
        return "completed";
    }
  }
  /**
   * Initiate an outbound call via Telnyx API.
   */
  async initiateCall(input) {
    const result = await this.apiRequest("/calls", {
      connection_id: this.connectionId,
      to: input.to,
      from: input.from,
      webhook_url: input.webhookUrl,
      webhook_url_method: "POST",
      client_state: Buffer.from(input.callId).toString("base64"),
      timeout_secs: 30
    });
    return {
      providerCallId: result.data.call_control_id,
      status: "initiated"
    };
  }
  /**
   * Hang up a call via Telnyx API.
   */
  async hangupCall(input) {
    await this.apiRequest(
      `/calls/${input.providerCallId}/actions/hangup`,
      { command_id: crypto.randomUUID() },
      { allowNotFound: true }
    );
  }
  /**
   * Play TTS audio via Telnyx speak action.
   */
  async playTts(input) {
    await this.apiRequest(`/calls/${input.providerCallId}/actions/speak`, {
      command_id: crypto.randomUUID(),
      payload: input.text,
      voice: input.voice || "female",
      language: input.locale || "en-US"
    });
  }
  /**
   * Start transcription (STT) via Telnyx.
   */
  async startListening(input) {
    await this.apiRequest(`/calls/${input.providerCallId}/actions/transcription_start`, {
      command_id: crypto.randomUUID(),
      language: input.language || "en"
    });
  }
  /**
   * Stop transcription via Telnyx.
   */
  async stopListening(input) {
    await this.apiRequest(
      `/calls/${input.providerCallId}/actions/transcription_stop`,
      { command_id: crypto.randomUUID() },
      { allowNotFound: true }
    );
  }
  async getCallStatus(input) {
    try {
      const data = await guardedJsonApiRequest({
        url: `${this.baseUrl}/calls/${input.providerCallId}`,
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        allowNotFound: true,
        allowedHostnames: [this.apiHost],
        auditContext: "telnyx-get-call-status",
        errorPrefix: "Telnyx get call status error"
      });
      if (!data) {
        return { status: "not-found", isTerminal: true };
      }
      const state = data.data?.state ?? "unknown";
      const isAlive = data.data?.is_alive;
      if (isAlive === void 0) {
        return { status: state, isTerminal: false, isUnknown: true };
      }
      return { status: state, isTerminal: !isAlive };
    } catch {
      return { status: "error", isTerminal: false, isUnknown: true };
    }
  }
}
export {
  TelnyxProvider
};
