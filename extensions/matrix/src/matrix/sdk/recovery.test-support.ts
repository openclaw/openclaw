import assert from "node:assert/strict";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { ClientStoppedError } from "matrix-js-sdk/lib/errors.js";
import { ClientEvent, EventType, MatrixEvent, Room } from "matrix-js-sdk/lib/matrix.js";
import { RustCrypto } from "matrix-js-sdk/lib/rust-crypto/rust-crypto.js";
import { SyncState } from "matrix-js-sdk/lib/sync.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { requestUrl, useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installMatrixTestRuntime } from "../../test-runtime.js";
import { MatrixClient } from "../sdk.js";
import { reconcileJoinedRoomEncryption } from "./joined-room-encryption.js";

class RecoveryClient extends MatrixClient {
  readonly sdk = this.client;
}
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => afterEach(cleanup));
const userId = "@bot:example.org";
const encryption = { algorithm: "m.megolm.v1.aes-sha2" };

let client: RecoveryClient;
let joined: string[];
let fetchRoom: (roomId: string, signal: AbortSignal) => Promise<Response>;
let discovery: () => Promise<Response>;
let abort: AbortController;
const fetch = vi.fn<typeof globalThis.fetch>();

function seedRoom(roomId: string, membership = "join", cached = false) {
  const result = new Room(roomId, client.sdk, userId);
  result.updateMyMembership(membership);
  if (cached) {
    result.currentState.setStateEvents([encryptionEvent(roomId)]);
  }
  client.sdk.store.storeRoom(result);
  return result;
}

function encryptionEvent(roomId: string) {
  return new MatrixEvent({
    room_id: roomId,
    type: EventType.RoomEncryption,
    state_key: "",
    content: encryption,
  });
}

beforeEach(() => {
  resetPluginStateStoreForTests();
  installMatrixTestRuntime();
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("matrix-recovery-state-"));
  joined = [];
  abort = new AbortController();
  fetchRoom = async () => Response.json(encryption);
  discovery = async () => Response.json({ joined_rooms: joined });
  client = new RecoveryClient("https://example.org", "test-token", {
    userId,
    deviceId: "BOT",
    encryption: true,
    autoBootstrapCrypto: false,
  });
  client.sdk.http.opts.fetchFn = fetch.mockReset().mockImplementation(async (input, init) => {
    const url = new URL(requestUrl(input));
    if (url.pathname.endsWith("/room_keys/version")) {
      return Response.json({ errcode: "M_NOT_FOUND" }, { status: 404 });
    }
    if (url.pathname.endsWith("/joined_rooms")) {
      return await discovery();
    }
    const match = url.pathname.match(/\/rooms\/([^/]+)\/state\/m.room.encryption\/?$/);
    if (match?.[1] && init?.signal) {
      return await fetchRoom(decodeURIComponent(match[1]), init.signal);
    }
    throw new Error(`Unexpected SDK request: ${url.pathname}`);
  });
  const initialize = client.sdk.initRustCrypto.bind(client.sdk);
  client.sdk.initRustCrypto = () => initialize({ useIndexedDB: false });
});

afterEach(async () => {
  await client.stopWithoutPersist();
  if (vi.isFakeTimers()) {
    await vi.runOnlyPendingTimersAsync();
  }
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

export function runJoinedRoomTests() {
  beforeEach(async () => {
    await client.sdk.initRustCrypto();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  it("recovers joined rooms from cached or fetched state while isolating ineligible and failed rooms", async () => {
    const missing = seedRoom("!missing:example.org");
    const cached = seedRoom("!cached:example.org", "join", true);
    const invited = seedRoom("!invited:example.org", "invite");
    const left = seedRoom("!left:example.org", "leave");
    const stale = seedRoom("!stale:example.org");
    const plain = seedRoom("!plain:example.org");
    const offline = seedRoom("!offline:example.org");
    const invalid = seedRoom("!invalid:example.org");
    joined = [plain, offline, invalid, missing, cached, invited, left].map((room) => room.roomId);
    fetchRoom = async (id) => {
      if (id === plain.roomId) {
        return Response.json({ errcode: "M_NOT_FOUND" }, { status: 404 });
      }
      if (id === offline.roomId) {
        return Response.json({ errcode: "M_FORBIDDEN" }, { status: 403 });
      }
      return Response.json(id === invalid.roomId ? { algorithm: "unsupported" } : encryption);
    };
    const crypto = client.sdk.getCrypto()!;
    expect(await crypto.isEncryptionEnabledInRoom(missing.roomId)).toBe(false);
    await reconcileJoinedRoomEncryption(client.sdk, abort.signal, () => undefined);
    for (const expected of [missing, cached]) {
      expect(await crypto.isEncryptionEnabledInRoom(expected.roomId)).toBe(true);
      expect(expected.hasEncryptionStateEvent()).toBe(true);
    }
    for (const excluded of [invited, left, stale, plain, offline, invalid]) {
      expect(await crypto.isEncryptionEnabledInRoom(excluded.roomId)).toBe(false);
    }
    expect(invalid.hasEncryptionStateEvent()).toBe(true);
  });

  it("bounds a large room set and aborts in-flight HTTP without scheduling the remaining rooms", async () => {
    joined = Array.from({ length: 80 }, (_, i) => `!room${i}:example.org`);
    joined.forEach((id) => seedRoom(id));
    const allStarted = createDeferred<void>();
    const signals: AbortSignal[] = [];
    fetchRoom = async (_id, signal) => {
      signals.push(signal);
      if (signals.length === 4) {
        allStarted.resolve();
      }
      await once(signal, "abort");
      throw signal.reason instanceof Error ? signal.reason : new Error("SDK request aborted");
    };
    const recovery = reconcileJoinedRoomEncryption(client.sdk, abort.signal, () => undefined);
    const rejected = expect(recovery).rejects.toThrow("cancel recovery");
    await allStarted.promise;
    await setImmediate();
    expect(signals).toHaveLength(4);
    abort.abort(new Error("cancel recovery"));
    await rejected;
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(signals).toHaveLength(4);
  });

  it.each(["abort", "authority", "membership"] as const)(
    "does not publish a late replay after %s changes, and joins every admitted replay",
    async (change) => {
      joined = ["!first:example.org", "!second:example.org"];
      const rooms = joined.map((id) => seedRoom(id));
      const replayStarted = createDeferred<void>();
      const finishReplay = createDeferred<void>();
      const backend = client.sdk.getCrypto();
      assert(backend instanceof RustCrypto, "Expected installed Rust crypto backend");
      const original = backend.onCryptoEvent.bind(backend);
      let replays = 0;
      vi.spyOn(RustCrypto.prototype, "onCryptoEvent").mockImplementation(async (room, event) => {
        if (++replays === 2) {
          replayStarted.resolve();
        }
        await finishReplay.promise;
        await original(room, event);
      });
      let current = true;
      const recovery = reconcileJoinedRoomEncryption(client.sdk, abort.signal, () => {
        assert(current, "stale authority");
      });
      const settled = vi.fn();
      const result = recovery.then(settled, settled);
      await replayStarted.promise;
      if (change === "abort") {
        abort.abort();
      } else if (change === "membership") {
        rooms.forEach((room) => room.updateMyMembership("leave"));
      } else {
        current = false;
      }
      await setImmediate();
      expect(settled).not.toHaveBeenCalled();
      finishReplay.resolve();
      await result;
      expect(rooms.every((room) => !room.hasEncryptionStateEvent())).toBe(true);
    },
  );
}

export const runDiscoveryRecoveryTests = () =>
  it.each(["503", "429", "connection", "401", "403", "abort", "malformed"])(
    "preserves encrypted startup safety after %s discovery",
    async (failure) => {
      const healthy = "!healthy:example.org";
      const missing = "!missing:example.org";
      vi.spyOn(client.sdk, "startClient").mockImplementation(async () => {
        const room = seedRoom(healthy);
        const event = encryptionEvent(healthy);
        const backend = client.sdk.getCrypto();
        assert(backend instanceof RustCrypto, "Expected the installed Rust crypto backend");
        await backend.onCryptoEvent(room, event);
        room.currentState.setStateEvents([event]);
        seedRoom(missing);
        client.sdk.emit(ClientEvent.Sync, SyncState.Prepared, null);
      });
      const errcode =
        failure === "401" ? "M_UNKNOWN_TOKEN" : failure === "403" ? "M_FORBIDDEN" : "M_UNKNOWN";
      discovery = async () => {
        if (failure === "abort") {
          abort.abort();
          throw new TypeError("connection closed during abort");
        }
        if (failure === "connection") {
          throw new TypeError("fetch failed");
        }
        return failure === "malformed"
          ? Response.json({ joined_rooms: [null] })
          : Response.json({ errcode }, { status: Number(failure) });
      };
      const startup = client.start({ abortSignal: abort.signal });
      if (failure === "401" || failure === "403") {
        await expect(startup).rejects.toMatchObject({ httpStatus: Number(failure), errcode });
      } else if (failure === "abort") {
        await expect(startup).rejects.toMatchObject({ name: "AbortError" });
      } else if (failure === "malformed") {
        await expect(startup).rejects.toThrow("invalid joined rooms");
      } else {
        await expect(startup).resolves.toBeUndefined();
        await expect(client.prepareRoomForMessageSend(healthy)).resolves.toBe("m.room.encrypted");
        vi.spyOn(client, "getRoomStateEvent").mockResolvedValue(encryption);
        await expect(
          client.sendMessage(missing, { msgtype: "m.text", body: "must not escape" }),
        ).rejects.toThrow("Encrypted Matrix room is not ready");
        expect(fetch.mock.calls.some(([input]) => requestUrl(input).includes("/send/"))).toBe(
          false,
        );
        const backend = client.sdk.getCrypto();
        assert(backend instanceof RustCrypto);
        await client.stopWithoutPersist();
        await expect(backend.getCrossSigningStatus()).rejects.toBeInstanceOf(ClientStoppedError);
      }
    },
  );
