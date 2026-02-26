import { describe, expect, it } from "vitest";
import { ProviderRateLimiter } from "./provider-rate-limiter.js";

describe("ProviderRateLimiter", () => {
  it("allows requests under the limit", () => {
    let time = 1_000_000;
    const limiter = new ProviderRateLimiter({
      config: { anthropic: { rpm: 3 } },
      now: () => time,
    });

    expect(limiter.consume("anthropic")).toMatchObject({ allowed: true, remaining: 2 });
    expect(limiter.consume("anthropic")).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.consume("anthropic")).toMatchObject({ allowed: true, remaining: 0 });
  });

  it("rejects requests at the limit", () => {
    let time = 1_000_000;
    const limiter = new ProviderRateLimiter({
      config: { anthropic: { rpm: 2 } },
      now: () => time,
    });

    limiter.consume("anthropic");
    limiter.consume("anthropic");
    const result = limiter.consume("anthropic");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("allows requests after window expires", () => {
    let time = 1_000_000;
    const limiter = new ProviderRateLimiter({
      config: { anthropic: { rpm: 1 } },
      windowMs: 10_000,
      now: () => time,
    });

    expect(limiter.consume("anthropic").allowed).toBe(true);
    expect(limiter.consume("anthropic").allowed).toBe(false);

    // Advance past window
    time += 11_000;
    expect(limiter.consume("anthropic").allowed).toBe(true);
  });

  it("unlimited when rpm is 0 or not configured", () => {
    const limiter = new ProviderRateLimiter({
      config: { test: { rpm: 0 } },
      now: () => 1_000_000,
    });

    for (let i = 0; i < 100; i++) {
      expect(limiter.consume("test").allowed).toBe(true);
    }
    // Unconfigured provider also unlimited
    expect(limiter.consume("unknown-provider").allowed).toBe(true);
  });

  it("peek does not consume a slot", () => {
    let time = 1_000_000;
    const limiter = new ProviderRateLimiter({
      config: { anthropic: { rpm: 1 } },
      now: () => time,
    });

    expect(limiter.peek("anthropic")).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.peek("anthropic")).toMatchObject({ allowed: true, remaining: 1 });
    limiter.consume("anthropic");
    expect(limiter.peek("anthropic")).toMatchObject({ allowed: false, remaining: 0 });
  });

  it("tracks providers independently", () => {
    let time = 1_000_000;
    const limiter = new ProviderRateLimiter({
      config: { a: { rpm: 1 }, b: { rpm: 1 } },
      now: () => time,
    });

    expect(limiter.consume("a").allowed).toBe(true);
    expect(limiter.consume("a").allowed).toBe(false);
    // Provider b is independent
    expect(limiter.consume("b").allowed).toBe(true);
  });

  it("reset clears state for a specific provider", () => {
    let time = 1_000_000;
    const limiter = new ProviderRateLimiter({
      config: { anthropic: { rpm: 1 } },
      now: () => time,
    });

    limiter.consume("anthropic");
    expect(limiter.consume("anthropic").allowed).toBe(false);

    limiter.reset("anthropic");
    expect(limiter.consume("anthropic").allowed).toBe(true);
  });
});
