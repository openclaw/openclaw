// Voice Call tests cover mock plugin behavior.
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

describe("MockProvider", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
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
    // First delivery is not a replay; second delivery of same key is.
    expect(resultA.isReplay).toBeFalsy();
    expect(resultB.isReplay).toBe(true);
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
    // Different payloads are not replays of each other.
    expect(resultA.isReplay).toBeFalsy();
    expect(resultB.isReplay).toBeFalsy();
  });

  it("flags repeated mock webhook payloads as replay", () => {
    const provider = new MockProvider();
    const payload = JSON.stringify({
      events: [{ type: "call.speech", callId: "call-replay" }],
    });
    const ctx = createWebhookContext(payload);

    const first = provider.verifyWebhook(ctx);
    const second = provider.verifyWebhook(ctx);
    const third = provider.verifyWebhook(ctx);

    expect(first.isReplay).toBeFalsy();
    expect(second.isReplay).toBe(true);
    expect(third.isReplay).toBe(true);
  });

  it("flags repeated payloads as replay when events have no explicit ids", () => {
    const provider = new MockProvider();
    // Events without explicit `id` — normalizeEvent assigns a randomUUID.
    const payload = JSON.stringify({
      events: [
        { type: "call.answered", callId: "call-no-id" },
        { type: "call.speech", callId: "call-no-id", transcript: "hi" },
      ],
    });
    const ctx = createWebhookContext(payload);

    // First delivery: ok, no replay.
    const first = provider.verifyWebhook(ctx);
    expect(first.ok).toBe(true);
    expect(first.isReplay).toBeFalsy();
    expect(first.verifiedRequestKey).toMatch(/^mock:/);

    // Same payload parsed once — events get auto-generated ids.
    const parsed = provider.parseWebhookEvent(ctx);
    expect(parsed.events).toHaveLength(2);
    for (const evt of parsed.events) {
      expect(evt.id).toBeDefined();
      expect(evt.id).not.toBe("");
    }

    // Second delivery: isReplay=true, same key.
    const second = provider.verifyWebhook(ctx);
    expect(second.ok).toBe(true);
    expect(second.isReplay).toBe(true);
    expect(second.verifiedRequestKey).toBe(first.verifiedRequestKey);

    // The webhook handler (webhook.ts:752) uses isReplay to skip event
    // processing and return a cached response instead.
  });

  it("expires replay keys after the mock replay window elapses", () => {
    vi.useFakeTimers();
    const provider = new MockProvider();
    const ctx = createWebhookContext(
      JSON.stringify({ event: { type: "call.answered", callId: "call-expire" } }),
    );

    // First delivery: not a replay.
    const first = provider.verifyWebhook(ctx);
    expect(first.ok).toBe(true);
    expect(first.isReplay).toBeFalsy();

    // Within the window: is replay.
    vi.advanceTimersByTime(5 * 60 * 1000); // +5 min
    const beforeExpiry = provider.verifyWebhook(ctx);
    expect(beforeExpiry.isReplay).toBe(true);

    // Past the 10-minute window: not a replay anymore.
    vi.advanceTimersByTime(6 * 60 * 1000); // +6 min → 11 min total
    const afterExpiry = provider.verifyWebhook(ctx);
    expect(afterExpiry.ok).toBe(true);
    expect(afterExpiry.isReplay).toBeFalsy();
    // Key is the same (stable derivation).
    expect(afterExpiry.verifiedRequestKey).toBe(first.verifiedRequestKey);
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
