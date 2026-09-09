import { EventEmitter } from "node:events";
import type { MatrixClient as MatrixJsClient } from "matrix-js-sdk/lib/matrix.js";
import { SyncApi, SyncState } from "matrix-js-sdk/lib/sync.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { quiesceMatrixClientSync } from "./client-sync-quiesce.js";

type SyncApiHarness = {
  getSyncState: () => SyncState;
  stop: () => void;
  connectionReturnedResolvers?: ReturnType<typeof createDeferred<boolean>>;
};

function createSyncApiHarness(state: SyncState): SyncApiHarness {
  const syncApi = Object.create(SyncApi.prototype) as unknown as SyncApiHarness;
  syncApi.getSyncState = vi.fn(() => state);
  syncApi.stop = vi.fn();
  return syncApi;
}

describe("quiesceMatrixClientSync", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([SyncState.Error, SyncState.Reconnecting])(
    "unwinds the pinned SDK %s keepalive without waiting for STOPPED",
    async (state) => {
      vi.useFakeTimers();
      const syncApi = createSyncApiHarness(state);
      const keepalive = createDeferred<boolean>();
      const keepaliveOutcome = keepalive.promise.catch((error: unknown) => error);
      syncApi.connectionReturnedResolvers = keepalive;
      const markStopped = vi.fn();

      await quiesceMatrixClientSync({
        client: { syncApi } as unknown as MatrixJsClient,
        emitter: new EventEmitter(),
        markStopped,
        started: true,
      });

      expect(syncApi.stop).toHaveBeenCalledTimes(1);
      await expect(keepaliveOutcome).resolves.toBe("SyncApi.stop() was called");
      expect(syncApi.connectionReturnedResolvers).toBeUndefined();
      expect(markStopped).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not clear a keepalive resolver replaced during stop", async () => {
    const syncApi = createSyncApiHarness(SyncState.Error);
    const captured = createDeferred<boolean>();
    const replacement = createDeferred<boolean>();
    syncApi.connectionReturnedResolvers = captured;
    const emitter = new EventEmitter();
    syncApi.stop = vi.fn(() => {
      syncApi.connectionReturnedResolvers = replacement;
      queueMicrotask(() => emitter.emit("sync.state", "STOPPED"));
    });

    await quiesceMatrixClientSync({
      client: { syncApi } as unknown as MatrixJsClient,
      emitter,
      markStopped: vi.fn(),
      started: true,
    });

    expect(syncApi.connectionReturnedResolvers).toBe(replacement);
    captured.resolve(false);
    replacement.resolve(false);
  });
});
