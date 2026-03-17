import crypto from "node:crypto";
class MockProvider {
  constructor() {
    this.name = "mock";
  }
  verifyWebhook(_ctx) {
    return { ok: true };
  }
  parseWebhookEvent(ctx, _options) {
    try {
      const payload = JSON.parse(ctx.rawBody);
      const events = [];
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
  normalizeEvent(evt) {
    if (!evt.type || !evt.callId) {
      return null;
    }
    const base = {
      id: evt.id ?? crypto.randomUUID(),
      callId: evt.callId,
      providerCallId: evt.providerCallId,
      timestamp: evt.timestamp ?? Date.now()
    };
    switch (evt.type) {
      case "call.initiated":
      case "call.ringing":
      case "call.answered":
      case "call.active":
        return { ...base, type: evt.type };
      case "call.speaking": {
        const payload = evt;
        return {
          ...base,
          type: evt.type,
          text: payload.text ?? ""
        };
      }
      case "call.speech": {
        const payload = evt;
        return {
          ...base,
          type: evt.type,
          transcript: payload.transcript ?? "",
          isFinal: payload.isFinal ?? true,
          confidence: payload.confidence
        };
      }
      case "call.silence": {
        const payload = evt;
        return {
          ...base,
          type: evt.type,
          durationMs: payload.durationMs ?? 0
        };
      }
      case "call.dtmf": {
        const payload = evt;
        return {
          ...base,
          type: evt.type,
          digits: payload.digits ?? ""
        };
      }
      case "call.ended": {
        const payload = evt;
        return {
          ...base,
          type: evt.type,
          reason: payload.reason ?? "completed"
        };
      }
      case "call.error": {
        const payload = evt;
        return {
          ...base,
          type: evt.type,
          error: payload.error ?? "unknown error",
          retryable: payload.retryable
        };
      }
      default:
        return null;
    }
  }
  async initiateCall(input) {
    return {
      providerCallId: `mock-${input.callId}`,
      status: "initiated"
    };
  }
  async hangupCall(_input) {
  }
  async playTts(_input) {
  }
  async startListening(_input) {
  }
  async stopListening(_input) {
  }
  async getCallStatus(input) {
    const id = input.providerCallId.toLowerCase();
    if (id.includes("stale") || id.includes("ended") || id.includes("completed")) {
      return { status: "completed", isTerminal: true };
    }
    return { status: "in-progress", isTerminal: false };
  }
}
export {
  MockProvider
};
