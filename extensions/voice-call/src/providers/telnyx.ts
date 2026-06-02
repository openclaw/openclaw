import crypto from "node:crypto";
import type { TelnyxConfig } from "../config.js";
import type {
  AnswerCallInput,
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
import { verifyTelnyxWebhook } from "../webhook-security.js";
import type { VoiceCallProvider } from "./base.js";
import { guardedJsonApiRequest } from "./shared/guarded-json-api.js";

/** Telnyx provider knobs that affect webhook verification behavior. */
export interface TelnyxProviderOptions {
  /** Development-only escape hatch; production webhooks should verify Ed25519 signatures. */
  skipVerification?: boolean;
}

function normalizeTelnyxDirection(
  direction: string | undefined,
): "inbound" | "outbound" | undefined {
  switch (direction) {
    case "incoming":
    case "inbound":
      return "inbound";
    case "outgoing":
    case "outbound":
      return "outbound";
    default:
      return undefined;
  }
}

function normalizeBase64ForCompare(value: string): string {
  return value.replace(/=+$/u, "").replace(/-/gu, "+").replace(/_/gu, "/");
}

function decodeClientStateBase64(value: string): string | null {
  const buffer = Buffer.from(value, "base64");
  if (normalizeBase64ForCompare(buffer.toString("base64")) !== normalizeBase64ForCompare(value)) {
    // Telnyx echoes client_state; reject malformed base64 instead of inventing a call id.
    return null;
  }
  return buffer.toString("utf8");
}

/** Telnyx Call Control provider for outbound/inbound call control and PCMU media streaming. */
export class TelnyxProvider implements VoiceCallProvider {
  readonly name = "telnyx" as const;

  private readonly apiKey: string;
  private readonly connectionId: string;
  private readonly publicKey: string | undefined;
  private readonly options: TelnyxProviderOptions;
  private readonly baseUrl = "https://api.telnyx.com/v2";
  private readonly apiHost = "api.telnyx.com";

  constructor(config: TelnyxConfig, options: TelnyxProviderOptions = {}) {
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

  /** Sends an authenticated Telnyx Call Control command through the SSRF guard. */
  private async apiRequest<T = unknown>(
    endpoint: string,
    body: Record<string, unknown>,
    options?: { allowNotFound?: boolean },
  ): Promise<T> {
    return await guardedJsonApiRequest<T>({
      url: `${this.baseUrl}${endpoint}`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body,
      allowNotFound: options?.allowNotFound,
      allowedHostnames: [this.apiHost],
      auditContext: "voice-call.telnyx.api",
      errorPrefix: "Telnyx API error",
    });
  }

  /** Verifies Telnyx webhook signatures and returns replay keys for manager dedupe. */
  verifyWebhook(ctx: WebhookContext): WebhookVerificationResult {
    const result = verifyTelnyxWebhook(ctx, this.publicKey, {
      skipVerification: this.options.skipVerification,
    });

    return {
      ok: result.ok,
      reason: result.reason,
      isReplay: result.isReplay,
      verifiedRequestKey: result.verifiedRequestKey,
    };
  }

  /** Parses one Telnyx webhook into the manager's normalized event envelope. */
  parseWebhookEvent(
    ctx: WebhookContext,
    options?: WebhookParseOptions,
  ): ProviderWebhookParseResult {
    try {
      const payload = JSON.parse(ctx.rawBody);
      const data = payload.data;

      if (!data || !data.event_type) {
        return { events: [], statusCode: 200 };
      }

      const event = this.normalizeEvent(data, options?.verifiedRequestKey);
      return {
        events: event ? [event] : [],
        statusCode: 200,
      };
    } catch {
      return { events: [], statusCode: 400 };
    }
  }

  /** Converts Telnyx Call Control events while preserving verified-request dedupe keys. */
  private normalizeEvent(data: TelnyxEvent, dedupeKey?: string): NormalizedEvent | null {
    let callId = "";
    if (data.payload?.client_state) {
      // Outbound calls encode OpenClaw's call id in client_state; fall back to raw carrier value.
      callId = decodeClientStateBase64(data.payload.client_state) ?? data.payload.client_state;
    }
    if (!callId) {
      callId = data.payload?.call_control_id || "";
    }

    const baseEvent = {
      id: data.id || crypto.randomUUID(),
      dedupeKey,
      callId,
      providerCallId: data.payload?.call_control_id,
      timestamp: Date.now(),
      direction: normalizeTelnyxDirection(data.payload?.direction),
      from: data.payload?.from,
      to: data.payload?.to,
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
          text: data.payload?.text || "",
        };

      case "call.transcription":
        return {
          ...baseEvent,
          type: "call.speech",
          transcript:
            data.payload?.transcription_data?.transcript ?? data.payload?.transcription ?? "",
          isFinal: data.payload?.transcription_data?.is_final ?? data.payload?.is_final ?? true,
          confidence: data.payload?.transcription_data?.confidence ?? data.payload?.confidence,
        };

      case "call.hangup":
        return {
          ...baseEvent,
          type: "call.ended",
          reason: this.mapHangupCause(data.payload?.hangup_cause),
        };

      case "call.dtmf.received":
        return {
          ...baseEvent,
          type: "call.dtmf",
          digits: data.payload?.digit || "",
        };

      case "streaming.started":
      case "streaming.stopped":
        // WebSocket bridge owns stream lifecycle; carrier lifecycle webhooks are acknowledged only.
        return null;

      default:
        return null;
    }
  }

  /** Maps Telnyx hangup causes to OpenClaw terminal reasons used by call records. */
  private mapHangupCause(cause?: string): EndReason {
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
        // Unknown Telnyx causes are not retryable proof; log and preserve historical completion behavior.
        if (cause) {
          console.warn(`[telnyx] Unknown hangup cause: ${cause}`);
        }
        return "completed";
    }
  }

  /** Starts an outbound Telnyx call and embeds the OpenClaw call id in signed callback state. */
  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    const body: Record<string, unknown> = {
      connection_id: this.connectionId,
      to: input.to,
      from: input.from,
      webhook_url: input.webhookUrl,
      webhook_url_method: "POST",
      // Telnyx echoes client_state on webhooks; encode the OpenClaw call id so
      // outbound callbacks can rejoin local state before call_control_id mapping exists.
      client_state: Buffer.from(input.callId).toString("base64"),
      timeout_secs: 30,
      ...(input.streamUrl
        ? buildTelnyxStreamingFields(input.streamUrl, input.streamAuthToken)
        : {}),
    };
    const result = await this.apiRequest<TelnyxCallResponse>("/calls", body);

    return {
      providerCallId: result.data.call_control_id,
      status: "initiated",
    };
  }

  /** Hangs up a call-control leg; missing legs are treated as already ended. */
  async hangupCall(input: HangupCallInput): Promise<void> {
    await this.apiRequest(
      `/calls/${input.providerCallId}/actions/hangup`,
      { command_id: crypto.randomUUID() },
      { allowNotFound: true },
    );
  }

  /** Answers an inbound call, optionally attaching the bidirectional PCMU stream bridge. */
  async answerCall(input: AnswerCallInput): Promise<void> {
    const body: Record<string, unknown> = {
      // Stable command id makes answer retries idempotent for one OpenClaw call.
      command_id: `openclaw-answer-${input.callId}`,
      ...(input.streamUrl
        ? buildTelnyxStreamingFields(input.streamUrl, input.streamAuthToken)
        : {}),
    };
    await this.apiRequest(`/calls/${input.providerCallId}/actions/answer`, body);
  }

  /** Plays text through Telnyx speak, passing provider-specific voice ids through unchanged. */
  async playTts(input: PlayTtsInput): Promise<void> {
    await this.apiRequest(`/calls/${input.providerCallId}/actions/speak`, {
      command_id: crypto.randomUUID(),
      payload: input.text,
      voice: input.voice || "female",
      language: input.locale || "en-US",
    });
  }

  /** Starts Telnyx transcription for the active call leg. */
  async startListening(input: StartListeningInput): Promise<void> {
    await this.apiRequest(`/calls/${input.providerCallId}/actions/transcription_start`, {
      command_id: crypto.randomUUID(),
      language: input.language || "en",
    });
  }

  /** Stops Telnyx transcription; missing legs are safe during hangup races. */
  async stopListening(input: StopListeningInput): Promise<void> {
    await this.apiRequest(
      `/calls/${input.providerCallId}/actions/transcription_stop`,
      { command_id: crypto.randomUUID() },
      { allowNotFound: true },
    );
  }

  /** Reads Telnyx liveness for restore; ambiguous responses stay non-terminal. */
  async getCallStatus(input: GetCallStatusInput): Promise<GetCallStatusResult> {
    try {
      const data = await guardedJsonApiRequest<{ data?: { state?: string; is_alive?: boolean } }>({
        url: `${this.baseUrl}/calls/${input.providerCallId}`,
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        allowNotFound: true,
        allowedHostnames: [this.apiHost],
        auditContext: "telnyx-get-call-status",
        errorPrefix: "Telnyx get call status error",
      });

      if (!data) {
        return { status: "not-found", isTerminal: true };
      }

      const state = data.data?.state ?? "unknown";
      const isAlive = data.data?.is_alive;
      if (isAlive === undefined) {
        // Missing liveness is not terminal proof; keep restore logic conservative.
        return { status: state, isTerminal: false, isUnknown: true };
      }
      return { status: state, isTerminal: !isAlive };
    } catch {
      return { status: "error", isTerminal: false, isUnknown: true };
    }
  }
}

function buildTelnyxStreamingFields(
  streamUrl: string,
  streamAuthToken: string | undefined,
): Record<string, unknown> {
  // Realtime voice expects 8kHz PCMU both ways; keep these fields in sync with
  // the WebSocket bridge's frame codec and sample-rate assumptions.
  return {
    stream_url: streamUrl,
    stream_track: "inbound_track",
    stream_codec: "PCMU",
    stream_bidirectional_mode: "rtp",
    stream_bidirectional_codec: "PCMU",
    stream_bidirectional_sampling_rate: 8000,
    stream_bidirectional_target_legs: "self",
    ...(streamAuthToken ? { stream_auth_token: streamAuthToken } : {}),
  };
}

interface TelnyxEvent {
  id?: string;
  event_type: string;
  payload?: {
    call_control_id?: string;
    client_state?: string;
    direction?: string;
    from?: string;
    to?: string;
    text?: string;
    transcription?: string;
    is_final?: boolean;
    confidence?: number;
    transcription_data?: {
      transcript?: string;
      is_final?: boolean;
      confidence?: number;
    };
    hangup_cause?: string;
    digit?: string;
    [key: string]: unknown;
  };
}

interface TelnyxCallResponse {
  data: {
    call_control_id: string;
    call_leg_id: string;
    call_session_id: string;
    is_alive: boolean;
    record_type: string;
  };
}
