import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  holdBrowserConnection,
  isBrowserConnectionHeld,
  watchBrowserConnectionIdle,
} from "./browser-connection-holds.js";

const cdpUrl = "http://127.0.0.1:18792";
const delayMs = 60_000;
const stops: Array<() => void> = [];

function watch(onIdle = vi.fn()) {
  stops.push(watchBrowserConnectionIdle(cdpUrl, delayMs, onIdle));
  return onIdle;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const stop of stops.splice(0)) {
    stop();
  }
  vi.useRealTimers();
});

describe("browser connection holds", () => {
  it("reports idle once an unheld connection stays unheld for the full delay", () => {
    const onIdle = watch();
    vi.advanceTimersByTime(delayMs - 1);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it("waits for the last of overlapping holders, then restarts the full delay", () => {
    const onIdle = watch();
    const releaseRequest = holdBrowserConnection(cdpUrl);
    const releaseTrace = holdBrowserConnection(`${cdpUrl}/`);
    releaseRequest();
    releaseRequest();
    vi.advanceTimersByTime(delayMs * 3);
    expect(onIdle).not.toHaveBeenCalled();
    expect(isBrowserConnectionHeld(cdpUrl)).toBe(true);

    releaseTrace();
    expect(isBrowserConnectionHeld(cdpUrl)).toBe(false);
    vi.advanceTimersByTime(delayMs - 1);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it("cancels a pending idle report when new work holds the connection", () => {
    const onIdle = watch();
    vi.advanceTimersByTime(delayMs - 1);
    const release = holdBrowserConnection(cdpUrl);
    vi.advanceTimersByTime(delayMs);
    expect(onIdle).not.toHaveBeenCalled();
    release();
    vi.advanceTimersByTime(delayMs);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it("shares holds between an endpoint and its credentialed URL", () => {
    const onIdle = watch();
    const release = holdBrowserConnection("http://openclaw-internal:relay-key@127.0.0.1:18792/");
    vi.advanceTimersByTime(delayMs * 2);
    expect(onIdle).not.toHaveBeenCalled();
    release();
    vi.advanceTimersByTime(delayMs);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it("leaves no timer behind when holds come and go without a watch", () => {
    holdBrowserConnection(cdpUrl)();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops one watch without affecting its replacement", () => {
    const stale = vi.fn();
    const stopStale = watchBrowserConnectionIdle(cdpUrl, delayMs, stale);
    const current = watch();
    stopStale();
    vi.advanceTimersByTime(delayMs);
    expect(stale).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledOnce();

    stops.pop()?.();
    holdBrowserConnection(cdpUrl)();
    expect(vi.getTimerCount()).toBe(0);
  });
});
