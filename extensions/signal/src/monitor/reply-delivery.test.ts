import { describe, expect, it } from "vitest";
import {
  markSignalReplyConsumed,
  resolveSignalReplyDelivery,
  type SignalReplyDeliveryState,
} from "./reply-delivery.js";

describe("resolveSignalReplyDelivery", () => {
  it("uses the inherited reply target until the first successful send", () => {
    const state: SignalReplyDeliveryState = { consumed: false };

    const first = resolveSignalReplyDelivery({
      payload: { text: "first" },
      inheritedReplyToId: "1700000000000",
      state,
    });
    markSignalReplyConsumed(state, first.effectiveReplyTo);

    const second = resolveSignalReplyDelivery({
      payload: { text: "second" },
      inheritedReplyToId: "1700000000000",
      state,
    });

    expect(first.payload.replyToId).toBeUndefined();
    expect(first.effectiveReplyTo).toBe("1700000000000");
    expect(second.payload.replyToId).toBeUndefined();
    expect(second.effectiveReplyTo).toBeUndefined();
  });

  it("keeps explicit reply targets after the inherited reply target is consumed", () => {
    const state: SignalReplyDeliveryState = { consumed: true };

    const explicit = resolveSignalReplyDelivery({
      payload: { text: "second", replyToId: "1700000000002" },
      inheritedReplyToId: "1700000000000",
      state,
    });

    expect(explicit.payload.replyToId).toBe("1700000000002");
    expect(explicit.effectiveReplyTo).toBe("1700000000002");
  });

  it("preserves explicit null reply suppression without consuming inherited reply state", () => {
    const state: SignalReplyDeliveryState = { consumed: false };

    const suppressed = resolveSignalReplyDelivery({
      payload: { text: "first", replyToId: null },
      inheritedReplyToId: "1700000000000",
      state,
    });
    markSignalReplyConsumed(state, suppressed.effectiveReplyTo);

    const inherited = resolveSignalReplyDelivery({
      payload: { text: "second" },
      inheritedReplyToId: "1700000000000",
      state,
    });

    expect(suppressed.payload.replyToId).toBeUndefined();
    expect(suppressed.effectiveReplyTo).toBeUndefined();
    expect(inherited.effectiveReplyTo).toBe("1700000000000");
  });

  it("does not consume inherited reply state for non-decimal reply ids", () => {
    const state: SignalReplyDeliveryState = { consumed: false };

    // Simulate a malformed reply_to tag that resolved to a non-timestamp string
    const malformed = resolveSignalReplyDelivery({
      payload: { text: "first", replyToId: "not-a-timestamp" },
      inheritedReplyToId: "1700000000000",
      state,
    });
    markSignalReplyConsumed(state, malformed.effectiveReplyTo);

    // The inherited reply should still be available for the next payload
    const next = resolveSignalReplyDelivery({
      payload: { text: "second" },
      inheritedReplyToId: "1700000000000",
      state,
    });

    expect(malformed.effectiveReplyTo).toBe("not-a-timestamp");
    expect(state.consumed).toBe(false);
    expect(next.effectiveReplyTo).toBe("1700000000000");
  });

  it("does not consume inherited reply state for zero timestamps", () => {
    const state: SignalReplyDeliveryState = { consumed: false };

    const zero = resolveSignalReplyDelivery({
      payload: { text: "first", replyToId: "0" },
      inheritedReplyToId: "1700000000000",
      state,
    });
    markSignalReplyConsumed(state, zero.effectiveReplyTo);

    const next = resolveSignalReplyDelivery({
      payload: { text: "second" },
      inheritedReplyToId: "1700000000000",
      state,
    });

    expect(zero.effectiveReplyTo).toBe("0");
    expect(state.consumed).toBe(false);
    expect(next.effectiveReplyTo).toBe("1700000000000");
  });
});
