import fs from "node:fs/promises";
import path from "node:path";
import { ClientEvent, type MatrixClient as MatrixJsClient } from "matrix-js-sdk/lib/matrix.js";
import { SyncState } from "matrix-js-sdk/lib/sync.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  drainFileLockStateForTest,
  resetFileLockStateForTest,
} from "openclaw/plugin-sdk/file-lock";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMatrixRuntime } from "../../runtime.js";
import { installMatrixTestRuntime, resetMatrixTestStores } from "../../test-runtime.js";
import { writeMatrixIdbSnapshotJson } from "../crypto-state-store.js";
import { MatrixClient } from "../sdk.js";
import * as cryptoOwnership from "./crypto-store-ownership.js";
import { observeCryptoStoreContention } from "./crypto-store-ownership.test-helpers.js";
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
vi.mock("./idb-persistence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./idb-persistence.js")>()),
  persistIdbToDisk: vi.fn(
    async (params?: Parameters<typeof import("./idb-persistence.js").persistIdbToDisk>[0]) => {
      const snapshotPath =
        params?.snapshotPath ??
        path.join(getMatrixRuntime().state.resolveStateDir(), "matrix", "crypto-idb-snapshot.json");
      await writeMatrixIdbSnapshotJson({
        storageRootDir: path.dirname(snapshotPath),
        snapshotJson: '{"version":1,"databases":[]}',
        databaseCount: 0,
        stateRuntime: params?.stateRuntime,
      });
    },
  ),
  restoreIdbFromDisk: vi.fn(async () => false),
}));
vi.mock("matrix-js-sdk/lib/matrix.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("matrix-js-sdk/lib/matrix.js")>();
  return {
    ...actual,
    createClient: (...args: Parameters<typeof actual.createClient>) => {
      const client = actual.createClient(...args);
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
    const stateDir = tempDirs.make("matrix-startup-state-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    installMatrixTestRuntime({ stateDir });
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
    await resetMatrixTestStores();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("holds custody when encrypted startup uses the default snapshot path", async () => {
    const stateDir = tempDirs.make("matrix-default-custody-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    client = new MatrixClient("https://matrix.example.org", "test-token", {
      encryption: true,
      autoBootstrapCrypto: false,
      userId: "@bot:example.org",
      deviceId: "BOT",
    });
    try {
      await client.prepareForOneOff();
      const recover = vi.fn(async () => {});
      await expect(
        cryptoOwnership.withMatrixCryptoStoreRecoveryLock(
          path.join(stateDir, "matrix", "crypto-idb-snapshot.json"),
          recover,
        ),
      ).rejects.toThrow();
      expect(recover).not.toHaveBeenCalled();
    } finally {
      await client.stopAndPersist();
    }
  });

  it("allows a successor after cancellation while arming refusal before Rust initialization", async () => {
    const snapshotPath = path.join(tempDirs.make("matrix-pre-init-abort-"), "snapshot.json");
    const armed = createDeferred<void>();
    const finishArm = createDeferred<void>();
    const acquire = cryptoOwnership.acquireMatrixCryptoStoreOwnership;
    vi.spyOn(cryptoOwnership, "acquireMatrixCryptoStoreOwnership").mockImplementationOnce(
      async (...args) => {
        const ownership = await acquire(...args);
        const arm = ownership.armUnsafeState;
        ownership.armUnsafeState = async () => {
          await arm();
          armed.resolve();
          await finishArm.promise;
        };
        return ownership;
      },
    );
    const options = { encryption: true, autoBootstrapCrypto: false, idbSnapshotPath: snapshotPath };
    client = new MatrixClient("https://matrix.example.org", "test-token", options);
    const successor = new MatrixClient("https://matrix.example.org", "test-token", options);
    const abort = new AbortController();
    const startup = client.start({ abortSignal: abort.signal });
    const rejected = expect(startup).rejects.toMatchObject({ name: "AbortError" });
    const settled = Promise.allSettled([startup]);
    try {
      await armed.promise;
      abort.abort();
      finishArm.resolve();
      await rejected;
      expect(fixture.init).not.toHaveBeenCalled();
      await client.stopWithoutPersist();
      await successor.prepareForOneOff();
      expect(fixture.init).toHaveBeenCalledTimes(1);
    } finally {
      finishArm.resolve();
      await settled;
      await Promise.allSettled([client.stopWithoutPersist(), successor.stopAndPersist()]);
    }
  });

  it("passes the configured crypto database prefix to Rust initialization", async () => {
    await client.prepareForOneOff();
    expect(fixture.init).toHaveBeenCalledWith({
      cryptoDatabasePrefix: "openclaw-matrix-test",
    });
    expect(fixture.reconcile).not.toHaveBeenCalled();
  });

  it.each([
    { phase: "replay", reason: "startup abort" },
    { phase: "replay", reason: "deadline" },
    { phase: "replay", reason: "generation stop" },
    { phase: "initialization", reason: "deadline" },
  ])(
    "cancels $phase promptly on $reason but drains it before backend stop",
    async ({ phase, reason }) => {
      vi.useFakeTimers();
      const started = createDeferred<void>();
      const finish = createDeferred<void>();
      const abort = new AbortController();
      let replaySignal: AbortSignal | undefined;
      const hold = async () => {
        started.resolve();
        await finish.promise;
      };
      if (phase === "initialization") {
        fixture.init.mockImplementation(hold);
      } else {
        fixture.reconcile.mockImplementation(async (_client, signal, assertCurrent) => {
          assertCurrent();
          replaySignal = signal;
          await hold();
          assertCurrent();
        });
      }
      const startup = client.start({ abortSignal: abort.signal, readyTimeoutMs: 1000 });
      const startupSettled = Promise.allSettled([startup]);
      let shutdown: Promise<void> | undefined;
      try {
        await Promise.race([
          started.promise,
          startup.then(() => {
            throw new Error(`Encrypted startup bypassed ${phase}`);
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
        if (phase === "replay") {
          expect(replaySignal?.aborted).toBe(true);
        }
        shutdown ??= client.stopWithoutPersist();
        await Promise.resolve();
        expect(fixture.stop).not.toHaveBeenCalled();
        finish.resolve();
        await shutdown;
        expect(fixture.stop).toHaveBeenCalledTimes(1);
        if (phase === "initialization") {
          expect(fixture.start).not.toHaveBeenCalled();
          expect(fixture.reconcile).not.toHaveBeenCalled();
        }
        await expect(client.start()).rejects.toThrow("fully stopped");
      } finally {
        finish.resolve();
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
      expect(await cryptoOwnership.isMatrixCryptoStoreUnsafe(snapshotPath)).toBe(false);
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
      const waiter = observeCryptoStoreContention(snapshotPath);
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

  it("retains custody through failed quiescence until pending crypto initialization is stopped", async () => {
    const tempDir = tempDirs.make("matrix-quiesce-failure-");
    const snapshotPath = path.join(tempDir, "snapshot.json");
    const initStarted = createDeferred<void>();
    const finishInit = createDeferred<void>();
    const requestsAborted = createDeferred<void>();
    const quiesceError = new Error("sync quiescence failed");
    fixture.init.mockImplementation(async () => {
      initStarted.resolve();
      await finishInit.promise;
    });
    const owner = new MatrixClient("https://matrix.example.org", "test-token", {
      userId: "@bot:example.org",
      deviceId: "BOT",
      encryption: true,
      autoBootstrapCrypto: false,
      cryptoDatabasePrefix: "openclaw-matrix-quiesce-failure-test",
      idbSnapshotPath: snapshotPath,
    });
    vi.spyOn(owner, "quiesceSync").mockRejectedValue(quiesceError);
    const abortRequests = owner.abortPendingRequests.bind(owner);
    vi.spyOn(owner, "abortPendingRequests").mockImplementation(() => {
      abortRequests();
      requestsAborted.resolve();
    });
    const startup = owner.prepareForOneOff();
    const startupSettled = Promise.allSettled([startup]);
    let shutdown: Promise<void> | undefined;
    try {
      await initStarted.promise;
      const savesBefore = vi.mocked(persistIdbToDisk).mock.calls.length;
      shutdown = owner.stopAndPersist();
      const shutdownSettled = Promise.allSettled([shutdown]);
      await Promise.race([
        requestsAborted.promise,
        shutdown.then(
          () => {
            throw new Error("Shutdown released custody without canceling crypto work");
          },
          (error: unknown) => {
            throw error;
          },
        ),
      ]);
      const inspect = vi.fn(async () => undefined);
      await expect(
        cryptoOwnership.withMatrixCryptoStoreRecoveryLock(snapshotPath, inspect),
      ).rejects.toThrow();
      expect(inspect).not.toHaveBeenCalled();
      expect(fixture.stop).not.toHaveBeenCalled();
      finishInit.resolve();
      await expect(shutdown).rejects.toBe(quiesceError);
      await shutdownSettled;
      await cryptoOwnership.withMatrixCryptoStoreRecoveryLock(snapshotPath, async (markerPath) => {
        expect(fixture.stop).toHaveBeenCalledTimes(1);
        expect(await fs.stat(markerPath)).toBeDefined();
      });
      expect(vi.mocked(persistIdbToDisk).mock.calls.length).toBe(savesBefore);
    } finally {
      finishInit.resolve();
      await startupSettled;
      await shutdown?.catch(() => undefined);
      await owner.stopWithoutPersist().catch(() => undefined);
    }
  });

  it("retains custody after Rust initialization rejects without a stoppable backend", async () => {
    const snapshotPath = path.join(tempDirs.make("matrix-rust-init-failure-"), "snapshot.json");
    const failure = new Error("Rust initialization failed after opening its store");
    fixture.init.mockRejectedValueOnce(failure);
    const owner = new MatrixClient("https://matrix.example.org", "test-token", {
      userId: "@bot:example.org",
      deviceId: "BOT",
      encryption: true,
      autoBootstrapCrypto: false,
      idbSnapshotPath: snapshotPath,
    });
    const inspect = vi.fn(async () => undefined);
    try {
      await expect(owner.prepareForOneOff()).rejects.toBe(failure);
      await expect(owner.prepareForOneOff()).rejects.toMatchObject({ cause: failure });
      expect(fixture.init).toHaveBeenCalledOnce();
      await expect(owner.stopAndPersist()).rejects.toMatchObject({ cause: failure });
      await expect(owner.stopWithoutPersist()).rejects.toMatchObject({ cause: failure });
      await expect(
        cryptoOwnership.withMatrixCryptoStoreRecoveryLock(snapshotPath, inspect),
      ).rejects.toThrow();
      expect(inspect).not.toHaveBeenCalled();
      expect(await cryptoOwnership.isMatrixCryptoStoreUnsafe(snapshotPath)).toBe(true);
    } finally {
      await owner.stopWithoutPersist().catch(() => undefined);
      // The SDK failed before exposing a backend; only process exit can release
      // custody in production. Close this test-owned manager after proving refusal.
      resetFileLockStateForTest();
      await drainFileLockStateForTest();
    }
  });

  it("retains custody after SDK stop throws even when discard cleanup is requested", async () => {
    const tempDir = tempDirs.make("matrix-sdk-stop-failure-");
    const snapshotPath = path.join(tempDir, "snapshot.json");
    const owner = new MatrixClient("https://matrix.example.org", "test-token", {
      userId: "@bot:example.org",
      deviceId: "BOT",
      encryption: true,
      autoBootstrapCrypto: false,
      cryptoDatabasePrefix: "openclaw-matrix-sdk-stop-failure-test",
      idbSnapshotPath: snapshotPath,
    });
    const stopError = new Error("SDK stop failed");
    try {
      await owner.prepareForOneOff();
      const savesBefore = vi.mocked(persistIdbToDisk).mock.calls.length;
      fixture.stop.mockImplementationOnce(() => {
        throw stopError;
      });
      await expect(owner.stopAndPersist()).rejects.toBe(stopError);
      await expect(owner.start()).rejects.toThrow("fully stopped");
      const inspect = vi.fn(async () => undefined);
      await expect(
        cryptoOwnership.withMatrixCryptoStoreRecoveryLock(snapshotPath, inspect),
      ).rejects.toThrow();
      expect(inspect).not.toHaveBeenCalled();
      expect(vi.mocked(persistIdbToDisk).mock.calls.length).toBe(savesBefore);
      await expect(owner.stopWithoutPersist()).rejects.toBe(stopError);
      expect(fixture.stop).toHaveBeenCalledTimes(1);
      await expect(
        cryptoOwnership.withMatrixCryptoStoreRecoveryLock(snapshotPath, inspect),
      ).rejects.toThrow();
      expect(inspect).not.toHaveBeenCalled();
      expect(await fs.stat(`${snapshotPath}.owner.poisoned`)).toBeDefined();
    } finally {
      await owner.stopWithoutPersist().catch(() => undefined);
      // Production retains this uncertain backend's lock until process exit.
      // Retire only the test-owned lock manager after checking that behavior.
      resetFileLockStateForTest();
      await drainFileLockStateForTest();
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
      const waiter = observeCryptoStoreContention(snapshotPath);
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
      expect(await cryptoOwnership.isMatrixCryptoStoreUnsafe(snapshotPath)).toBe(false);
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

  it("allows a successor after refusal-marker durability fails before Rust initialization", async () => {
    const snapshotPath = path.join(tempDirs.make("matrix-arming-durability-"), "snapshot.json");
    const actualOpen = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const file = await actualOpen(...args);
      if (args[0] === `${snapshotPath}.owner.poisoned`) {
        vi.spyOn(file, "sync").mockRejectedValueOnce(new Error("marker sync failed"));
      }
      return file;
    });
    const makeClient = () =>
      new MatrixClient("https://matrix.example.org", "test-token", {
        userId: "@bot:example.org",
        deviceId: "BOT",
        encryption: true,
        autoBootstrapCrypto: false,
        idbSnapshotPath: snapshotPath,
      });
    const owner = makeClient();
    let successor: MatrixClient | undefined;
    try {
      await expect(owner.prepareForOneOff()).rejects.toThrow("marker sync failed");
      expect(fixture.init).not.toHaveBeenCalled();
      vi.restoreAllMocks();
      successor = makeClient();
      await successor.prepareForOneOff();
      await successor.stopAndPersist();
    } finally {
      await owner.stopWithoutPersist();
      await successor?.stopWithoutPersist();
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
});
