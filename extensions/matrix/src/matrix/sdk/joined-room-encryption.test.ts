import { setImmediate } from "node:timers/promises";
import {
  createClient,
  EventType,
  MatrixEvent,
  Room,
  type MatrixClient,
} from "matrix-js-sdk/lib/matrix.js";
import { RustCrypto } from "matrix-js-sdk/lib/rust-crypto/rust-crypto.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileJoinedRoomEncryption } from "./joined-room-encryption.js";

const userId = "@bot:example.org";
const encryption = { algorithm: "m.megolm.v1.aes-sha2" };

describe("joined-room recovery with the installed Matrix SDK", () => {
  let client: MatrixClient;
  let joined: string[];
  let fetchRoom: (roomId: string, signal: AbortSignal) => Promise<Response>;
  let fetched: string[];
  let abort: AbortController;

  function seedRoom(roomId: string, membership = "join", cached = false) {
    const result = new Room(roomId, client, userId);
    result.updateMyMembership(membership);
    if (cached) {
      result.currentState.setStateEvents([
        new MatrixEvent({
          room_id: roomId,
          type: EventType.RoomEncryption,
          state_key: "",
          content: encryption,
        }),
      ]);
    }
    client.store.storeRoom(result);
    return result;
  }

  beforeEach(async () => {
    joined = [];
    fetched = [];
    abort = new AbortController();
    fetchRoom = async () => Response.json(encryption);
    client = createClient({
      baseUrl: "https://example.org",
      userId,
      deviceId: "BOT",
      accessToken: "test-token",
      fetchFn: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname.endsWith("/room_keys/version")) {
          return Response.json({ errcode: "M_NOT_FOUND" }, { status: 404 });
        }
        if (url.pathname.endsWith("/joined_rooms")) {
          return Response.json({ joined_rooms: joined });
        }
        const match = url.pathname.match(/\/rooms\/([^/]+)\/state\/m.room.encryption\/?$/);
        if (match?.[1] && init?.signal) {
          const roomId = decodeURIComponent(match[1]);
          fetched.push(roomId);
          return await fetchRoom(roomId, init.signal);
        }
        throw new Error(`Unexpected SDK request: ${url.pathname}`);
      },
    });
    await client.initRustCrypto({ useIndexedDB: false });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(async () => {
    client.stopClient();
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("restores missing encryption while excluding invited, left, and no-longer-joined cached rooms", async () => {
    const missing = seedRoom("!missing:example.org");
    const cached = seedRoom("!cached:example.org", "join", true);
    const invited = seedRoom("!invited:example.org", "invite");
    const left = seedRoom("!left:example.org", "leave");
    const stale = seedRoom("!stale:example.org");
    joined = [missing.roomId, cached.roomId, invited.roomId, left.roomId];
    const crypto = client.getCrypto()!;
    expect(await crypto.isEncryptionEnabledInRoom(missing.roomId)).toBe(false);
    await reconcileJoinedRoomEncryption(client, abort.signal, () => undefined);
    expect(fetched).toEqual([missing.roomId]);
    for (const expected of [missing, cached]) {
      expect(await crypto.isEncryptionEnabledInRoom(expected.roomId)).toBe(true);
      expect(expected.currentState.getStateEvents(EventType.RoomEncryption, "")).toBeInstanceOf(
        MatrixEvent,
      );
    }
    for (const excluded of [invited, left, stale]) {
      expect(await crypto.isEncryptionEnabledInRoom(excluded.roomId)).toBe(false);
    }
  });

  it("keeps failed and unsupported rooms unconfigured while recovering other rooms", async () => {
    joined = [
      "!plain:example.org",
      "!offline:example.org",
      "!invalid:example.org",
      "!valid:example.org",
    ];
    const rooms = joined.map((id) => seedRoom(id));
    fetchRoom = async (id) => {
      if (id === joined[0]) {
        return Response.json({ errcode: "M_NOT_FOUND" }, { status: 404 });
      }
      if (id === joined[1]) {
        return Response.json({ errcode: "M_FORBIDDEN" }, { status: 403 });
      }
      return Response.json(id === joined[2] ? { algorithm: "unsupported" } : encryption);
    };
    await reconcileJoinedRoomEncryption(client, abort.signal, () => undefined);
    expect(
      await Promise.all(joined.map((id) => client.getCrypto()!.isEncryptionEnabledInRoom(id))),
    ).toEqual([false, false, false, true]);
    expect(rooms[2]?.hasEncryptionStateEvent()).toBe(true);
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
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () =>
            reject(
              signal.reason instanceof Error ? signal.reason : new Error("SDK request aborted"),
            ),
          { once: true },
        );
      });
    };
    const recovery = reconcileJoinedRoomEncryption(client, abort.signal, () => undefined);
    const rejected = expect(recovery).rejects.toThrow("cancel recovery");
    await allStarted.promise;
    await setImmediate();
    expect(fetched).toHaveLength(4);
    abort.abort(new Error("cancel recovery"));
    await rejected;
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(fetched).toHaveLength(4);
  });

  it.each(["abort", "authority", "membership"] as const)(
    "does not publish a late replay after %s changes, and joins every admitted replay",
    async (change) => {
      joined = ["!first:example.org", "!second:example.org"];
      const rooms = joined.map((id) => seedRoom(id));
      const replayStarted = createDeferred<void>();
      const finishReplay = createDeferred<void>();
      const backend = client.getCrypto();
      if (!(backend instanceof RustCrypto)) {
        throw new Error("Expected installed Rust crypto backend");
      }
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
      const recovery = reconcileJoinedRoomEncryption(client, abort.signal, () => {
        if (!current) {
          throw new Error("stale authority");
        }
      });
      const settled = vi.fn();
      const result = recovery.then(settled, settled);
      await replayStarted.promise;
      if (change === "abort") {
        abort.abort();
      }
      if (change === "authority") {
        current = false;
      }
      if (change === "membership") {
        rooms.forEach((room) => room.updateMyMembership("leave"));
      }
      await setImmediate();
      expect(settled).not.toHaveBeenCalled();
      finishReplay.resolve();
      await result;
      expect(rooms.every((room) => !room.hasEncryptionStateEvent())).toBe(true);
    },
  );
});
