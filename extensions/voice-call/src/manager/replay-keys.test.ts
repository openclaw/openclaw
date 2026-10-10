import { describe, expect, it } from "vitest";
import {
  releaseRejectedProviderCall,
  rememberManagerReplayKey,
  reserveRejectedProviderCall,
} from "./replay-keys.js";

describe("voice-call manager replay keys", () => {
  it("evicts the oldest unique manager key without refreshing duplicates", () => {
    const keys = new Set(["a", ...Array.from({ length: 9_997 }, (_, index) => `key-${index}`)]);

    for (const key of ["b", "c", "a", "d"]) {
      rememberManagerReplayKey(keys, key);
    }

    expect(keys.size).toBe(10_000);
    expect(keys.has("a")).toBe(false);
    expect([...keys].slice(-3)).toEqual(["b", "c", "d"]);
  });

  it("does not let a stale failed rejection release a newer reservation", () => {
    const calls = new Map<string, symbol>();
    const firstReservation = reserveRejectedProviderCall(calls, "provider-a");
    expect(firstReservation).toBeDefined();
    for (let index = 0; index < 9_999; index += 1) {
      calls.set(`provider-${index}`, Symbol("retained-call"));
    }

    reserveRejectedProviderCall(calls, "provider-b");
    const newerReservation = reserveRejectedProviderCall(calls, "provider-a");
    expect(newerReservation).toBeDefined();

    releaseRejectedProviderCall(calls, "provider-a", firstReservation as symbol);

    expect(calls.get("provider-a")).toBe(newerReservation);
  });
});
