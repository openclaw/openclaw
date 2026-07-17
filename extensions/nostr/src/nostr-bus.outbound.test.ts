// Nostr tests cover outbound relay failover behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { startNostrBus } from "./nostr-bus.js";

const BAD_RELAY = "wss://bad-relay.example";
const GOOD_RELAY = "wss://good-relay.example";
const RECIPIENT_PUBKEY = "b".repeat(64);

const mocks = vi.hoisted(() => ({
  ensureRelay: vi.fn(),
  poolPublish: vi.fn(),
  relayPublish: vi.fn(),
  close: vi.fn(),
}));

vi.mock("nostr-tools", () => {
  class MockSimplePool {
    maxWaitForConnection = 3000;

    subscribeMany() {
      return { close: vi.fn() };
    }

    ensureRelay(relay: string, options?: { connectionTimeout?: number }) {
      return mocks.ensureRelay(relay, options);
    }

    publish(relays: string[]) {
      return mocks.poolPublish(relays);
    }

    close(relays: string[]) {
      mocks.close(relays);
    }
  }

  return {
    SimplePool: MockSimplePool,
    finalizeEvent: vi.fn((event: unknown) => event),
    getPublicKey: vi.fn(() => "a".repeat(64)),
    verifyEvent: vi.fn(() => true),
    nip19: {
      decode: vi.fn(),
      npubEncode: vi.fn(),
    },
  };
});

vi.mock("nostr-tools/nip04", () => ({
  decrypt: vi.fn(),
  encrypt: vi.fn(() => "ciphertext"),
}));

vi.mock("./nostr-state-store.js", () => ({
  readNostrBusState: vi.fn(async () => null),
  writeNostrBusState: vi.fn(async () => {}),
  computeSinceTimestamp: vi.fn(() => 0),
  readNostrProfileState: vi.fn(async () => null),
  writeNostrProfileState: vi.fn(async () => {}),
}));

vi.mock("./nostr-profile.js", () => ({
  publishProfile: vi.fn(),
}));

describe("Nostr outbound relay failover", () => {
  beforeEach(() => {
    mocks.ensureRelay.mockReset().mockImplementation(async (relay: string) => {
      if (relay === BAD_RELAY) {
        throw new Error("connection failed");
      }
      return { publish: mocks.relayPublish };
    });
    mocks.poolPublish
      .mockReset()
      .mockImplementation((relays: string[]) => [
        Promise.resolve(
          relays[0] === BAD_RELAY ? "connection failure: connection failed" : "saved",
        ),
      ]);
    mocks.relayPublish.mockReset().mockResolvedValue("saved");
    mocks.close.mockReset();
  });

  it("tries the next relay when the first relay cannot connect", async () => {
    const bus = await startNostrBus({
      privateKey: "1".repeat(64),
      relays: [BAD_RELAY, GOOD_RELAY],
      onMessage: vi.fn(async () => {}),
      onMetric: () => {},
    });

    await bus.sendDm(RECIPIENT_PUBKEY, "hello");

    expect(mocks.ensureRelay).toHaveBeenNthCalledWith(1, BAD_RELAY, {
      connectionTimeout: 3000,
    });
    expect(mocks.ensureRelay).toHaveBeenNthCalledWith(2, GOOD_RELAY, {
      connectionTimeout: 3000,
    });
    expect(mocks.relayPublish).toHaveBeenCalledTimes(1);

    bus.close();
  });

  it("preserves string connection failures when every relay fails", async () => {
    mocks.ensureRelay.mockRejectedValue("connection failed");
    const onError = vi.fn();
    const bus = await startNostrBus({
      privateKey: "1".repeat(64),
      relays: [BAD_RELAY],
      onMessage: vi.fn(async () => {}),
      onError,
      onMetric: () => {},
    });

    await expect(bus.sendDm(RECIPIENT_PUBKEY, "hello")).rejects.toThrow(
      "Failed to publish to any relay: connection failed",
    );
    expect(onError).toHaveBeenCalledWith(expect.any(Error), `publish to ${BAD_RELAY}`);

    bus.close();
  });
});
