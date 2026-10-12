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
});
