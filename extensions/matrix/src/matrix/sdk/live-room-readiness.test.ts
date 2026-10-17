import path from "node:path";
import { ClientEvent, type MatrixClient as MatrixJsClient } from "matrix-js-sdk/lib/matrix.js";
import { Room } from "matrix-js-sdk/lib/models/room.js";
import { SyncState } from "matrix-js-sdk/lib/sync.js";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixTestRuntime } from "../../test-runtime.js";
import { MatrixClient } from "../sdk.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => afterEach(cleanup));

const fixture = vi.hoisted(() => ({
  sdk: undefined as MatrixJsClient | undefined,
  room: undefined as Room | undefined,
  init: vi.fn<() => Promise<void>>(),
  probe: vi.fn<(roomId: string) => Promise<boolean>>(),
  stopped: vi.fn(),
  beforeResolve: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("openclaw/plugin-sdk/ssrf-dispatcher", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-dispatcher")>();
  return {
    ...actual,
    resolvePinnedHostnameWithPolicy: async (
      ...args: Parameters<typeof actual.resolvePinnedHostnameWithPolicy>
    ) => {
      await fixture.beforeResolve?.();
      return await actual.resolvePinnedHostnameWithPolicy(...args);
    },
  };
});
vi.mock("./joined-room-encryption.js", () => ({
  reconcileJoinedRoomEncryption: async () => undefined,
}));
vi.mock("./idb-persistence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./idb-persistence.js")>()),
  persistIdbToDisk: vi.fn(async () => undefined),
  restoreIdbFromDisk: vi.fn(async () => false),
}));
vi.mock("matrix-js-sdk/lib/matrix.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("matrix-js-sdk/lib/matrix.js")>();
  return {
    ...actual,
    createClient: (...args: Parameters<typeof actual.createClient>) => {
      const client = actual.createClient(...args);
      fixture.sdk = client;
      vi.spyOn(client, "initRustCrypto").mockImplementation(fixture.init);
      // Mock only readiness; uploads retain the real SDK transport.
      vi.mocked(vi.spyOn(client, "getCrypto"), { partial: true }).mockReturnValue({
        isEncryptionEnabledInRoom: fixture.probe,
      });
      vi.spyOn(client, "getRoom").mockImplementation(() => fixture.room ?? null);
      vi.spyOn(client, "getRooms").mockReturnValue([]);
      vi.spyOn(client, "getAccountDataFromServer").mockResolvedValue(null);
      vi.spyOn(client, "startClient").mockImplementation(async () => {
        client.emit(ClientEvent.Sync, SyncState.Prepared, null, { fromCache: true });
      });
      vi.spyOn(client, "stopClient").mockImplementation(fixture.stopped);
      return client;
    },
  };
});

describe("Matrix live encrypted room ownership", () => {
  const roomId = "!room:matrix.test";
  let client: MatrixClient;
  let sdk: MatrixJsClient;
  let releases: (() => void)[];
  let pending: Promise<unknown>[];
  function track<T>(operation: Promise<T>) {
    pending.push(Promise.allSettled([operation]));
    return operation;
  }
  function gate<T>(fallback: T) {
    const started = createDeferred<void>();
    const finish = createDeferred<T>();
    releases.push(() => finish.resolve(fallback));
    return {
      started: started.promise,
      finish: finish.resolve,
      run: () => {
        started.resolve();
        return finish.promise;
      },
    };
  }
  const makeRoom = () => {
    const room = new Room(roomId, sdk, "@bot:matrix.test");
    vi.spyOn(room, "getMyMembership").mockReturnValue("join");
    vi.spyOn(room, "hasEncryptionStateEvent").mockReturnValue(true);
    return room;
  };
  const liveSync = () => sdk.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Syncing);
  function holdProbe(once = false) {
    const probe = gate(false);
    if (once) {
      fixture.probe.mockImplementationOnce(probe.run);
    } else {
      fixture.probe.mockImplementation(probe.run);
    }
    return probe;
  }
  function makeClient(options: ConstructorParameters<typeof MatrixClient>[2]) {
    client = new MatrixClient("https://127.0.0.1:8008", "fixture-token", {
      userId: "@bot:matrix.test",
      encryption: true,
      autoBootstrapCrypto: false,
      idbSnapshotPath: path.join(tempDirs.make("matrix-live-room-"), "snapshot.json"),
      ...options,
    });
    sdk = fixture.sdk!;
    fixture.room = makeRoom();
  }
  const uploadFixture = () =>
    client.uploadContent(Buffer.from("encrypted fixture"), "application/octet-stream", "fixture");

  beforeEach(async () => {
    releases = [];
    pending = [];
    installMatrixTestRuntime();
    vi.useFakeTimers();
    fixture.init.mockReset().mockResolvedValue(undefined);
    fixture.probe.mockReset().mockResolvedValue(true);
    fixture.stopped.mockReset();
    fixture.beforeResolve = undefined;
    makeClient({
      deviceId: "BOT",
      ssrfPolicy: { allowPrivateNetwork: true },
    });
    await client.start();
  });
  afterEach(async () => {
    releases.forEach((release) => release());
    client.abortPendingRequests();
    await Promise.all(pending);
    await client.stopWithoutPersist();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["room replacement", "missing room", "membership", "encryption", "offline"])(
    "revalidates %s after a held crypto probe",
    async (change) => {
      liveSync();
      const { started, finish } = holdProbe(true);
      const send = vi.fn(async () => "$sent");
      const operation = track(client.withLiveEncryptedRoom(roomId, send));
      await started;
      if (change === "room replacement") {
        fixture.room = makeRoom();
        fixture.probe.mockResolvedValue(false);
      } else if (change === "missing room") {
        fixture.room = undefined;
      } else if (change === "membership") {
        vi.mocked(fixture.room!).getMyMembership.mockReturnValue("leave");
      } else if (change === "encryption") {
        vi.mocked(fixture.room!).hasEncryptionStateEvent.mockReturnValue(false);
      } else {
        sdk.emit(ClientEvent.Sync, SyncState.Reconnecting, SyncState.Syncing);
      }
      finish(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(send).not.toHaveBeenCalled();
      fixture.room = makeRoom();
      fixture.probe.mockResolvedValue(true);
      liveSync();
      await expect(operation).resolves.toBe("$sent");
    },
  );

  it("cancels one waiter without canceling a sibling's shared crypto initialization", async () => {
    const initialization = gate(undefined);
    fixture.init.mockImplementation(initialization.run);
    await client.stopWithoutPersist();
    makeClient({});
    const startup = track(client.start());
    await initialization.started;
    const abort = new AbortController();
    const canceledSend = vi.fn(async () => "$canceled");
    const first = track(
      client.withLiveEncryptedRoom(roomId, canceledSend, { abortSignal: abort.signal }),
    );
    const siblingSend = vi.fn(async () => "$sibling");
    const second = track(client.withLiveEncryptedRoom(roomId, siblingSend));
    abort.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    initialization.finish(undefined);
    await startup;
    liveSync();
    await expect(second).resolves.toBe("$sibling");
    expect(canceledSend).not.toHaveBeenCalled();
    expect(fixture.init).toHaveBeenCalledTimes(2);
  });

  it.each(["caller cancellation", "STOPPED"] as const)(
    "rejects %s promptly while retaining a held probe until backend teardown",
    async (cause) => {
      liveSync();
      const state = vi.fn();
      client.on("sync.state", state);
      const { started, finish } = holdProbe();
      const abort = new AbortController();
      const send = vi.fn(async () => "$sent");
      const operation = track(
        client.withLiveEncryptedRoom(roomId, send, { abortSignal: abort.signal }),
      );
      const settled = Promise.allSettled([operation]);
      let outcome: PromiseSettledResult<unknown> | undefined;
      void settled.then(([result]) => {
        outcome = result;
      });
      await started;
      if (cause === "STOPPED") {
        sdk.emit(ClientEvent.Sync, SyncState.Stopped, SyncState.Prepared);
      } else {
        abort.abort();
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome?.status).toBe("rejected");
      if (cause === "STOPPED") {
        await expect(operation).rejects.toThrow("sync stopped");
        expect(state).toHaveBeenCalledExactlyOnceWith("STOPPED", "PREPARED", undefined);
      } else {
        await expect(operation).rejects.toMatchObject({ name: "AbortError" });
      }
      const stop = track(client.stopWithoutPersist());
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.stopped).not.toHaveBeenCalled();
      finish(true);
      await settled;
      await stop;
      expect(fixture.stopped).toHaveBeenCalledOnce();
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("aborts the actual SDK upload transport without claiming an in-flight request was unsent", async () => {
    liveSync();
    const dispatched = createDeferred<AbortSignal>();
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("upload transport has no cancellation signal");
      }
      dispatched.resolve(signal);
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            const reason: unknown = signal.reason;
            reject(
              reason instanceof Error ? reason : new Error("upload aborted", { cause: reason }),
            );
          },
          { once: true },
        );
      });
    });
    vi.stubGlobal("fetch", fetch);
    const upload = track(client.withLiveEncryptedRoom(roomId, uploadFixture));
    const signal = await dispatched.promise;
    client.abortPendingRequests();
    expect(signal.aborted).toBe(true);
    await expect(upload).rejects.not.toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["room membership", "operation owner"])(
    "rechecks %s after DNS before upload dispatch",
    async (change) => {
      liveSync();
      let active = true;
      const resolution = gate(undefined);
      fixture.beforeResolve = resolution.run;
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        Response.json({ content_uri: "mxc://matrix.test/image" }),
      );
      vi.stubGlobal("fetch", fetch);
      const upload = track(
        client.withLiveEncryptedRoom(roomId, uploadFixture, {
          assertCurrent: () => {
            if (!active) {
              throw new Error("operation stopped");
            }
          },
        }),
      );
      await resolution.started;
      if (change === "room membership") {
        vi.mocked(fixture.room!).getMyMembership.mockReturnValue("leave");
        liveSync();
      } else {
        active = false;
      }
      resolution.finish(undefined);
      await expect(upload).rejects.toThrow(
        change === "room membership" ? "room changed" : "operation stopped",
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("waits for live sync before sending and allows healthy same-state sync during media preparation and upload", async () => {
    const preparation = gate(undefined);
    const uploading = gate(undefined);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      await uploading.run();
      return Response.json({ content_uri: "mxc://matrix.test/image" });
    });
    vi.stubGlobal("fetch", fetch);
    const send = vi.fn(async (assertCurrent: () => void) => {
      await preparation.run();
      assertCurrent();
      const uri = await client.uploadContent(Buffer.from("encrypted fixture"));
      assertCurrent();
      return uri;
    });
    const operation = track(client.withLiveEncryptedRoom(roomId, send));
    await vi.advanceTimersByTimeAsync(0);
    expect(send).not.toHaveBeenCalled();
    sdk.emit(ClientEvent.Sync, SyncState.Catchup, SyncState.Prepared);
    await vi.advanceTimersByTimeAsync(0);
    expect(send).not.toHaveBeenCalled();
    liveSync();
    await preparation.started;
    liveSync();
    preparation.finish(undefined);
    await uploading.started;
    liveSync();
    uploading.finish(undefined);
    await expect(operation).resolves.toBe("mxc://matrix.test/image");
    expect(fetch).toHaveBeenCalledOnce();
  });
});
