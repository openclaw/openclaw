// Irc tests cover reconnect backoff plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIrcReconnectBackoff } from "./reconnect-backoff.js";

function createClock(start = 1_000_000) {
  let current = start;
  vi.spyOn(performance, "now").mockImplementation(() => current);
  return {
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function stepWallClock(toEpoch: number) {
  vi.spyOn(Date, "now").mockReturnValue(toEpoch);
}

describe("irc reconnect backoff", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resets after a connection stayed up for a minute", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const clock = createClock();
    const backoff = createIrcReconnectBackoff();
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
    const backoff = createIrcReconnectBackoff();
    backoff.nextDelayMs();
    backoff.markConnected();
    clock.advance(59_999);
    expect(backoff.nextDelayMs()).toBe(2_000);
  });

  it("does not let a failed connect attempt inherit an earlier connection's uptime", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const clock = createClock();
    const backoff = createIrcReconnectBackoff();
    backoff.nextDelayMs();
    backoff.markConnected();
    clock.advance(10_000);
    expect(backoff.nextDelayMs()).toBe(2_000);
    clock.advance(120_000);
    expect(backoff.nextDelayMs()).toBe(4_000);
  });

  it("still resets after a minute of uptime when the wall clock steps backward", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const clock = createClock();
    stepWallClock(1_700_000_000_000);
    const backoff = createIrcReconnectBackoff();
    backoff.nextDelayMs();
    backoff.nextDelayMs();
    expect(backoff.nextDelayMs()).toBe(4_000);
    backoff.markConnected();
    clock.advance(60_000);
    stepWallClock(1_700_000_000_000 - 3_600_000);
    expect(backoff.nextDelayMs()).toBe(1_000);
  });

  it("does not reset early when the wall clock steps forward", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const clock = createClock();
    stepWallClock(1_700_000_000_000);
    const backoff = createIrcReconnectBackoff();
    backoff.nextDelayMs();
    backoff.markConnected();
    clock.advance(10_000);
    stepWallClock(1_700_000_000_000 + 3_600_000);
    expect(backoff.nextDelayMs()).toBe(2_000);
  });
});
