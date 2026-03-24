import { describe, expect, it } from "vitest";
import { classifyPrompt } from "./classifier.js";

describe("classifyPrompt", () => {
  describe("SIMPLE tier", () => {
    it("classifies greetings as simple", () => {
      expect(classifyPrompt("hello").tier).toBe("simple");
      expect(classifyPrompt("hi").tier).toBe("simple");
    });

    it("classifies trivial questions as simple", () => {
      expect(classifyPrompt("What is TypeScript?").tier).toBe("simple");
      expect(classifyPrompt("Who is Alan Turing?").tier).toBe("simple");
    });

    it("classifies empty prompts as simple", () => {
      expect(classifyPrompt("").tier).toBe("simple");
      expect(classifyPrompt("   ").tier).toBe("simple");
    });

    it("classifies thank-you messages as simple", () => {
      expect(classifyPrompt("thanks").tier).toBe("simple");
      expect(classifyPrompt("thank you").tier).toBe("simple");
    });
  });

  describe("MEDIUM tier", () => {
    it("classifies moderate questions as medium", () => {
      const result = classifyPrompt(
        "How do I set up a React project with routing and state management?",
      );
      expect(["medium", "complex"]).toContain(result.tier);
    });

    it("classifies prompts with some technical terms as medium", () => {
      const result = classifyPrompt("Can you explain how a database index works?");
      expect(["medium", "complex"]).toContain(result.tier);
    });
  });

  describe("COMPLEX tier", () => {
    it("classifies implementation requests with multiple technical terms as complex", () => {
      const result = classifyPrompt(
        "Implement a distributed microservice architecture with kubernetes deployment, " +
          "database optimization, and infrastructure monitoring. " +
          "First set up the cluster, then configure the services, and finally deploy the monitoring stack.",
      );
      expect(["complex", "reasoning"]).toContain(result.tier);
    });

    it("classifies code-heavy prompts as complex or higher", () => {
      const result = classifyPrompt(
        "```typescript\nasync function fetchData() {\n  const result = await fetch(url);\n" +
          "  return result.json();\n}\n```\n" +
          "Refactor this to add error handling, retry logic, and implement caching",
      );
      expect(["complex", "reasoning"]).toContain(result.tier);
    });
  });

  describe("REASONING tier", () => {
    it("classifies reasoning-heavy prompts", () => {
      const result = classifyPrompt(
        "Prove that this algorithm runs in O(n log n) time, step by step. " +
          "Derive the recurrence relation and formally analyze the proof.",
      );
      expect(result.tier).toBe("reasoning");
    });

    it("forces reasoning tier when 2+ reasoning keywords match", () => {
      const result = classifyPrompt("Prove this theorem and derive the result logically");
      expect(result.tier).toBe("reasoning");
      expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    });
  });

  describe("confidence", () => {
    it("returns confidence between 0 and 1", () => {
      const result = classifyPrompt("Tell me about React");
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it("returns high confidence for clear-cut prompts", () => {
      // Very clearly simple
      expect(classifyPrompt("hello").confidence).toBeGreaterThan(0.6);
      // Very clearly reasoning
      expect(
        classifyPrompt("Prove the theorem step by step and derive formally").confidence,
      ).toBeGreaterThan(0.8);
    });
  });

  describe("scores", () => {
    it("includes all dimension scores", () => {
      const result = classifyPrompt("test prompt");
      expect(result.scores).toHaveProperty("reasoningMarkers");
      expect(result.scores).toHaveProperty("codePresence");
      expect(result.scores).toHaveProperty("multiStepPatterns");
      expect(result.scores).toHaveProperty("technicalTerms");
      expect(result.scores).toHaveProperty("tokenEstimate");
      expect(result.scores).toHaveProperty("simpleIndicators");
    });
  });
});
