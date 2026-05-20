import { describe, expect, it } from "vitest";
import { TelegramRateLimiter, type TelegramRateLimitConfig } from "./rate-limiter.js";

const advanceClock = () => {
  let now = 1_700_000_000_000;
  return {
    now: () => now,
    advanceMs: (ms: number) => {
      now += ms;
    },
    setMs: (ms: number) => {
      now = ms;
    },
  };
};

describe("TelegramRateLimiter", () => {
  it("is a no-op when no windows are configured", () => {
    const clock = advanceClock();
    const limiter = new TelegramRateLimiter(undefined, { now: clock.now });
    expect(limiter.isEnabled()).toBe(false);
    for (let i = 0; i < 100; i += 1) {
      expect(limiter.tryConsume(42, "dm").allowed).toBe(true);
    }
  });

  it("allows traffic up to maxRequests within the window then denies", () => {
    const clock = advanceClock();
    const cfg: TelegramRateLimitConfig = {
      perSender: { windowSeconds: 60, maxRequests: 3 },
    };
    const limiter = new TelegramRateLimiter(cfg, { now: clock.now });

    for (let i = 0; i < 3; i += 1) {
      expect(limiter.tryConsume(1234, "dm").allowed).toBe(true);
    }
    const denied = limiter.tryConsume(1234, "dm");
    expect(denied.allowed).toBe(false);
    if (denied.allowed === false) {
      expect(denied.reason).toBe("window");
      expect(denied.retryAfterMs).toBeGreaterThan(0);
      expect(denied.retryAfterMs).toBeLessThanOrEqual(60_000);
    }
  });

  it("recovers budget after the window slides past the oldest event", () => {
    const clock = advanceClock();
    const limiter = new TelegramRateLimiter(
      { perSender: { windowSeconds: 10, maxRequests: 2 } },
      { now: clock.now },
    );

    expect(limiter.tryConsume(1, "dm").allowed).toBe(true);
    clock.advanceMs(4_000);
    expect(limiter.tryConsume(1, "dm").allowed).toBe(true);
    expect(limiter.tryConsume(1, "dm").allowed).toBe(false);
    clock.advanceMs(7_000); // first event now 11s old; second still in window
    expect(limiter.tryConsume(1, "dm").allowed).toBe(true);
    expect(limiter.tryConsume(1, "dm").allowed).toBe(false);
    clock.advanceMs(5_000); // second event now 16s old; third still recent
    expect(limiter.tryConsume(1, "dm").allowed).toBe(true);
  });

  it("isolates senders from each other", () => {
    const clock = advanceClock();
    const limiter = new TelegramRateLimiter(
      { perSender: { windowSeconds: 60, maxRequests: 1 } },
      { now: clock.now },
    );
    expect(limiter.tryConsume(11, "dm").allowed).toBe(true);
    expect(limiter.tryConsume(11, "dm").allowed).toBe(false);
    expect(limiter.tryConsume(22, "dm").allowed).toBe(true);
    expect(limiter.tryConsume(22, "dm").allowed).toBe(false);
  });

  it("keeps dm and pairing counters independent", () => {
    const clock = advanceClock();
    const limiter = new TelegramRateLimiter(
      {
        perSender: { windowSeconds: 60, maxRequests: 2 },
        pairing: { windowSeconds: 60, maxRequests: 1 },
      },
      { now: clock.now },
    );
    expect(limiter.tryConsume(99, "dm").allowed).toBe(true);
    expect(limiter.tryConsume(99, "pairing").allowed).toBe(true);
    // pairing budget exhausted but dm still has one slot
    expect(limiter.tryConsume(99, "pairing").allowed).toBe(false);
    expect(limiter.tryConsume(99, "dm").allowed).toBe(true);
    expect(limiter.tryConsume(99, "dm").allowed).toBe(false);
  });

  it("applies backoffMs as a hard cooldown after exhaustion", () => {
    const clock = advanceClock();
    const limiter = new TelegramRateLimiter(
      {
        pairing: { windowSeconds: 10, maxRequests: 1, backoffMs: 5_000 },
      },
      { now: clock.now },
    );
    expect(limiter.tryConsume(7, "pairing").allowed).toBe(true);
    const denied = limiter.tryConsume(7, "pairing");
    expect(denied.allowed).toBe(false);
    if (denied.allowed === false) {
      expect(denied.reason).toBe("window");
      expect(denied.retryAfterMs).toBe(5_000);
    }

    // 2s later still cooled down — even though the *window* might have slots
    clock.advanceMs(2_000);
    const stillCooling = limiter.tryConsume(7, "pairing");
    expect(stillCooling.allowed).toBe(false);
    if (stillCooling.allowed === false) {
      expect(stillCooling.reason).toBe("backoff");
    }

    clock.advanceMs(4_000); // total 6s — past cooldown
    // Window slot is still consumed by the 6s-old event, so this should fail
    // for `window` reason rather than `backoff`. Verifies the cooldown release
    // path runs without leaving stale state.
    const afterCooldown = limiter.tryConsume(7, "pairing");
    expect(afterCooldown.allowed).toBe(false);
    if (afterCooldown.allowed === false) {
      expect(afterCooldown.reason).toBe("window");
    }
  });

  it("treats exempt sender ids as unlimited regardless of scope", () => {
    const clock = advanceClock();
    const limiter = new TelegramRateLimiter(
      {
        perSender: { windowSeconds: 60, maxRequests: 1 },
        pairing: { windowSeconds: 60, maxRequests: 1 },
        exemptSenderIds: ["telegram:8569038939", 1234],
      },
      { now: clock.now },
    );
    for (let i = 0; i < 10; i += 1) {
      expect(limiter.tryConsume("8569038939", "dm").allowed).toBe(true);
      expect(limiter.tryConsume("telegram:8569038939", "pairing").allowed).toBe(true);
      expect(limiter.tryConsume(1234, "dm").allowed).toBe(true);
    }
    expect(limiter.isExempt("8569038939")).toBe(true);
    expect(limiter.isExempt("tg:1234")).toBe(true);
    expect(limiter.isExempt("9999")).toBe(false);
  });

  it("denies non-numeric / unknown sender ids by default so a malformed update cannot bypass", () => {
    const limiter = new TelegramRateLimiter({
      perSender: { windowSeconds: 60, maxRequests: 5 },
    });
    expect(limiter.tryConsume(undefined, "dm").allowed).toBe(false);
    expect(limiter.tryConsume("", "dm").allowed).toBe(false);
    expect(limiter.tryConsume("not-a-number", "dm").allowed).toBe(false);
    // But if pairing window is undefined the scope is a no-op even for bad ids
    expect(limiter.tryConsume(undefined, "pairing").allowed).toBe(true);
  });

  it("rejects malformed config silently (no window) instead of throwing", () => {
    const limiter = new TelegramRateLimiter({
      perSender: { windowSeconds: 0, maxRequests: 5 },
      pairing: { windowSeconds: 60, maxRequests: -3 },
    });
    expect(limiter.isEnabled()).toBe(false);
    expect(limiter.tryConsume(1, "dm").allowed).toBe(true);
    expect(limiter.tryConsume(1, "pairing").allowed).toBe(true);
  });

  it("normalises exempt list entries to numeric ids", () => {
    const limiter = new TelegramRateLimiter({
      perSender: { windowSeconds: 60, maxRequests: 1 },
      exemptSenderIds: ["telegram:42", "tg:42", "42", 42, "@notnumeric", "  43  "],
    });
    expect(limiter.isExempt(42)).toBe(true);
    expect(limiter.isExempt(43)).toBe(true);
    expect(limiter.isExempt("notnumeric")).toBe(false);
  });

  it("surfaces the configured dropPolicy on denies for telemetry", () => {
    const limiter = new TelegramRateLimiter({
      perSender: { windowSeconds: 60, maxRequests: 1, dropPolicy: "errorReply" },
    });
    expect(limiter.tryConsume(1, "dm").allowed).toBe(true);
    const denied = limiter.tryConsume(1, "dm");
    if (denied.allowed === true) {
      throw new Error("expected denial");
    }
    expect(denied.dropPolicy).toBe("errorReply");
  });

  it("reset() drops in-memory state", () => {
    const clock = advanceClock();
    const limiter = new TelegramRateLimiter(
      { perSender: { windowSeconds: 60, maxRequests: 1 } },
      { now: clock.now },
    );
    expect(limiter.tryConsume(1, "dm").allowed).toBe(true);
    expect(limiter.tryConsume(1, "dm").allowed).toBe(false);
    limiter.reset();
    expect(limiter.tryConsume(1, "dm").allowed).toBe(true);
  });
});
