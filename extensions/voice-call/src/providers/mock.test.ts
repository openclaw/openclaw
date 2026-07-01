// Voice Call tests cover mock plugin behavior.
import { describe, expect, it } from "vitest";
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

describe("MockProvider", () => {
  it("returns a stable verified request key for the same webhook payload", () => {
    const provider = new MockProvider();
    const ctxA = createWebhookContext(
      JSON.stringify({ event: { type: "call.answered", callId: "c1" } }),
    );
    const ctxB = createWebhookContext(
      JSON.stringify({ event: { type: "call.answered", callId: "c1" } }),
    );

    const resultA = provider.verifyWebhook(ctxA);
    const resultB = provider.verifyWebhook(ctxB);

    expect(resultA.ok).toBe(true);
    expect(resultA.verifiedRequestKey).toBeDefined();
    expect(resultA.verifiedRequestKey).toBe(resultB.verifiedRequestKey);
    expect(resultA.verifiedRequestKey).toMatch(/^mock:/);
  });

  it("returns distinct verified request keys for different webhook payloads", () => {
    const provider = new MockProvider();
    const ctxA = createWebhookContext(
      JSON.stringify({ event: { type: "call.answered", callId: "c1" } }),
    );
    const ctxB = createWebhookContext(
      JSON.stringify({ event: { type: "call.ended", callId: "c2" } }),
    );

    const resultA = provider.verifyWebhook(ctxA);
    const resultB = provider.verifyWebhook(ctxB);

    expect(resultA.verifiedRequestKey).not.toBe(resultB.verifiedRequestKey);
  });

  it("preserves explicit falsy event values", () => {
    const provider = new MockProvider();
    const beforeParse = Date.now();
    const result = provider.parseWebhookEvent(
      createWebhookContext(
        JSON.stringify({
          events: [
            {
              id: "evt-error",
              type: "call.error",
              callId: "call-1",
              timestamp: 0,
              error: "",
              retryable: false,
            },
            {
              id: "evt-ended",
              type: "call.ended",
              callId: "call-2",
              reason: "",
            },
            {
              id: "evt-speech",
              type: "call.speech",
              callId: "call-3",
              transcript: "",
              isFinal: false,
            },
          ],
        }),
      ),
    );
    const afterParse = Date.now();
    const endedTimestamp = result.events[1]?.timestamp;
    const speechTimestamp = result.events[2]?.timestamp;

    expect(result.events).toEqual([
      {
        id: "evt-error",
        type: "call.error",
        callId: "call-1",
        providerCallId: undefined,
        timestamp: 0,
        error: "",
        retryable: false,
      },
      {
        id: "evt-ended",
        type: "call.ended",
        callId: "call-2",
        providerCallId: undefined,
        timestamp: endedTimestamp,
        reason: "",
      },
      {
        id: "evt-speech",
        type: "call.speech",
        callId: "call-3",
        providerCallId: undefined,
        timestamp: speechTimestamp,
        transcript: "",
        isFinal: false,
        confidence: undefined,
      },
    ]);
    expect(endedTimestamp).toBeGreaterThanOrEqual(beforeParse);
    expect(endedTimestamp).toBeLessThanOrEqual(afterParse);
    expect(speechTimestamp).toBeGreaterThanOrEqual(beforeParse);
    expect(speechTimestamp).toBeLessThanOrEqual(afterParse);
  });
});
