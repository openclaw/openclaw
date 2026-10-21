import { verifyEvent, getPublicKey, SimplePool } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishProfile } from "./nostr-profile.js";
import { createNostrRelayFixture, PREFIX_ACK_REASON } from "./nostr-relay.test-harness.js";
import { TEST_HEX_PRIVATE_KEY_BYTES } from "./test-fixtures.js";

const TEST_PUBKEY = getPublicKey(TEST_HEX_PRIVATE_KEY_BYTES);
const profile = { name: "wire-profile" };

describe("publishProfile", () => {
  let pool: SimplePool;
  let relays: Array<Awaited<ReturnType<typeof createNostrRelayFixture>>>;

  beforeEach(() => {
    pool = new SimplePool();
    relays = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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
  const publish = (urls: string[], lastPublishedAt?: number) =>
    publishProfile(pool, TEST_HEX_PRIVATE_KEY_BYTES, urls, profile, lastPublishedAt);

  it("uses current time when lastPublishedAt is in the past", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1705320000000);
    const publishSpy = vi.spyOn(pool, "publish").mockReturnValue([Promise.resolve("saved")]);
    await publish(["wss://relay.example"], 1705320000 - 3600);
    expect(publishSpy).toHaveBeenCalledWith(
      ["wss://relay.example"],
      expect.objectContaining({ created_at: 1705320000 }),
    );
  });

  it("fans out before acknowledgements and classifies OK by its boolean, not its reason", async () => {
    const first = await relay({ reason: PREFIX_ACK_REASON, holdAcknowledgements: true });
    const second = await relay({
      accepted: false,
      reason: PREFIX_ACK_REASON,
      holdAcknowledgements: true,
    });
    const publishing = publish([first.url, second.url]);
    try {
      await vi.waitFor(() => {
        expect([first.events.length, second.events.length]).toEqual([1, 1]);
      });
      expect([first.acknowledgements, second.acknowledgements]).toEqual([[], []]);
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

    const result = await publish([failed.url]);

    expect(failed.upgradeAttempts()).toBeGreaterThan(0);
    expect(failed.events).toEqual([]);
    expect(result.successes).toEqual([]);
    expect(result.failures).toEqual([
      { relay: failed.url, error: expect.stringContaining("connection failure:") },
    ]);
  });
});
