import { describe, expect, it, vi } from "vitest";
import { awaitPendingManagerWork, awaitSearchSyncIfNeeded } from "./manager-async-state.js";

describe("memory search async sync", () => {
  it("awaits sync when searching dirty indexes", async () => {
    let releaseSync = () => {};
    let settled = false;
    const pending = new Promise<void>((resolve) => {
      releaseSync = () => {
        settled = true;
        resolve();
      };
    });
    const syncMock = vi.fn(async () => pending);
    const onError = vi.fn();

    const searchSyncPromise = awaitSearchSyncIfNeeded({
      enabled: true,
      dirty: true,
      sessionsDirty: false,
      sync: syncMock,
      onError,
    });

    expect(syncMock).toHaveBeenCalledTimes(1);
    let finished = false;
    void searchSyncPromise.then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(settled).toBe(false);

    releaseSync();
    await searchSyncPromise;
    expect(finished).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it("waits for in-flight search sync during close", async () => {
    let releaseSync = () => {};
    const pendingSync = new Promise<void>((resolve) => {
      releaseSync = () => resolve();
    });

    let closed = false;
    const closePromise = awaitPendingManagerWork({ pendingSync }).then(() => {
      closed = true;
    });

    await Promise.resolve();
    expect(closed).toBe(false);

    releaseSync();
    await closePromise;
  });

  it("skips search sync when search-triggered sync is disabled", async () => {
    const syncMock = vi.fn(async () => {});
    await awaitSearchSyncIfNeeded({
      enabled: false,
      dirty: true,
      sessionsDirty: false,
      sync: syncMock,
      onError: vi.fn(),
    });
    expect(syncMock).not.toHaveBeenCalled();
  });
});
