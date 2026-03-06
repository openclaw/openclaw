import crypto from "node:crypto";
import fs from "node:fs";
import type { VonageConfig, WebhookSecurityConfig } from "../config.js";
import { getHeader } from "../http-headers.js";
import type { HostedAudioTtsProvider } from "../telephony-tts.js";
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
import { reconstructWebhookUrl } from "../webhook-security.js";
import type { VoiceCallProvider } from "./base.js";
import { guardedJsonApiRequest } from "./shared/guarded-json-api.js";

export interface VonageProviderOptions {
  publicUrl?: string;
  skipVerification?: boolean;
  ringTimeoutSec?: number;
  webhookSecurity?: WebhookSecurityConfig;
  streamingEnabled?: boolean;
}

type ReplayCache = {
  seenUntil: Map<string, number>;
  calls: number;
};

type MediaUrlPublisher = (params: {
  audio: Buffer;
  contentType: string;
  ttlMs?: number;
}) => string | null;

const REPLAY_WINDOW_MS = 10 * 60 * 1000;
const replayCache: ReplayCache = {
  seenUntil: new Map<string, number>(),
  calls: 0,
};

function pruneReplayCache(cache: ReplayCache, now: number): void {
  for (const [key, expiresAt] of cache.seenUntil) {
    if (expiresAt <= now) {
      cache.seenUntil.delete(key);
    }
  }
}

function markReplay(cache: ReplayCache, replayKey: string): boolean {
  const now = Date.now();
  cache.calls += 1;
  if (cache.calls % 64 === 0) {
    pruneReplayCache(cache, now);
  }

  const existing = cache.seenUntil.get(replayKey);
  if (existing && existing > now) {
    return true;
  }

  cache.seenUntil.set(replayKey, now + REPLAY_WINDOW_MS);
  return false;
}

function base64url(input: Buffer | string): string {
  const source = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return source.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function parseJson<T = Record<string, unknown>>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const json = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function verifyHs256Jwt(token: string, secret: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return false;
  }
  const data = `${parts[0]}.${parts[1]}`;
  const expected = base64url(crypto.createHmac("sha256", secret).update(data).digest());
  return timingSafeEqualStr(expected, parts[2]);
}

function verifyRs256Jwt(token: string, publicKey: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return false;
  }
  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(`${parts[0]}.${parts[1]}`);
  verifier.end();
  return verifier.verify(
    publicKey,
    Buffer.from(parts[2].replace(/-/g, "+").replace(/_/g, "/"), "base64"),
  );
}

function signRs256Jwt(payload: Record<string, unknown>, privateKey: string): string {
  const header = { alg: "RS256", typ: "JWT" };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const data = `${encodedHeader}.${encodedPayload}`;

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(data);
  signer.end();
  const signature = signer.sign(privateKey);

  return `${data}.${base64url(signature)}`;
}

function extractBearerToken(ctx: WebhookContext): string | null {
  const auth = getHeader(ctx.headers, "authorization");
  if (!auth) {
    return null;
  }
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

function extractNumber(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    const maybe = value as Record<string, unknown>;
    if (typeof maybe.number === "string") {
      return maybe.number;
    }
  }
  return undefined;
}

export class VonageProvider implements VoiceCallProvider {
  readonly name = "vonage" as const;

  private readonly applicationId: string;
  private readonly privateKey: string;
  private readonly publicKey: string;
  private readonly signatureSecret?: string;
  private readonly options: VonageProviderOptions;
  private readonly baseUrl = "https://api.nexmo.com/v1";
  private callIdToWebhookUrl = new Map<string, string>();
  private providerCallIdToCallId = new Map<string, string>();
  private hostedAudioTtsProvider: HostedAudioTtsProvider | null = null;
  private mediaUrlPublisher: MediaUrlPublisher | null = null;

  constructor(config: VonageConfig, options: VonageProviderOptions = {}) {
    if (!config.applicationId) {
      throw new Error("Vonage applicationId is required");
    }

    const privateKey = config.privateKey ?? this.readPrivateKeyFromPath(config.privateKeyPath);
    if (!privateKey) {
      throw new Error("Vonage privateKey or privateKeyPath is required");
    }

    this.applicationId = config.applicationId;
    this.privateKey = privateKey;
    this.publicKey = crypto
      .createPublicKey(privateKey)
      .export({ type: "spki", format: "pem" })
      .toString();
    this.signatureSecret = config.signatureSecret;
    this.options = options;
  }

  setHostedAudioTtsProvider(provider: HostedAudioTtsProvider): void {
    this.hostedAudioTtsProvider = provider;
  }

  setMediaUrlPublisher(publisher: MediaUrlPublisher): void {
    this.mediaUrlPublisher = publisher;
  }

  async interruptPlayback(providerCallId: string): Promise<void> {
    await Promise.all([
      this.apiRequest<void>({
        method: "DELETE",
        endpoint: `/calls/${encodeURIComponent(providerCallId)}/stream`,
        allowNotFound: true,
      }).catch(() => undefined),
      this.apiRequest<void>({
        method: "DELETE",
        endpoint: `/calls/${encodeURIComponent(providerCallId)}/talk`,
        allowNotFound: true,
      }).catch(() => undefined),
    ]);
  }

  private readPrivateKeyFromPath(path?: string): string | undefined {
    if (!path) {
      return undefined;
    }
    return fs.readFileSync(path, "utf8");
  }

  private buildApiJwt(): string {
    const now = Math.floor(Date.now() / 1000);
    return signRs256Jwt(
      {
        application_id: this.applicationId,
        iat: now,
        exp: now + 900,
        jti: crypto.randomUUID(),
      },
      this.privateKey,
    );
  }

  private async apiRequest<T = unknown>(params: {
    method: "GET" | "POST" | "DELETE" | "PUT";
    endpoint: string;
    body?: Record<string, unknown>;
    allowNotFound?: boolean;
  }): Promise<T> {
    const token = this.buildApiJwt();
    return await guardedJsonApiRequest<T>({
      url: `${this.baseUrl}${params.endpoint}`,
      method: params.method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: params.body,
      allowNotFound: params.allowNotFound,
      allowedHostnames: ["api.nexmo.com", "api.vonage.com"],
      auditContext: "voice-call.vonage.api",
      errorPrefix: "Vonage API error",
    });
  }

  verifyWebhook(ctx: WebhookContext): WebhookVerificationResult {
    const replayBase = crypto
      .createHash("sha256")
      .update(`${ctx.method}\n${ctx.url}\n${ctx.rawBody}`)
      .digest("hex");

    if (this.options.skipVerification) {
      const replayKey = `vonage:skip:${replayBase}`;
      return {
        ok: true,
        isReplay: markReplay(replayCache, replayKey),
        verifiedRequestKey: replayKey,
      };
    }

    const token = extractBearerToken(ctx);
    if (!token) {
      return { ok: false, reason: "Missing Authorization bearer token" };
    }

    const claims = decodeJwtClaims(token);
    if (!claims) {
      return { ok: false, reason: "Invalid JWT payload" };
    }

    const verified =
      (this.signatureSecret ? verifyHs256Jwt(token, this.signatureSecret) : false) ||
      verifyRs256Jwt(token, this.publicKey);

    if (!verified) {
      return { ok: false, reason: "Invalid webhook JWT signature" };
    }

    const iat = typeof claims.iat === "number" ? claims.iat : undefined;
    if (iat) {
      const ageSec = Math.floor(Date.now() / 1000) - iat;
      if (ageSec > 10 * 60) {
        return { ok: false, reason: "Webhook JWT too old" };
      }
    }

    const jti = typeof claims.jti === "string" ? claims.jti : undefined;
    const replayKey = `vonage:${jti ?? replayBase}`;
    const isReplay = markReplay(replayCache, replayKey);

    return {
      ok: true,
      isReplay,
      verifiedRequestKey: replayKey,
    };
  }

  parseWebhookEvent(
    ctx: WebhookContext,
    options?: WebhookParseOptions,
  ): ProviderWebhookParseResult {
    const flow = typeof ctx.query?.flow === "string" ? ctx.query.flow.trim() : "";
    const callIdFromQuery = typeof ctx.query?.callId === "string" ? ctx.query.callId.trim() : "";

    if (flow === "answer") {
      return {
        events: [],
        providerResponseBody: JSON.stringify([
          {
            action: "conversation",
            name: callIdFromQuery || "openclaw-voice-session",
          },
        ]),
        providerResponseHeaders: { "Content-Type": "application/json" },
        statusCode: 200,
      };
    }

    if (flow === "listen") {
      const actionUrl = this.buildWebhookUrl(ctx, {
        flow: "input-result",
        callId: callIdFromQuery,
      });
      const ncco = [
        {
          action: "input",
          type: ["speech", "dtmf"],
          speech: {
            endOnSilence: true,
            maxDuration: 30,
          },
          eventUrl: [actionUrl],
          eventMethod: "POST",
        },
        {
          action: "conversation",
          name: callIdFromQuery || "openclaw-voice-session",
        },
      ];
      return {
        events: [],
        providerResponseBody: JSON.stringify(ncco),
        providerResponseHeaders: { "Content-Type": "application/json" },
        statusCode: 200,
      };
    }

    const payload = parseJson<Record<string, unknown>>(ctx.rawBody);
    if (!payload) {
      return { events: [], statusCode: 400 };
    }

    const providerCallId =
      (typeof payload.uuid === "string" && payload.uuid) ||
      (typeof payload.call_uuid === "string" && payload.call_uuid) ||
      undefined;

    if (callIdFromQuery) {
      const webhookBase = this.baseWebhookUrl(ctx);
      this.callIdToWebhookUrl.set(callIdFromQuery, webhookBase);
      if (providerCallId) {
        this.providerCallIdToCallId.set(providerCallId, callIdFromQuery);
      }
    }

    const mappedCallId = providerCallId
      ? this.providerCallIdToCallId.get(providerCallId)
      : undefined;
    const event = this.normalizeEvent(
      payload,
      callIdFromQuery || mappedCallId,
      options?.verifiedRequestKey,
    );

    if (event?.callId && providerCallId) {
      this.providerCallIdToCallId.set(providerCallId, event.callId);
    }

    return {
      events: event ? [event] : [],
      providerResponseBody: JSON.stringify({ ok: true }),
      providerResponseHeaders: { "Content-Type": "application/json" },
      statusCode: 200,
    };
  }

  private normalizeEvent(
    payload: Record<string, unknown>,
    callIdOverride?: string,
    dedupeKey?: string,
  ): NormalizedEvent | null {
    const providerCallId =
      (typeof payload.uuid === "string" && payload.uuid) ||
      (typeof payload.call_uuid === "string" && payload.call_uuid) ||
      undefined;

    const callId =
      callIdOverride ||
      (typeof payload.call_id === "string" && payload.call_id) ||
      providerCallId ||
      crypto.randomUUID();

    const baseEvent = {
      id: crypto.randomUUID(),
      dedupeKey,
      callId,
      providerCallId,
      timestamp: Date.now(),
      from: extractNumber(payload.from),
      to: extractNumber(payload.to),
      direction:
        payload.direction === "inbound"
          ? ("inbound" as const)
          : payload.direction === "outbound"
            ? ("outbound" as const)
            : undefined,
    };

    const speech = payload.speech as Record<string, unknown> | undefined;
    const speechResults = Array.isArray(speech?.results)
      ? (speech?.results as Array<Record<string, unknown>>)
      : undefined;
    const transcript =
      (speechResults?.find((r) => typeof r.text === "string")?.text as string | undefined) ||
      (typeof speech?.text === "string" ? speech.text : undefined);

    if (transcript) {
      const confidenceValue = speechResults?.find((r) => typeof r.confidence === "number")
        ?.confidence as number | undefined;

      return {
        ...baseEvent,
        type: "call.speech",
        transcript,
        isFinal: true,
        confidence: confidenceValue,
      };
    }

    const dtmf = payload.dtmf as Record<string, unknown> | undefined;
    const digits =
      (typeof dtmf?.digits === "string" && dtmf.digits) ||
      (typeof payload.digits === "string" ? payload.digits : undefined);

    if (digits) {
      return {
        ...baseEvent,
        type: "call.dtmf",
        digits,
      };
    }

    const status =
      (typeof payload.status === "string" && payload.status.toLowerCase()) ||
      (typeof payload.call_status === "string" && payload.call_status.toLowerCase()) ||
      "";

    if (status === "started") {
      return { ...baseEvent, type: "call.initiated" };
    }
    if (status === "ringing") {
      return { ...baseEvent, type: "call.ringing" };
    }
    if (status === "answered") {
      return { ...baseEvent, type: "call.answered" };
    }
    if (status === "busy") {
      return { ...baseEvent, type: "call.ended", reason: "busy" };
    }
    if (status === "timeout") {
      return { ...baseEvent, type: "call.ended", reason: "timeout" };
    }
    if (status === "unanswered") {
      return { ...baseEvent, type: "call.ended", reason: "no-answer" };
    }
    if (status === "rejected" || status === "failed" || status === "cancelled") {
      return { ...baseEvent, type: "call.ended", reason: "failed" };
    }
    if (status === "completed") {
      return { ...baseEvent, type: "call.ended", reason: "completed" };
    }

    return null;
  }

  private buildWebhookUrl(ctx: WebhookContext, query: Record<string, string | undefined>): string {
    const base = this.baseWebhookUrl(ctx);
    const url = new URL(base);
    for (const [key, value] of Object.entries(query)) {
      if (value) {
        url.searchParams.set(key, value);
      }
    }
    return url.toString();
  }

  private baseWebhookUrl(ctx: WebhookContext): string {
    if (this.options.publicUrl) {
      const url = new URL(this.options.publicUrl);
      url.search = "";
      url.hash = "";
      return url.toString();
    }

    return reconstructWebhookUrl(ctx, {
      allowedHosts: this.options.webhookSecurity?.allowedHosts,
      trustForwardingHeaders: this.options.webhookSecurity?.trustForwardingHeaders,
      trustedProxyIPs: this.options.webhookSecurity?.trustedProxyIPs,
      remoteIP: ctx.remoteAddress,
    });
  }

  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    this.callIdToWebhookUrl.set(input.callId, input.webhookUrl);

    const answerUrl = new URL(input.webhookUrl);
    answerUrl.searchParams.set("flow", "answer");
    answerUrl.searchParams.set("callId", input.callId);

    const eventUrl = new URL(input.webhookUrl);
    eventUrl.searchParams.set("flow", "event");
    eventUrl.searchParams.set("callId", input.callId);

    const response = await this.apiRequest<{ uuid?: string; status?: string }>({
      method: "POST",
      endpoint: "/calls",
      body: {
        to: [{ type: "phone", number: input.to }],
        from: { type: "phone", number: input.from },
        answer_url: [answerUrl.toString()],
        answer_method: "POST",
        event_url: [eventUrl.toString()],
        event_method: "POST",
        ringing_timer: this.options.ringTimeoutSec,
      },
    });

    if (!response?.uuid) {
      throw new Error("Vonage create call response missing uuid");
    }

    this.providerCallIdToCallId.set(response.uuid, input.callId);

    return {
      providerCallId: response.uuid,
      status: response.status === "started" ? "initiated" : "queued",
    };
  }

  async hangupCall(input: HangupCallInput): Promise<void> {
    await this.apiRequest<void>({
      method: "PUT",
      endpoint: `/calls/${encodeURIComponent(input.providerCallId)}`,
      body: { action: "hangup" },
      allowNotFound: true,
    });
  }

  async playTts(input: PlayTtsInput): Promise<void> {
    if (
      this.options.streamingEnabled &&
      this.hostedAudioTtsProvider &&
      this.mediaUrlPublisher &&
      this.options.publicUrl
    ) {
      try {
        const hostedAudio = await this.hostedAudioTtsProvider.synthesizeForHostedPlayback(
          input.text,
        );
        const mediaUrl = this.mediaUrlPublisher({
          audio: hostedAudio.audio,
          contentType: hostedAudio.contentType,
          ttlMs: 120_000,
        });

        if (mediaUrl) {
          await this.apiRequest<void>({
            method: "PUT",
            endpoint: `/calls/${encodeURIComponent(input.providerCallId)}/stream`,
            body: {
              stream_url: [mediaUrl],
              loop: 1,
            },
          });
          return;
        }
      } catch (err) {
        console.warn(
          `[voice-call] Vonage stream playback failed; falling back to talk: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    await this.apiRequest<void>({
      method: "PUT",
      endpoint: `/calls/${encodeURIComponent(input.providerCallId)}/talk`,
      body: {
        text: input.text,
        language: input.locale,
      },
    });
  }

  async startListening(input: StartListeningInput): Promise<void> {
    const webhookBase = this.callIdToWebhookUrl.get(input.callId);
    if (!webhookBase) {
      throw new Error("Vonage listen URL unavailable for call");
    }

    const listenUrl = new URL(webhookBase);
    listenUrl.searchParams.set("flow", "listen");
    listenUrl.searchParams.set("callId", input.callId);

    // Transfer call to a dynamic NCCO URL that returns an input action.
    // This mirrors the Plivo/Telnyx style provider control flow.
    await this.apiRequest<void>({
      method: "PUT",
      endpoint: `/calls/${encodeURIComponent(input.providerCallId)}`,
      body: {
        action: "transfer",
        destination: {
          type: "ncco",
          url: [listenUrl.toString()],
        },
      },
    });
  }

  async stopListening(_input: StopListeningInput): Promise<void> {
    // No dedicated stop endpoint for NCCO input actions.
  }

  async getCallStatus(input: GetCallStatusInput): Promise<GetCallStatusResult> {
    const terminalStatuses = new Set([
      "completed",
      "busy",
      "failed",
      "cancelled",
      "rejected",
      "timeout",
      "unanswered",
    ]);

    try {
      const data = await this.apiRequest<{ status?: string; call_status?: string }>({
        method: "GET",
        endpoint: `/calls/${encodeURIComponent(input.providerCallId)}`,
        allowNotFound: true,
      });

      if (!data) {
        return { status: "not-found", isTerminal: true };
      }

      const status = (data.status ?? data.call_status ?? "unknown").toLowerCase();
      return {
        status,
        isTerminal: terminalStatuses.has(status),
      };
    } catch {
      return { status: "error", isTerminal: false, isUnknown: true };
    }
  }
}
