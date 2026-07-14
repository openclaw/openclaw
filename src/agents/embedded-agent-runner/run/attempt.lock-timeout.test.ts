import { describe, it, expect, vi } from "vitest";

/**
 * Minimal unit test verifying the forceDisposeRetainedLock behavior
 * in isolation (does not require full module tree).
 */
describe("forceDisposeRetainedLock behavior", () => {
  function createMockLockController() {
    let retainedLockUseCount = 0;
    const retainedLockIdleWaiters = new Set<() => void>();

    function beginRetainedLockUse(): () => void {
      retainedLockUseCount += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        retainedLockUseCount -= 1;
        if (retainedLockUseCount === 0 && retainedLockIdleWaiters.size > 0) {
          const waiters = Array.from(retainedLockIdleWaiters);
          retainedLockIdleWaiters.clear();
          for (const resolve of waiters) resolve();
        }
      };
    }

    async function waitForRetainedLockIdle(): Promise<boolean> {
      if (retainedLockUseCount === 0) return true;
      await new Promise<void>((resolve) => {
        retainedLockIdleWaiters.add(resolve);
      });
      return true;
    }

    function forceDisposeRetainedLock(): void {
      retainedLockUseCount = 0;
      if (retainedLockIdleWaiters.size > 0) {
        const waiters = Array.from(retainedLockIdleWaiters);
        retainedLockIdleWaiters.clear();
        for (const resolve of waiters) resolve();
      }
    }

    return {
      beginRetainedLockUse,
      waitForRetainedLockIdle,
      forceDisposeRetainedLock,
      getUseCount: () => retainedLockUseCount,
    };
  }

  it("forceDisposeRetainedLock clears use count and resolves idle waiters", async () => {
    const controller = createMockLockController();

    // Simulate a retained lock use that never completes (stuck tool execution)
    controller.beginRetainedLockUse();
    expect(controller.getUseCount()).toBe(1);

    // Start waiting for idle - this would normally hang
    let idleResolved = false;
    const idlePromise = controller.waitForRetainedLockIdle().then(() => {
      idleResolved = true;
    });

    // Force dispose should unblock the waiter immediately
    controller.forceDisposeRetainedLock();
    await idlePromise;

    expect(idleResolved).toBe(true);
    expect(controller.getUseCount()).toBe(0);
  });

  it("forceDisposeRetainedLock is safe to call when already idle", () => {
    const controller = createMockLockController();
    expect(controller.getUseCount()).toBe(0);
    // Should not throw
    controller.forceDisposeRetainedLock();
    expect(controller.getUseCount()).toBe(0);
  });

  it("forceDisposeRetainedLock resolves multiple waiters", async () => {
    const controller = createMockLockController();
    controller.beginRetainedLockUse();

    let resolved1 = false;
    let resolved2 = false;
    const p1 = controller.waitForRetainedLockIdle().then(() => {
      resolved1 = true;
    });
    const p2 = controller.waitForRetainedLockIdle().then(() => {
      resolved2 = true;
    });

    controller.forceDisposeRetainedLock();
    await Promise.all([p1, p2]);

    expect(resolved1).toBe(true);
    expect(resolved2).toBe(true);
  });

  it("attempt teardown timeout + forceDispose flow", async () => {
    const controller = createMockLockController();
    let lockReleased = false;

    // Simulate stuck retained lock use (tool execution hung)
    controller.beginRetainedLockUse();

    // Simulate the release function that waits for idle
    const releaseRetainedSessionLock = async () => {
      await controller.waitForRetainedLockIdle();
      lockReleased = true;
    };

    const LOCK_RELEASE_TIMEOUT_MS = 100; // Use short timeout for test
    const timeout = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), LOCK_RELEASE_TIMEOUT_MS);
    });
    const release = releaseRetainedSessionLock().then(() => "released" as const);

    const result = await Promise.race([release, timeout]);
    expect(result).toBe("timeout");
    expect(lockReleased).toBe(false);

    // Force dispose and retry
    controller.forceDisposeRetainedLock();
    await releaseRetainedSessionLock();

    expect(lockReleased).toBe(true);
  });
});
