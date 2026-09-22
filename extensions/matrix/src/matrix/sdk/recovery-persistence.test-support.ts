import type { ICreateClientOpts } from "matrix-js-sdk/lib/matrix.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  OpenAsyncKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { vi } from "vitest";
import { getMatrixRuntime } from "../../runtime.js";
import {
  readMatrixRecoveryKeyStateForPathAsync,
  type MatrixSnapshotStateRuntime,
} from "../crypto-state-store.js";

export async function readStoredRecoveryKey(recoveryKeyPath: string) {
  return readMatrixRecoveryKeyStateForPathAsync(recoveryKeyPath, getMatrixRuntime().state);
}

export function holdRecoveryKeyPersistence() {
  const admitted = createDeferred<void>();
  const release = createDeferred<void>();
  const stateRuntime: MatrixSnapshotStateRuntime = {
    openKeyedStore<T>(options: OpenAsyncKeyedStoreOptions): PluginStateKeyedStore<T> {
      const store = createPluginStateKeyedStoreForTests<T>("matrix", options);
      const compareAndApply = store.compareAndApply;
      if (!compareAndApply) {
        throw new Error("expected current SQLite comparison support");
      }
      return {
        ...store,
        compareAndApply: async (key, comparison, intent) => {
          if (options.namespace === "recovery-key" && intent.action === "set") {
            admitted.resolve();
            await release.promise;
          }
          return await compareAndApply(key, comparison, intent);
        },
      };
    },
  };
  return { admitted, release, stateRuntime };
}

export function captureRecoveryCacheWrite(capturedOptions: unknown) {
  // SAFETY: the SDK mock captures production options; required callbacks are checked below.
  const options = capturedOptions as ICreateClientOpts;
  const callbacks = options?.cryptoCallbacks;
  if (!callbacks?.cacheSecretStorageKey || !callbacks.getSecretStorageKey) {
    throw new Error("expected Matrix recovery callbacks");
  }
  const getSecretStorageKey = vi.spyOn(callbacks, "getSecretStorageKey");
  callbacks.cacheSecretStorageKey(
    "SSSSKEY",
    {
      algorithm: "m.secret_storage.v1.aes-hmac-sha2",
      name: "Synthetic recovery key",
      passphrase: { algorithm: "m.pbkdf2", iterations: 1, salt: "synthetic" },
      iv: "synthetic-iv",
      mac: "synthetic-mac",
    },
    new Uint8Array([1, 2, 3, 4]),
  );
  return { options, getSecretStorageKey };
}
