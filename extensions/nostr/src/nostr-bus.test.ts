import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPublicKeyFromPrivate,
  isValidPubkey,
  normalizePubkey,
  pubkeyToNpub,
  startNostrBus,
  validatePrivateKey,
} from "./nostr-bus.js";

const TEST_HEX_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_RELAY = "wss://relay.test.local";
const BOT_PUBLIC_KEY = "a".repeat(64);
const SENDER_PUBLIC_KEY = "b".repeat(64);

const mocks = vi.hoisted(() => {
  const subscriptions: Array<{
    relays: string[];
    filters: Record<string, unknown>;
    handlers: {
      onevent: (event: {
        kind: number;
        content: string;
        tags: string[][];
        pubkey: string;
        created_at: number;
        id: string;
        sig: string;
      }) => Promise<void>;
      oneose?: () => void;
      onclose?: (reason: string[]) => void;
    };
  }> = [];

  const publishMock = vi.fn(async () => undefined);
  const closeMock = vi.fn();
  const getConversationKeyMock = vi.fn(
    (_secret: Uint8Array, toPubkey: string): string => `shared-${toPubkey}`,
  );
  const encryptMock = vi.fn((text: string, key: string) => `nip44:${key}:${text}`);
  const decryptMock = vi.fn((content: string, key: string) => `{"ver":1,"message":"${content}"}`);

  class MockSimplePool {
    publish(relays: string[], event: unknown): Promise<void> {
      return publishMock(relays, event);
    }

    subscribeMany(
      relays: string[],
      filters: Record<string, unknown>,
      handlers: {
        onevent: (event: {
          kind: number;
          content: string;
          tags: string[][];
          pubkey: string;
          created_at: number;
          id: string;
          sig: string;
        }) => Promise<void>;
        oneose?: () => void;
        onclose?: (reason: string[]) => void;
      },
    ): { close: () => void } {
      subscriptions.push({ relays, filters, handlers });
      return { close: closeMock };
    }
  }

  return {
    subscriptions,
    publishMock,
    closeMock,
    getConversationKeyMock,
    encryptMock,
    decryptMock,
    MockSimplePool,
  };
});

vi.mock("nostr-tools", async () => {
  const actual = await vi.importActual<typeof import("nostr-tools")>("nostr-tools");
  return {
    ...actual,
    SimplePool: mocks.MockSimplePool,
    finalizeEvent: vi.fn(
      (event: { kind: number; content: string; tags: string[][]; created_at: number }) => ({
        id: `event-${event.created_at}`,
        pubkey: BOT_PUBLIC_KEY,
        sig: "sig",
        ...event,
      }),
    ),
    getPublicKey: vi.fn(() => BOT_PUBLIC_KEY),
    verifyEvent: vi.fn(() => true),
  };
});

vi.mock("nostr-tools/nip44", () => ({
  getConversationKey: mocks.getConversationKeyMock,
  encrypt: mocks.encryptMock,
  decrypt: mocks.decryptMock,
}));

vi.mock("./nostr-state-store.js", () => ({
  readNostrBusState: vi.fn(async () => null),
  writeNostrBusState: vi.fn(async () => undefined),
  computeSinceTimestamp: vi.fn(
    (_state: unknown, now: number = Math.floor(Date.now() / 1000)) => now,
  ),
  readNostrProfileState: vi.fn(async () => null),
  writeNostrProfileState: vi.fn(async () => undefined),
}));

describe("validatePrivateKey", () => {
  describe("hex format", () => {
    it("accepts valid 64-char hex key", () => {
      const result = validatePrivateKey(TEST_HEX_KEY);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(32);
    });

    it("accepts lowercase hex", () => {
      const result = validatePrivateKey(TEST_HEX_KEY.toLowerCase());
      expect(result).toBeInstanceOf(Uint8Array);
    });

    it("accepts uppercase hex", () => {
      const result = validatePrivateKey(TEST_HEX_KEY.toUpperCase());
      expect(result).toBeInstanceOf(Uint8Array);
    });

    it("accepts mixed case", () => {
      const mixed = "0123456789ABCdef0123456789abcDEF0123456789abcdef0123456789ABCDEF";
      const result = validatePrivateKey(mixed);
      expect(result).toBeInstanceOf(Uint8Array);
    });

    it("trims whitespace", () => {
      const result = validatePrivateKey(`  ${TEST_HEX_KEY}  `);
      expect(result).toBeInstanceOf(Uint8Array);
    });

    it("trims newlines", () => {
      const result = validatePrivateKey(`${TEST_HEX_KEY}\n`);
      expect(result).toBeInstanceOf(Uint8Array);
    });

    it("rejects 63-char hex (too short)", () => {
      expect(() => validatePrivateKey(TEST_HEX_KEY.slice(0, 63))).toThrow(
        "Private key must be 64 hex characters",
      );
    });

    it("rejects 65-char hex (too long)", () => {
      expect(() => validatePrivateKey(TEST_HEX_KEY + "0")).toThrow(
        "Private key must be 64 hex characters",
      );
    });

    it("rejects non-hex characters", () => {
      const invalid = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdeg";
      expect(() => validatePrivateKey(invalid)).toThrow("Private key must be 64 hex characters");
    });

    it("rejects empty string", () => {
      expect(() => validatePrivateKey("")).toThrow("Private key must be 64 hex characters");
    });

    it("rejects whitespace-only string", () => {
      expect(() => validatePrivateKey("   ")).toThrow("Private key must be 64 hex characters");
    });

    it("rejects key with 0x prefix", () => {
      expect(() => validatePrivateKey("0x" + TEST_HEX_KEY)).toThrow(
        "Private key must be 64 hex characters",
      );
    });
  });

  describe("nsec format", () => {
    it("rejects invalid nsec (wrong checksum)", () => {
      const badNsec = "nsec1invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalid";
      expect(() => validatePrivateKey(badNsec)).toThrow();
    });

    it("rejects npub (wrong type)", () => {
      const npub = "npub1qypqxpq9qtpqscx7peytzfwtdjmcv0mrz5rjpej8vjppfkqfqy8s5epk55";
      expect(() => validatePrivateKey(npub)).toThrow();
    });
  });
});

describe("isValidPubkey", () => {
  describe("hex format", () => {
    it("accepts valid 64-char hex pubkey", () => {
      expect(isValidPubkey(TEST_HEX_KEY)).toBe(true);
    });

    it("accepts uppercase hex", () => {
      expect(isValidPubkey(TEST_HEX_KEY.toUpperCase())).toBe(true);
    });

    it("rejects 63-char hex", () => {
      expect(isValidPubkey(TEST_HEX_KEY.slice(0, 63))).toBe(false);
    });

    it("rejects 65-char hex", () => {
      expect(isValidPubkey(`${TEST_HEX_KEY}0`)).toBe(false);
    });

    it("rejects non-hex characters", () => {
      expect(isValidPubkey(TEST_HEX_KEY.slice(0, 63) + "g")).toBe(false);
    });
  });

  describe("npub format", () => {
    it("rejects invalid npub", () => {
      expect(isValidPubkey("npub1invalid")).toBe(false);
    });

    it("rejects nsec (wrong type)", () => {
      const nsec = "nsec1qypqxpq9qtpqscx7peytzfwtdjmcv0mrz5rjpej8vjppfkqfqy8s5epk55";
      expect(isValidPubkey(nsec)).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("rejects empty string", () => {
      expect(isValidPubkey("")).toBe(false);
    });

    it("handles whitespace-padded input", () => {
      expect(isValidPubkey(`  ${TEST_HEX_KEY}  `)).toBe(true);
    });
  });
});

describe("normalizePubkey", () => {
  describe("hex format", () => {
    it("lowercases hex pubkey", () => {
      const upper = TEST_HEX_KEY.toUpperCase();
      const result = normalizePubkey(upper);
      expect(result).toBe(upper.toLowerCase());
    });

    it("trims whitespace", () => {
      expect(normalizePubkey(`  ${TEST_HEX_KEY}  `)).toBe(TEST_HEX_KEY);
    });

    it("rejects invalid hex", () => {
      expect(() => normalizePubkey("invalid")).toThrow("Pubkey must be 64 hex characters");
    });
  });
});

describe("getPublicKeyFromPrivate", () => {
  it("derives public key from hex private key", () => {
    const pubkey = getPublicKeyFromPrivate(TEST_HEX_KEY);
    expect(pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(pubkey.length).toBe(64);
  });

  it("derives consistent public key", () => {
    const pubkey1 = getPublicKeyFromPrivate(TEST_HEX_KEY);
    const pubkey2 = getPublicKeyFromPrivate(TEST_HEX_KEY);
    expect(pubkey1).toBe(pubkey2);
  });

  it("throws for invalid private key", () => {
    expect(() => getPublicKeyFromPrivate("invalid")).toThrow();
  });
});

describe("pubkeyToNpub", () => {
  it("converts hex pubkey to npub format", () => {
    const npub = pubkeyToNpub(TEST_HEX_KEY);
    expect(npub).toMatch(/^npub1[a-z0-9]+$/);
  });

  it("produces consistent output", () => {
    const npub1 = pubkeyToNpub(TEST_HEX_KEY);
    const npub2 = pubkeyToNpub(TEST_HEX_KEY);
    expect(npub1).toBe(npub2);
  });

  it("normalizes uppercase hex first", () => {
    const lower = TEST_HEX_KEY;
    const upper = lower.toUpperCase();
    expect(pubkeyToNpub(lower)).toBe(pubkeyToNpub(upper));
  });
});

describe("startNostrBus NIP-63 protocol flow", () => {
  beforeEach(() => {
    mocks.subscriptions.length = 0;
    vi.clearAllMocks();
  });

  it("subscribes to NIP-63-related event kinds", async () => {
    const onMessage = vi.fn();
    const bus = await startNostrBus({
      privateKey: TEST_HEX_KEY,
      relays: [TEST_RELAY],
      onMessage,
      onError: vi.fn(),
    });

    expect(mocks.subscriptions).toHaveLength(1);

    const { filters } = mocks.subscriptions[0];
    expect(filters.kinds).toEqual([25800, 25801, 25802, 25803, 25804, 25805, 25806, 31340]);
    expect(filters.kinds).not.toContain(4);
    expect(filters["#p"]).toEqual([BOT_PUBLIC_KEY]);
    expect(filters.since).toBeGreaterThan(0);

    bus.close();
  });

  it("processes NIP-63 prompts and replies with session/thread tags", async () => {
    const inbound = {
      kind: 25802,
      content: "cipher-input",
      pubkey: SENDER_PUBLIC_KEY,
      created_at: Math.floor(Date.now() / 1000) + 10,
      id: "inbound-evt-1",
      sig: "sig",
      tags: [
        ["p", BOT_PUBLIC_KEY],
        ["encryption", "nip44"],
        ["s", "session-alpha"],
        ["e", "prompt-parent"],
      ],
    };

    const onMessage = vi.fn(async (payload, reply) => {
      await reply("agent response", {
        sessionId: payload.sessionId,
        inReplyTo: payload.eventId,
      });
    });

    const bus = await startNostrBus({
      privateKey: TEST_HEX_KEY,
      relays: [TEST_RELAY],
      onMessage,
      onError: vi.fn(),
    });

    await mocks.subscriptions[0]!.handlers.onevent(inbound);

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0]?.[0]).toEqual({
      senderPubkey: SENDER_PUBLIC_KEY,
      text: "cipher-input",
      createdAt: inbound.created_at,
      eventId: inbound.id,
      kind: 25802,
      sessionId: "session-alpha",
      inReplyTo: "prompt-parent",
    });
    expect(mocks.publishMock).toHaveBeenCalledTimes(1);
    expect(mocks.publishMock).toHaveBeenCalledWith(
      [TEST_RELAY],
      expect.objectContaining({
        kind: 25803,
        content: expect.stringContaining(`\"text\":\"agent response\"`),
        tags: [
          ["p", SENDER_PUBLIC_KEY],
          ["encryption", "nip44"],
          ["s", "session-alpha"],
          ["e", "inbound-evt-1", "", "root"],
        ],
      }),
    );
    expect(mocks.getConversationKeyMock).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      SENDER_PUBLIC_KEY,
    );
    expect(mocks.decryptMock).toHaveBeenCalledWith(inbound.content, `shared-${SENDER_PUBLIC_KEY}`);

    bus.close();
  });

  it("supports implicit sessions when no s tag is present", async () => {
    const inbound = {
      kind: 25802,
      content: "cipher-input",
      pubkey: SENDER_PUBLIC_KEY,
      created_at: Math.floor(Date.now() / 1000) + 10,
      id: "inbound-evt-implicit",
      sig: "sig",
      tags: [
        ["p", BOT_PUBLIC_KEY],
        ["encryption", "nip44"],
      ],
    };

    const onMessage = vi.fn(async (_payload, reply) => {
      await reply("implicit response");
    });

    const bus = await startNostrBus({
      privateKey: TEST_HEX_KEY,
      relays: [TEST_RELAY],
      onMessage,
      onError: vi.fn(),
    });

    await mocks.subscriptions[0]!.handlers.onevent(inbound);

    expect(onMessage).toHaveBeenCalledTimes(1);
    const payload = onMessage.mock.calls[0]?.[0];
    expect(payload).toMatchObject({
      sessionId: undefined,
      inReplyTo: undefined,
    });
    expect(mocks.publishMock).toHaveBeenCalledTimes(1);
    expect(mocks.publishMock).toHaveBeenCalledWith(
      [TEST_RELAY],
      expect.objectContaining({
        kind: 25803,
        content: expect.stringContaining(`\"text\":\"implicit response\"`),
        tags: [
          ["p", SENDER_PUBLIC_KEY],
          ["encryption", "nip44"],
        ],
      }),
    );

    bus.close();
  });

  it("ignores malformed tags and still processes valid prompt content", async () => {
    const inbound = {
      kind: 25802,
      content: "cipher-input",
      pubkey: SENDER_PUBLIC_KEY,
      created_at: Math.floor(Date.now() / 1000) + 10,
      id: "inbound-evt-malformed-tags",
      sig: "sig",
      tags: [
        ["p", BOT_PUBLIC_KEY],
        ["encryption", "nip44"],
        ["s"],
        ["e"],
        ["s", ""],
        ["e", ""],
        ["s", "  "],
        ["e", " "],
        ["bad"],
      ],
    };

    const onMessage = vi.fn(async (payload) => {
      expect(payload.sessionId).toBeUndefined();
      expect(payload.inReplyTo).toBeUndefined();
    });

    const bus = await startNostrBus({
      privateKey: TEST_HEX_KEY,
      relays: [TEST_RELAY],
      onMessage,
      onError: vi.fn(),
    });

    await mocks.subscriptions[0]!.handlers.onevent(inbound);

    expect(onMessage).toHaveBeenCalledTimes(1);
    bus.close();
  });

  it("sendDm excludes session and thread tags when reply options are omitted", async () => {
    const bus = await startNostrBus({
      privateKey: TEST_HEX_KEY,
      relays: [TEST_RELAY],
      onMessage: vi.fn(),
      onError: vi.fn(),
    });

    await bus.sendDm("deadbeef", "hi");

    expect(mocks.publishMock).toHaveBeenCalledWith(
      [TEST_RELAY],
      expect.objectContaining({
        kind: 25803,
        content: expect.stringContaining(`\"text\":\"hi\"`),
        tags: [
          ["p", "deadbeef"],
          ["encryption", "nip44"],
        ],
      }),
    );

    bus.close();
  });

  it("sendDm includes thread tags when inReplyTo is provided", async () => {
    const bus = await startNostrBus({
      privateKey: TEST_HEX_KEY,
      relays: [TEST_RELAY],
      onMessage: vi.fn(),
      onError: vi.fn(),
    });

    await bus.sendDm("deadbeef", "hi", { sessionId: "session-xyz", inReplyTo: "prompt-123" });

    expect(mocks.publishMock).toHaveBeenCalledWith(
      [TEST_RELAY],
      expect.objectContaining({
        kind: 25803,
        content: expect.stringContaining(`\"text\":\"hi\"`),
        tags: [
          ["p", "deadbeef"],
          ["encryption", "nip44"],
          ["s", "session-xyz"],
          ["e", "prompt-123", "", "root"],
        ],
      }),
    );

    bus.close();
  });

  it("ignores non-prompt NIP-63 events", async () => {
    const inbound = {
      kind: 25803,
      content: "ignored-response",
      pubkey: SENDER_PUBLIC_KEY,
      created_at: Math.floor(Date.now() / 1000) + 10,
      id: "inbound-non-prompt",
      sig: "sig",
      tags: [
        ["p", BOT_PUBLIC_KEY],
        ["encryption", "nip44"],
      ],
    };

    const onMessage = vi.fn(async () => {
      // no-op
    });

    const bus = await startNostrBus({
      privateKey: TEST_HEX_KEY,
      relays: [TEST_RELAY],
      onMessage,
      onError: vi.fn(),
    });

    await mocks.subscriptions[0]!.handlers.onevent(inbound);

    expect(onMessage).not.toHaveBeenCalled();
    expect(mocks.publishMock).not.toHaveBeenCalled();

    bus.close();
  });

  it("rejects prompts missing required encryption tag", async () => {
    const inbound = {
      kind: 25802,
      content: "cipher-input",
      pubkey: SENDER_PUBLIC_KEY,
      created_at: Math.floor(Date.now() / 1000) + 10,
      id: "inbound-no-encryption",
      sig: "sig",
      tags: [["p", BOT_PUBLIC_KEY]],
    };

    const onMessage = vi.fn(async () => {
      // no-op
    });

    const bus = await startNostrBus({
      privateKey: TEST_HEX_KEY,
      relays: [TEST_RELAY],
      onMessage,
      onError: vi.fn(),
    });

    await mocks.subscriptions[0]!.handlers.onevent(inbound);

    expect(onMessage).not.toHaveBeenCalled();
    expect(mocks.publishMock).not.toHaveBeenCalled();

    bus.close();
  });

  it("rejects prompts with non-json payloads", async () => {
    const inbound = {
      kind: 25802,
      content: "not-json",
      pubkey: SENDER_PUBLIC_KEY,
      created_at: Math.floor(Date.now() / 1000) + 10,
      id: "inbound-non-json",
      sig: "sig",
      tags: [
        ["p", BOT_PUBLIC_KEY],
        ["encryption", "nip44"],
      ],
    };

    const onMessage = vi.fn(async () => {
      // no-op
    });

    const bus = await startNostrBus({
      privateKey: TEST_HEX_KEY,
      relays: [TEST_RELAY],
      onMessage,
      onError: vi.fn(),
    });

    mocks.decryptMock.mockReturnValueOnce("not-json");

    await mocks.subscriptions[0]!.handlers.onevent(inbound);

    expect(onMessage).not.toHaveBeenCalled();
    expect(mocks.publishMock).not.toHaveBeenCalled();

    bus.close();
  });

  it("rejects prompts missing required message field", async () => {
    const inbound = {
      kind: 25802,
      content: JSON.stringify({ ver: 1, notMessage: "x" }),
      pubkey: SENDER_PUBLIC_KEY,
      created_at: Math.floor(Date.now() / 1000) + 10,
      id: "inbound-missing-message",
      sig: "sig",
      tags: [
        ["p", BOT_PUBLIC_KEY],
        ["encryption", "nip44"],
      ],
    };

    const bus = await startNostrBus({
      privateKey: TEST_HEX_KEY,
      relays: [TEST_RELAY],
      onMessage: vi.fn(),
      onError: vi.fn(),
    });

    mocks.decryptMock.mockReturnValueOnce('{"ver":1,"notMessage":"x"}');

    await mocks.subscriptions[0]!.handlers.onevent(inbound);

    expect(mocks.publishMock).not.toHaveBeenCalled();
    bus.close();
  });

  it("rejects prompts with empty message text", async () => {
    const inbound = {
      kind: 25802,
      content: "cipher-input",
      pubkey: SENDER_PUBLIC_KEY,
      created_at: Math.floor(Date.now() / 1000) + 10,
      id: "inbound-empty-message",
      sig: "sig",
      tags: [
        ["p", BOT_PUBLIC_KEY],
        ["encryption", "nip44"],
      ],
    };

    const bus = await startNostrBus({
      privateKey: TEST_HEX_KEY,
      relays: [TEST_RELAY],
      onMessage: vi.fn(),
      onError: vi.fn(),
    });

    mocks.decryptMock.mockReturnValueOnce('{"ver":1,"message":"   "}');

    await mocks.subscriptions[0]!.handlers.onevent(inbound);

    expect(mocks.publishMock).not.toHaveBeenCalled();
    bus.close();
  });

  it("rejects unsupported prompt payload versions", async () => {
    const inbound = {
      kind: 25802,
      content: "cipher-input",
      pubkey: SENDER_PUBLIC_KEY,
      created_at: Math.floor(Date.now() / 1000) + 10,
      id: "inbound-unsupported-version",
      sig: "sig",
      tags: [
        ["p", BOT_PUBLIC_KEY],
        ["encryption", "nip44"],
      ],
    };

    const bus = await startNostrBus({
      privateKey: TEST_HEX_KEY,
      relays: [TEST_RELAY],
      onMessage: vi.fn(),
      onError: vi.fn(),
    });

    mocks.decryptMock.mockReturnValueOnce('{"ver":999,"message":"hello"}');

    await mocks.subscriptions[0]!.handlers.onevent(inbound);

    expect(mocks.publishMock).not.toHaveBeenCalled();
    bus.close();
  });
});
