import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireTelegramPollingLease,
  releaseStoppedTelegramPollingLease,
} from "./polling-lease.js";
import { resetTelegramPollingLeasesForTest as resetTelegramPollingLeasesForTests } from "./runtime.test-support.js";

const leaseOptions = { token: "123:abc", accountId: "default" };
const acquire = (options: Partial<Parameters<typeof acquireTelegramPollingLease>[0]> = {}) =>
  acquireTelegramPollingLease({ ...leaseOptions, ...options });
const releaseStopped = () => releaseStoppedTelegramPollingLease(leaseOptions);
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
    const pending = acquire();
    await Promise.resolve();
    first.release();
    const second = await pending;
    expect(second).toMatchObject({ waitedForPrevious: true, replacedStoppingPrevious: false });
    second.release();
  });

  it("keeps a replacement lease after the default grace period", async () => {
    vi.useFakeTimers();
    const { abort, first } = await initialLease("old");
    abort.abort();
    const acquireReplacement = acquire({ accountId: "new" });
    await vi.advanceTimersByTimeAsync(5_000);
    const replacement = await acquireReplacement;
    expect(replacement.replacedStoppingPrevious).toBe(true);

    first.release();

    await expect(acquire({ accountId: "third" })).rejects.toThrow('account "new"');

    replacement.release();
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

  it("releases an aborted same-account lease after the default grace period", async () => {
    vi.useFakeTimers();
    const { abort, first } = await initialLease();
    abort.abort();
    const release = releaseStopped();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(await Promise.race([release, Promise.resolve("pending")])).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    await expect(release).resolves.toBe(true);
    const next = await acquire();
    next.release();
    first.release();
  });
});
