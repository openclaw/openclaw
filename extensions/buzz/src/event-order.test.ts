import { describe, expect, it } from "vitest";
import { isNewerBuzzRevision } from "./event-order.js";

describe("isNewerBuzzRevision", () => {
  it.each([
    {
      name: "older timestamp",
      candidate: { createdAt: 9, eventId: "a" },
      current: { createdAt: 10, eventId: "b" },
      expected: false,
    },
    {
      name: "identical revision",
      candidate: { createdAt: 10, eventId: "a" },
      current: { createdAt: 10, eventId: "a" },
      expected: false,
    },
  ])("$name", ({ candidate, current, expected }) => {
    expect(isNewerBuzzRevision(candidate, current)).toBe(expected);
  });
});
