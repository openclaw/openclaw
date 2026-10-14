// Irc tests cover reconnect backoff plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIrcReconnectBackoff } from "./reconnect-backoff.js";

function createClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("irc reconnect backoff", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts at the historical one-second delay and doubles up to the cap", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const backoff = createIrcReconnectBackoff(createClock().now);
    const delays = Array.from({ length: 8 }, () => backoff.nextDelayMs());
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  });

  it("keeps jitter within twenty percent and never exceeds the cap", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    const backoff = createIrcReconnectBackoff(createClock().now);
    const first = backoff.nextDelayMs();
    expect(first).toBeGreaterThanOrEqual(1_000);
    expect(first).toBeLessThanOrEqual(1_200);
    const later = Array.from({ length: 10 }, () => backoff.nextDelayMs());
    expect(Math.max(...later)).toBeLessThanOrEqual(30_000);
  });

  it("keeps growing when a peer registers and is dropped immediately", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const clock = createClock();
    const backoff = createIrcReconnectBackoff(clock.now);
    const delays: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      backoff.markConnected();
      clock.advance(5);
      delays.push(backoff.nextDelayMs());
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it("resets after a connection stayed up for a minute", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const clock = createClock();
    const backoff = createIrcReconnectBackoff(clock.now);
    backoff.nextDelayMs();
    backoff.nextDelayMs();
    expect(backoff.nextDelayMs()).toBe(4_000);
    backoff.markConnected();
    clock.advance(60_000);
    expect(backoff.nextDelayMs()).toBe(1_000);
  });

  it("does not reset just before the stable threshold", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const clock = createClock();
    const backoff = createIrcReconnectBackoff(clock.now);
    backoff.nextDelayMs();
    backoff.markConnected();
    clock.advance(59_999);
    expect(backoff.nextDelayMs()).toBe(2_000);
  });

  it("does not let a failed connect attempt inherit an earlier connection's uptime", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const clock = createClock();
    const backoff = createIrcReconnectBackoff(clock.now);
    backoff.nextDelayMs();
    backoff.markConnected();
    clock.advance(10_000);
    expect(backoff.nextDelayMs()).toBe(2_000);
    clock.advance(120_000);
    expect(backoff.nextDelayMs()).toBe(4_000);
  });
});
