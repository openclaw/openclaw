// Microsoft Graph Mail Wake tests cover notification dedup behavior.
import { describe, expect, it } from "vitest";
import {
  createGraphWakeDedupe,
  GRAPH_WAKE_DEDUP_COMPLETED_TTL_MS,
  GRAPH_WAKE_DEDUP_MAX_COMPLETED_ENTRIES,
} from "./dedupe.js";

describe("createGraphWakeDedupe", () => {
  it("claims a key once as leader, then reports duplicates within the TTL", () => {
    const dedupe = createGraphWakeDedupe();
    const first = dedupe.claim("key-1");
    expect(first.kind).toBe("leader");
    if (first.kind !== "leader") {
      return;
    }
    first.complete({ wakeId: "wake-1" });

    const second = dedupe.claim("key-1");
    expect(second).toEqual({ kind: "duplicate", wakeId: "wake-1" });
  });

  it("shares the leader completion with concurrent followers", async () => {
    const dedupe = createGraphWakeDedupe();
    const leader = dedupe.claim("key-1");
    expect(leader.kind).toBe("leader");
    const follower = dedupe.claim("key-1");
    expect(follower.kind).toBe("shared");
    if (leader.kind !== "leader" || follower.kind !== "shared") {
      return;
    }
    leader.complete({ wakeId: "wake-1" });
    await expect(follower.completion).resolves.toEqual({ wakeId: "wake-1" });
  });

  it("records nothing on failure so the next delivery becomes the leader", async () => {
    const dedupe = createGraphWakeDedupe();
    const leader = dedupe.claim("key-1");
    if (leader.kind !== "leader") {
      throw new Error("expected leader");
    }
    leader.fail();

    const retry = dedupe.claim("key-1");
    expect(retry.kind).toBe("leader");
  });

  it("resolves shared followers to null when the leader fails", async () => {
    const dedupe = createGraphWakeDedupe();
    const leader = dedupe.claim("key-1");
    const follower = dedupe.claim("key-1");
    if (leader.kind !== "leader" || follower.kind !== "shared") {
      throw new Error("expected leader + shared");
    }
    leader.fail();
    await expect(follower.completion).resolves.toBeNull();
  });

  it("expires completed records after the TTL so repeated updates wake again", () => {
    let nowMs = 1_000_000;
    const dedupe = createGraphWakeDedupe({ now: () => nowMs });
    const leader = dedupe.claim("key-1");
    if (leader.kind !== "leader") {
      throw new Error("expected leader");
    }
    leader.complete({ wakeId: "wake-1" });
    expect(dedupe.claim("key-1").kind).toBe("duplicate");

    nowMs += GRAPH_WAKE_DEDUP_COMPLETED_TTL_MS + 1;
    const afterExpiry = dedupe.claim("key-1");
    expect(afterExpiry.kind).toBe("leader");
  });

  it("keeps exactly 1000 completed keys and evicts the oldest on the 1001st", () => {
    const dedupe = createGraphWakeDedupe();
    for (let index = 0; index < GRAPH_WAKE_DEDUP_MAX_COMPLETED_ENTRIES; index += 1) {
      const claim = dedupe.claim(`key-${String(index)}`);
      if (claim.kind !== "leader") {
        throw new Error("expected leader");
      }
      claim.complete({});
    }
    expect(dedupe.claim("key-0").kind).toBe("duplicate");
    expect(dedupe.claim(`key-${String(GRAPH_WAKE_DEDUP_MAX_COMPLETED_ENTRIES - 1)}`).kind).toBe(
      "duplicate",
    );

    const overflow = dedupe.claim(`key-${String(GRAPH_WAKE_DEDUP_MAX_COMPLETED_ENTRIES)}`);
    if (overflow.kind !== "leader") {
      throw new Error("expected overflow key to be a leader");
    }
    overflow.complete({});

    expect(dedupe.claim("key-0").kind).toBe("leader");
    expect(dedupe.claim("key-1").kind).toBe("duplicate");
    expect(dedupe.claim(`key-${String(GRAPH_WAKE_DEDUP_MAX_COMPLETED_ENTRIES)}`).kind).toBe(
      "duplicate",
    );
  });
});
