import crypto from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { TelnyxConfig, TelnyxNoiseSuppressionEngineConfig } from "../config.js";
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
import { assertVoiceCallProviderSetting, type VoiceCallProvider } from "./base.js";
import { createCarrierApi } from "./shared/carrier-api.js";

interface TelnyxProviderOptions {
  /** Skip webhook signature verification (development only, NOT for production) */
  skipVerification?: boolean;
}

// The realtime stream token issued before answerCall expires 30s later, so a stalled
// suppression_start must give up well before then to leave streaming_start a live token.
const NOISE_SUPPRESSION_START_TIMEOUT_MS = 5_000;

/** OpenClaw engine tuning keys and the `noise_suppression_engine_config` names Telnyx expects. */
const NOISE_SUPPRESSION_ENGINE_CONFIG_FIELDS = [
  ["model", "model"],
  ["suppressionLevel", "suppression_level"],
  ["attenuationLimit", "attenuation_limit"],
  ["mode", "mode"],
  ["enhancementLevel", "enhancement_level"],
  ["voiceGain", "voice_gain"],
] as const satisfies ReadonlyArray<readonly [keyof TelnyxNoiseSuppressionEngineConfig, string]>;

/** Map OpenClaw's camelCase engine tuning onto Telnyx's `noise_suppression_engine_config` keys. */
function buildTelnyxNoiseSuppressionEngineConfig(
  config: TelnyxNoiseSuppressionEngineConfig,
): Record<string, string | number> {
  return Object.fromEntries(
    NOISE_SUPPRESSION_ENGINE_CONFIG_FIELDS.flatMap(([key, telnyxKey]) =>
      config[key] === undefined ? [] : [[telnyxKey, config[key]]],
    ),
  );
}

const HANGUP_REASONS = new Map<string, EndReason>([
  ["normal_clearing", "completed"],
  ["normal_unspecified", "completed"],
  ["originator_cancel", "hangup-bot"],
  ["call_rejected", "busy"],
  ["user_busy", "busy"],
  ["no_answer", "no-answer"],
  ["no_user_response", "no-answer"],
  ["destination_out_of_order", "failed"],
  ["network_out_of_order", "failed"],
  ["service_unavailable", "failed"],
  ["recovery_on_timer_expire", "failed"],
  ["machine_detected", "voicemail"],
  ["fax_detected", "voicemail"],
  ["user_hangup", "hangup-user"],
  ["subscriber_absent", "hangup-user"],
]);

function normalizeTelnyxDirection(
  direction: string | undefined,
): "inbound" | "outbound" | undefined {
  if (direction === "incoming" || direction === "inbound") {
    return "inbound";
  }
  if (direction === "outgoing" || direction === "outbound") {
    return "outbound";
  }
  return undefined;
}

function normalizeBase64ForCompare(value: string): string {
  return value.replace(/=+$/u, "").replace(/-/gu, "+").replace(/_/gu, "/");
}

function decodeClientStateBase64(value: string): string | null {
  const buffer = Buffer.from(value, "base64");
  if (normalizeBase64ForCompare(buffer.toString("base64")) !== normalizeBase64ForCompare(value)) {
    return null;
  }
  return buffer.toString("utf8");
}

export class TelnyxProvider implements VoiceCallProvider {
  readonly name = "telnyx" as const;

  private readonly connectionId: string;
  private readonly publicKey: string | undefined;
  private readonly noiseSuppression: TelnyxConfig["noiseSuppression"];
  private readonly options: TelnyxProviderOptions;
  private readonly api: ReturnType<typeof createCarrierApi>;

  /**
   * Build a Telnyx Call Control provider. `config` supplies the API key and connection ID
   * (both required; throws when either is missing), the optional webhook public key, and the
   * optional `noiseSuppression` settings that `answerCall` applies to streamed calls.
   * `options` carries provider flags such as `skipVerification`.
   */
  constructor(config: TelnyxConfig, options: TelnyxProviderOptions = {}) {
    assertVoiceCallProviderSetting(config.apiKey, "Telnyx API key is required");
    assertVoiceCallProviderSetting(config.connectionId, "Telnyx connection ID is required");

    this.connectionId = config.connectionId;
    this.publicKey = config.publicKey;
    this.noiseSuppression = config.noiseSuppression;
    this.options = options;
    this.api = createCarrierApi("Telnyx", "https://api.telnyx.com/v2", `Bearer ${config.apiKey}`, {
      statusContentType: "application/json",
    });
  }

  verifyWebhook(ctx: WebhookContext): WebhookVerificationResult {
    return verifyTelnyxWebhook(ctx, this.publicKey, {
      skipVerification: this.options.skipVerification,
    });
  }

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

  private normalizeEvent(data: TelnyxEvent, dedupeKey?: string): NormalizedEvent | null {
    let callId = "";
    if (data.payload?.client_state) {
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
      case "call.ringing":
      case "call.answered":
        return { ...baseEvent, type: data.event_type };

      case "call.bridged":
        return { ...baseEvent, type: "call.active" };

      case "call.speak.started":
        return {
          ...baseEvent,
          type: "call.speaking",
          text: data.payload?.text || "",
        };

      case "call.transcription": {
        const transcript =
          data.payload?.transcription_data?.transcript ?? data.payload?.transcription ?? "";
        if (!transcript.trim()) {
          return null;
        }
        return {
          ...baseEvent,
          type: "call.speech",
          transcript,
          isFinal: data.payload?.transcription_data?.is_final ?? data.payload?.is_final ?? true,
        };
      }

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

      default:
        return null;
    }
  }

  private mapHangupCause(cause?: string): EndReason {
    const reason = cause && HANGUP_REASONS.get(cause);
    if (reason) {
      return reason;
    }
    if (cause) {
      console.warn(`[telnyx] Unknown hangup cause: ${cause}`);
    }
    return "completed";
  }

  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    const body: Record<string, unknown> = {
      connection_id: this.connectionId,
      to: input.to,
      from: input.from,
      webhook_url: input.webhookUrl,
      webhook_url_method: "POST",
      client_state: Buffer.from(input.callId).toString("base64"),
      timeout_secs: 30,
      ...buildTelnyxStreamingFields(input.streamUrl, input.streamAuthToken),
    };
    const result = await this.api.request<TelnyxCallResponse>("/calls", body);

    return {
      providerCallId: result.data.call_control_id,
      status: "initiated",
    };
  }

  async hangupCall(input: HangupCallInput): Promise<void> {
    await this.api.request(
      `/calls/${input.providerCallId}/actions/hangup`,
      { command_id: crypto.randomUUID() },
      { allowNotFound: true },
    );
  }

  /**
   * Answer an inbound Telnyx call and attach its media stream. `input.providerCallId` is the
   * Telnyx call control ID, `input.callId` keys the idempotent `command_id`s, and
   * `input.streamUrl`/`input.streamAuthToken` describe the optional realtime media stream.
   * Resolves once every step has succeeded or been skipped.
   *
   * Without a stream URL or without `noiseSuppression` configured, this sends a single `answer`
   * carrying any streaming fields, and an `answer` failure rejects.
   *
   * With both, the steps must run in this order, because Telnyx rejects `suppression_start`
   * while media streaming is active:
   * 1. `answer` without streaming fields. Failure hangs the call up (best effort, since Telnyx may
   *    have answered before its response was lost) and rejects with the `answer` error.
   * 2. `suppression_start` with the configured direction, engine, and engine config, capped at 5s so the stream
   *    token stays valid. Failure or timeout is logged and the call streams without suppression.
   * 3. `streaming_start` with the streaming fields. Failure hangs the answered call up (a failed
   *    hangup is only logged) and rejects with the `streaming_start` error as `cause`.
   */
  async answerCall(input: AnswerCallInput): Promise<void> {
    const streaming = buildTelnyxStreamingFields(input.streamUrl, input.streamAuthToken);
    // Telnyx rejects suppression_start while media streaming is active (422, code 90045),
    // so a suppressed call answers without its stream and starts it after suppression.
    const suppression = input.streamUrl ? this.noiseSuppression : undefined;
    try {
      await this.api.request(`/calls/${input.providerCallId}/actions/answer`, {
        command_id: `openclaw-answer-${input.callId}`,
        ...(suppression ? {} : streaming),
      });
    } catch (err) {
      // This answer carries no stream; if Telnyx answered but its response was lost, the
      // caller would sit on silence, so release the call before reporting the failure.
      if (suppression) {
        await this.hangUpAfterFailedStep(input, "answer");
      }
      throw err;
    }
    if (!suppression) {
      return;
    }
    try {
      await this.api.request(
        `/calls/${input.providerCallId}/actions/suppression_start`,
        {
          command_id: `openclaw-suppression-${input.callId}`,
          direction: suppression.direction,
          ...(suppression.engine ? { noise_suppression_engine: suppression.engine } : {}),
          ...(suppression.engineConfig
            ? {
                noise_suppression_engine_config: buildTelnyxNoiseSuppressionEngineConfig(
                  suppression.engineConfig,
                ),
              }
            : {}),
        },
        { timeoutMs: NOISE_SUPPRESSION_START_TIMEOUT_MS },
      );
    } catch (err) {
      // Fail open: streaming without suppression beats dropping the call.
      console.warn(
        `[telnyx] Noise suppression failed to start for call ${input.callId} (providerCallId=${input.providerCallId}); streaming without it: ${formatErrorMessage(err)}`,
      );
    }
    try {
      await this.api.request(`/calls/${input.providerCallId}/actions/streaming_start`, {
        command_id: `openclaw-streaming-${input.callId}`,
        ...streaming,
      });
    } catch (err) {
      // The call is already answered; without media the caller would sit on silence.
      await this.hangUpAfterFailedStep(input, "streaming_start");
      const message = `call answered but Telnyx streaming_start failed; hanging up: ${formatErrorMessage(err)}`;
      throw new Error(message, { cause: err });
    }
  }

  /** Hang up a call whose answer setup failed; a failed hangup is only logged. */
  private async hangUpAfterFailedStep(input: AnswerCallInput, step: string): Promise<void> {
    await this.hangupCall({
      callId: input.callId,
      providerCallId: input.providerCallId,
      reason: "error",
    }).catch((hangupErr: unknown) => {
      console.warn(
        `[telnyx] Failed to hang up call ${input.callId} after ${step} failed: ${formatErrorMessage(hangupErr)}`,
      );
    });
  }

  async playTts(input: PlayTtsInput): Promise<void> {
    await this.api.request(`/calls/${input.providerCallId}/actions/speak`, {
      command_id: crypto.randomUUID(),
      payload: input.text,
      voice: input.voice || "female",
      language: input.locale || "en-US",
    });
  }

  async startListening(input: StartListeningInput): Promise<void> {
    await this.api.request(`/calls/${input.providerCallId}/actions/transcription_start`, {
      command_id: crypto.randomUUID(),
      language: input.language || "en",
    });
  }

  async stopListening(input: StopListeningInput): Promise<void> {
    await this.api.request(
      `/calls/${input.providerCallId}/actions/transcription_stop`,
      { command_id: crypto.randomUUID() },
      { allowNotFound: true },
    );
  }

  async getCallStatus(input: GetCallStatusInput): Promise<GetCallStatusResult> {
    return this.api.getCallStatus<{ data?: { state?: string; is_alive?: boolean } }>(
      `/calls/${input.providerCallId}`,
      (data) => {
        const status = data.data?.state ?? "unknown";
        const isAlive = data.data?.is_alive;
        return isAlive === undefined
          ? { status, isTerminal: false, isUnknown: true }
          : { status, isTerminal: !isAlive };
      },
    );
  }
}

function buildTelnyxStreamingFields(
  streamUrl: string | undefined,
  streamAuthToken: string | undefined,
): Record<string, unknown> {
  if (!streamUrl) {
    return {};
  }
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
  };
}
