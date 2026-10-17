// Voice Call tests cover bounded child output plugin behavior.
import { describe, expect, it } from "vitest";
import { formatBoundedChildOutput } from "./bounded-child-output.js";

describe("bounded child output", () => {
  it("keeps a bounded tail and records truncation", () => {
    expect(formatBoundedChildOutput("short")).toBe("short");
    const tail = "a".repeat(16_384);
    expect(formatBoundedChildOutput(`discarded${tail}`)).toBe(`[output truncated]\n${tail}`);
  });

  it("does not split a surrogate pair at the tail cap boundary", () => {
    // The bounded tail starts on the emoji's low surrogate.
    const tail = "a".repeat(16_383);
    const chunk = `discarded🤖${tail}`;
    expect(formatBoundedChildOutput(chunk)).toBe(`[output truncated]\n${tail}`);
  });
});
