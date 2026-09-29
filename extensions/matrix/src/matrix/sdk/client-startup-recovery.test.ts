import { ClientEvent, type MatrixClient as MatrixJsClient } from "matrix-js-sdk/lib/matrix.js";
import { SyncState } from "matrix-js-sdk/lib/sync.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MatrixClient } from "../sdk.js";

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
