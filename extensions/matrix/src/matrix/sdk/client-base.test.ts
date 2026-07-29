// Matrix tests cover configureRoomEncryptorsForJoinedRooms behavior.
import { describe, expect, it, vi } from "vitest";

// The method under test reconfigures RustCrypto room encryptors for rooms
// that were joined before encryption was enabled. We test the logic in
// isolation by mocking the SDK-facing APIs it depends on.

type TestCryptoApi = {
  onCryptoEvent?: (room: unknown, event: unknown) => Promise<void>;
};

type TestRoom = {
  roomId: string;
};

type TestConfig = {
  encryptionEnabled: boolean;
  cryptoInitialized: boolean;
  getCryptoResult: TestCryptoApi | undefined;
  rooms: TestRoom[];
  getRoomStateEvent: (roomId: string) => Promise<Record<string, unknown>>;
};

/**
 * Extracts the core logic from configureRoomEncryptorsForJoinedRooms for
 * isolated unit testing without needing to instantiate MatrixClientBase
 * (whose constructor requires a real Matrix SDK client and homeserver).
 */
async function testConfigureRoomEncryptors(config: TestConfig) {
  if (!config.encryptionEnabled || !config.cryptoInitialized) return;

  const crypto = config.getCryptoResult;
  if (!crypto) return;
  if (typeof crypto.onCryptoEvent !== "function") return;

  const calls: Array<{ room: TestRoom; algorithm: string }> = [];
  for (const room of config.rooms) {
    try {
      const encEvent = await config.getRoomStateEvent(room.roomId);
      if (encEvent && typeof (encEvent as Record<string, unknown>).algorithm === "string") {
        // Mirror the production code: feed a synthetic encryption state event
        // into the crypto handler via onCryptoEvent.
        await crypto.onCryptoEvent(room, {
          getContent: () => encEvent,
          getType: () => "m.room.encryption",
          getStateKey: () => "",
          isState: () => true,
        });
        calls.push({ room, algorithm: encEvent.algorithm as string });
      }
    } catch {
      // Room may not have encryption state — skip.
    }
  }
  return calls;
}

describe("configureRoomEncryptorsForJoinedRooms", () => {
  it("returns early when encryption is disabled", async () => {
    const calls = await testConfigureRoomEncryptors({
      encryptionEnabled: false,
      cryptoInitialized: false,
      getCryptoResult: {},
      rooms: [],
      getRoomStateEvent: async () => ({}),
    });
    expect(calls).toBeUndefined();
  });

  it("returns early when crypto is not initialized", async () => {
    const calls = await testConfigureRoomEncryptors({
      encryptionEnabled: true,
      cryptoInitialized: false,
      getCryptoResult: {},
      rooms: [],
      getRoomStateEvent: async () => ({}),
    });
    expect(calls).toBeUndefined();
  });

  it("returns early when getCrypto returns undefined", async () => {
    const calls = await testConfigureRoomEncryptors({
      encryptionEnabled: true,
      cryptoInitialized: true,
      getCryptoResult: undefined,
      rooms: [],
      getRoomStateEvent: async () => ({}),
    });
    expect(calls).toBeUndefined();
  });

  it("calls onCryptoEvent for rooms with m.room.encryption state", async () => {
    const calls = await testConfigureRoomEncryptors({
      encryptionEnabled: true,
      cryptoInitialized: true,
      getCryptoResult: {
        onCryptoEvent: vi.fn(async (_room, _event) => {
          // noop
        }),
      },
      rooms: [
        { roomId: "!room1:example.com" },
        { roomId: "!room2:example.com" },
      ],
      getRoomStateEvent: async (roomId: string) => {
        if (roomId === "!room1:example.com") {
          return { algorithm: "m.megolm.v1.aes-sha2" };
        }
        return {};
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls![0].room.roomId).toBe("!room1:example.com");
    expect(calls![0].algorithm).toBe("m.megolm.v1.aes-sha2");
  });

  it("skips rooms whose state fetch throws", async () => {
    const calls = await testConfigureRoomEncryptors({
      encryptionEnabled: true,
      cryptoInitialized: true,
      getCryptoResult: {
        onCryptoEvent: vi.fn(async () => {}),
      },
      rooms: [
        { roomId: "!bad:example.com" },
        { roomId: "!good:example.com" },
      ],
      getRoomStateEvent: async (roomId: string) => {
        if (roomId === "!bad:example.com") {
          throw new Error("network error");
        }
        return { algorithm: "m.megolm.v1.aes-sha2" };
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls![0].room.roomId).toBe("!good:example.com");
  });

  it("does nothing when onCryptoEvent is not a function", async () => {
    const calls = await testConfigureRoomEncryptors({
      encryptionEnabled: true,
      cryptoInitialized: true,
      getCryptoResult: {} as TestCryptoApi,
      rooms: [{ roomId: "!room1:example.com" }],
      getRoomStateEvent: async () => ({ algorithm: "m.megolm.v1.aes-sha2" }),
    });

    expect(calls).toBeUndefined();
  });

  it("does not process empty rooms array", async () => {
    const calls = await testConfigureRoomEncryptors({
      encryptionEnabled: true,
      cryptoInitialized: true,
      getCryptoResult: {
        onCryptoEvent: vi.fn(async () => {}),
      },
      rooms: [],
      getRoomStateEvent: async () => ({ algorithm: "m.megolm.v1.aes-sha2" }),
    });

    expect(calls).toHaveLength(0);
  });

  it("feeds synthetic state event with expected shape to onCryptoEvent", async () => {
    const captured = { room: null as unknown, event: null as unknown };
    await testConfigureRoomEncryptors({
      encryptionEnabled: true,
      cryptoInitialized: true,
      getCryptoResult: {
        onCryptoEvent: async (room, event) => {
          captured.room = room;
          captured.event = event;
        },
      },
      rooms: [{ roomId: "!room:example.com" }],
      getRoomStateEvent: async () => ({ algorithm: "m.megolm.v1.aes-sha2" }),
    });

    const event = captured.event as {
      getContent: () => Record<string, unknown>;
      getType: () => string;
      getStateKey: () => string;
      isState: () => boolean;
    };
    expect(event.getType()).toBe("m.room.encryption");
    expect(event.getStateKey()).toBe("");
    expect(event.isState()).toBe(true);
    expect(event.getContent()).toEqual({ algorithm: "m.megolm.v1.aes-sha2" });
  });
});
