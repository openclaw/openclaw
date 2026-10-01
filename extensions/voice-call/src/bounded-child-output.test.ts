// Voice Call tests cover bounded child output plugin behavior.
import { describe, expect, it } from "vitest";
import { formatBoundedChildOutput } from "./bounded-child-output.js";

describe("bounded child output", () => {
  it("keeps a bounded tail and records truncation", () => {
    expect(formatBoundedChildOutput("short", 5)).toBe("short");
    expect(formatBoundedChildOutput("abcdefghij", 5)).toBe("[output truncated]\nfghij");
  });

  it("does not split a surrogate pair at the tail cap boundary", () => {
    // The five-code-unit tail starts on the emoji's low surrogate.
    const chunk = `${"p".repeat(10)}🤖kept`;
    expect(formatBoundedChildOutput(chunk, 5)).toBe("[output truncated]\nkept");
  });
});
