import { describe, expect, it } from "vitest";
import { createRateLimiter, resolveRateLimitKey } from "./rate-limiter.js";

describe("createRateLimiter", () => {
  it("allows requests within window", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 3 });
    const key = "rest|user1";
    expect(limiter.consume(key).allowed).toBe(true);
    expect(limiter.consume(key).allowed).toBe(true);
    expect(limiter.consume(key).allowed).toBe(true);
    expect(limiter.consume(key).allowed).toBe(false);
  });

  it("resets bucket after window expires", () => {
    const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 1 });
    const key = "rest|user2";
    expect(limiter.consume(key, 0).allowed).toBe(true);
    expect(limiter.consume(key, 500).allowed).toBe(false);
    expect(limiter.consume(key, 1001).allowed).toBe(true);
  });

  it("resolveRateLimitKey combines source and subject", () => {
    expect(resolveRateLimitKey("rest", "alice")).toBe("rest|alice");
    expect(resolveRateLimitKey("", "")).toBe("unknown|anonymous");
  });
});
