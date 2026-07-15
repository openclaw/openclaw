// Tests for command-utils formatToolError UTF-16 safety.
import { describe, expect, it } from "vitest";
import { formatToolError } from "./command-utils.js";

describe("formatToolError", () => {
  it("truncates error detail without splitting surrogate pairs at the boundary", () => {
    // 299 ASCII chars + emoji (2 code units) = 301 code units; slice(0, 300)
    // would split the surrogate pair. truncateUtf16Safe backs off to 299.
    const detail = "e".repeat(299) + "😀";
    const result = formatToolError({
      code: 1,
      stdout: detail,
      stderr: "",
      termination: null,
    } as never);

    expect(result).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(result.length).toBeLessThanOrEqual(300);
    expect(result).toContain("eee");
    expect(result).not.toContain("😀");
  });

  it("preserves short error detail unchanged", () => {
    const result = formatToolError({
      code: 1,
      stdout: "something went wrong",
      stderr: "",
      termination: null,
    } as never);
    expect(result).toBe("something went wrong");
  });

  it("falls back to exit code when no output", () => {
    const result = formatToolError({
      code: 42,
      stdout: "",
      stderr: "   ",
      termination: null,
    } as never);
    expect(result).toBe("exit 42");
  });
});
