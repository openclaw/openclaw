import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireTelegramPollingLease,
  releaseStoppedTelegramPollingLease,
} from "./polling-lease.js";
import { resetTelegramPollingLeasesForTest as resetTelegramPollingLeasesForTests } from "./runtime.test-support.js";

const leaseOptions = { token: "123:abc", accountId: "default" };
const acquire = (options: Partial<Parameters<typeof acquireTelegramPollingLease>[0]> = {}) =>
  acquireTelegramPollingLease({ ...leaseOptions, ...options });
const releaseStopped = (waitMs?: number) =>
  releaseStoppedTelegramPollingLease({ ...leaseOptions, waitMs });
async function initialLease(accountId = "default") {
  const abort = new AbortController();
  const first = await acquire({ accountId, abortSignal: abort.signal });
  return { abort, first };
}

describe("Telegram polling lease", () => {
  beforeEach(resetTelegramPollingLeasesForTests);
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("refuses an old active duplicate poller for the same bot token", async () => {
    vi.useFakeTimers();
    const { first } = await initialLease();
    await vi.advanceTimersByTimeAsync(6 * 60 * 1_000);
    await expect(acquire({ accountId: "ops" })).rejects.toThrow(
      'refusing duplicate poller for account "ops"',
    );
    first.release();
  });

  it("waits for an aborting same-token poller before acquiring", async () => {
    const { abort, first } = await initialLease();
    abort.abort();
    const pending = acquire({ waitMs: 1_000 });
    await Promise.resolve();
    first.release();
    const second = await pending;
    expect(second).toMatchObject({ waitedForPrevious: true, replacedStoppingPrevious: false });
    second.release();
  });

  it("does not let stale release clear a replacement lease", async () => {
    vi.useFakeTimers();
    const { abort, first } = await initialLease("old");
    abort.abort();
    const acquireReplacement = acquire({ accountId: "new", waitMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    const replacement = await acquireReplacement;
    expect(replacement.replacedStoppingPrevious).toBe(true);

    first.release();

    await expect(acquire({ accountId: "third" })).rejects.toThrow('account "new"');

    replacement.release();
  });

  it("caps oversized duplicate-poller wait timers before scheduling", async () => {
    vi.useFakeTimers();
    const { abort, first } = await initialLease("old");
    abort.abort();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

    void acquire({ accountId: "new", waitMs: Number.MAX_SAFE_INTEGER }).catch(() => undefined);
    await Promise.resolve();

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    first.release();
  });

  it("does not release a no-signal active lease", async () => {
    const first = await acquire();
    await expect(acquire({ accountId: "ops" })).rejects.toThrow(
      'refusing duplicate poller for account "ops"',
    );
    await expect(releaseStopped()).resolves.toBe(false);
    await expect(acquire({ accountId: "ops" })).rejects.toThrow('account "default"');
    first.release();
  });

  it("does not release a non-aborted active lease", async () => {
    const { first } = await initialLease();
    await expect(releaseStopped()).resolves.toBe(false);
    await expect(acquire({ accountId: "ops" })).rejects.toThrow('account "default"');
    first.release();
  });

  it.each([0, 10])("releases an aborted same-account lease after %i ms", async (waitMs) => {
    if (waitMs > 0) {
      vi.useFakeTimers();
    }
    const { abort, first } = await initialLease();
    abort.abort();
    const release = releaseStopped(waitMs);
    if (waitMs > 0) {
      await vi.advanceTimersByTimeAsync(waitMs);
    }
    await expect(release).resolves.toBe(true);
    const next = await acquire();
    next.release();
    first.release();
  });
});
