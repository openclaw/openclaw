// Voice Call plugin module implements mock behavior.
import crypto from "node:crypto";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  EndReason,
  GetCallStatusInput,
  GetCallStatusResult,
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  NormalizedEvent,
  PlayTtsInput,
  WebhookParseOptions,
  ProviderWebhookParseResult,
  SendDtmfInput,
  StartListeningInput,
  StopListeningInput,
  WebhookContext,
  WebhookVerificationResult,
} from "../types.js";
import type { VoiceCallProvider } from "./base.js";

/** Match the shared webhook replay window in webhook-security.ts. */
const REPLAY_WINDOW_MS = 10 * 60 * 1000;

/**
 * Mock voice call provider for local testing.
 *
 * Events are driven via webhook POST with JSON body:
 * - { events: NormalizedEvent[] } for bulk events
 * - { event: NormalizedEvent } for single event
 */
export class MockProvider implements VoiceCallProvider {
  readonly name = "mock" as const;

  /** Track seen request keys with expiry so replay is window-bounded.
   *  Same 10-minute window as webhook-security.ts REPLAY_WINDOW_MS. */
  private readonly seenKeys = new Map<string, number>();

  verifyWebhook(_ctx: WebhookContext): WebhookVerificationResult {
    const key = `mock:${crypto.createHash("sha256").update(`${_ctx.method}\n${_ctx.url}\n${_ctx.rawBody}`).digest("hex")}`;
    const now = Date.now();
    this.pruneExpiredKeys(now);
    const isReplay = this.seenKeys.has(key);
    // Only set on first sight so expiry is relative to the original delivery,
    // not refreshed on every replay.
    if (!isReplay) {
      this.seenKeys.set(key, now + REPLAY_WINDOW_MS);
    }
    return { ok: true, verifiedRequestKey: key, isReplay };
  }

  private pruneExpiredKeys(now: number): void {
    for (const [k, expiresAt] of this.seenKeys) {
      if (expiresAt <= now) {
        this.seenKeys.delete(k);
      }
    }
  }

  parseWebhookEvent(
    ctx: WebhookContext,
    _options?: WebhookParseOptions,
  ): ProviderWebhookParseResult {
    try {
      const payload = JSON.parse(ctx.rawBody);
      const events: NormalizedEvent[] = [];

      if (Array.isArray(payload.events)) {
        for (const evt of payload.events) {
          const normalized = this.normalizeEvent(evt);
          if (normalized) {
            events.push(normalized);
          }
        }
      } else if (payload.event) {
        const normalized = this.normalizeEvent(payload.event);
        if (normalized) {
          events.push(normalized);
        }
      }

      return { events, statusCode: 200 };
    } catch {
      return { events: [], statusCode: 400 };
    }
  }

  private normalizeEvent(evt: Partial<NormalizedEvent>): NormalizedEvent | null {
    if (!evt.type || !evt.callId) {
      return null;
    }

    const base = {
      id: evt.id ?? crypto.randomUUID(),
      callId: evt.callId,
      providerCallId: evt.providerCallId,
      timestamp: evt.timestamp ?? Date.now(),
    };

    switch (evt.type) {
      case "call.initiated":
      case "call.ringing":
      case "call.answered":
      case "call.active":
        return { ...base, type: evt.type };

      case "call.speaking": {
        const payload = evt as Partial<NormalizedEvent & { text?: string }>;
        return {
          ...base,
          type: evt.type,
          text: payload.text ?? "",
        };
      }

      case "call.speech": {
        const payload = evt as Partial<
          NormalizedEvent & {
            transcript?: string;
            isFinal?: boolean;
            confidence?: number;
          }
        >;
        return {
          ...base,
          type: evt.type,
          transcript: payload.transcript ?? "",
          isFinal: payload.isFinal ?? true,
          confidence: payload.confidence,
        };
      }

      case "call.silence": {
        const payload = evt as Partial<NormalizedEvent & { durationMs?: number }>;
        return {
          ...base,
          type: evt.type,
          durationMs: payload.durationMs ?? 0,
        };
      }

      case "call.dtmf": {
        const payload = evt as Partial<NormalizedEvent & { digits?: string }>;
        return {
          ...base,
          type: evt.type,
          digits: payload.digits ?? "",
        };
      }

      case "call.ended": {
        const payload = evt as Partial<NormalizedEvent & { reason?: EndReason }>;
        return {
          ...base,
          type: evt.type,
          reason: payload.reason ?? "completed",
        };
      }

      case "call.error": {
        const payload = evt as Partial<NormalizedEvent & { error?: string; retryable?: boolean }>;
        return {
          ...base,
          type: evt.type,
          error: payload.error ?? "unknown error",
          retryable: payload.retryable,
        };
      }

      default:
        return null;
    }
  }

  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    return {
      providerCallId: `mock-${input.callId}`,
      status: "initiated",
    };
  }

  async hangupCall(_input: HangupCallInput): Promise<void> {
    // No-op for mock
  }

  async playTts(_input: PlayTtsInput): Promise<void> {
    // No-op for mock
  }

  async sendDtmf(_input: SendDtmfInput): Promise<void> {
    // No-op for mock
  }

  async startListening(_input: StartListeningInput): Promise<void> {
    // No-op for mock
  }

  async stopListening(_input: StopListeningInput): Promise<void> {
    // No-op for mock
  }

  async getCallStatus(input: GetCallStatusInput): Promise<GetCallStatusResult> {
    const id = normalizeLowercaseStringOrEmpty(input.providerCallId);
    if (id.includes("stale") || id.includes("ended") || id.includes("completed")) {
      return { status: "completed", isTerminal: true };
    }
    return { status: "in-progress", isTerminal: false };
  }
}
