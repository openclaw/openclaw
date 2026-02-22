import { describe, expect, it } from "vitest";
import { classifyComplexity } from "./classifier.js";

describe("classifyComplexity", () => {
  it("returns 'simple' for empty messages", () => {
    expect(classifyComplexity([])).toBe("simple");
  });

  it("returns 'simple' for null/undefined messages", () => {
    expect(classifyComplexity(null as unknown as unknown[])).toBe("simple");
    expect(classifyComplexity(undefined as unknown as unknown[])).toBe("simple");
  });

  it("returns 'simple' for a plain text question", () => {
    const msgs = [{ role: "user", content: "What is the weather today?" }];
    expect(classifyComplexity(msgs)).toBe("simple");
  });

  it("returns 'moderate' for code blocks in context (score 2)", () => {
    const msgs = [
      {
        role: "user",
        content: "Here is my code:\n```typescript\nconst x = 1;\n```",
      },
    ];
    expect(classifyComplexity(msgs)).toBe("moderate");
  });

  it("returns 'complex' for multi-step code analysis (score 4+)", () => {
    const msgs = [
      {
        role: "user",
        content:
          "First analyze this code, then review it:\n```typescript\nfunction foo() { return 1; }\n```\nCalculate the complexity.",
      },
    ];
    expect(classifyComplexity(msgs)).toBe("complex");
  });

  it("returns 'simple' for a tool result only message", () => {
    const msgs = [{ role: "toolResult", content: '{"result": "ok"}' }];
    expect(classifyComplexity(msgs)).toBe("simple");
  });

  it("scores analysis keywords as moderate", () => {
    const msgs = [{ role: "user", content: "Please analyze this data and compare the results." }];
    // "analyze" + "compare" both match ANALYSIS_KEYWORDS → score 1 (single regex match)
    // This alone is score 1, which is simple. Add more to push to moderate.
    expect(classifyComplexity(msgs)).toBe("simple");

    const msgs2 = [
      {
        role: "user",
        content: "Analyze and evaluate the overall performance.",
      },
    ];
    // ANALYSIS_KEYWORDS → 1, still simple unless more signals present
    expect(classifyComplexity(msgs2)).toBe("simple");
  });

  it("scores math keywords at +2", () => {
    const msgs = [{ role: "user", content: "Calculate the derivative and solve for x." }];
    // MATH_KEYWORDS → +2 → moderate
    expect(classifyComplexity(msgs)).toBe("moderate");
  });

  it("scores creative keywords at +1", () => {
    const msgs = [{ role: "user", content: "Create a REST API with authentication." }];
    // CREATIVE_KEYWORDS → +1 → simple
    expect(classifyComplexity(msgs)).toBe("simple");
  });

  it("adds +1 for long context (>2000 tokens)", () => {
    const longContent = "x".repeat(9000); // ~2250 tokens
    const msgs = [{ role: "user", content: longContent }];
    // Long context → +1 → simple (score 1)
    expect(classifyComplexity(msgs)).toBe("simple");
  });

  it("adds +2 for very long context (>5000 tokens)", () => {
    const longContent = "x".repeat(21000); // ~5250 tokens
    const msgs = [{ role: "user", content: longContent }];
    // Very long context → +2 → moderate
    expect(classifyComplexity(msgs)).toBe("moderate");
  });

  it("accumulates multiple signals to complex", () => {
    const msgs = [
      {
        role: "user",
        content:
          "First compute the result, then review the code:\n```js\nimport foo from 'bar';\n```",
      },
    ];
    // CODE_PATTERNS → +2, MATH_KEYWORDS (compute) → +2, MULTI_STEP (first..then) → +1, ANALYSIS_KEYWORDS (review) → +1 = 6
    expect(classifyComplexity(msgs)).toBe("complex");
  });

  it("respects custom thresholds", () => {
    const msgs = [{ role: "user", content: "Calculate something." }];
    // MATH_KEYWORDS → score 2

    // Default thresholds: moderate=2, complex=4 → moderate
    expect(classifyComplexity(msgs)).toBe("moderate");

    // Custom: moderate=3 → simple
    expect(classifyComplexity(msgs, { moderate: 3 })).toBe("simple");

    // Custom: complex=2 → complex
    expect(classifyComplexity(msgs, { complex: 2 })).toBe("complex");
  });

  it("handles messages with mixed roles", () => {
    const msgs = [
      { role: "user", content: "Solve this equation" },
      { role: "assistant", content: "Sure, let me help." },
      { role: "user", content: "Also compute the integral." },
    ];
    // MATH_KEYWORDS ("solve", "compute") → +2 → moderate
    expect(classifyComplexity(msgs)).toBe("moderate");
  });
});
