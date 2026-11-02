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
import { persistIdbToDisk, restoreIdbFromDisk } from "./idb-persistence.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => afterEach(cleanup));
type ClientOptions = ConstructorParameters<typeof MatrixClient>[2];

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
  let stops: Array<() => Promise<void>>;
  const optionsFor = (idbSnapshotPath?: string, prefix?: string): ClientOptions => ({
    userId: "@bot:example.org",
    deviceId: "BOT",
    encryption: true,
    autoBootstrapCrypto: false,
    idbSnapshotPath,
    cryptoDatabasePrefix: prefix,
  });
  const makeClient = (options = optionsFor(), ignoreStopFailure = false) => {
    const created = new MatrixClient("https://matrix.example.org", "test-token", options);
    stops.push(() =>
      ignoreStopFailure
        ? created.stopWithoutPersist().catch(() => undefined)
        : created.stopWithoutPersist(),
    );
    return created;
  };
  const snapshot = (label: string) => path.join(tempDirs.make(`matrix-${label}-`), "snapshot.json");
  const expectCustodyHeld = async (snapshotPath: string) => {
    const inspect = vi.fn(async () => undefined);
    await expect(
      cryptoOwnership.withMatrixCryptoStoreRecoveryLock(snapshotPath, inspect),
    ).rejects.toThrow();
    expect(inspect).not.toHaveBeenCalled();
  };
  const holdWork = () => {
    const started = createDeferred<void>();
    const finish = createDeferred<void>();
    const hold = async () => {
      started.resolve();
      await finish.promise;
    };
    return { started, finish, hold };
  };
  beforeEach(() => {
    const stateDir = tempDirs.make("matrix-startup-state-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    installMatrixTestRuntime({ stateDir });
    fixture.reconcile.mockReset().mockResolvedValue(undefined);
    fixture.init.mockReset().mockResolvedValue(undefined);
    fixture.start.mockReset().mockResolvedValue(undefined);
    fixture.stop.mockReset();
    stops = [];
    client = makeClient(optionsFor(undefined, "openclaw-matrix-test"));
  });
  afterEach(async () => {
    await Promise.all(stops.map((stop) => stop()));
    // Failed SDK initialization/stop retain custody until process exit; retire test-owned locks.
    resetFileLockStateForTest();
    await drainFileLockStateForTest();
    await resetMatrixTestStores();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("holds custody when encrypted startup uses the default snapshot path", async () => {
    const stateDir = tempDirs.make("matrix-default-custody-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    client = makeClient();
    await client.prepareForOneOff();
    await expectCustodyHeld(path.join(stateDir, "matrix", "crypto-idb-snapshot.json"));
    await client.stopAndPersist();
  });

  it("allows a successor after cancellation while arming refusal before Rust initialization", async () => {
    const snapshotPath = snapshot("pre-init-abort");
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
    client = makeClient(options);
    const successor = makeClient(options);
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
      await successor.stopAndPersist();
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
      const { started, finish, hold } = holdWork();
      const abort = new AbortController();
      let replaySignal: AbortSignal | undefined;
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
    const snapshotPath = snapshot("readiness-retry");
    const options = optionsFor(snapshotPath, "openclaw-matrix-readiness-test");
    const failed = makeClient(options);
    const successor = makeClient(options);
    fixture.reconcile.mockRejectedValueOnce(new Error("room reconciliation failed"));
    await expect(failed.start()).rejects.toThrow("room reconciliation failed");
    expect(fixture.init).toHaveBeenCalledTimes(1);
    expect(await fs.stat(`${snapshotPath}.owner.poisoned`)).toBeDefined();
    await failed.stopAndPersist();
    expect(await cryptoOwnership.isMatrixCryptoStoreUnsafe(snapshotPath)).toBe(false);
    await successor.prepareForOneOff();
    expect(fixture.init).toHaveBeenCalledTimes(2);
    await successor.stopAndPersist();
  });

  it("retains crypto-store ownership after a post-initialization abort", async () => {
    const snapshotPath = snapshot("crypto-owner");
    const { started, finish, hold } = holdWork();
    fixture.init.mockImplementation(hold);
    const options = optionsFor(snapshotPath, "openclaw-matrix-owner-test");
    const owner = makeClient(options);
    const replacement = makeClient(options);
    const abort = new AbortController();
    const startup = owner.start({ abortSignal: abort.signal });

    try {
      await started.promise;
      abort.abort();
      finish.resolve();
      await expect(startup).rejects.toMatchObject({ name: "AbortError" });
      await expect(replacement.prepareForOneOff()).rejects.toMatchObject({
        code: "matrix_crypto_store_owner_active",
      });
      expect(fixture.init).toHaveBeenCalledTimes(1);
      await owner.stopWithoutPersist();
      await expect(replacement.prepareForOneOff()).rejects.toThrow("unresolved unsafe final state");
    } finally {
      finish.resolve();
      await startup.catch(() => undefined);
    }
  });

  it("retains custody through failed quiescence until pending crypto initialization is stopped", async () => {
    const snapshotPath = snapshot("quiesce-failure");
    const { started: initStarted, finish: finishInit, hold } = holdWork();
    fixture.init.mockImplementation(hold);
    const requestsAborted = createDeferred<void>();
    const quiesceError = new Error("sync quiescence failed");
    const owner = makeClient(
      optionsFor(snapshotPath, "openclaw-matrix-quiesce-failure-test"),
      true,
    );
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
        shutdown.then(() => {
          throw new Error("Shutdown released custody without canceling crypto work");
        }),
      ]);
      await expectCustodyHeld(snapshotPath);
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
    }
  });

  it("retains custody after Rust initialization rejects without a stoppable backend", async () => {
    const snapshotPath = snapshot("rust-init-failure");
    const failure = new Error("Rust initialization failed after opening its store");
    fixture.init.mockRejectedValueOnce(failure);
    const owner = makeClient(optionsFor(snapshotPath), true);
    await expect(owner.prepareForOneOff()).rejects.toBe(failure);
    await expect(owner.prepareForOneOff()).rejects.toMatchObject({ cause: failure });
    expect(fixture.init).toHaveBeenCalledOnce();
    await expect(owner.stopAndPersist()).rejects.toMatchObject({ cause: failure });
    await expect(owner.stopWithoutPersist()).rejects.toMatchObject({ cause: failure });
    await expectCustodyHeld(snapshotPath);
    expect(await cryptoOwnership.isMatrixCryptoStoreUnsafe(snapshotPath)).toBe(true);
  });

  it("retains custody after SDK stop throws even when discard cleanup is requested", async () => {
    const snapshotPath = snapshot("sdk-stop-failure");
    const owner = makeClient(
      optionsFor(snapshotPath, "openclaw-matrix-sdk-stop-failure-test"),
      true,
    );
    const stopError = new Error("SDK stop failed");
    await owner.prepareForOneOff();
    const savesBefore = vi.mocked(persistIdbToDisk).mock.calls.length;
    fixture.stop.mockImplementationOnce(() => {
      throw stopError;
    });
    await expect(owner.stopAndPersist()).rejects.toBe(stopError);
    await expect(owner.start()).rejects.toThrow("fully stopped");
    await expectCustodyHeld(snapshotPath);
    expect(vi.mocked(persistIdbToDisk).mock.calls.length).toBe(savesBefore);
    await expect(owner.stopWithoutPersist()).rejects.toBe(stopError);
    expect(fixture.stop).toHaveBeenCalledTimes(1);
    await expectCustodyHeld(snapshotPath);
    expect(await fs.stat(`${snapshotPath}.owner.poisoned`)).toBeDefined();
  });

  it("never publishes a refused replacement that did not acquire crypto ownership", async () => {
    const snapshotPath = snapshot("unowned-replacement");
    const options = optionsFor(snapshotPath, "openclaw-matrix-unowned-test");
    const owner = makeClient(options);
    const replacement = makeClient(options);
    await owner.prepareForOneOff();
    const savedBefore = vi.mocked(persistIdbToDisk).mock.calls.length;
    await expect(replacement.start()).rejects.toMatchObject({
      code: "matrix_crypto_store_owner_active",
    });
    expect(fixture.init).toHaveBeenCalledTimes(1);
    await replacement.stopAndPersist();
    expect(vi.mocked(persistIdbToDisk).mock.calls.length).toBe(savedBefore);
    await owner.stopAndPersist();
    expect(await cryptoOwnership.isMatrixCryptoStoreUnsafe(snapshotPath)).toBe(false);
    const successor = makeClient(options);
    await successor.prepareForOneOff();
    await successor.stopAndPersist();
  });

  it("refuses a successor when final snapshot publication fails", async () => {
    const snapshotPath = snapshot("failed-final-save");
    const options = optionsFor(snapshotPath, "openclaw-matrix-failed-save-test");
    const owner = makeClient(options);
    await owner.prepareForOneOff();
    expect(await fs.stat(`${snapshotPath}.owner.poisoned`)).toBeDefined();
    vi.mocked(persistIdbToDisk).mockRejectedValueOnce(new Error("disk full"));
    await expect(owner.stopAndPersist()).rejects.toThrow("disk full");
    await expect(makeClient(options).prepareForOneOff()).rejects.toThrow(
      "unresolved unsafe final state",
    );
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
    const makeRecoveryClient = () =>
      new MatrixClient("https://matrix.example.org", "test-token", {
        userId: "@bot:example.org",
        deviceId: "BOT",
        encryption: true,
        autoBootstrapCrypto: false,
        idbSnapshotPath: snapshotPath,
      });
    const owner = makeRecoveryClient();
    let successor: MatrixClient | undefined;
    try {
      await expect(owner.prepareForOneOff()).rejects.toThrow("marker sync failed");
      expect(fixture.init).not.toHaveBeenCalled();
      vi.restoreAllMocks();
      successor = makeRecoveryClient();
      await successor.prepareForOneOff();
      await successor.stopAndPersist();
    } finally {
      await owner.stopWithoutPersist();
      await successor?.stopWithoutPersist();
    }
  });

  it("refuses crypto initialization when unsafe-state arming fails", async () => {
    const snapshotPath = snapshot("unsafe-state-arm-failure");
    vi.mocked(restoreIdbFromDisk).mockImplementationOnce(async () => {
      await fs.mkdir(`${snapshotPath}.owner.poisoned`);
      return false;
    });
    const owner = makeClient(optionsFor(snapshotPath, "openclaw-matrix-arm-failure-test"));
    await expect(owner.prepareForOneOff()).rejects.toThrow();
    expect(fixture.init).not.toHaveBeenCalled();
  });
});
