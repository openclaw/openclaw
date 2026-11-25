import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebhookContext } from "../types.js";
import { MockProvider } from "./mock.js";

function createWebhookContext(rawBody: string): WebhookContext {
  return {
    headers: {},
    rawBody,
    url: "http://localhost/voice/webhook",
    method: "POST",
    query: {},
  };
}

function parseEvent(event: Record<string, unknown>) {
  return new MockProvider().parseWebhookEvent(createWebhookContext(JSON.stringify({ event })));
}

const callerFacts = {
  id: "caller-facts",
  type: "call.initiated",
  callId: "mock-call",
  providerCallId: "mock-provider-call",
  timestamp: 123,
  direction: "inbound",
  from: "+15550000001",
  to: "+15550000002",
};

describe("MockProvider", () => {
  function parseCallerEvent(overrides: Record<string, unknown> = {}) {
    return parseEvent({ ...callerFacts, ...overrides });
  }

  it("preserves caller facts for call.initiated JSON", () => {
    expect(parseCallerEvent()).toEqual({
      statusCode: 200,
      events: [callerFacts],
    });
  });

  it("does not emit events without a nonempty string call identity", () => {
    for (const callId of [undefined, null, "", 42, true, {}, []]) {
      expect(parseCallerEvent({ callId }).events, JSON.stringify({ callId })).toEqual([]);
    }
  });

  it("omits malformed optional providerCallId without discarding the event", () => {
    for (const value of [null, 42, {}, []]) {
      const result = parseCallerEvent({ providerCallId: value });
      expect(result).toMatchObject({
        statusCode: 200,
        events: [{ id: "caller-facts", callId: "mock-call", type: "call.initiated" }],
      });
      expect(result.events[0]?.providerCallId, JSON.stringify({ value })).toBeUndefined();
    }
  });

  it("simulates machine detection through the webhook event boundary", () => {
    const result = parseEvent({
      type: "call.amd",
      callId: "call-1",
      answeredBy: "machine_end_beep",
    });
    expect(result.events).toMatchObject([
      { type: "call.amd", callId: "call-1", answeredBy: "machine_end_beep" },
    ]);
  });

  it("does not emit blank speech payloads", () => {
    const result = parseEvent({
      type: "call.speech",
      callId: "call-blank",
      transcript: undefined,
      isFinal: true,
    });
    expect(result.events).toEqual([]);
  });

  afterEach(() => vi.useRealTimers());

  it("expires replay keys after the mock replay window elapses", () => {
    vi.useFakeTimers();
    const provider = new MockProvider();
    const ctx = createWebhookContext(
      JSON.stringify({ event: { type: "call.answered", callId: "call-expire" } }),
    );

    const first = provider.verifyWebhook(ctx);
    vi.advanceTimersByTime(5 * 60 * 1000);
    const beforeExpiry = provider.verifyWebhook(ctx);
    vi.advanceTimersByTime(6 * 60 * 1000);
    const afterExpiry = provider.verifyWebhook(ctx);

    expect([first.isReplay, beforeExpiry.isReplay, afterExpiry.isReplay]).toEqual([
      false,
      true,
      false,
    ]);
    expect(afterExpiry.verifiedRequestKey).toBe(first.verifiedRequestKey);
  });

  it("preserves explicit falsy event values", () => {
    const provider = new MockProvider();
    const error = {
      id: "evt-error",
      type: "call.error",
      callId: "call-1",
      timestamp: 0,
      error: "",
      retryable: false,
    };
    const ended = { id: "evt-ended", type: "call.ended", callId: "call-2", reason: "" };
    const speech = {
      id: "evt-speech",
      type: "call.speech",
      callId: "call-3",
      transcript: "",
      isFinal: false,
    };
    const assistant = {
      id: "evt-assistant-speech",
      type: "call.assistant-speech",
      callId: "call-4",
      transcript: "",
    };
    const beforeParse = Date.now();
    const result = provider.parseWebhookEvent(
      createWebhookContext(JSON.stringify({ events: [error, ended, speech, assistant] })),
    );
    const afterParse = Date.now();
    const endedTimestamp = result.events[1]?.timestamp;

    expect(result.events).toEqual([
      { ...error, providerCallId: undefined },
      { ...ended, providerCallId: undefined, timestamp: endedTimestamp },
      { ...assistant, providerCallId: undefined, timestamp: expect.any(Number) },
    ]);
    expect(endedTimestamp).toBeGreaterThanOrEqual(beforeParse);
    expect(endedTimestamp).toBeLessThanOrEqual(afterParse);
  });
});
