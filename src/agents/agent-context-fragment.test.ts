import { describe, expect, it } from "vitest";
import type { ContextFragment } from "./agent-context-fragment.js";
import {
  isContextFragment,
  parseFragmentType,
  renderContextFragment,
  renderContextFragments,
  renderContextFragmentsSafe,
} from "./agent-context-fragment.js";
import type { ProviderSystemPromptContribution } from "./system-prompt-contribution.js";

// ---------------------------------------------------------------------------
// isContextFragment — validation
// ---------------------------------------------------------------------------

describe("isContextFragment", () => {
  it("accepts a minimal valid fragment", () => {
    expect(isContextFragment({ source: "test", type: "fact", content: "hello" })).toBe(true);
  });

  it("accepts all three valid types", () => {
    for (const type of ["fact", "inference", "preference"] as const) {
      expect(isContextFragment({ source: "s", type, content: "c" })).toBe(true);
    }
  });

  it("rejects unknown type string", () => {
    expect(isContextFragment({ source: "s", type: "opinion", content: "c" })).toBe(false);
  });

  it("rejects empty source", () => {
    expect(isContextFragment({ source: "", type: "fact", content: "c" })).toBe(false);
  });

  it("rejects non-string content", () => {
    expect(isContextFragment({ source: "s", type: "fact", content: 42 })).toBe(false);
  });

  it("rejects null", () => {
    expect(isContextFragment(null)).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isContextFragment(undefined)).toBe(false);
  });

  it("rejects a bare string", () => {
    expect(isContextFragment("fact")).toBe(false);
  });

  it("rejects missing fields", () => {
    expect(isContextFragment({ source: "s", type: "fact" })).toBe(false);
  });

  it("accepts extra unknown fields (structural check only)", () => {
    expect(
      isContextFragment({
        source: "s",
        type: "preference",
        content: "x",
        extra: true,
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseFragmentType
// ---------------------------------------------------------------------------

describe("parseFragmentType", () => {
  it("returns fact for 'fact'", () => {
    expect(parseFragmentType("fact")).toBe("fact");
  });

  it("returns inference for 'inference'", () => {
    expect(parseFragmentType("inference")).toBe("inference");
  });

  it("returns preference for 'preference'", () => {
    expect(parseFragmentType("preference")).toBe("preference");
  });

  it("returns undefined for unknown value", () => {
    expect(parseFragmentType("opinion")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parseFragmentType("")).toBeUndefined();
  });

  it("is case-sensitive", () => {
    expect(parseFragmentType("Fact")).toBeUndefined();
    expect(parseFragmentType("FACT")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// renderContextFragment — rendering
// ---------------------------------------------------------------------------

describe("renderContextFragment", () => {
  it("renders a fact with source annotation", () => {
    const f: ContextFragment = {
      source: "workspace-scan",
      type: "fact",
      content: "The repo uses pnpm workspaces.",
    };
    const out = renderContextFragment(f);
    expect(out).toBe("The repo uses pnpm workspaces. *(source: workspace-scan, type: fact)*");
  });

  it("renders inference type", () => {
    const f: ContextFragment = {
      source: "prior-session",
      type: "inference",
      content: "User prefers short responses.",
    };
    expect(renderContextFragment(f)).toContain("type: inference");
  });

  it("renders preference type", () => {
    const f: ContextFragment = {
      source: "user-profile",
      type: "preference",
      content: "Use British English.",
    };
    const out = renderContextFragment(f);
    expect(out).toContain("source: user-profile");
    expect(out).toContain("type: preference");
    expect(out.startsWith("Use British English.")).toBe(true);
  });

  it("trims leading/trailing whitespace from content", () => {
    const f: ContextFragment = {
      source: "s",
      type: "fact",
      content: "  trimmed  ",
    };
    expect(renderContextFragment(f).startsWith("trimmed")).toBe(true);
  });

  it("returns empty string for empty content", () => {
    const f: ContextFragment = { source: "s", type: "fact", content: "" };
    expect(renderContextFragment(f)).toBe("");
  });

  it("returns empty string for whitespace-only content", () => {
    const f: ContextFragment = { source: "s", type: "fact", content: "   " };
    expect(renderContextFragment(f)).toBe("");
  });

  it("does not modify multi-line content (no special handling)", () => {
    const f: ContextFragment = {
      source: "s",
      type: "fact",
      content: "line one\nline two",
    };
    const out = renderContextFragment(f);
    expect(out).toContain("line one\nline two");
    expect(out).toContain("*(source: s, type: fact)*");
  });
});

// ---------------------------------------------------------------------------
// renderContextFragments — batch rendering
// ---------------------------------------------------------------------------

describe("renderContextFragments", () => {
  it("returns empty string for empty array", () => {
    expect(renderContextFragments([])).toBe("");
  });

  it("renders a single fragment", () => {
    const f: ContextFragment = { source: "s", type: "fact", content: "hello" };
    const out = renderContextFragments([f]);
    expect(out).toBe("hello *(source: s, type: fact)*");
  });

  it("joins multiple fragments with newlines", () => {
    const fragments: ContextFragment[] = [
      { source: "a", type: "fact", content: "first" },
      { source: "b", type: "inference", content: "second" },
    ];
    const out = renderContextFragments(fragments);
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("first");
    expect(lines[1]).toContain("second");
  });

  it("silently omits empty-content fragments", () => {
    const fragments: ContextFragment[] = [
      { source: "a", type: "fact", content: "real" },
      { source: "b", type: "fact", content: "" },
    ];
    const out = renderContextFragments(fragments);
    expect(out).not.toContain("\n");
    expect(out).toContain("real");
  });

  it("returns empty string when all fragments have empty content", () => {
    const fragments: ContextFragment[] = [
      { source: "a", type: "fact", content: "" },
      { source: "b", type: "fact", content: "   " },
    ];
    expect(renderContextFragments(fragments)).toBe("");
  });

  it("preserves fragment order", () => {
    const fragments: ContextFragment[] = [
      { source: "first", type: "fact", content: "alpha" },
      { source: "second", type: "fact", content: "beta" },
      { source: "third", type: "fact", content: "gamma" },
    ];
    const out = renderContextFragments(fragments);
    const alphaPos = out.indexOf("alpha");
    const betaPos = out.indexOf("beta");
    const gammaPos = out.indexOf("gamma");
    expect(alphaPos).toBeLessThan(betaPos);
    expect(betaPos).toBeLessThan(gammaPos);
  });
});

// ---------------------------------------------------------------------------
// renderContextFragmentsSafe — optional wrapper
// ---------------------------------------------------------------------------

describe("renderContextFragmentsSafe", () => {
  it("returns undefined for undefined input", () => {
    expect(renderContextFragmentsSafe(undefined)).toBeUndefined();
  });

  it("returns undefined for empty array", () => {
    expect(renderContextFragmentsSafe([])).toBeUndefined();
  });

  it("returns undefined when all fragments render to empty", () => {
    expect(
      renderContextFragmentsSafe([{ source: "s", type: "fact", content: "" }]),
    ).toBeUndefined();
  });

  it("returns a string for non-empty fragments", () => {
    const out = renderContextFragmentsSafe([{ source: "s", type: "fact", content: "hello" }]);
    expect(typeof out).toBe("string");
    expect(out).toContain("hello");
  });
});

// ---------------------------------------------------------------------------
// Backwards compatibility — ProviderSystemPromptContribution
// ---------------------------------------------------------------------------

describe("ProviderSystemPromptContribution backwards compat", () => {
  it("compiles and validates without contextFragments (existing shape)", () => {
    const contrib: ProviderSystemPromptContribution = {
      stablePrefix: "Be concise.",
    };
    // existing field still present; contextFragments absent
    expect(contrib.contextFragments).toBeUndefined();
    expect(contrib.stablePrefix).toBe("Be concise.");
  });

  it("accepts contextFragments alongside existing fields", () => {
    const contrib: ProviderSystemPromptContribution = {
      stablePrefix: "Be concise.",
      contextFragments: [{ source: "plugin:lark-base", type: "fact", content: "User is admin." }],
    };
    expect(contrib.contextFragments).toHaveLength(1);
    expect(contrib.contextFragments?.[0]?.source).toBe("plugin:lark-base");
  });

  it("contextFragments field is optional — undefined by default", () => {
    const contrib: ProviderSystemPromptContribution = {};
    expect(contrib.contextFragments).toBeUndefined();
  });

  it("existing fields still present and typed correctly", () => {
    const contrib: ProviderSystemPromptContribution = {
      dynamicSuffix: "Dynamic text.",
      sectionOverrides: { interaction_style: "Custom style." },
    };
    expect(contrib.dynamicSuffix).toBe("Dynamic text.");
    expect(contrib.sectionOverrides?.interaction_style).toBe("Custom style.");
    expect(contrib.contextFragments).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// No-throw safety
// ---------------------------------------------------------------------------

describe("no-throw safety", () => {
  it("renderContextFragment never throws for valid input", () => {
    const valid: ContextFragment = {
      source: "x",
      type: "fact",
      content: "y",
    };
    expect(() => renderContextFragment(valid)).not.toThrow();
  });

  it("renderContextFragments never throws for empty array", () => {
    expect(() => renderContextFragments([])).not.toThrow();
  });

  it("renderContextFragmentsSafe never throws for undefined", () => {
    expect(() => renderContextFragmentsSafe(undefined)).not.toThrow();
  });

  it("isContextFragment never throws for null/undefined/primitives", () => {
    for (const v of [null, undefined, 0, "", false, [], {}]) {
      expect(() => isContextFragment(v)).not.toThrow();
    }
  });

  it("parseFragmentType never throws for any string", () => {
    for (const s of ["", "fact", "FACT", "unknown", "123"]) {
      expect(() => parseFragmentType(s)).not.toThrow();
    }
  });
});
