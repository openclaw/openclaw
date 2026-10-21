import { describe, expect, it } from "vitest";
import { rememberManagerReplayKey } from "./replay-keys.js";

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
});
