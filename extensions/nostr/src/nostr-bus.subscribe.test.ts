import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const subscribeMany = vi.fn(() => ({ close: vi.fn() }));
  const publish = vi.fn(async () => undefined);
  const poolInstance = { subscribeMany, publish };
  const createSeenTracker = vi.fn(() => ({
    seed: vi.fn(),
    peek: vi.fn(() => false),
    add: vi.fn(),
    size: vi.fn(() => 0),
    stop: vi.fn(),
  }));
  const metrics = {
    emit: vi.fn(),
    getSnapshot: vi.fn(() => ({ counters: {} })),
  };
  return {
    subscribeMany,
    publish,
    poolInstance,
    createSeenTracker,
    metrics,
    readNostrBusState: vi.fn(async () => null),
    writeNostrBusState: vi.fn(async () => undefined),
    computeSinceTimestamp: vi.fn(() => 123),
    readNostrProfileState: vi.fn(async () => null),
    writeNostrProfileState: vi.fn(async () => undefined),
    publishProfile: vi.fn(),
  };
});

vi.mock("nostr-tools", () => ({
  SimplePool: class {
    constructor() {
      return mocks.poolInstance;
    }
  },
  finalizeEvent: vi.fn((event) => event),
  getPublicKey: vi.fn(() => "a".repeat(64)),
  verifyEvent: vi.fn(() => true),
  nip19: {
    decode: vi.fn(() => {
      throw new Error("not used");
    }),
  },
}));

vi.mock("nostr-tools/nip04", () => ({
  decrypt: vi.fn(),
  encrypt: vi.fn(),
}));

vi.mock("./metrics.js", () => ({
  createMetrics: vi.fn(() => mocks.metrics),
  createNoopMetrics: vi.fn(() => mocks.metrics),
}));

vi.mock("./seen-tracker.js", () => ({
  createSeenTracker: mocks.createSeenTracker,
}));

vi.mock("./nostr-state-store.js", () => ({
  readNostrBusState: mocks.readNostrBusState,
  writeNostrBusState: mocks.writeNostrBusState,
  computeSinceTimestamp: mocks.computeSinceTimestamp,
  readNostrProfileState: mocks.readNostrProfileState,
  writeNostrProfileState: mocks.writeNostrProfileState,
}));

vi.mock("./nostr-profile.js", () => ({
  publishProfile: mocks.publishProfile,
}));

import { startNostrBus } from "./nostr-bus.js";

describe("startNostrBus subscribe filters", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes a single filter object to subscribeMany", async () => {
    const bus = await startNostrBus({
      accountId: "default",
      privateKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      relays: ["wss://relay.example.com"],
      onMessage: async () => {},
    });

    expect(mocks.subscribeMany).toHaveBeenCalledTimes(1);
    expect(mocks.subscribeMany).toHaveBeenCalledWith(
      ["wss://relay.example.com"],
      expect.objectContaining({
        kinds: [4],
        "#p": ["a".repeat(64)],
        since: 3,
      }),
      expect.any(Object),
    );

    bus.close();
  });
});
