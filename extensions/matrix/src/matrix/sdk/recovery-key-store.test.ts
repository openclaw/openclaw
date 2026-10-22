import fs from "node:fs";
import path from "node:path";
import { createClient } from "matrix-js-sdk";
import { encodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key.js";
import { RustCrypto } from "matrix-js-sdk/lib/rust-crypto/rust-crypto.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMatrixRuntime } from "../../runtime.js";
import { installMatrixTestRuntime } from "../../test-runtime.js";
import {
  readMatrixRecoveryKeyStateForPathAsync,
  writeMatrixRecoveryKeyStateForPathAsync,
  type MatrixSnapshotStateRuntime,
} from "../crypto-state-store.js";
import { createMatrixCryptoApi } from "./crypto.test-support.js";
import { LogService } from "./logger.js";
import { MatrixRecoveryKeyStore } from "./recovery-key-store.js";
import type { MatrixCryptoBootstrapApi, MatrixSecretStorageStatus } from "./types.js";

const stores: MatrixRecoveryKeyStore[] = [];
const releases: (() => void)[] = [];
const pending: Promise<unknown>[] = [];
const clients: (() => void)[] = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    releases.splice(0).forEach((release) => release());
    await Promise.all(pending.splice(0));
    await Promise.all(stores.splice(0).map((store) => store.close()));
    clients.splice(0).forEach((stop) => stop());
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

function createTempRecoveryKeyPath(): string {
  return path.join(tempDirs.make("matrix-recovery-key-store-"), "recovery-key.json");
}

function createStore(
  runtime?: MatrixSnapshotStateRuntime,
  recoveryKeyPath = createTempRecoveryKeyPath(),
) {
  const store = new MatrixRecoveryKeyStore(recoveryKeyPath, runtime);
  stores.push(store);
  return { recoveryKeyPath, store, callbacks: store.buildCryptoCallbacks() };
}

async function createStoredKey(keyId: string, bytes: number[], encodedPrivateKey?: string) {
  const recoveryKeyPath = createTempRecoveryKeyPath();
  await writeStoredRecoveryKey(recoveryKeyPath, keyId, bytes, encodedPrivateKey);
  return createStore(undefined, recoveryKeyPath);
}

function createReleaseGate() {
  const gate = createDeferred<void>();
  releases.push(() => gate.resolve());
  return gate;
}

function readKey(store: MatrixRecoveryKeyStore, ...keyIds: string[]) {
  return store.buildCryptoCallbacks().getSecretStorageKey(
    {
      keys: Object.fromEntries(keyIds.map((keyId) => [keyId, {}])),
    },
    "m.cross_signing.master",
  );
}

function encodedKey(start: number) {
  const bytes = Array.from({ length: 32 }, (_, i) => i + start);
  const encoded = encodeRecoveryKey(new Uint8Array(bytes));
  if (!encoded) {
    throw new Error("expected encoded synthetic key");
  }
  return { bytes, encoded };
}

async function writeStoredRecoveryKey(
  recoveryKeyPath: string,
  keyId: string,
  bytes: number[],
  encodedPrivateKey?: string,
) {
  await writeMatrixRecoveryKeyStateForPathAsync({
    recoveryKeyPath,
    stateRuntime: getMatrixRuntime().state,
    payload: {
      version: 1,
      createdAt: "2026-07-01T00:00:00.000Z",
      keyId,
      encodedPrivateKey,
      privateKeyBase64: Buffer.from(bytes).toString("base64"),
    },
  });
}

function createGeneratedRecoveryKey(keyId: string, bytes: number[], encodedPrivateKey: string) {
  return {
    keyId,
    keyInfo: { name: keyId },
    privateKey: new Uint8Array(bytes),
    encodedPrivateKey,
  };
}

function createBootstrapSecretStorageMock(errorMessage?: string) {
  return vi.fn(
    async (opts?: {
      setupNewSecretStorage?: boolean;
      createSecretStorageKey?: () => Promise<unknown>;
    }) => {
      if (opts?.setupNewSecretStorage || !errorMessage) {
        await opts?.createSecretStorageKey?.();
        return;
      }
      throw new Error(errorMessage);
    },
  );
}

function createRecoveryKeyCrypto(params: {
  bootstrapSecretStorage?: MatrixCryptoBootstrapApi["bootstrapSecretStorage"];
  createRecoveryKeyFromPassphrase?: MatrixCryptoBootstrapApi["createRecoveryKeyFromPassphrase"];
  status: MatrixSecretStorageStatus;
}): MatrixCryptoBootstrapApi {
  return createMatrixCryptoApi({
    bootstrapSecretStorage: params.bootstrapSecretStorage ?? vi.fn(async () => {}),
    createRecoveryKeyFromPassphrase:
      params.createRecoveryKeyFromPassphrase ??
      vi.fn(async () => {
        throw new Error("should not be called");
      }),
    getSecretStorageStatus: vi.fn(async () => params.status),
  });
}

const readRecoveryState = (recoveryKeyPath: string) =>
  readMatrixRecoveryKeyStateForPathAsync(recoveryKeyPath, getMatrixRuntime().state);

async function readStoredRecoveryKey(recoveryKeyPath: string) {
  const state = await readRecoveryState(recoveryKeyPath);
  if (!state) {
    throw new Error("expected stored recovery key state");
  }
  return state;
}

function interceptRecoveryStore(hooks: {
  beforeRead?: () => Promise<void>;
  afterRead?: () => Promise<void>;
  beforeWrite?: () => Promise<void>;
}): MatrixSnapshotStateRuntime {
  const original = getMatrixRuntime().state.openKeyedStoreV2;
  return {
    openKeyedStoreV2: <T>(options: Parameters<typeof original>[0]) => {
      const store = original<T>(options);
      return {
        ...store,
        async lookup(key: string) {
          await hooks.beforeRead?.();
          const value = await store.lookup(key);
          await hooks.afterRead?.();
          return value;
        },
        async compareAndApply(...args: Parameters<typeof store.compareAndApply>) {
          await hooks.beforeWrite?.();
          return store.compareAndApply(...args);
        },
      };
    },
  };
}

function holdRecoveryWrites() {
  const entered = createDeferred<void>();
  const release = createReleaseGate();
  const runtime = interceptRecoveryStore({
    beforeWrite: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  return { entered, release, runtime };
}

describe("MatrixRecoveryKeyStore", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetPluginStateStoreForTests();
    installMatrixTestRuntime();
  });

  it.each(["cached", "staged"] as const)(
    "joins the cache write before real SDK cross-signing encryption with a %s key",
    async (source) => {
      const held = holdRecoveryWrites();
      const { recoveryKeyPath, store, callbacks } = createStore(held.runtime);
      const privateKey = new Uint8Array(32).fill(7);
      const encodedPrivateKey = encodeRecoveryKey(privateKey);
      if (!encodedPrivateKey) {
        throw new Error("expected encoded synthetic key");
      }
      await store.drainPendingPersistence();
      if (source === "staged") {
        await store.stageEncodedRecoveryKey({ encodedPrivateKey });
        expect(await readRecoveryState(recoveryKeyPath)).toBeNull();
      }
      const accountData = new Map<string, unknown>();
      const encryptedWrites: string[] = [];
      const sdk = createClient({
        baseUrl: "https://matrix.example.org",
        userId: "@fixture:example.org",
        accessToken: "fixture-token",
        cryptoCallbacks: callbacks,
        fetchFn: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          const event = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
          if (init?.method === "PUT") {
            if (typeof init.body !== "string") {
              throw new Error("expected SDK JSON account-data body");
            }
            const content: unknown = JSON.parse(init.body);
            if (event.startsWith("m.cross_signing.")) {
              const persisted = await readStoredRecoveryKey(recoveryKeyPath);
              expect(persisted.privateKeyBase64).toBe(Buffer.from(privateKey).toString("base64"));
              expect(content).toMatchObject({ encrypted: expect.any(Object) });
              encryptedWrites.push(event);
            }
            accountData.set(event, content);
            return Response.json({});
          }
          return accountData.has(event)
            ? Response.json(accountData.get(event))
            : Response.json({ errcode: "M_NOT_FOUND", error: "fixture missing" }, { status: 404 });
        },
      });
      clients.push(() => sdk.stopClient());
      const receiver = Object.assign(Object.create(RustCrypto.prototype) as RustCrypto, {
        logger: { info() {} },
        secretStorage: sdk.secretStorage,
        cryptoCallbacks: callbacks,
        olmMachine: {
          async exportCrossSigningKeys() {
            return {
              masterKey: "fixture-master",
              self_signing_key: "fixture-self",
              userSigningKey: "fixture-user",
            };
          },
        },
        async saveBackupKeyToStorage() {},
      });
      const crypto = createRecoveryKeyCrypto({
        status: { ready: false, defaultKeyId: null },
        createRecoveryKeyFromPassphrase: vi.fn(async () => ({
          privateKey,
          encodedPrivateKey,
        })),
        bootstrapSecretStorage: vi.fn((options) =>
          RustCrypto.prototype.bootstrapSecretStorage.call(receiver, options),
        ),
      });
      const bootstrap = store.bootstrapSecretStorageWithRecoveryKey(crypto);
      pending.push(Promise.allSettled([bootstrap]));
      await Promise.race([
        held.entered.promise,
        bootstrap.then(() => {
          throw new Error("bootstrap completed before persistence admission");
        }),
      ]);
      expect(encryptedWrites).toEqual([]);
      held.release.resolve();
      await bootstrap;
      expect(encryptedWrites).toEqual([
        "m.cross_signing.master",
        "m.cross_signing.user_signing",
        "m.cross_signing.self_signing",
      ]);
    },
  );

  it.each([false, true])(
    "settles a no-getter bootstrap before returning or throwing (failure=%s)",
    async (fail) => {
      const held = holdRecoveryWrites();
      const { recoveryKeyPath, store, callbacks } = createStore(held.runtime);
      const error = new Error("synthetic bootstrap failure");
      const crypto = createRecoveryKeyCrypto({
        status: { ready: true, defaultKeyId: "fixture" },
        createRecoveryKeyFromPassphrase: vi.fn(),
        bootstrapSecretStorage: vi.fn(async () => {
          callbacks.cacheSecretStorageKey?.("fixture", {}, new Uint8Array([1, 2, 3]));
          if (fail) {
            throw error;
          }
        }),
      });
      let settled = false;
      const bootstrap = store
        .bootstrapSecretStorageWithRecoveryKey(crypto)
        .then(
          () => null,
          (cause: unknown) => cause,
        )
        .finally(() => {
          settled = true;
        });
      pending.push(Promise.allSettled([bootstrap]));
      await held.entered.promise;
      expect(settled).toBe(false);
      held.release.resolve();
      expect(await bootstrap).toBe(fail ? error : null);
      expect((await readStoredRecoveryKey(recoveryKeyPath)).keyId).toBe("fixture");
    },
  );

  it("preserves a concurrent durable encoding and FIFO callback writes through the worker", async () => {
    const held = holdRecoveryWrites();
    const { recoveryKeyPath, store, callbacks } = createStore(held.runtime);
    await store.drainPendingPersistence();
    callbacks.cacheSecretStorageKey?.("first", {}, new Uint8Array([1]));
    callbacks.cacheSecretStorageKey?.("second", {}, new Uint8Array([2]));
    await held.entered.promise;
    await writeStoredRecoveryKey(recoveryKeyPath, "concurrent", [3], "fixture-concurrent-encoding");
    held.release.resolve();
    await store.drainPendingPersistence();
    expect(await readStoredRecoveryKey(recoveryKeyPath)).toMatchObject({
      keyId: "second",
      privateKeyBase64: "Ag==",
      encodedPrivateKey: "fixture-concurrent-encoding",
    });
  });

  it("does not recreate secret storage when the local recovery key cannot be read", async () => {
    const failure = new Error("synthetic recovery-key read failure");
    const { store } = createStore(
      interceptRecoveryStore({
        beforeRead: async () => {
          throw failure;
        },
      }),
    );
    const crypto = createRecoveryKeyCrypto({ status: { ready: false, defaultKeyId: "EXISTING" } });
    await expect(store.bootstrapSecretStorageWithRecoveryKey(crypto)).rejects.toBe(failure);
    expect(crypto.createRecoveryKeyFromPassphrase).not.toHaveBeenCalled();
    expect(crypto.bootstrapSecretStorage).not.toHaveBeenCalled();
  });

  it("keeps failed writes best-effort and drains later writes on the worker store", async () => {
    const failure = new Error("synthetic persistence failure");
    let failNext = true;
    const warn = vi.spyOn(LogService, "warn").mockImplementation(() => {});
    const runtime = interceptRecoveryStore({
      beforeWrite: async () => {
        if (failNext) {
          failNext = false;
          throw failure;
        }
      },
    });
    const { recoveryKeyPath, store, callbacks } = createStore(runtime);
    await store.drainPendingPersistence();
    callbacks.cacheSecretStorageKey?.("failed", {}, new Uint8Array([1]));
    await expect(
      callbacks.getSecretStorageKey?.({ keys: { failed: {} } }, "fixture"),
    ).resolves.toEqual(["failed", new Uint8Array([1])]);
    expect(await store.getSecretStorageKeyCandidate("failed")).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "MatrixClientLite",
      "Failed to persist recovery key:",
      failure,
    );
    callbacks.cacheSecretStorageKey?.("saved", {}, new Uint8Array([2]));
    await store.close();
    expect(await readStoredRecoveryKey(recoveryKeyPath)).toMatchObject({
      keyId: "saved",
      privateKeyBase64: "Ag==",
    });
  });

  it.each(["SDK callback", "reset candidate"] as const)(
    "does not return a durable key after closure during a %s read",
    async (reader) => {
      const recoveryKeyPath = createTempRecoveryKeyPath();
      await writeStoredRecoveryKey(recoveryKeyPath, "fixture", [1, 2, 3]);
      const readCompleted = createDeferred<void>();
      const releaseRead = createReleaseGate();
      let delayRead = false;
      const stateRuntime = interceptRecoveryStore({
        afterRead: async () => {
          if (delayRead) {
            readCompleted.resolve();
            await releaseRead.promise;
          }
        },
      });
      const { store } = createStore(stateRuntime, recoveryKeyPath);
      await store.drainPendingPersistence();
      delayRead = true;
      const result =
        reader === "SDK callback"
          ? store.buildCryptoCallbacks().getSecretStorageKey?.({ keys: { fixture: {} } }, "fixture")
          : store.getSecretStorageKeyCandidate("fixture");
      pending.push(Promise.allSettled([result]));
      await readCompleted.promise;
      await store.close();
      releaseRead.resolve();
      await expect(result).resolves.toBeNull();
    },
  );

  it("loads a stored recovery key for requested secret-storage keys", async () => {
    const { store, recoveryKeyPath } = await createStoredKey("SSSS", [1, 2, 3, 4]);
    await store.drainPendingPersistence();
    expect(fs.existsSync(recoveryKeyPath)).toBe(false);
    expect(await store.getSecretStorageKeyCandidate("SSSS")).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(await readKey(store, "SSSS")).toEqual(["SSSS", new Uint8Array([1, 2, 3, 4])]);
    expect((await readKey(store, "OLD", "SSSS"))?.[0]).toBe("SSSS");
  });

  it.each([false, true])(
    "refuses retired recovery-key JSON without replacing state (SQLite key present=%s)",
    async (hasStoredKey) => {
      const recoveryKeyPath = createTempRecoveryKeyPath();
      if (hasStoredKey) {
        await writeStoredRecoveryKey(recoveryKeyPath, "CURRENT", [4, 3, 2, 1]);
      }
      const previousState = await readRecoveryState(recoveryKeyPath);
      const legacyJson = JSON.stringify({
        version: 1,
        createdAt: "2026-03-12T00:00:00.000Z",
        keyId: "SSSS",
        privateKeyBase64: "AQIDBA==",
      });
      fs.writeFileSync(recoveryKeyPath, legacyJson, "utf8");
      const warn = vi.spyOn(LogService, "warn").mockImplementation(() => {});
      const { store, callbacks } = createStore(undefined, recoveryKeyPath);
      const remediation =
        'Install OpenClaw 2026.9.5, run "openclaw doctor --fix", and start the Matrix channel once to migrate it, then upgrade to latest.';

      await expect(store.getRecoveryKeySummary()).rejects.toThrow(remediation);
      await expect(store.getSecretStorageKeyCandidate("SSSS")).rejects.toThrow(remediation);
      await expect(readKey(store, "SSSS")).rejects.toThrow(remediation);
      callbacks.cacheSecretStorageKey?.("NEW", {}, new Uint8Array([9, 8, 7]));
      await expect(store.drainPendingPersistence()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        "MatrixClientLite",
        "Failed to persist recovery key:",
        expect.objectContaining({ message: expect.stringContaining(remediation) }),
      );
      expect(await readRecoveryState(recoveryKeyPath)).toEqual(previousState);
      expect(fs.readFileSync(recoveryKeyPath, "utf8")).toBe(legacyJson);
      expect(fs.existsSync(`${recoveryKeyPath}.migrated`)).toBe(false);
    },
  );

  it("loads a custom recovery key filename without colliding with the default key", async () => {
    const dir = tempDirs.make("matrix-recovery-key-store-");
    const recoveryKeyPath = path.join(dir, "recovery.key");
    await writeStoredRecoveryKey(path.join(dir, "recovery-key.json"), "DEFAULT", [1, 2, 3, 4]);
    await writeStoredRecoveryKey(recoveryKeyPath, "CUSTOM", [4, 3, 2, 1]);

    const { store } = createStore(undefined, recoveryKeyPath);
    expect(await readKey(store, "CUSTOM")).toEqual(["CUSTOM", new Uint8Array([4, 3, 2, 1])]);
    expect(await readRecoveryState(path.join(dir, "recovery-key.json"))).toMatchObject({
      keyId: "DEFAULT",
      privateKeyBase64: "AQIDBA==",
    });
    expect(await readRecoveryState(recoveryKeyPath)).toMatchObject({ keyId: "CUSTOM" });
    expect(fs.existsSync(recoveryKeyPath)).toBe(false);
  });

  it("does not authorize destructive reset from an ephemeral cached key", async () => {
    const store = new MatrixRecoveryKeyStore();
    const callbacks = store.buildCryptoCallbacks();

    callbacks.cacheSecretStorageKey?.("KEY123", { name: "openclaw" }, new Uint8Array([9, 8, 7]));

    expect(await store.getSecretStorageKeyCandidate("KEY123")).toBeNull();
  });

  it.each(["rebind", "repair missing key", "validate staged key", "rotate"] as const)(
    "bootstraps secret storage with the correct durable key: %s",
    async (mode) => {
      const repair = mode === "repair missing key";
      const rotate = mode === "rotate";
      const staged = mode === "validate staged key";
      const oldKey = encodedKey(1);
      const freshKey = encodedKey(101);
      const { store, recoveryKeyPath } = repair
        ? createStore()
        : await createStoredKey("OLD", oldKey.bytes, oldKey.encoded);
      if (staged) {
        await store.stageEncodedRecoveryKey({ encodedPrivateKey: freshKey.encoded, keyId: "NEW" });
      }
      const keyId = repair ? "REPAIRED" : "NEW";
      const createRecoveryKeyFromPassphrase = vi.fn(async () => {
        if (!repair && !rotate) {
          throw new Error("should not be called");
        }
        return createGeneratedRecoveryKey(keyId, freshKey.bytes, freshKey.encoded);
      });
      const bootstrapSecretStorage = createBootstrapSecretStorageMock(
        repair ? "getSecretStorageKey callback returned falsey" : undefined,
      );
      await store.bootstrapSecretStorageWithRecoveryKey(
        createRecoveryKeyCrypto({
          bootstrapSecretStorage,
          createRecoveryKeyFromPassphrase,
          status: { ready: true, defaultKeyId: rotate ? "OLD" : "NEW" },
        }),
        {
          allowSecretStorageRecreateWithoutRecoveryKey: repair,
          forceNewRecoveryKey: rotate,
          forceNewSecretStorage: rotate,
        },
      );
      expect(createRecoveryKeyFromPassphrase).toHaveBeenCalledTimes(repair || rotate ? 1 : 0);
      expect(bootstrapSecretStorage).toHaveBeenCalledTimes(repair ? 2 : 1);
      if (repair) {
        expect(bootstrapSecretStorage).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({ setupNewSecretStorage: true }),
        );
      }
      const expected = {
        keyId: staged ? "OLD" : keyId,
        encodedPrivateKey: repair || rotate ? freshKey.encoded : oldKey.encoded,
      };
      await expect(store.getRecoveryKeySummary()).resolves.toMatchObject(expected);
      const persisted = await readStoredRecoveryKey(recoveryKeyPath);
      expect(persisted).toMatchObject(expected);
      if (rotate) {
        expect(persisted.encodedPrivateKey).not.toBe(oldKey.encoded);
      }
    },
  );
});
