import { verifyEvent, getPublicKey, SimplePool, type Event } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NostrProfile } from "./config-schema.js";
import { publishProfile } from "./nostr-profile.js";
import { createNostrRelayFixture, PREFIX_ACK_REASON } from "./nostr-relay.test-harness.js";
import { TEST_HEX_PRIVATE_KEY_BYTES } from "./test-fixtures.js";

const TEST_PUBKEY = getPublicKey(TEST_HEX_PRIVATE_KEY_BYTES);

async function publishTestProfile(profile: NostrProfile, lastPublishedAt?: number): Promise<Event> {
  let publishedEvent: Event | undefined;
  const pool = {
    publish: vi.fn((_relays: string[], event: Event) => {
      publishedEvent = event;
      return [Promise.resolve("saved")];
    }),
  } as unknown as SimplePool;

  await publishProfile(
    pool,
    TEST_HEX_PRIVATE_KEY_BYTES,
    ["wss://relay.example"],
    profile,
    lastPublishedAt,
  );

  if (!publishedEvent) {
    throw new Error("expected profile event to be published");
  }
  return publishedEvent;
}

describe("createProfileEvent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses current time when lastPublishedAt is in the past", async () => {
    const pastTimestamp = 1705320000 - 3600; // 1 hour in the past
    const profile: NostrProfile = { name: "pasttest" };

    const event = await publishTestProfile(profile, pastTimestamp);

    const expectedTimestamp = Math.floor(Date.now() / 1000);
    expect(event.created_at).toBe(expectedTimestamp);
  });
});

describe("publishProfile real relay outcomes", () => {
  let pool: SimplePool;
  let relays: Array<Awaited<ReturnType<typeof createNostrRelayFixture>>>;

  beforeEach(() => {
    pool = new SimplePool();
    relays = [];
  });

  afterEach(async () => {
    const poolResults = await Promise.allSettled([Promise.resolve().then(() => pool.destroy())]);
    const relayResults = await Promise.allSettled(relays.map((entry) => entry.close()));
    const failures = [...poolResults, ...relayResults].flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "Nostr profile cleanup failed");
    }
    for (const entry of relays) {
      expect(entry.endpoints()).toEqual({ listening: false, connections: 0, clients: 0 });
      expect(entry.errors).toEqual([]);
    }
  });

  async function relay(options: Parameters<typeof createNostrRelayFixture>[0]) {
    const result = await createNostrRelayFixture(options);
    relays.push(result);
    return result;
  }

  it("fans out before acknowledgements and classifies OK by its boolean, not its reason", async () => {
    const first = await relay({ reason: PREFIX_ACK_REASON, holdAcknowledgements: true });
    const second = await relay({
      accepted: false,
      reason: PREFIX_ACK_REASON,
      holdAcknowledgements: true,
    });
    const publishing = publishProfile(pool, TEST_HEX_PRIVATE_KEY_BYTES, [first.url, second.url], {
      name: "wire-profile",
    });
    try {
      await vi.waitFor(() => {
        expect(first.events).toHaveLength(1);
        expect(second.events).toHaveLength(1);
      });
      expect(first.acknowledgements).toEqual([]);
      expect(second.acknowledgements).toEqual([]);
      first.acknowledgeAll();
      second.acknowledgeAll();

      const result = await publishing;
      expect(first.events).toEqual(second.events);
      expect(first.events[0]).toMatchObject({ kind: 0, id: result.eventId, pubkey: TEST_PUBKEY });
      expect(verifyEvent(first.events[0]!)).toBe(true);
      expect(JSON.parse(first.events[0]!.content)).toEqual({ name: "wire-profile" });
      expect(first.acknowledgements).toEqual([["OK", result.eventId, true, PREFIX_ACK_REASON]]);
      expect(second.acknowledgements).toEqual([["OK", result.eventId, false, PREFIX_ACK_REASON]]);
      expect(result.successes).toEqual([first.url]);
      expect(result.failures).toEqual([{ relay: second.url, error: PREFIX_ACK_REASON }]);
    } finally {
      // Release both response gates and join this exact publish, including assertion failures.
      first.acknowledgeAll();
      second.acknowledgeAll();
      await publishing;
    }
  });

  it("reports actual relay connection failures instead of successful publishes", async () => {
    const failed = await relay({ rejectUpgrade: true });

    const result = await publishProfile(pool, TEST_HEX_PRIVATE_KEY_BYTES, [failed.url], {
      name: "wire-profile",
    });

    expect(failed.upgradeAttempts()).toBeGreaterThan(0);
    expect(failed.events).toEqual([]);
    expect(result.successes).toEqual([]);
    expect(result.failures).toEqual([
      { relay: failed.url, error: expect.stringContaining("connection failure:") },
    ]);
  });
});
