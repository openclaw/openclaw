import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { screencastParams } from "./test-support.js";
import {
  clearBrowserScreencastTokens,
  consumeBrowserScreencastToken,
  mintBrowserScreencastToken,
} from "./tokens.js";

afterEach(() => {
  clearBrowserScreencastTokens();
  vi.useRealTimers();
});

describe("browser screencast tokens", () => {
  it("revokes unconsumed tokens when their requester leaves", () => {
    const requester = new AbortController();
    const token = mintBrowserScreencastToken(
      screencastParams({ requesterSignal: requester.signal }),
    );
    requester.abort();
    expect(consumeBrowserScreencastToken(token.token)).toBeUndefined();
    expect(getEventListeners(requester.signal, "abort")).toHaveLength(0);
  });

  it("expires at 60 seconds, including before the expiry timer runs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const token = mintBrowserScreencastToken(screencastParams());
    expect(token.expiresAtMs).toBe(61_000);
    vi.setSystemTime(token.expiresAtMs);
    expect(consumeBrowserScreencastToken(token.token)).toBeUndefined();
    const timed = mintBrowserScreencastToken(screencastParams());
    vi.advanceTimersByTime(60_000);
    expect(consumeBrowserScreencastToken(timed.token)).toBeUndefined();
  });
});
