import fs from "node:fs/promises";
import path from "node:path";
import { ClientEvent, type MatrixClient as MatrixJsClient } from "matrix-js-sdk/lib/matrix.js";
import { SyncState } from "matrix-js-sdk/lib/sync.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MatrixClient } from "../sdk.js";
import { observeCryptoStoreWaiter } from "./crypto-store-ownership.test-helpers.js";
import { persistIdbToDisk, restoreIdbFromDisk } from "./idb-persistence.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => afterEach(cleanup));

const fixture = vi.hoisted(() => ({
  init: vi.fn<MatrixJsClient["initRustCrypto"]>(),
  start: vi.fn<MatrixJsClient["startClient"]>(),
  stop: vi.fn<MatrixJsClient["stopClient"]>(),
  reconcile:
    vi.fn<(typeof import("./joined-room-encryption.js"))["reconcileJoinedRoomEncryption"]>(),
}));
vi.mock("./joined-room-encryption.js", () => ({
  reconcileJoinedRoomEncryption: fixture.reconcile,
}));
vi.mock("./idb-persistence.js", () => ({
  persistIdbToDisk: vi.fn(async () => undefined),
  restoreIdbFromDisk: vi.fn(async () => false),
}));
vi.mock("matrix-js-sdk/lib/matrix.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("matrix-js-sdk/lib/matrix.js")>();
  return {
    ...actual,
    createClient: (...args: Parameters<typeof actual.createClient>) => {
      const client = actual.createClient(...args);
      // Keep the actual SDK object and plugin lifecycle; no network/sync loop is
      // needed to hold crypto initialization or replay at the cancellation boundary.
      vi.spyOn(client, "initRustCrypto").mockImplementation(fixture.init);
      vi.spyOn(client, "startClient").mockImplementation(async (...options) => {
        await fixture.start(...options);
        client.emit(ClientEvent.Sync, SyncState.Prepared, null);
      });
      const stopSdk = client.stopClient.bind(client);
      vi.spyOn(client, "stopClient").mockImplementation(() => {
        fixture.stop();
        stopSdk();
      });
      return client;
    },
  };
});

describe("Matrix encrypted startup ownership", () => {
  let client: MatrixClient;
  beforeEach(() => {
    fixture.reconcile.mockReset().mockResolvedValue(undefined);
    fixture.init.mockReset().mockResolvedValue(undefined);
    fixture.start.mockReset().mockResolvedValue(undefined);
    fixture.stop.mockReset();
    client = new MatrixClient("https://matrix.example.org", "test-token", {
      userId: "@bot:example.org",
      deviceId: "BOT",
      encryption: true,
      autoBootstrapCrypto: false,
      cryptoDatabasePrefix: "openclaw-matrix-test",
    });
  });
  afterEach(async () => {
    await client.stopWithoutPersist();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("passes the configured crypto database prefix to Rust initialization", async () => {
    await client.prepareForOneOff();
    expect(fixture.init).toHaveBeenCalledWith({
      cryptoDatabasePrefix: "openclaw-matrix-test",
    });
    expect(fixture.reconcile).not.toHaveBeenCalled();
  });

  it.each(["startup abort", "deadline", "generation stop"] as const)(
    "cancels startup promptly but drains room replay before backend stop (%s)",
    async (reason) => {
      vi.useFakeTimers();
      const replayStarted = createDeferred<void>();
      const finishReplay = createDeferred<void>();
      const abort = new AbortController();
      let replaySignal: AbortSignal | undefined;
      fixture.reconcile.mockImplementation(async (_client, signal, assertCurrent) => {
        assertCurrent();
        replaySignal = signal;
        replayStarted.resolve();
        await finishReplay.promise;
        assertCurrent();
      });
      const startup = client.start({ abortSignal: abort.signal, readyTimeoutMs: 1000 });
      const startupSettled = Promise.allSettled([startup]);
      let shutdown: Promise<void> | undefined;
      try {
        await Promise.race([
          replayStarted.promise,
          startup.then(() => {
            throw new Error("Encrypted startup bypassed room recovery");
          }),
        ]);
        if (reason === "startup abort") {
          abort.abort();
        } else if (reason === "deadline") {
          await vi.advanceTimersByTimeAsync(1000);
        } else {
          shutdown = client.stopWithoutPersist();
        }
        await expect(startup).rejects.toMatchObject({ name: "AbortError" });
        expect(replaySignal?.aborted).toBe(true);
        shutdown ??= client.stopWithoutPersist();
        await Promise.resolve();
        expect(fixture.stop).not.toHaveBeenCalled();
        finishReplay.resolve();
        await shutdown;
        expect(fixture.stop).toHaveBeenCalledTimes(1);
        await expect(client.start()).rejects.toThrow("fully stopped");
      } finally {
        finishReplay.resolve();
        await startupSettled;
        await shutdown;
      }
    },
  );

  it("allows a successor after post-initialization readiness failure is published", async () => {
    const tempDir = tempDirs.make("matrix-readiness-retry-");
    const snapshotPath = path.join(tempDir, "snapshot.json");
    const options = {
      userId: "@bot:example.org",
      deviceId: "BOT",
      encryption: true,
      autoBootstrapCrypto: false,
      cryptoDatabasePrefix: "openclaw-matrix-readiness-test",
      idbSnapshotPath: snapshotPath,
    };
    const failed = new MatrixClient("https://matrix.example.org", "test-token", options);
    const successor = new MatrixClient("https://matrix.example.org", "test-token", options);
    fixture.reconcile.mockRejectedValueOnce(new Error("room reconciliation failed"));
    try {
      await expect(failed.start()).rejects.toThrow("room reconciliation failed");
      expect(fixture.init).toHaveBeenCalledTimes(1);
      expect(await fs.stat(`${snapshotPath}.owner.poisoned`)).toBeDefined();
      await failed.stopAndPersist();
      expect(await fs.stat(`${snapshotPath}.owner.poisoned`).catch(() => null)).toBeNull();
      await successor.prepareForOneOff();
      expect(fixture.init).toHaveBeenCalledTimes(2);
    } finally {
      await Promise.allSettled([failed.stopWithoutPersist(), successor.stopAndPersist()]);
    }
  });

  it("retains crypto-store ownership after a post-initialization abort", async () => {
    const tempDir = tempDirs.make("matrix-crypto-owner-");
    const snapshotPath = path.join(tempDir, "crypto-idb-snapshot.json");
    const started = createDeferred<void>();
    const finish = createDeferred<void>();
    fixture.init.mockImplementation(async () => {
      started.resolve();
      await finish.promise;
    });
    const options = {
      userId: "@bot:example.org",
      deviceId: "BOT",
      encryption: true,
      autoBootstrapCrypto: false,
      cryptoDatabasePrefix: "openclaw-matrix-owner-test",
      idbSnapshotPath: snapshotPath,
    };
    const owner = new MatrixClient("https://matrix.example.org", "test-token", options);
    const replacement = new MatrixClient("https://matrix.example.org", "test-token", options);
    const abort = new AbortController();
    const startup = owner.start({ abortSignal: abort.signal });

    try {
      await started.promise;
      abort.abort();
      finish.resolve();
      await expect(startup).rejects.toMatchObject({ name: "AbortError" });
      const waiter = await observeCryptoStoreWaiter(snapshotPath);
      const replacementStartup = replacement.prepareForOneOff();
      try {
        await waiter.waitFor(replacementStartup);
        expect(fixture.init).toHaveBeenCalledTimes(1);
        await owner.stopWithoutPersist();
        await expect(replacementStartup).rejects.toThrow("unresolved unsafe final state");
      } finally {
        waiter.close();
      }
    } finally {
      finish.resolve();
      await startup.catch(() => undefined);
      await Promise.allSettled([owner.stopWithoutPersist(), replacement.stopWithoutPersist()]);
    }
  });

  it("never publishes a canceled replacement that did not acquire crypto ownership", async () => {
    const tempDir = tempDirs.make("matrix-unowned-replacement-");
    const snapshotPath = path.join(tempDir, "snapshot.json");
    const options = {
      userId: "@bot:example.org",
      deviceId: "BOT",
      encryption: true,
      autoBootstrapCrypto: false,
      cryptoDatabasePrefix: "openclaw-matrix-unowned-test",
      idbSnapshotPath: snapshotPath,
    };
    const owner = new MatrixClient("https://matrix.example.org", "test-token", options);
    const replacement = new MatrixClient("https://matrix.example.org", "test-token", options);
    const abort = new AbortController();
    try {
      await owner.prepareForOneOff();
      const savedBefore = vi.mocked(persistIdbToDisk).mock.calls.length;
      const waiter = await observeCryptoStoreWaiter(snapshotPath);
      const replacementStartup = replacement.start({ abortSignal: abort.signal });
      const rejected = expect(replacementStartup).rejects.toMatchObject({ name: "AbortError" });
      try {
        await waiter.waitFor(replacementStartup);
      } finally {
        waiter.close();
      }
      expect(fixture.init).toHaveBeenCalledTimes(1);
      abort.abort();
      await rejected;
      await replacement.stopAndPersist();
      expect(vi.mocked(persistIdbToDisk).mock.calls.length).toBe(savedBefore);
      await owner.stopAndPersist();
      expect(await fs.stat(`${snapshotPath}.owner.poisoned`).catch(() => null)).toBeNull();
      const successor = new MatrixClient("https://matrix.example.org", "test-token", options);
      try {
        await successor.prepareForOneOff();
      } finally {
        await successor.stopAndPersist();
      }
    } finally {
      abort.abort();
      await Promise.allSettled([owner.stopWithoutPersist(), replacement.stopWithoutPersist()]);
    }
  });

  it("refuses a successor when final snapshot publication fails", async () => {
    const tempDir = tempDirs.make("matrix-failed-final-save-");
    const snapshotPath = path.join(tempDir, "snapshot.json");
    const options = {
      userId: "@bot:example.org",
      deviceId: "BOT",
      encryption: true,
      autoBootstrapCrypto: false,
      cryptoDatabasePrefix: "openclaw-matrix-failed-save-test",
      idbSnapshotPath: snapshotPath,
    };
    const owner = new MatrixClient("https://matrix.example.org", "test-token", options);
    try {
      await owner.prepareForOneOff();
      expect(await fs.stat(`${snapshotPath}.owner.poisoned`)).toBeDefined();
      vi.mocked(persistIdbToDisk).mockRejectedValueOnce(new Error("disk full"));
      await expect(owner.stopAndPersist()).rejects.toThrow("disk full");
      const successor = new MatrixClient("https://matrix.example.org", "test-token", options);
      try {
        await expect(successor.prepareForOneOff()).rejects.toThrow("unresolved unsafe final state");
      } finally {
        await successor.stopWithoutPersist();
      }
    } finally {
      await owner.stopWithoutPersist();
    }
  });

  it("refuses crypto initialization when unsafe-state arming fails", async () => {
    const tempDir = tempDirs.make("matrix-unsafe-state-arm-failure-");
    const snapshotPath = path.join(tempDir, "snapshot.json");
    vi.mocked(restoreIdbFromDisk).mockImplementationOnce(async () => {
      await fs.mkdir(`${snapshotPath}.owner.poisoned`);
      return false;
    });
    const owner = new MatrixClient("https://matrix.example.org", "test-token", {
      userId: "@bot:example.org",
      deviceId: "BOT",
      encryption: true,
      autoBootstrapCrypto: false,
      cryptoDatabasePrefix: "openclaw-matrix-arm-failure-test",
      idbSnapshotPath: snapshotPath,
    });
    try {
      await expect(owner.prepareForOneOff()).rejects.toThrow();
      expect(fixture.init).not.toHaveBeenCalled();
    } finally {
      await owner.stopWithoutPersist();
    }
  });

  it("bounds Rust initialization without tearing down its still-owned backend", async () => {
    vi.useFakeTimers();
    const started = createDeferred<void>();
    const finish = createDeferred<void>();
    fixture.init.mockImplementation(async () => {
      started.resolve();
      await finish.promise;
    });
    const startup = client.start({ readyTimeoutMs: 1000 });
    const rejected = expect(startup).rejects.toMatchObject({ name: "AbortError" });
    let shutdown: Promise<void> | undefined;
    try {
      await started.promise;
      await vi.advanceTimersByTimeAsync(1000);
      await rejected;
      shutdown = client.stopWithoutPersist();
      await Promise.resolve();
      expect(fixture.stop).not.toHaveBeenCalled();
      finish.resolve();
      await shutdown;
      expect(fixture.start).not.toHaveBeenCalled();
      expect(fixture.reconcile).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
      await startup.catch(() => undefined);
      await shutdown;
    }
  });
});
