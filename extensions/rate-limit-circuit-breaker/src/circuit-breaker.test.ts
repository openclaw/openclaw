import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  RateLimitCircuitBreaker,
  isRateLimitErrorMessage,
  isTransientErrorMessage,
} from "./circuit-breaker.js";

describe("isRateLimitErrorMessage", () => {
  it("matches the standard OpenClaw rate limit message", () => {
    expect(isRateLimitErrorMessage("API rate limit reached. Please try again later.")).toBe(true);
  });

  it("matches messages with emoji prefix", () => {
    expect(isRateLimitErrorMessage("\u26a0\ufe0f API rate limit reached. Please try again later.")).toBe(true);
  });

  it("matches 429 status code references", () => {
    expect(isRateLimitErrorMessage("HTTP 429 Too Many Requests")).toBe(true);
  });

  it("matches rate_limit_exceeded error type", () => {
    expect(isRateLimitErrorMessage('{"type":"rate_limit_exceeded"}')).toBe(true);
  });

  it("matches overloaded messages", () => {
    expect(isRateLimitErrorMessage("The AI service is temporarily overloaded. Please try again in a moment.")).toBe(true);
  });

  it("does not match normal messages", () => {
    expect(isRateLimitErrorMessage("Hello, how are you?")).toBe(false);
    expect(isRateLimitErrorMessage("The rate of improvement is excellent")).toBe(false);
  });
});

describe("isTransientErrorMessage", () => {
  it("matches timeout messages", () => {
    expect(isTransientErrorMessage("LLM request timed out.")).toBe(true);
  });

  it("matches rate limit messages (superset)", () => {
    expect(isTransientErrorMessage("API rate limit reached. Please try again later.")).toBe(true);
  });

  it("does not match normal messages", () => {
    expect(isTransientErrorMessage("Here is your report.")).toBe(false);
  });
});

describe("RateLimitCircuitBreaker", () => {
  let breaker: RateLimitCircuitBreaker;
  const channel = "matrix";
  const room = "!room123:server.org";
  const errorMsg = "\u26a0\ufe0f API rate limit reached. Please try again later.";
  const normalMsg = "Here is the analysis you requested.";

  const warnSpy = vi.fn();
  const debugSpy = vi.fn();

  beforeEach(() => {
    warnSpy.mockReset();
    debugSpy.mockReset();
    breaker = new RateLimitCircuitBreaker(
      { maxConsecutiveErrors: 3, baseCooldownMs: 1000, maxCooldownMs: 8000 },
      { warn: warnSpy, debug: debugSpy },
    );
  });

  it("allows normal messages through", () => {
    expect(breaker.shouldSuppress(channel, room, normalMsg)).toBe(false);
  });

  it("allows first N-1 rate limit errors through", () => {
    expect(breaker.shouldSuppress(channel, room, errorMsg)).toBe(false); // 1/3
    expect(breaker.shouldSuppress(channel, room, errorMsg)).toBe(false); // 2/3
  });

  it("suppresses the Nth consecutive error (trips the circuit)", () => {
    breaker.shouldSuppress(channel, room, errorMsg); // 1
    breaker.shouldSuppress(channel, room, errorMsg); // 2
    expect(breaker.shouldSuppress(channel, room, errorMsg)).toBe(true); // 3 -> OPEN
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("closed -> open"));
  });

  it("suppresses subsequent errors while circuit is open", () => {
    for (let i = 0; i < 3; i++) breaker.shouldSuppress(channel, room, errorMsg);
    expect(breaker.shouldSuppress(channel, room, errorMsg)).toBe(true);
    expect(breaker.shouldSuppress(channel, room, errorMsg)).toBe(true);
  });

  it("allows normal messages while circuit is open (does not suppress non-error)", () => {
    for (let i = 0; i < 3; i++) breaker.shouldSuppress(channel, room, errorMsg);
    // Non-error messages always go through
    expect(breaker.shouldSuppress(channel, room, normalMsg)).toBe(false);
  });

  it("transitions to half_open after cooldown and allows one retry", () => {
    for (let i = 0; i < 3; i++) breaker.shouldSuppress(channel, room, errorMsg);
    const state = breaker.getState(channel, room)!;
    // Simulate cooldown expiration by backdating openedAt
    state.openedAt = Date.now() - 2000; // 2s > 1s cooldown
    // Next error triggers half_open transition + is allowed through
    expect(breaker.shouldSuppress(channel, room, errorMsg)).toBe(false);
    expect(breaker.getState(channel, room)!.state).toBe("half_open");
  });

  it("re-opens with doubled cooldown if retry fails in half_open", () => {
    for (let i = 0; i < 3; i++) breaker.shouldSuppress(channel, room, errorMsg);
    const state = breaker.getState(channel, room)!;
    state.openedAt = Date.now() - 2000;
    breaker.shouldSuppress(channel, room, errorMsg); // -> half_open, allowed
    // Another error in half_open
    expect(breaker.shouldSuppress(channel, room, errorMsg)).toBe(true);
    const updatedState = breaker.getState(channel, room)!;
    expect(updatedState.state).toBe("open");
    expect(updatedState.cooldownMs).toBe(2000); // doubled from 1000
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("half_open -> open"));
  });

  it("resets to closed on success in half_open state", () => {
    for (let i = 0; i < 3; i++) breaker.shouldSuppress(channel, room, errorMsg);
    const state = breaker.getState(channel, room)!;
    state.openedAt = Date.now() - 2000;
    breaker.shouldSuppress(channel, room, errorMsg); // -> half_open
    // Normal message = success
    expect(breaker.shouldSuppress(channel, room, normalMsg)).toBe(false);
    const updatedState = breaker.getState(channel, room)!;
    expect(updatedState.state).toBe("closed");
    expect(updatedState.consecutiveErrors).toBe(0);
    expect(updatedState.tripCount).toBe(0);
  });

  it("resets error count on normal message in closed state", () => {
    breaker.shouldSuppress(channel, room, errorMsg); // 1
    breaker.shouldSuppress(channel, room, errorMsg); // 2
    breaker.shouldSuppress(channel, room, normalMsg); // reset
    breaker.shouldSuppress(channel, room, errorMsg); // 1 again
    breaker.shouldSuppress(channel, room, errorMsg); // 2 again
    expect(breaker.shouldSuppress(channel, room, errorMsg)).toBe(true); // 3 -> trips
  });

  it("tracks rooms independently", () => {
    const room2 = "!room456:server.org";
    for (let i = 0; i < 3; i++) breaker.shouldSuppress(channel, room, errorMsg);
    // room1 is open
    expect(breaker.shouldSuppress(channel, room, errorMsg)).toBe(true);
    // room2 is still closed
    expect(breaker.shouldSuppress(channel, room2, errorMsg)).toBe(false);
  });

  it("caps cooldown at maxCooldownMs", () => {
    // Trip multiple times
    for (let trip = 0; trip < 10; trip++) {
      // Fill up consecutive errors
      for (let i = 0; i < 3; i++) breaker.shouldSuppress(channel, room, errorMsg);
      // Now it's open. Expire the cooldown.
      const state = breaker.getState(channel, room)!;
      state.openedAt = Date.now() - state.cooldownMs - 100;
      breaker.shouldSuppress(channel, room, errorMsg); // -> half_open, allowed
      // Fail the retry
      breaker.shouldSuppress(channel, room, errorMsg); // -> open with doubled cooldown
    }
    const finalState = breaker.getState(channel, room)!;
    expect(finalState.cooldownMs).toBeLessThanOrEqual(8000);
  });

  it("recordSuccess resets the circuit fully", () => {
    for (let i = 0; i < 3; i++) breaker.shouldSuppress(channel, room, errorMsg);
    expect(breaker.getState(channel, room)!.state).toBe("open");
    breaker.recordSuccess(channel, room);
    expect(breaker.getState(channel, room)!.state).toBe("closed");
    expect(breaker.getState(channel, room)!.consecutiveErrors).toBe(0);
  });

  it("cleanup removes stale entries", () => {
    for (let i = 0; i < 3; i++) breaker.shouldSuppress(channel, room, errorMsg);
    const state = breaker.getState(channel, room)!;
    state.openedAt = Date.now() - 7_200_000; // 2 hours ago
    breaker.cleanup(3_600_000); // 1 hour max age
    expect(breaker.getState(channel, room)).toBeUndefined();
  });
});
