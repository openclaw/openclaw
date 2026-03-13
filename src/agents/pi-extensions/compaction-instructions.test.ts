import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPACTION_INSTRUCTIONS,
  resolveCompactionInstructions,
  composeSplitTurnInstructions,
} from "./compaction-instructions.js";

describe("DEFAULT_COMPACTION_INSTRUCTIONS", () => {
  it("is a non-empty string", () => {
    expect(typeof DEFAULT_COMPACTION_INSTRUCTIONS).toBe("string");
    expect(DEFAULT_COMPACTION_INSTRUCTIONS.trim().length).toBeGreaterThan(0);
  });

  it("contains language preservation directive", () => {
    expect(DEFAULT_COMPACTION_INSTRUCTIONS).toContain("primary language");
  });

  it("contains factual content directive", () => {
    expect(DEFAULT_COMPACTION_INSTRUCTIONS).toContain("factual content");
  });

  it("does not exceed MAX_INSTRUCTION_LENGTH (800 chars)", () => {
    expect(DEFAULT_COMPACTION_INSTRUCTIONS.length).toBeLessThanOrEqual(800);
  });
});

describe("resolveCompactionInstructions", () => {
  describe("null / undefined handling", () => {
    it("returns DEFAULT when both args are undefined", () => {
      expect(resolveCompactionInstructions(undefined, undefined)).toBe(
        DEFAULT_COMPACTION_INSTRUCTIONS,
      );
    });

    it("returns DEFAULT when both args are explicitly null (untyped JS caller)", () => {
      expect(
        resolveCompactionInstructions(null as unknown as undefined, null as unknown as undefined),
      ).toBe(DEFAULT_COMPACTION_INSTRUCTIONS);
    });
  });

  describe("empty and whitespace normalization", () => {
    it("treats empty-string event as absent -- runtime wins", () => {
      const result = resolveCompactionInstructions("", "runtime value");
      expect(result).toBe("runtime value");
    });

    it("treats whitespace-only event as absent -- runtime wins", () => {
      const result = resolveCompactionInstructions("   ", "runtime value");
      expect(result).toBe("runtime value");
    });

    it("treats tab/newline-only event as absent -- runtime wins", () => {
      const result = resolveCompactionInstructions("\t\n\r", "runtime value");
      expect(result).toBe("runtime value");
    });

    it("treats empty-string runtime as absent -- DEFAULT wins", () => {
      const result = resolveCompactionInstructions(undefined, "");
      expect(result).toBe(DEFAULT_COMPACTION_INSTRUCTIONS);
    });

    it("treats whitespace-only runtime as absent -- DEFAULT wins", () => {
      const result = resolveCompactionInstructions(undefined, "   \n  ");
      expect(result).toBe(DEFAULT_COMPACTION_INSTRUCTIONS);
    });

    it("falls through both empty to DEFAULT", () => {
      const result = resolveCompactionInstructions("", "");
      expect(result).toBe(DEFAULT_COMPACTION_INSTRUCTIONS);
    });
  });

  describe("precedence", () => {
    it("event takes priority over runtime", () => {
      const result = resolveCompactionInstructions("event text", "runtime text");
      expect(result).toBe("event text");
    });

    it("runtime wins when event is undefined", () => {
      const result = resolveCompactionInstructions(undefined, "runtime text");
      expect(result).toBe("runtime text");
    });
  });

  describe("truncation", () => {
    it("truncates to 800 code-points", () => {
      const long = "x".repeat(1000);
      const result = resolveCompactionInstructions(long, undefined);
      expect(Array.from(result).length).toBe(800);
    });

    it("handles multi-byte unicode without splitting surrogates", () => {
      const emoji = "🎉".repeat(1000); // 1000 code points, 2000 UTF-16 code units
      const result = resolveCompactionInstructions(emoji, undefined);
      expect(Array.from(result).length).toBe(800);
      // Every char should be a valid emoji, no broken surrogates
      for (const c of result) {
        expect(c).toBe("🎉");
      }
    });
  });
});

describe("composeSplitTurnInstructions", () => {
  it("joins prefix + additional requirements + resolved instructions", () => {
    const result = composeSplitTurnInstructions("Turn prefix here", "Keep language consistent");
    expect(result).toBe("Turn prefix here\n\nAdditional requirements:\n\nKeep language consistent");
  });
});
