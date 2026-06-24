import { describe, expect, it } from "vitest";
import type { Model } from "../../llm/types.js";
import { findExactModelReferenceMatch, parseModelPattern } from "./model-resolver.js";

function makeModel(id: string, provider = "anthropic"): Model {
  return { id, name: id, provider } as Model;
}

describe("parseModelPattern", () => {
  describe("numeric version sorting", () => {
    const models: Model[] = [
      makeModel("claude-opus-4-9"),
      makeModel("claude-opus-4-10"),
      makeModel("claude-opus-4-11"),
      makeModel("claude-sonnet-4-20250514"),
    ];

    it("selects numerically newest version when alias matches multiple versioned ids", () => {
      const result = parseModelPattern("opus", models);
      expect(result.model?.id).toBe("claude-opus-4-11");
    });

    it("selects numerically newest for partial match across double-digit versions", () => {
      const result = parseModelPattern("claude-opus-4", models);
      expect(result.model?.id).toBe("claude-opus-4-11");
    });

    it("selects version 10 over version 9 (lexicographic trap)", () => {
      const subset: Model[] = [makeModel("claude-opus-4-9"), makeModel("claude-opus-4-10")];
      const result = parseModelPattern("opus", subset);
      expect(result.model?.id).toBe("claude-opus-4-10");
    });

    it("handles single-digit versions correctly (no regression)", () => {
      const singleDigit: Model[] = [makeModel("claude-opus-4-1"), makeModel("claude-opus-4-9")];
      const result = parseModelPattern("opus", singleDigit);
      expect(result.model?.id).toBe("claude-opus-4-9");
    });
  });

  describe("dated version sorting", () => {
    const models: Model[] = [
      makeModel("claude-sonnet-4-20250514"),
      makeModel("claude-sonnet-4-20250620"),
    ];

    it("selects latest dated version", () => {
      const result = parseModelPattern("sonnet", models);
      expect(result.model?.id).toBe("claude-sonnet-4-20250620");
    });
  });
});

describe("findExactModelReferenceMatch", () => {
  it("returns undefined for empty pattern", () => {
    expect(findExactModelReferenceMatch("", [makeModel("claude-opus-4-10")])).toBeUndefined();
  });

  it("matches exact id", () => {
    expect(
      findExactModelReferenceMatch("claude-opus-4-10", [makeModel("claude-opus-4-10")])?.id,
    ).toBe("claude-opus-4-10");
  });
});
