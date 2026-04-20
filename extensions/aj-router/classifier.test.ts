import { describe, expect, it } from "vitest";
import { classifyHeuristic } from "./classifier.js";

describe("aj-router classifier", () => {
  it("classifies short 'classify' prompts as simple with high confidence", () => {
    const result = classifyHeuristic({
      prompt: "Classify this email as sales, support, or spam.",
    });
    expect(result.tier).toBe("simple");
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("classifies explicit architecture requests as complex", () => {
    const result = classifyHeuristic({
      prompt: "Design a system architecture for multi-region failover.",
    });
    expect(result.tier).toBe("complex");
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("classifies legal/privileged keywords as complex", () => {
    const result = classifyHeuristic({
      prompt: "Review this attorney-client communication for privilege.",
    });
    expect(result.tier).toBe("complex");
  });

  it("returns medium for generic mid-length prompts without signal", () => {
    // Must exceed SHORT_PROMPT_CHARS (200) to avoid the short-prompt fallback
    // that classifies unknown shapes as 'simple' with low confidence.
    const prompt =
      "Write the follow-up message for tomorrow's meeting. It should cover the pricing agreement, delivery terms, and call out the three open action items from last week. Keep it polite but direct so the counterparty can tell what is blocking and what still needs their input. Include timestamps where useful.";
    const result = classifyHeuristic({ prompt });
    expect(result.tier).toBe("medium");
  });

  it("returns complex for very long prompts even without keywords", () => {
    const result = classifyHeuristic({
      prompt: "x".repeat(5000),
    });
    expect(result.tier).toBe("complex");
  });

  it("returns simple with low confidence for unclear short prompts", () => {
    const result = classifyHeuristic({ prompt: "what?" });
    expect(result.tier).toBe("simple");
    expect(result.confidence).toBeLessThan(0.85);
  });
});
