import { ClientEvent, type MatrixClient as MatrixJsClient } from "matrix-js-sdk/lib/matrix.js";
import { Room } from "matrix-js-sdk/lib/models/room.js";
import { SyncState } from "matrix-js-sdk/lib/sync.js";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MatrixClient } from "../sdk.js";

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
vi.mock("matrix-js-sdk/lib/matrix.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("matrix-js-sdk/lib/matrix.js")>();
  return {
    ...actual,
    createClient: (...args: Parameters<typeof actual.createClient>) => {
      const client = actual.createClient(...args);
      fixture.sdk = client;
      vi.spyOn(client, "initRustCrypto").mockImplementation(fixture.init);
      // Only the read-only readiness probe uses this crypto fixture. Encryption
      // and recovery are outside this suite; uploads retain the real SDK transport.
      const crypto = {
        isEncryptionEnabledInRoom: fixture.probe,
      } satisfies Pick<
        NonNullable<ReturnType<MatrixJsClient["getCrypto"]>>,
        "isEncryptionEnabledInRoom"
      >;
      vi.mocked(vi.spyOn(client, "getCrypto"), { partial: true }).mockReturnValue(crypto);
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
  const makeRoom = () => {
    const room = new Room(roomId, sdk, "@bot:matrix.test");
    vi.spyOn(room, "getMyMembership").mockReturnValue("join");
    vi.spyOn(room, "hasEncryptionStateEvent").mockReturnValue(true);
    return room;
  };
  const liveSync = () => sdk.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Syncing);

  beforeEach(async () => {
    vi.useFakeTimers();
    fixture.init.mockReset().mockResolvedValue(undefined);
    fixture.probe.mockReset().mockResolvedValue(true);
    fixture.stopped.mockReset();
    fixture.beforeResolve = undefined;
    client = new MatrixClient("https://127.0.0.1:8008", "fixture-token", {
      userId: "@bot:matrix.test",
      deviceId: "BOT",
      encryption: true,
      autoBootstrapCrypto: false,
      ssrfPolicy: { allowPrivateNetwork: true },
    });
    sdk = fixture.sdk!;
    fixture.room = makeRoom();
    await client.start();
  });
  afterEach(async () => {
    await client.stopWithoutPersist();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps cached startup and CATCHUP compatible without admitting a live send", async () => {
    const send = vi.fn(async () => "$sent");
    const operation = client.withLiveEncryptedRoom(roomId, send);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(send).not.toHaveBeenCalled();
      sdk.emit(ClientEvent.Sync, SyncState.Catchup, SyncState.Prepared);
      await vi.advanceTimersByTimeAsync(0);
      expect(send).not.toHaveBeenCalled();
      liveSync();
      await expect(operation).resolves.toBe("$sent");
    } finally {
      client.abortPendingRequests();
      await operation.catch(() => undefined);
    }
  });

  it.each([
    "same-state revision",
    "room replacement",
    "missing room",
    "membership",
    "encryption",
    "offline",
  ])("revalidates %s after a held crypto probe", async (change) => {
    liveSync();
    const started = createDeferred<void>();
    const finish = createDeferred<boolean>();
    fixture.probe.mockImplementationOnce(() => {
      started.resolve();
      return finish.promise;
    });
    const send = vi.fn(async () => "$sent");
    const operation = client.withLiveEncryptedRoom(roomId, send);
    const settled = Promise.allSettled([operation]);
    try {
      await started.promise;
      if (change === "same-state revision") {
        fixture.probe.mockResolvedValue(false);
        liveSync();
      } else if (change === "room replacement") {
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
      finish.resolve(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(send).not.toHaveBeenCalled();
      fixture.room = makeRoom();
      fixture.probe.mockResolvedValue(true);
      liveSync();
      await expect(operation).resolves.toBe("$sent");
    } finally {
      finish.resolve(false);
      client.abortPendingRequests();
      await settled;
    }
  });

  it("rejects STOPPED and retains the three-argument sync event contract", async () => {
    const state = vi.fn();
    client.on("sync.state", state);
    const send = vi.fn(async () => "$sent");
    const operation = client.withLiveEncryptedRoom(roomId, send);
    const settled = Promise.allSettled([operation]);
    sdk.emit(ClientEvent.Sync, SyncState.Stopped, SyncState.Prepared);
    await settled;
    await expect(operation).rejects.toThrow("sync stopped");
    expect(send).not.toHaveBeenCalled();
    expect(state).toHaveBeenCalledExactlyOnceWith("STOPPED", "PREPARED", undefined);
  });

  it("cancels one waiter without canceling a sibling's shared crypto initialization", async () => {
    const initialization = createDeferred<void>();
    const started = createDeferred<void>();
    fixture.init.mockImplementation(async () => {
      started.resolve();
      await initialization.promise;
    });
    await client.stopWithoutPersist();
    client = new MatrixClient("https://127.0.0.1:8008", "fixture-token", {
      userId: "@bot:matrix.test",
      encryption: true,
      autoBootstrapCrypto: false,
    });
    sdk = fixture.sdk!;
    fixture.room = makeRoom();
    const startup = client.start();
    await started.promise;
    const abort = new AbortController();
    const canceledSend = vi.fn(async () => "$canceled");
    const first = client.withLiveEncryptedRoom(roomId, canceledSend, { abortSignal: abort.signal });
    const siblingSend = vi.fn(async () => "$sibling");
    const second = client.withLiveEncryptedRoom(roomId, siblingSend);
    const settled = Promise.allSettled([first, second, startup]);
    try {
      abort.abort();
      await expect(first).rejects.toMatchObject({ name: "AbortError" });
      initialization.resolve();
      await startup;
      liveSync();
      await expect(second).resolves.toBe("$sibling");
      expect(canceledSend).not.toHaveBeenCalled();
      expect(fixture.init).toHaveBeenCalledTimes(2);
    } finally {
      initialization.resolve();
      client.abortPendingRequests();
      await settled;
    }
  });

  it.each(["caller cancellation", "STOPPED"] as const)(
    "rejects %s promptly while retaining a held probe until backend teardown",
    async (cause) => {
      liveSync();
      const started = createDeferred<void>();
      const finish = createDeferred<boolean>();
      fixture.probe.mockImplementation(() => {
        started.resolve();
        return finish.promise;
      });
      const abort = new AbortController();
      const send = vi.fn(async () => "$sent");
      const operation = client.withLiveEncryptedRoom(roomId, send, { abortSignal: abort.signal });
      const settled = Promise.allSettled([operation]);
      let outcome: PromiseSettledResult<unknown> | undefined;
      void settled.then(([result]) => {
        outcome = result;
      });
      let stop: Promise<void> | undefined;
      try {
        await started.promise;
        if (cause === "STOPPED") {
          sdk.emit(ClientEvent.Sync, SyncState.Stopped, SyncState.Syncing);
        } else {
          abort.abort();
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(outcome?.status).toBe("rejected");
        if (cause === "STOPPED") {
          await expect(operation).rejects.toThrow("sync stopped");
        } else {
          await expect(operation).rejects.toMatchObject({ name: "AbortError" });
        }
        stop = client.stopWithoutPersist();
        await vi.advanceTimersByTimeAsync(0);
        expect(fixture.stopped).not.toHaveBeenCalled();
      } finally {
        finish.resolve(true);
        await settled;
        await stop;
      }
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
    const upload = client.withLiveEncryptedRoom(roomId, () =>
      client.uploadContent(Buffer.from("encrypted fixture"), "application/octet-stream", "fixture"),
    );
    const settled = Promise.allSettled([upload]);
    const signal = await dispatched.promise;
    client.abortPendingRequests();
    expect(signal.aborted).toBe(true);
    const [result] = await settled;
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.reason).not.toBeInstanceOf(PlatformMessageNotDispatchedError);
    }
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["room membership", "operation owner"])(
    "rechecks %s after DNS before upload dispatch",
    async (change) => {
      liveSync();
      let active = true;
      const resolving = createDeferred<void>();
      const resolved = createDeferred<void>();
      fixture.beforeResolve = async () => {
        resolving.resolve();
        await resolved.promise;
      };
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        Response.json({ content_uri: "mxc://matrix.test/image" }),
      );
      vi.stubGlobal("fetch", fetch);
      const upload = client.withLiveEncryptedRoom(
        roomId,
        () =>
          client.uploadContent(
            Buffer.from("encrypted fixture"),
            "application/octet-stream",
            "fixture",
          ),
        {
          assertCurrent: () => {
            if (!active) {
              throw new Error("operation stopped");
            }
          },
        },
      );
      const settled = Promise.allSettled([upload]);
      try {
        await resolving.promise;
        if (change === "room membership") {
          vi.mocked(fixture.room!).getMyMembership.mockReturnValue("leave");
          liveSync();
        } else {
          active = false;
        }
        resolved.resolve();
        await settled;
        expect(fetch).not.toHaveBeenCalled();
        await expect(upload).rejects.toThrow(
          change === "room membership" ? "room changed" : "operation stopped",
        );
      } finally {
        resolved.resolve();
        client.abortPendingRequests();
        await settled;
      }
    },
  );

  it("allows healthy same-state sync during media preparation and upload", async () => {
    liveSync();
    const preparing = createDeferred<void>();
    const prepared = createDeferred<void>();
    const uploading = createDeferred<void>();
    const uploaded = createDeferred<void>();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      uploading.resolve();
      await uploaded.promise;
      return Response.json({ content_uri: "mxc://matrix.test/image" });
    });
    vi.stubGlobal("fetch", fetch);
    const operation = client.withLiveEncryptedRoom(roomId, async (assertCurrent) => {
      preparing.resolve();
      await prepared.promise;
      assertCurrent();
      const uri = await client.uploadContent(Buffer.from("encrypted fixture"));
      assertCurrent();
      return uri;
    });
    const settled = Promise.allSettled([operation]);
    try {
      await preparing.promise;
      liveSync();
      prepared.resolve();
      await uploading.promise;
      liveSync();
      uploaded.resolve();
      await expect(operation).resolves.toBe("mxc://matrix.test/image");
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      prepared.resolve();
      uploaded.resolve();
      client.abortPendingRequests();
      await settled;
    }
  });
});
