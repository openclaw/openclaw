import { beforeEach, describe, expect, it, vi } from "vitest";
import { runInProcessRestartHooks } from "openclaw/plugin-sdk/lifecycle-restart-hooks";
import {
  acquireTelegramPollingLease,
  releaseTelegramPollingLeasesForLifecycleReset,
  resetTelegramPollingLeasesForTests,
} from "./polling-lease.js";

describe("Telegram polling lease", () => {
  beforeEach(() => {
    resetTelegramPollingLeasesForTests();
  });

  it("refuses an active duplicate poller for the same bot token", async () => {
    const first = await acquireTelegramPollingLease({
      token: "123:abc",
      accountId: "default",
    });

    await expect(
      acquireTelegramPollingLease({
        token: "123:abc",
        accountId: "ops",
      }),
    ).rejects.toThrow('refusing duplicate poller for account "ops"');

    first.release();
  });

  it("allows concurrent pollers for different bot tokens", async () => {
    const first = await acquireTelegramPollingLease({
      token: "123:abc",
      accountId: "default",
    });
    const second = await acquireTelegramPollingLease({
      token: "456:def",
      accountId: "ops",
    });

    expect(first.tokenFingerprint).not.toBe(second.tokenFingerprint);

    first.release();
    second.release();
  });

  it("waits for an aborting same-token poller before acquiring", async () => {
    const oldAbort = new AbortController();
    const first = await acquireTelegramPollingLease({
      token: "123:abc",
      accountId: "default",
      abortSignal: oldAbort.signal,
    });
    oldAbort.abort();

    const acquire = acquireTelegramPollingLease({
      token: "123:abc",
      accountId: "default",
      waitMs: 1_000,
    });
    await Promise.resolve();
    first.release();
    const second = await acquire;

    expect(second.waitedForPrevious).toBe(true);
    expect(second.replacedStoppingPrevious).toBe(false);

    second.release();
  });

  it("does not let stale release clear a replacement lease", async () => {
    vi.useFakeTimers();
    try {
      const oldAbort = new AbortController();
      const first = await acquireTelegramPollingLease({
        token: "123:abc",
        accountId: "old",
        abortSignal: oldAbort.signal,
      });
      oldAbort.abort();

      const acquireReplacement = acquireTelegramPollingLease({
        token: "123:abc",
        accountId: "new",
        waitMs: 10,
      });
      await vi.advanceTimersByTimeAsync(10);
      const replacement = await acquireReplacement;
      expect(replacement.replacedStoppingPrevious).toBe(true);

      first.release();

      await expect(
        acquireTelegramPollingLease({
          token: "123:abc",
          accountId: "third",
        }),
      ).rejects.toThrow('account "new"');

      replacement.release();
    } finally {
      vi.useRealTimers();
    }
  });

  // Regression: openclaw/openclaw#81507
  // The polling lease registry lives on a process-global Symbol, so a stale
  // entry left by a dropped previous-lifecycle monitor task blocks every new
  // acquire after an in-process gateway restart. The Telegram extension
  // registers a lifecycle reset hook that drains the registry at the restart
  // boundary; after that runs, a fresh acquire for the same token must
  // succeed even though the old lease was never explicitly released.
  it("clears stale same-token leases at the in-process restart boundary", async () => {
    const oldAbort = new AbortController();
    const stale = await acquireTelegramPollingLease({
      token: "123:abc",
      accountId: "old-lifecycle",
      abortSignal: oldAbort.signal,
    });

    // Simulate the previous lifecycle dying without ever calling release()
    // (its `finally` block was interrupted by the in-process restart).
    await expect(
      acquireTelegramPollingLease({
        token: "123:abc",
        accountId: "new-lifecycle",
        waitMs: 0,
      }),
    ).rejects.toThrow('refusing duplicate poller for account "new-lifecycle"');

    // The gateway run-loop drains plugin-registered subsystem hooks at the
    // restart boundary. The Telegram extension registers itself on first
    // module load, so this drain frees the stale lease.
    const drained = releaseTelegramPollingLeasesForLifecycleReset();
    expect(drained).toBe(1);

    const fresh = await acquireTelegramPollingLease({
      token: "123:abc",
      accountId: "new-lifecycle",
    });
    expect(fresh.tokenFingerprint).toBe(stale.tokenFingerprint);

    // A late `release()` from the dropped previous-lifecycle task must NOT
    // delete the fresh lease (owner-checked release).
    stale.release();
    await expect(
      acquireTelegramPollingLease({
        token: "123:abc",
        accountId: "third",
      }),
    ).rejects.toThrow('refusing duplicate poller for account "new-lifecycle"');

    fresh.release();
  });

  // Regression: openclaw/openclaw#81507
  // The cleanup is lifecycle-owned, not steady-state. Two concurrent live
  // pollers within the same lifecycle (no restart in between) must still be
  // rejected by the same-token guard.
  it("keeps the same-token live duplicate guard outside the restart boundary", async () => {
    const first = await acquireTelegramPollingLease({
      token: "123:abc",
      accountId: "a",
    });
    await expect(
      acquireTelegramPollingLease({
        token: "123:abc",
        accountId: "b",
      }),
    ).rejects.toThrow('refusing duplicate poller for account "b"');
    first.release();
  });

  // The Telegram extension wires its cleanup through the shared
  // in-process-restart-hooks registry on first module load. Running the
  // registry must cascade through to the Telegram lease registry without
  // any callers having to know about the Telegram-specific helper.
  it("is wired into the shared in-process restart hook registry", async () => {
    const lease = await acquireTelegramPollingLease({
      token: "123:abc",
      accountId: "hook-test",
    });
    expect(runInProcessRestartHooks()).toBeGreaterThanOrEqual(1);
    const fresh = await acquireTelegramPollingLease({
      token: "123:abc",
      accountId: "hook-test-2",
    });
    fresh.release();
    // Late stale release from the dropped previous-lifecycle task is safe.
    lease.release();
  });
});
