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

/**
 * Mock voice call provider for local testing.
 *
 * Events are driven via webhook POST with JSON body:
 * - { events: NormalizedEvent[] } for bulk events
 * - { event: NormalizedEvent } for single event
 */
export class MockProvider implements VoiceCallProvider {
  readonly name = "mock" as const;

  /** Local fixtures are intentionally unsigned; manager auth checks still exercise provider selection. */
  verifyWebhook(_ctx: WebhookContext): WebhookVerificationResult {
    return { ok: true };
  }

  /**
   * Converts JSON fixture payloads into the same normalized event stream real providers return.
   *
   * Invalid JSON yields a 400 so webhook tests can cover request rejection
   * without introducing a network-backed provider.
   */
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
          // Preserve explicit empty transcripts and false final flags so tests can
          // model partial/falsy provider payloads without the mock rewriting them.
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
          // Empty error strings are valid fixtures; only missing values get a default.
          error: payload.error ?? "unknown error",
          retryable: payload.retryable,
        };
      }

      default:
        return null;
    }
  }

  /** Returns a stable synthetic provider id so tests can round-trip manager/provider state. */
  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    return {
      providerCallId: `mock-${input.callId}`,
      status: "initiated",
    };
  }

  /** Mock call-control methods deliberately acknowledge commands without side effects. */
  async hangupCall(_input: HangupCallInput): Promise<void> {
    // No-op for mock.
  }

  /** Mock media playback is synchronous from the manager's perspective. */
  async playTts(_input: PlayTtsInput): Promise<void> {
    // No-op for mock.
  }

  /** DTMF dispatch is accepted but not recorded; tests assert manager behavior instead. */
  async sendDtmf(_input: SendDtmfInput): Promise<void> {
    // No-op for mock.
  }

  /** Listening state is owned by the manager harness, not the mock provider. */
  async startListening(_input: StartListeningInput): Promise<void> {
    // No-op for mock.
  }

  /** Stop-listening acknowledgements keep provider cleanup paths available in tests. */
  async stopListening(_input: StopListeningInput): Promise<void> {
    // No-op for mock.
  }

  /**
   * Simulates restore-time provider reconciliation from the synthetic provider id.
   *
   * Embedding terminal words in the id lets tests choose active vs completed
   * calls without introducing mutable provider-side state.
   */
  async getCallStatus(input: GetCallStatusInput): Promise<GetCallStatusResult> {
    const id = normalizeLowercaseStringOrEmpty(input.providerCallId);
    // Let tests force restore/cleanup paths by embedding terminal-state words in
    // the mock provider call id; all other ids behave like active calls.
    if (id.includes("stale") || id.includes("ended") || id.includes("completed")) {
      return { status: "completed", isTerminal: true };
    }
    return { status: "in-progress", isTerminal: false };
  }
}
