import crypto from "node:crypto";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { PlivoConfig, WebhookSecurityConfig } from "../config.js";
import { getHeader } from "../http-headers.js";
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
import { escapeXml } from "../voice-mapping.js";
import { reconstructWebhookUrl, verifyPlivoWebhook } from "../webhook-security.js";
import type { VoiceCallProvider } from "./base.js";
import { createCarrierApi } from "./shared/carrier-api.js";

interface PlivoProviderOptions {
  /** Override public URL origin for signature verification */
  publicUrl?: string;
  /** Skip webhook signature verification (development only) */
  skipVerification?: boolean;
  /** Outbound ring timeout in seconds */
  ringTimeoutSec?: number;
  /** Webhook security options (forwarded headers/allowlist) */
  webhookSecurity?: WebhookSecurityConfig;
}

type PendingSpeak = { text: string; locale?: string; listenAfterPlayback?: boolean };
type PendingListen = { language?: string };

function createPlivoRequestDedupeKey(ctx: WebhookContext): string {
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

export class PlivoProvider implements VoiceCallProvider {
  readonly name = "plivo" as const;

  private readonly authToken: string;
  private readonly options: PlivoProviderOptions;
  private readonly api: ReturnType<typeof createCarrierApi>;

  // Best-effort mapping between create-call request UUID and call UUID.
  private requestUuidToCallUuid = new Map<string, string>();

  // Used for transfer URLs and GetInput action URLs.
  private callIdToWebhookUrl = new Map<string, string>();
  private callUuidToWebhookUrl = new Map<string, string>();

  private pendingSpeakByCallId = new Map<string, PendingSpeak>();
  private pendingListenByCallId = new Map<string, PendingListen>();

  /**
   * Release all process-local metadata owned by one Plivo call.
   * Terminal webhooks can be replayed, so this must stay idempotent.
   */
  private releaseCallState(params: {
    callId?: string;
    providerCallId?: string;
    callUuid?: string;
  }): void {
    if (params.callId) {
      this.callIdToWebhookUrl.delete(params.callId);
      this.pendingSpeakByCallId.delete(params.callId);
      this.pendingListenByCallId.delete(params.callId);
    }

    const callUuid =
      params.callUuid ||
      (params.providerCallId
        ? (this.requestUuidToCallUuid.get(params.providerCallId) ?? params.providerCallId)
        : undefined);
    if (params.providerCallId) {
      this.requestUuidToCallUuid.delete(params.providerCallId);
      this.callUuidToWebhookUrl.delete(params.providerCallId);
    }
    if (!callUuid) {
      return;
    }

    this.callUuidToWebhookUrl.delete(callUuid);
    for (const [requestUuid, mappedCallUuid] of this.requestUuidToCallUuid) {
      if (mappedCallUuid === callUuid) {
        this.requestUuidToCallUuid.delete(requestUuid);
      }
    }
  }

  constructor(config: PlivoConfig, options: PlivoProviderOptions = {}) {
    if (!config.authId) {
      throw new Error("Plivo Auth ID is required");
    }
    if (!config.authToken) {
      throw new Error("Plivo Auth Token is required");
    }

    this.authToken = config.authToken;
    this.options = options;
    this.api = createCarrierApi(
      "Plivo",
      `https://api.plivo.com/v1/Account/${config.authId}`,
      `Basic ${Buffer.from(`${config.authId}:${config.authToken}`).toString("base64")}`,
    );
  }

  verifyWebhook(ctx: WebhookContext): WebhookVerificationResult {
    const result = verifyPlivoWebhook(ctx, this.authToken, {
      publicUrl: this.options.publicUrl,
      skipVerification: this.options.skipVerification,
      allowedHosts: this.options.webhookSecurity?.allowedHosts,
      trustForwardingHeaders: this.options.webhookSecurity?.trustForwardingHeaders,
      trustedProxyIPs: this.options.webhookSecurity?.trustedProxyIPs,
      remoteIP: ctx.remoteAddress,
    });

    if (!result.ok) {
      console.warn(`[plivo] Webhook verification failed: ${result.reason}`);
    }

    return {
      ok: result.ok,
      reason: result.reason,
      isReplay: result.isReplay,
      verifiedRequestKey: result.verifiedRequestKey,
      releaseReplay: result.releaseReplay,
    };
  }

  parseWebhookEvent(
    ctx: WebhookContext,
    options?: WebhookParseOptions,
  ): ProviderWebhookParseResult {
    const flow = normalizeOptionalString(ctx.query?.flow) ?? "";

    const parsed = new URLSearchParams(ctx.rawBody);

    // Keep providerCallId mapping for later call control.
    const callUuid = parsed.get("CallUUID") || undefined;
    if (callUuid) {
      const webhookBase = this.baseWebhookUrlFromCtx(ctx);
      if (webhookBase) {
        this.callUuidToWebhookUrl.set(callUuid, webhookBase);
      }
    }

    const callId = normalizeOptionalString(ctx.query?.callId);
    let event: NormalizedEvent | null = null;
    let providerResponseBody: string;

    // Special flows that exist only to return Plivo XML (no events).
    if (flow === "xml-speak") {
      const pending = callId ? this.pendingSpeakByCallId.get(callId) : undefined;
      if (callId) {
        this.pendingSpeakByCallId.delete(callId);
      }

      const actionUrl =
        pending?.listenAfterPlayback && callId ? this.buildActionUrl(ctx, callId) : null;
      providerResponseBody = pending
        ? actionUrl
          ? PlivoProvider.xmlGetInputSpeech({
              text: pending.text,
              language: pending.locale,
              actionUrl,
            })
          : PlivoProvider.xmlKeepAlive(
              `  <Speak language="${escapeXml(pending.locale || "en-US")}">${escapeXml(pending.text)}</Speak>\n`,
            )
        : PlivoProvider.xmlKeepAlive();
    } else if (flow === "xml-listen") {
      const pending = callId ? this.pendingListenByCallId.get(callId) : undefined;
      if (callId) {
        this.pendingListenByCallId.delete(callId);
      }

      const actionUrl = this.buildActionUrl(ctx, callId);

      providerResponseBody =
        actionUrl && callId
          ? PlivoProvider.xmlGetInputSpeech({
              actionUrl,
              language: pending?.language,
            })
          : PlivoProvider.xmlKeepAlive();
    } else {
      const dedupeKey = options?.verifiedRequestKey ?? createPlivoRequestDedupeKey(ctx);
      event = this.normalizeEvent(parsed, callId, dedupeKey);
      providerResponseBody =
        flow === "answer" || flow === "getinput"
          ? PlivoProvider.xmlKeepAlive()
          : '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
    }

    return {
      events: event ? [event] : [],
      providerResponseBody,
      providerResponseHeaders: { "Content-Type": "text/xml" },
      statusCode: 200,
    };
  }

  private normalizeEvent(
    params: URLSearchParams,
    callIdOverride?: string,
    dedupeKey?: string,
  ): NormalizedEvent | null {
    const callUuid = params.get("CallUUID") || "";
    const requestUuid = params.get("RequestUUID") || "";

    if (requestUuid && callUuid) {
      this.requestUuidToCallUuid.set(requestUuid, callUuid);
    }

    const direction = params.get("Direction");
    const callStatus = params.get("CallStatus");

    const baseEvent = {
      id: crypto.randomUUID(),
      dedupeKey,
      callId: callIdOverride || callUuid || requestUuid,
      providerCallId: callUuid || requestUuid || undefined,
      timestamp: Date.now(),
      direction:
        direction === "inbound"
          ? ("inbound" as const)
          : direction === "outbound"
            ? ("outbound" as const)
            : undefined,
      from: params.get("From") || undefined,
      to: params.get("To") || undefined,
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
        isFinal: true,
      };
    }

    if (callStatus === "ringing") {
      return { ...baseEvent, type: "call.ringing" };
    }

    if (callStatus === "in-progress") {
      return { ...baseEvent, type: "call.answered" };
    }

    if (
      callStatus === "completed" ||
      callStatus === "busy" ||
      callStatus === "no-answer" ||
      callStatus === "failed"
    ) {
      const event: NormalizedEvent = {
        ...baseEvent,
        type: "call.ended",
        reason: callStatus,
      };
      this.releaseCallState({
        callId: baseEvent.callId || undefined,
        providerCallId: callUuid || requestUuid || undefined,
        callUuid: callUuid || undefined,
      });
      return event;
    }

    // Plivo will call our answer_url when the call is answered; if we don't have
    // a CallStatus for some reason, treat it as answered so the call can proceed.
    if (params.get("Event") === "StartApp" && callUuid) {
      return { ...baseEvent, type: "call.answered" };
    }

    return null;
  }

  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    const webhookUrl = new URL(input.webhookUrl);
    webhookUrl.searchParams.set("provider", "plivo");
    webhookUrl.searchParams.set("callId", input.callId);

    const answerUrl = new URL(webhookUrl);
    answerUrl.searchParams.set("flow", "answer");

    const hangupUrl = new URL(webhookUrl);
    hangupUrl.searchParams.set("flow", "hangup");

    this.callIdToWebhookUrl.set(input.callId, input.webhookUrl);

    const result = await this.api.request<PlivoCreateCallResponse>("/Call/", {
      from: PlivoProvider.normalizeNumber(input.from),
      to: PlivoProvider.normalizeNumber(input.to),
      answer_url: answerUrl.toString(),
      answer_method: "POST",
      hangup_url: hangupUrl.toString(),
      hangup_method: "POST",
      // Plivo's API uses `hangup_on_ring` for outbound ring timeout.
      hangup_on_ring: this.options.ringTimeoutSec ?? 30,
    });

    const requestUuid = Array.isArray(result.request_uuid)
      ? result.request_uuid[0]
      : result.request_uuid;
    if (!requestUuid) {
      throw new Error("Plivo call create returned no request_uuid");
    }

    return { providerCallId: requestUuid, status: "initiated" };
  }

  async hangupCall(input: HangupCallInput): Promise<void> {
    const callUuid = this.requestUuidToCallUuid.get(input.providerCallId);
    await this.api.request(`/Call/${callUuid || input.providerCallId}/`, undefined, {
      method: "DELETE",
      allowNotFound: true,
    });
    // Without a resolved call UUID, also try canceling the outbound request.
    if (!callUuid) {
      await this.api.request(`/Request/${input.providerCallId}/`, undefined, {
        method: "DELETE",
        allowNotFound: true,
      });
    }
    this.releaseCallState({
      callId: input.callId,
      providerCallId: input.providerCallId,
      callUuid,
    });
  }

  private resolveCallContext(
    input: Pick<PlayTtsInput, "callId" | "providerCallId">,
    operation: string,
  ): {
    callUuid: string;
    webhookBase: string;
    callId: string;
  } {
    const callUuid = this.requestUuidToCallUuid.get(input.providerCallId) ?? input.providerCallId;
    const webhookBase =
      this.callUuidToWebhookUrl.get(callUuid) || this.callIdToWebhookUrl.get(input.callId);
    if (!webhookBase) {
      throw new Error("Missing webhook URL for this call (provider state missing)");
    }
    if (!callUuid) {
      throw new Error(`Missing Plivo CallUUID for ${operation}`);
    }
    return { callUuid, webhookBase, callId: input.callId };
  }

  private async transferCallLeg(params: {
    callUuid: string;
    webhookBase: string;
    callId: string;
    flow: "xml-speak" | "xml-listen";
  }): Promise<void> {
    const transferUrl = new URL(params.webhookBase);
    transferUrl.searchParams.set("provider", "plivo");
    transferUrl.searchParams.set("flow", params.flow);
    transferUrl.searchParams.set("callId", params.callId);

    await this.api.request(`/Call/${params.callUuid}/`, {
      legs: "aleg",
      aleg_url: transferUrl.toString(),
      aleg_method: "POST",
    });
  }

  async playTts(input: PlayTtsInput): Promise<void> {
    const context = this.resolveCallContext(input, "playTts");

    this.pendingSpeakByCallId.set(input.callId, {
      text: input.text,
      locale: input.locale,
      listenAfterPlayback: input.listenAfterPlayback,
    });

    await this.transferCallLeg({ ...context, flow: "xml-speak" });
  }

  async startListening(input: StartListeningInput): Promise<void> {
    const context = this.resolveCallContext(input, "startListening");

    this.pendingListenByCallId.set(input.callId, {
      language: input.language,
    });

    await this.transferCallLeg({ ...context, flow: "xml-listen" });
  }

  async stopListening(_input: StopListeningInput): Promise<void> {
    // GetInput ends automatically when speech ends.
  }

  async getCallStatus(input: GetCallStatusInput): Promise<GetCallStatusResult> {
    const terminalStatuses = new Set([
      "completed",
      "busy",
      "failed",
      "timeout",
      "no-answer",
      "cancel",
      "machine",
      "hangup",
    ]);
    return this.api.getCallStatus<{ call_status?: string }>(
      `/Call/${input.providerCallId}/`,
      (data) => {
        const status = data.call_status ?? "unknown";
        return { status, isTerminal: terminalStatuses.has(status) };
      },
    );
  }

  private static normalizeNumber(numberOrSip: string): string {
    const trimmed = numberOrSip.trim();
    if (normalizeLowercaseStringOrEmpty(trimmed).startsWith("sip:")) {
      return trimmed;
    }
    return trimmed.replace(/[^\d+]/g, "");
  }

  private static xmlKeepAlive(content = ""): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
${content}  <Wait length="300" />
</Response>`;
  }

  private static xmlGetInputSpeech(params: {
    text?: string;
    actionUrl: string;
    language?: string;
  }): string {
    const language = params.language || "en-US";
    const prompt =
      params.text === undefined
        ? ""
        : `    <Speak language="${escapeXml(language)}">${escapeXml(params.text)}</Speak>\n`;
    return PlivoProvider.xmlKeepAlive(
      `  <GetInput inputType="speech" method="POST" action="${escapeXml(params.actionUrl)}" language="${escapeXml(language)}" executionTimeout="30" speechEndTimeout="2" redirect="false">
${prompt}  </GetInput>
`,
    );
  }

  private buildActionUrl(ctx: WebhookContext, callId?: string): string | null {
    const base = this.baseWebhookUrlFromCtx(ctx);
    if (!base) {
      return null;
    }

    const u = new URL(base);
    u.searchParams.set("provider", "plivo");
    u.searchParams.set("flow", "getinput");
    if (callId) {
      u.searchParams.set("callId", callId);
    }
    return u.toString();
  }

  private baseWebhookUrlFromCtx(ctx: WebhookContext): string | null {
    try {
      const u = new URL(
        this.options.publicUrl ||
          reconstructWebhookUrl(ctx, {
            allowedHosts: this.options.webhookSecurity?.allowedHosts,
            trustForwardingHeaders: this.options.webhookSecurity?.trustForwardingHeaders,
            trustedProxyIPs: this.options.webhookSecurity?.trustedProxyIPs,
            remoteIP: ctx.remoteAddress,
          }),
      );
      return `${u.origin}${u.pathname}`;
    } catch {
      return null;
    }
  }

  private static extractTranscript(params: URLSearchParams): string | null {
    const candidates = [
      "Speech",
      "Transcription",
      "TranscriptionText",
      "SpeechResult",
      "RecognizedSpeech",
      "Text",
    ] as const;

    for (const key of candidates) {
      const value = params.get(key)?.trim();
      if (value) {
        return value;
      }
    }
    return null;
  }
}

type PlivoCreateCallResponse = {
  request_uuid?: string | string[];
};
