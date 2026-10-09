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
  function parseCallerEvent(overrides: Record<string, unknown> = {}) {
    return new MockProvider().parseWebhookEvent(
      createWebhookContext(
        JSON.stringify({
          event: {
            id: "caller-facts",
            type: "call.initiated",
            callId: "mock-call",
            providerCallId: "mock-provider-call",
            timestamp: 123,
            direction: "inbound",
            from: "+15550000001",
            to: "+15550000002",
            ...overrides,
          },
        }),
      ),
    );
  }

  it.each(["call.initiated", "call.ringing", "call.answered", "call.active"])(
    "preserves caller facts for %s JSON",
    (type) => {
      expect(parseCallerEvent({ type })).toEqual({
        statusCode: 200,
        events: [
          {
            id: "caller-facts",
            type,
            callId: "mock-call",
            providerCallId: "mock-provider-call",
            timestamp: 123,
            direction: "inbound",
            from: "+15550000001",
            to: "+15550000002",
          },
        ],
      });
    },
  );

  it("does not emit events without a nonempty string call identity", () => {
    for (const callId of [undefined, null, "", 42, true, {}, []]) {
      expect(parseCallerEvent({ callId }).events, JSON.stringify({ callId })).toEqual([]);
    }
  });

  it.each([
    { field: "providerCallId", values: [null, 42, {}, []] },
    { field: "direction", values: [null, "sideways", "", 42, {}] },
    { field: "from", values: [null, 42, {}, []] },
    { field: "to", values: [null, false, {}, []] },
  ] as const)(
    "omits malformed optional $field without discarding the event",
    ({ field, values }) => {
      for (const value of values) {
        const result = parseCallerEvent({ [field]: value });
        expect(result.statusCode).toBe(200);
        expect(result.events).toHaveLength(1);
        expect(result.events[0]).toMatchObject({
          id: "caller-facts",
          callId: "mock-call",
          type: "call.initiated",
        });
        expect(result.events[0]?.[field], JSON.stringify({ field, value })).toBeUndefined();
      }
    },
  );

  it("retains an update with omitted optional caller fields", () => {
    const result = parseCallerEvent({
      type: "call.active",
      providerCallId: undefined,
      direction: undefined,
      from: undefined,
      to: undefined,
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ type: "call.active", callId: "mock-call" });
    for (const field of ["providerCallId", "direction", "from", "to"] as const) {
      expect(result.events[0]?.[field]).toBeUndefined();
    }
  });

  it("preserves string facts without imposing phone formatting or trimming", () => {
    expect(
      parseCallerEvent({
        callId: " ",
        providerCallId: "",
        direction: "outbound",
        from: "",
        to: "  caller-extension  ",
      }).events,
    ).toMatchObject([
      {
        callId: " ",
        providerCallId: "",
        direction: "outbound",
        from: "",
        to: "  caller-extension  ",
      },
    ]);
  });

  it("simulates machine detection through the webhook event boundary", () => {
    const provider = new MockProvider();
    const result = provider.parseWebhookEvent(
      createWebhookContext(
        JSON.stringify({
          event: {
            id: "amd",
            type: "call.amd",
            callId: "call-1",
            answeredBy: "machine_end_beep",
          },
        }),
      ),
    );
    expect(result.events).toMatchObject([
      { type: "call.amd", callId: "call-1", answeredBy: "machine_end_beep" },
    ]);
  });

  it.each([undefined, " \t\n"])("does not emit blank speech payloads %#", (transcript) => {
    const provider = new MockProvider();
    const result = provider.parseWebhookEvent(
      createWebhookContext(
        JSON.stringify({
          event: {
            id: "evt-blank-speech",
            type: "call.speech",
            callId: "call-blank",
            transcript,
            isFinal: true,
          },
        }),
      ),
    );

    expect(result.events).toEqual([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });
  it("derives stable request keys and detects replays", () => {
    const provider = new MockProvider();
    const repeated = createWebhookContext(
      JSON.stringify({ event: { type: "call.answered", callId: "c1" } }),
    );
    const distinct = createWebhookContext(
      JSON.stringify({ event: { type: "call.ended", callId: "c2" } }),
    );

    const first = provider.verifyWebhook(repeated);
    const second = provider.verifyWebhook(repeated);
    const other = provider.verifyWebhook(distinct);

    expect(first).toMatchObject({ ok: true, isReplay: false });
    expect(first.verifiedRequestKey).toMatch(/^mock:/);
    expect(second.verifiedRequestKey).toBe(first.verifiedRequestKey);
    expect(second.isReplay).toBe(true);
    expect(other.isReplay).toBe(false);
    expect(other.verifiedRequestKey).not.toBe(first.verifiedRequestKey);
  });

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

    expect(first.isReplay).toBe(false);
    expect(beforeExpiry.isReplay).toBe(true);
    expect(afterExpiry.isReplay).toBe(false);
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
            {
              id: "evt-assistant-speech",
              type: "call.assistant-speech",
              callId: "call-4",
              transcript: "",
            },
          ],
        }),
      ),
    );
    const afterParse = Date.now();
    const endedTimestamp = result.events[1]?.timestamp;

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
        id: "evt-assistant-speech",
        type: "call.assistant-speech",
        callId: "call-4",
        providerCallId: undefined,
        timestamp: expect.any(Number),
        transcript: "",
      },
    ]);
    expect(endedTimestamp).toBeGreaterThanOrEqual(beforeParse);
    expect(endedTimestamp).toBeLessThanOrEqual(afterParse);
  });
});
