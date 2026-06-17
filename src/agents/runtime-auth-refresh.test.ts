// Verifies runtime auth refresh timers stay within safe JavaScript timer bounds.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clampRuntimeAuthRefreshDelayMs,
  RUNTIME_AUTH_REFRESH_HARD_TIMEOUT_MS,
  withRuntimeAuthRefreshDeadline,
} from "./runtime-auth-refresh.js";

describe("clampRuntimeAuthRefreshDelayMs", () => {
  it("clamps far-future refresh delays to a timer-safe ceiling", () => {
    expect(
      clampRuntimeAuthRefreshDelayMs({
        refreshAt: 12_345_678_901_000,
        now: 0,
        minDelayMs: 60_000,
      }),
    ).toBe(2_147_483_647);
  });

  it("still respects the configured minimum delay", () => {
    expect(
      clampRuntimeAuthRefreshDelayMs({
        refreshAt: 1_000,
        now: 900,
        minDelayMs: 60_000,
      }),
    ).toBe(60_000);
  });
});

describe("withRuntimeAuthRefreshDeadline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects once the deadline elapses when the work never settles", async () => {
    vi.useFakeTimers();
    // A provider auth hook that hangs forever — the exact wedge that froze the
    // gateway. The backstop must reject so the single-flight handle can clear.
    const hung = new Promise<string>(() => {});
    const raced = withRuntimeAuthRefreshDeadline(hung, 1_000, "openai");
    const assertion = expect(raced).rejects.toThrow(
      /Runtime auth refresh for openai exceeded hard deadline \(1000ms\)/,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it("resolves with the work value when the work settles before the deadline", async () => {
    vi.useFakeTimers();
    const raced = withRuntimeAuthRefreshDeadline(Promise.resolve("ok"), 5_000, "openai");
    await expect(raced).resolves.toBe("ok");
  });

  it("propagates the work rejection when it settles before the deadline", async () => {
    vi.useFakeTimers();
    const raced = withRuntimeAuthRefreshDeadline(
      Promise.reject(new Error("refresh boom")),
      5_000,
      "openai",
    );
    await expect(raced).rejects.toThrow("refresh boom");
  });

  it("passes work through unbounded when the timeout is non-positive", async () => {
    await expect(withRuntimeAuthRefreshDeadline(Promise.resolve("ok"), 0, "openai")).resolves.toBe(
      "ok",
    );
  });

  it("keeps the default hard timeout above the OAuth manager call + stale-lock budget", () => {
    // OAuth manager: 120s call timeout + 180s peer stale-lock window.
    expect(RUNTIME_AUTH_REFRESH_HARD_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000 + 180_000);
  });
});
