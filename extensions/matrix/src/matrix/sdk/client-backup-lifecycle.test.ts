import "fake-indexeddb/auto";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { BackupDecryptionKey, OlmMachine } from "@matrix-org/matrix-sdk-crypto-wasm";
import { MatrixClient as MatrixJsClient } from "matrix-js-sdk/lib/matrix.js";
import { RustCrypto } from "matrix-js-sdk/lib/rust-crypto/rust-crypto.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { installMatrixTestRuntime, resetMatrixTestStores } from "../../test-runtime.js";
import { MatrixClient } from "../sdk.js";

class RealCryptoClient extends MatrixClient {
  get sdkClient() {
    return this.client;
  }
}

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => afterEach(cleanup));
afterEach(async () => {
  await resetMatrixTestStores();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("settles initial backup enablement before closing a one-off crypto client", async () => {
  const root = tempDirs.make("matrix-backup-lifecycle-");
  installMatrixTestRuntime({ stateDir: root });
  const backupRequested = createDeferred<void>();
  const backupResponse = createDeferred<Response>();
  const enabling = createDeferred<void>();
  const releaseEnable = createDeferred<void>();
  const failures: unknown[] = [];
  const checks = new Set<Promise<unknown>>();
  // oxlint-disable-next-line typescript/unbound-method -- Every invocation restores the actual SDK receiver with call below.
  const check = RustCrypto.prototype.checkKeyBackupAndEnable;
  const checkSpy = vi.spyOn(RustCrypto.prototype, "checkKeyBackupAndEnable");
  checkSpy.mockImplementation(function (this: RustCrypto) {
    const pending = check.call(this);
    checks.add(pending);
    void pending.then(
      () => checks.delete(pending),
      (error: unknown) => {
        checks.delete(pending);
        failures.push(error);
      },
    );
    return pending;
  });
  // Hold the real Rust call at the SDK's final asynchronous backup step.
  // oxlint-disable-next-line typescript/unbound-method -- Every invocation restores the actual Rust receiver with apply below.
  const enable = OlmMachine.prototype.enableBackupV1;
  const enableSpy = vi.spyOn(OlmMachine.prototype, "enableBackupV1");
  enableSpy.mockImplementation(async function (this: OlmMachine, ...args) {
    enabling.resolve();
    await releaseEnable.promise;
    return await enable.apply(this, args);
  });
  const stop = vi.spyOn(MatrixJsClient.prototype, "stopClient");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (!url.pathname.endsWith("/room_keys/version")) {
        throw new Error("Unexpected Matrix fixture request: " + url.pathname);
      }
      backupRequested.resolve();
      return await backupResponse.promise;
    }),
  );
  const client = new RealCryptoClient("http://127.0.0.1:8448", "fixture-token", {
    userId: "@fixture:example.org",
    deviceId: "FIXTURE",
    encryption: true,
    ssrfPolicy: { allowPrivateNetwork: true },
    autoBootstrapCrypto: false,
    idbSnapshotPath: path.join(root, "snapshot.json"),
    cryptoDatabasePrefix: path.basename(root),
  });
  const preparation = client.prepareForOneOff();
  let shutdown: Promise<void> | undefined;
  try {
    await preparation;
    await backupRequested.promise;
    const key = BackupDecryptionKey.createRandomKey();
    const crypto = client.sdkClient.getCrypto();
    if (!crypto) {
      throw new Error("Real SDK crypto was not initialized");
    }
    await crypto.storeSessionBackupPrivateKey(
      Uint8Array.from(Buffer.from(key.toBase64(), "base64")),
      "1",
    );
    backupResponse.resolve(
      Response.json({
        algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
        auth_data: { public_key: key.megolmV1PublicKey.publicKeyBase64 },
        version: "1",
      }),
    );
    await enabling.promise;
    await client.quiesceSync();
    shutdown = client.stopWithoutPersist();
    // Shutdown has no outstanding sync/startup work; drain its promise continuations.
    await setImmediate();
    const stoppedBeforeEnablementSettled = stop.mock.calls.length;
    releaseEnable.resolve();
    await shutdown;
    await Promise.allSettled(checks);
    expect(failures).toEqual([]);
    expect(stoppedBeforeEnablementSettled).toBe(0);
    expect(stop).toHaveBeenCalledOnce();
  } finally {
    backupResponse.resolve(Response.json({ errcode: "M_NOT_FOUND" }, { status: 404 }));
    releaseEnable.resolve();
    await preparation.catch(() => undefined);
    await shutdown;
    await client.stopWithoutPersist();
  }
});
