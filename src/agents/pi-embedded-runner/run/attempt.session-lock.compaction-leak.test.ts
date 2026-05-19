import { describe, expect, it, vi } from "vitest";
import { createEmbeddedAttemptSessionLockController } from "./attempt.session-lock.js";

const lockOptions = {
  sessionFile: "/tmp/session-84193.jsonl",
  timeoutMs: 60_000,
  staleMs: 1_800_000,
  maxHoldMs: 300_000,
};

describe("embedded attempt session lock — stuck auto-compaction (#84193)", () => {
  it("abandons in-flight write lock when cleanup runs while a hung compact() still owns it", async () => {
    const releases: string[] = [];
    const prepRelease = vi.fn(async () => {
      releases.push("prep");
    });
    const stuckRelease = vi.fn(async () => {
      releases.push("stuck-compaction");
    });
    const cleanupRelease = vi.fn(async () => {
      releases.push("cleanup");
    });
    const acquireSessionWriteLock = vi
      .fn()
      .mockResolvedValueOnce({ release: prepRelease })
      .mockResolvedValueOnce({ release: stuckRelease })
      .mockResolvedValueOnce({ release: cleanupRelease });

    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions,
    });

    await controller.releaseForPrompt();

    let unblockStuck: (() => void) | undefined;
    const stuckPromise = controller
      .withSessionWriteLock(
        () =>
          new Promise<void>((resolve) => {
            unblockStuck = resolve;
          }),
      )
      .catch(() => undefined);

    for (let i = 0; i < 20; i += 1) {
      if (unblockStuck) {
        break;
      }
      await new Promise((r) => setImmediate(r));
    }
    expect(typeof unblockStuck).toBe("function");
    expect(acquireSessionWriteLock).toHaveBeenCalledTimes(2);
    expect(releases).toEqual(["prep"]);

    const cleanupLock = await controller.acquireForCleanup();
    expect(stuckRelease).toHaveBeenCalledTimes(1);
    expect(releases).toContain("stuck-compaction");

    await cleanupLock.release();

    unblockStuck?.();
    await stuckPromise;

    expect(stuckRelease).toHaveBeenCalledTimes(1);
    expect(controller.hasSessionTakeover()).toBe(true);
  });

  it("rejects further withSessionWriteLock calls after abandoning a hung in-flight lock", async () => {
    const acquireSessionWriteLock = vi
      .fn()
      .mockResolvedValueOnce({ release: vi.fn(async () => {}) })
      .mockResolvedValueOnce({ release: vi.fn(async () => {}) });

    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions,
    });
    await controller.releaseForPrompt();

    let unblockStuck: (() => void) | undefined;
    const stuckPromise = controller
      .withSessionWriteLock(
        () =>
          new Promise<void>((resolve) => {
            unblockStuck = resolve;
          }),
      )
      .catch(() => undefined);
    for (let i = 0; i < 20; i += 1) {
      if (unblockStuck) {
        break;
      }
      await new Promise((r) => setImmediate(r));
    }
    expect(typeof unblockStuck).toBe("function");

    await controller.acquireForCleanup();

    await expect(controller.withSessionWriteLock(() => "after-cleanup")).rejects.toThrowError(
      /session file changed/,
    );

    unblockStuck?.();
    await stuckPromise;
  });
});
