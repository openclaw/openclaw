import { describe, expect, it } from "vitest";
import { normalizeSessionKeyForComparison } from "./session-key-comparison.js";

describe("normalization-core/session-key-comparison", () => {
  it.each([
    [" Agent:OPS:Telegram:Direct:ABC ", "agent:ops:telegram:direct:abc"],
    [" \t\n", ""],
    [
      "Agent:Ops:Catalog:Fixture:Node%3ADevBox:Thread%3AA",
      "agent:ops:Catalog:Fixture:Node%3ADevBox:Thread%3AA",
    ],
    ["agent:ops:other:signal:group:AbC", "agent:ops:other:signal:group:abc"],
    ["agent:ops:signal:group:AbC:signal:group:DeF", "agent:ops:signal:group:AbC:signal:group:def"],
    [":Matrix:Channel:!Room:Org", ":matrix:channel:!Room:Org"],
    ["agent:ops: :Matrix:Channel:!Room:Org", "agent:ops: :matrix:channel:!Room:Org"],
    [
      "agent:ops:matrix:channel: !Room:Org :thread:$Event",
      "agent:ops:matrix:channel: !Room:Org :thread:$Event",
    ],
  ])("retains session comparison normalization for %s", (key, expected) => {
    expect(normalizeSessionKeyForComparison(key)).toBe(expected);
  });
});
