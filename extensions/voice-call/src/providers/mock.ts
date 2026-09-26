import crypto from "node:crypto";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
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
import { createWebhookReplayCache, reserveWebhookReplay } from "../webhook-replay.js";
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
  private readonly replayCache = createWebhookReplayCache();

  verifyWebhook(ctx: WebhookContext): WebhookVerificationResult {
    const requestMaterial = `${ctx.method}\n${ctx.url}\n${ctx.rawBody}`;
    const key = `mock:${crypto.createHash("sha256").update(requestMaterial).digest("hex")}`;
    return {
      ok: true,
      ...reserveWebhookReplay(this.replayCache, key),
    };
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
        return {
          ...base,
          type: evt.type,
          text: evt.text ?? "",
        };
      }

      case "call.assistant-speech": {
        return {
          ...base,
          type: evt.type,
          transcript: evt.transcript ?? "",
        };
      }

      case "call.speech": {
        const transcript = evt.transcript ?? "";
        if (!transcript.trim()) {
          return null;
        }
        return {
          ...base,
          type: evt.type,
          transcript,
          isFinal: evt.isFinal ?? true,
          confidence: evt.confidence,
        };
      }

      case "call.silence": {
        return {
          ...base,
          type: evt.type,
          durationMs: evt.durationMs ?? 0,
        };
      }

      case "call.dtmf": {
        return {
          ...base,
          type: evt.type,
          digits: evt.digits ?? "",
        };
      }

      case "call.ended": {
        return {
          ...base,
          type: evt.type,
          reason: evt.reason ?? "completed",
        };
      }

      case "call.error": {
        return {
          ...base,
          type: evt.type,
          error: evt.error ?? "unknown error",
          retryable: evt.retryable,
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
