import { describe, expect, test } from "vitest";
import { wrapHookSystemContext } from "./prompt-compaction-hook-helpers.js";

describe("wrapHookSystemContext", () => {
  test("wraps a non-empty segment with boundary markers", () => {
    const result = wrapHookSystemContext("## My Custom Rules\n\nFoo bar baz.");
    expect(result).toBe("---\n## My Custom Rules\n\nFoo bar baz.\n---");
  });

  test("returns undefined for undefined input", () => {
    expect(wrapHookSystemContext(undefined)).toBeUndefined();
  });

  test("returns undefined for an empty string", () => {
    expect(wrapHookSystemContext("")).toBeUndefined();
  });

  test("wraps a single-line segment", () => {
    const result = wrapHookSystemContext("Rule: always format output.");
    expect(result).toBe("---\nRule: always format output.\n---");
  });

  test("preserves leading and trailing whitespace within the segment", () => {
    const segment = "\n\n## Top\n\n\n";
    const result = wrapHookSystemContext(segment);
    expect(result).toBe("---\n\n\n## Top\n\n\n\n---");
  });
});
