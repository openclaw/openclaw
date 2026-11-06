import type { Event, SimplePool } from "nostr-tools";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { importProfileFromRelays, mergeProfiles } from "./nostr-profile-import.js";

type ProfileSubscriptionParams = Parameters<SimplePool["subscribeMany"]>[2];
const pubkey = "a".repeat(64);
const relay = "wss://relay.example";
const imported = { name: "imported", displayName: "Imported User", about: "Bio from relay" };

const mockState = vi.hoisted(() => ({
  close: vi.fn(),
  closeSubscription: vi.fn(),
  subscribeMany:
    vi.fn<(relays: string[], filter: unknown, params: ProfileSubscriptionParams) => void>(),
}));

vi.mock("nostr-tools", () => ({
  SimplePool: class {
    subscribeMany(relays: string[], filter: unknown, params: ProfileSubscriptionParams) {
      mockState.subscribeMany(relays, filter, params);
      return { close: mockState.closeSubscription };
    }

    close = mockState.close;
  },
}));

function createProfileEvent(content: unknown, id = "1", created_at = 1): Event {
  return {
    id: id.repeat(64),
    pubkey,
    created_at,
    kind: 0,
    tags: [],
    content: JSON.stringify(content),
    sig: "b".repeat(128),
  };
}

function respondWithEvents(...events: Event[]): void {
  mockState.subscribeMany.mockImplementation((_relays, _filter, params) => {
    params.onevent?.(events.shift()!);
    params.oneose?.();
  });
}

const importProfile = (relays = [relay]) => importProfileFromRelays({ pubkey, relays });

describe("nostr-profile-import", () => {
  beforeEach(() => vi.resetAllMocks());

  it("uses the lowest event id when profile timestamps match", async () => {
    const relays = ["wss://first.example", "wss://second.example"];
    respondWithEvents(
      createProfileEvent({ name: "arrived-first" }, "f", 20),
      createProfileEvent({ name: "canonical" }, "0", 20),
    );
    await expect(importProfile(relays)).resolves.toMatchObject({
      ok: true,
      profile: { name: "canonical" },
      event: { id: "0".repeat(64), created_at: 20 },
      sourceRelay: relays[1],
    });
  });

  it("bounds the whole query while the native relay subscription is pending", async () => {
    vi.useFakeTimers();
    try {
      const resultPromise = importProfile(["wss://slow.example"]);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(resultPromise).resolves.toMatchObject({
        ok: false,
        error: "No profile found on any relay",
      });
      expect(mockState.closeSubscription).toHaveBeenCalledOnce();
      expect(mockState.close).toHaveBeenCalledWith(["wss://slow.example"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [null, "Profile event content must be a JSON object"],
    [
      { name: "valid", about: 123, picture: "https://127.0.0.1/avatar.png" },
      "Profile event content has invalid fields",
    ],
  ])("rejects invalid profile content: %j", async (content, error) => {
    respondWithEvents(createProfileEvent(content));
    await expect(importProfile()).resolves.toMatchObject({ ok: false, error, sourceRelay: relay });
  });

  it("drops unknown fields and unsafe URLs from an otherwise valid profile", async () => {
    respondWithEvents(
      createProfileEvent({
        name: "valid",
        picture: "https://127.0.0.1/avatar.png",
        website: "https://example.com",
        custom: "ignored",
      }),
    );
    const result = await importProfile();
    expect(result).toMatchObject({ ok: true, sourceRelay: relay });
    expect(result.profile).toStrictEqual({ name: "valid", website: "https://example.com" });
  });
  it.each([
    [undefined, undefined, {}],
    [undefined, imported, imported],
  ])("mergeProfiles fills missing local fields: %j, %j", (local, remote, expected) => {
    expect(mergeProfiles(local, remote)).toStrictEqual(expected);
  });
  it("mergeProfiles fills undefined local fields from the imported profile", () => {
    expect(mergeProfiles({ name: undefined, displayName: undefined }, imported)).toMatchObject(
      imported,
    );
  });
});
