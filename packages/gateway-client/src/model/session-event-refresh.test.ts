import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionEventRefreshCoordinator } from "./session-event-refresh.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("session event refresh coordinator", () => {
  it("coalesces bursts and runs one bounded trailing refresh after failure", async () => {
    vi.useFakeTimers();
    const first = deferred<void>();
    const refresh = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const coordinator = createSessionEventRefreshCoordinator({
      active: true,
      debounceMs: 200,
      maxWaitMs: 1_000,
      minCooldownMs: 1_000,
      jitterRatio: 0,
      refresh,
    });

    coordinator.schedule();
    coordinator.schedule();
    await vi.advanceTimersByTimeAsync(200);
    expect(refresh).toHaveBeenCalledTimes(1);

    coordinator.schedule();
    await vi.advanceTimersByTimeAsync(200);
    first.reject(new Error("transient failure"));
    await vi.advanceTimersByTimeAsync(999);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("retires pending work on reset", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const coordinator = createSessionEventRefreshCoordinator({
      active: true,
      refresh,
    });
    coordinator.schedule();
    coordinator.reset();
    await vi.runAllTimersAsync();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("contains synchronous refresh failures and remains reusable", async () => {
    vi.useFakeTimers();
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => {
        throw new Error("synchronous failure");
      })
      .mockResolvedValue(undefined);
    const coordinator = createSessionEventRefreshCoordinator({
      active: true,
      debounceMs: 200,
      maxWaitMs: 1_000,
      minCooldownMs: 1_000,
      jitterRatio: 0,
      refresh,
    });

    coordinator.schedule();
    await vi.advanceTimersByTimeAsync(200);
    coordinator.schedule();
    await vi.advanceTimersByTimeAsync(999);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("defers hidden work and redeems it once after activation", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const coordinator = createSessionEventRefreshCoordinator({
      active: false,
      refresh,
    });

    coordinator.schedule();
    await vi.runAllTimersAsync();
    expect(refresh).not.toHaveBeenCalled();

    coordinator.setActive(true);
    await vi.waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
    });
  });

  it("invalidates the completion guard when pending work is absorbed", async () => {
    vi.useFakeTimers();
    const pending = deferred<void>();
    let isCurrent: (() => boolean) | undefined;
    const coordinator = createSessionEventRefreshCoordinator({
      active: true,
      debounceMs: 200,
      maxWaitMs: 1_000,
      minCooldownMs: 1_000,
      jitterRatio: 0,
      refresh: vi.fn((current) => {
        isCurrent = current;
        return pending.promise;
      }),
    });

    coordinator.schedule();
    await vi.advanceTimersByTimeAsync(200);
    expect(isCurrent?.()).toBe(true);
    coordinator.absorb();
    expect(isCurrent?.()).toBe(false);
    pending.resolve();
    coordinator.dispose();
  });

  it("spreads simultaneous invalidations without postponing their armed deadlines", async () => {
    vi.useFakeTimers();
    const refreshFirst = vi.fn(async () => {});
    const refreshSecond = vi.fn(async () => {});
    const first = createSessionEventRefreshCoordinator({
      active: true,
      refresh: refreshFirst,
      random: () => 0,
    });
    const second = createSessionEventRefreshCoordinator({
      active: true,
      refresh: refreshSecond,
      random: () => 0.5,
    });
    try {
      first.schedule();
      second.schedule();
      await vi.advanceTimersByTimeAsync(3_000);
      first.schedule();
      second.schedule();

      await vi.advanceTimersByTimeAsync(1_499);
      expect(refreshFirst).not.toHaveBeenCalled();
      expect(refreshSecond).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(refreshSecond).toHaveBeenCalledOnce();
      expect(refreshFirst).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);
      expect(refreshFirst).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(refreshFirst).toHaveBeenCalledOnce();
      expect(refreshSecond).toHaveBeenCalledOnce();
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it.each([
    { duration: 100, cooldown: 5_000, draw: 0, collection: 5_000 },
    { duration: 2_000, cooldown: 6_000, draw: 0.5, collection: 4_500 },
    { duration: 6_000, cooldown: 15_000, draw: 0.75, collection: 4_250 },
  ])(
    "waits $cooldown ms after a $duration ms refresh and debounces after idle",
    async ({ duration, cooldown, draw, collection }) => {
      vi.useFakeTimers();
      const refresh = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, duration);
          }),
      );
      const coordinator = createSessionEventRefreshCoordinator({
        active: true,
        refresh,
        random: () => draw,
      });
      try {
        coordinator.schedule();
        await vi.advanceTimersByTimeAsync(collection - 1);
        expect(refresh).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        coordinator.schedule();
        await vi.advanceTimersByTimeAsync(duration + cooldown - 1);
        expect(refresh).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(refresh).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(duration + cooldown + 1);
        coordinator.schedule();
        await vi.advanceTimersByTimeAsync(collection - 1);
        expect(refresh).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(refresh).toHaveBeenCalledTimes(3);
      } finally {
        coordinator.dispose();
        await vi.advanceTimersByTimeAsync(duration);
      }
    },
  );

  it("holds pending and in-flight invalidation while inactive and catches up once", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 1_000);
        }),
    );
    const coordinator = createSessionEventRefreshCoordinator({ active: true, refresh });
    try {
      coordinator.schedule();
      coordinator.setActive(false);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(refresh).not.toHaveBeenCalled();
      coordinator.setActive(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(refresh).toHaveBeenCalledTimes(1);
      coordinator.schedule();
      coordinator.setActive(false);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(refresh).toHaveBeenCalledTimes(1);
      coordinator.setActive(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(refresh).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      coordinator.dispose();
    }
  });

  it("keeps one minute fallback under row traffic and absorbs it on an authoritative read", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => {});
    const coordinator = createSessionEventRefreshCoordinator({ active: true, refresh });
    try {
      for (let second = 0; second < 60; second += 1) {
        coordinator.scheduleFallback();
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(refresh).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(refresh).toHaveBeenCalledOnce();
      coordinator.scheduleFallback();
      coordinator.absorb();
      await vi.advanceTimersByTimeAsync(65_000);
      expect(refresh).toHaveBeenCalledOnce();
    } finally {
      coordinator.dispose();
    }
  });
});
