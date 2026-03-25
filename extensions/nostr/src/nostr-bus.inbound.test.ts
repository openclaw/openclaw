import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startNostrBus } from "./nostr-bus.js";
import { TEST_HEX_PRIVATE_KEY } from "./test-fixtures.js";

const BOT_PUBKEY = "b".repeat(64);

const mockState = vi.hoisted(() => ({
  handlers: null as {
    onevent: (event: Record<string, unknown>) => void | Promise<void>;
    oneose?: () => void;
    onclose?: (reason: string[]) => void;
  } | null,
  verifyEvent: vi.fn(() => true),
  decrypt: vi.fn(() => "plaintext"),
  publishProfile: vi.fn(async () => ({
    createdAt: 0,
    eventId: "profile-event",
    successes: [],
    failures: [],
  })),
}));

vi.mock("nostr-tools", () => {
  class MockSimplePool {
    subscribeMany(
      _relays: string[],
      _filters: unknown,
      handlers: {
        onevent: (event: Record<string, unknown>) => void | Promise<void>;
        oneose?: () => void;
        onclose?: (reason: string[]) => void;
      },
    ) {
      mockState.handlers = handlers;
      return {
        close: vi.fn(),
      };
    }

    publish = vi.fn(async () => {});
  }

  return {
    SimplePool: MockSimplePool,
    finalizeEvent: vi.fn((event: unknown) => event),
    getPublicKey: vi.fn(() => BOT_PUBKEY),
    verifyEvent: mockState.verifyEvent,
    nip19: {
      decode: vi.fn(),
      npubEncode: vi.fn((value: string) => `npub-${value}`),
    },
  };
});

vi.mock("nostr-tools/nip04", () => ({
  decrypt: mockState.decrypt,
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
  publishProfile: mockState.publishProfile,
}));

function createEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "event-1",
    kind: 4,
    pubkey: "a".repeat(64),
    content: "ciphertext",
    created_at: Math.floor(Date.now() / 1000),
    tags: [["p", BOT_PUBKEY]],
    ...overrides,
  };
}

async function emitEvent(event: Record<string, unknown>) {
  if (!mockState.handlers) {
    throw new Error("missing subscription handlers");
  }
  await mockState.handlers.onevent(event);
}

describe("startNostrBus inbound guards", () => {
  beforeEach(() => {
    mockState.handlers = null;
    mockState.verifyEvent.mockClear();
    mockState.verifyEvent.mockReturnValue(true);
    mockState.decrypt.mockClear();
    mockState.decrypt.mockReturnValue("plaintext");
  });

  afterEach(() => {
    mockState.handlers = null;
  });

  it("checks sender authorization before verify/decrypt", async () => {
    const onMessage = vi.fn(async () => {});
    const authorizeSender = vi.fn(async () => "block" as const);
    const bus = await startNostrBus({
      privateKey: TEST_HEX_PRIVATE_KEY,
      onMessage,
      authorizeSender,
      onMetric: () => {},
    });

    await emitEvent(createEvent());

    expect(authorizeSender).toHaveBeenCalledTimes(1);
    expect(mockState.verifyEvent).not.toHaveBeenCalled();
    expect(mockState.decrypt).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    expect(bus.getMetrics().eventsReceived).toBe(1);

    bus.close();
  });

  it("rate limits repeated events before decrypt", async () => {
    const onMessage = vi.fn(async () => {});
    const bus = await startNostrBus({
      privateKey: TEST_HEX_PRIVATE_KEY,
      onMessage,
      onMetric: () => {},
    });

    for (let i = 0; i < 21; i += 1) {
      await emitEvent(
        createEvent({
          id: `event-${i}`,
        }),
      );
    }

    const snapshot = bus.getMetrics();
    expect(snapshot.eventsRejected.rateLimited).toBe(1);
    expect(mockState.decrypt).toHaveBeenCalledTimes(20);
    expect(onMessage).toHaveBeenCalledTimes(20);

    bus.close();
  });

  it("rejects far-future events before crypto", async () => {
    const onMessage = vi.fn(async () => {});
    const bus = await startNostrBus({
      privateKey: TEST_HEX_PRIVATE_KEY,
      onMessage,
      onMetric: () => {},
    });

    await emitEvent(
      createEvent({
        created_at: Math.floor(Date.now() / 1000) + 600,
      }),
    );

    const snapshot = bus.getMetrics();
    expect(snapshot.eventsRejected.future).toBe(1);
    expect(mockState.verifyEvent).not.toHaveBeenCalled();
    expect(mockState.decrypt).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();

    bus.close();
  });

  it("rejects oversized ciphertext before verify/decrypt", async () => {
    const onMessage = vi.fn(async () => {});
    const bus = await startNostrBus({
      privateKey: TEST_HEX_PRIVATE_KEY,
      onMessage,
      onMetric: () => {},
    });

    await emitEvent(
      createEvent({
        content: "x".repeat(20_000),
      }),
    );

    const snapshot = bus.getMetrics();
    expect(snapshot.eventsRejected.oversizedCiphertext).toBe(1);
    expect(mockState.verifyEvent).not.toHaveBeenCalled();
    expect(mockState.decrypt).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();

    bus.close();
  });
});
