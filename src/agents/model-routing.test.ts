import { describe, it, expect } from "vitest";
import {
  classifyTask,
  routeMessage,
  formatRoutingDecision,
  DEFAULT_ROUTING_CONFIG,
  type TaskType,
} from "./model-routing.js";

describe("model-routing", () => {
  describe("classifyTask", () => {
    it("should classify status check correctly", () => {
      const result = classifyTask("Check WhatsApp lead status");
      expect(result.taskType).toBe("status_check");
      expect(result.complexity).toBe("simple");
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it("should classify draft message correctly", () => {
      const result = classifyTask("Draft a follow-up message for the client");
      expect(result.taskType).toBe("draft_message");
      expect(result.complexity).toBe("medium");
    });

    it("should classify proposal creation correctly", () => {
      const result = classifyTask("Create a detailed proposal with timeline and pricing");
      expect(result.taskType).toBe("proposal_creation");
      expect(result.complexity).toBe("complex");
    });

    it("should classify file operations correctly", () => {
      const result = classifyTask("Read the README file");
      expect(result.taskType).toBe("file_operation");
      expect(result.complexity).toBe("simple");
    });

    it("should classify technical discussions correctly", () => {
      const result = classifyTask("Analyze the database architecture and suggest optimizations");
      expect(result.taskType).toMatch(/technical_discussion|analysis/);
      expect(result.complexity).toBe("complex");
    });

    it("should recommend local model for simple tasks", () => {
      const result = classifyTask("list all files");
      expect(result.recommendedModel).toContain("llama");
    });

    it("should recommend haiku for medium tasks", () => {
      const result = classifyTask("write a brief summary");
      expect(result.recommendedModel).toContain("haiku");
    });

    it("should recommend sonnet for complex tasks", () => {
      const result = classifyTask("create a comprehensive technical proposal");
      expect(result.recommendedModel).toContain("sonnet");
    });

    it("should handle technical terms", () => {
      const result = classifyTask("help me with API integration architecture");
      expect(result.recommendedModel).toContain("sonnet");
    });

    it("should handle short messages", () => {
      const result = classifyTask("status");
      expect(result.complexity).toBe("simple");
    });

    it("should provide reasoning", () => {
      const result = classifyTask("check status");
      expect(result.reasoning).toContain("status_check");
      expect(result.reasoning).toContain("confidence");
    });
  });

  describe("routeMessage", () => {
    it("should not override when routing disabled", () => {
      const config = { ...DEFAULT_ROUTING_CONFIG, enabled: false };
      const result = routeMessage({ message: "check status" }, config);
      expect(result.shouldOverride).toBe(false);
      expect(result.suggestedModel).toBeNull();
    });

    it("should override when routing enabled and confidence high", () => {
      const config = { ...DEFAULT_ROUTING_CONFIG, enabled: true };
      const result = routeMessage({ message: "check status" }, config);
      expect(result.shouldOverride).toBe(true);
      expect(result.suggestedModel).toBeTruthy();
    });

    it("should respect user override [use sonnet]", () => {
      const config = { ...DEFAULT_ROUTING_CONFIG, enabled: true };
      const result = routeMessage({ message: "check status [use sonnet]" }, config);
      expect(result.shouldOverride).toBe(true);
      expect(result.suggestedModel).toContain("sonnet");
    });

    it("should respect user override [use local]", () => {
      const config = { ...DEFAULT_ROUTING_CONFIG, enabled: true };
      const result = routeMessage({ message: "complex task [use local]" }, config);
      expect(result.shouldOverride).toBe(true);
      expect(result.suggestedModel).toContain("llama");
    });

    it("should respect user override [use haiku]", () => {
      const config = { ...DEFAULT_ROUTING_CONFIG, enabled: true };
      const result = routeMessage({ message: "any task [use haiku]" }, config);
      expect(result.shouldOverride).toBe(true);
      expect(result.suggestedModel).toContain("haiku");
    });

    it("should not override when confidence below threshold", () => {
      const config = {
        ...DEFAULT_ROUTING_CONFIG,
        enabled: true,
        override: { minConfidence: 0.99, fallback: "anthropic/claude-3-5-haiku" },
      };
      const result = routeMessage({ message: "ambiguous message" }, config);
      // Low confidence should not trigger override
      if (result.classification.confidence < 0.99) {
        expect(result.shouldOverride).toBe(false);
      }
    });
  });

  describe("formatRoutingDecision", () => {
    it("should show match when models align", () => {
      const classification = {
        taskType: "status_check" as TaskType,
        complexity: "simple" as const,
        confidence: 0.95,
        recommendedModel: "ollama/llama3.1:8b",
        reasoning: "test",
      };
      const result = formatRoutingDecision(classification, "ollama/llama3.1:8b", true);
      expect(result).toContain("✓");
      expect(result).toContain("==");
    });

    it("should show mismatch when models differ", () => {
      const classification = {
        taskType: "status_check" as TaskType,
        complexity: "simple" as const,
        confidence: 0.95,
        recommendedModel: "ollama/llama3.1:8b",
        reasoning: "test",
      };
      const result = formatRoutingDecision(classification, "anthropic/claude-sonnet-4-5", false);
      expect(result).toContain("→");
      expect(result).toContain("!=");
    });

    it("should include task type and confidence", () => {
      const classification = {
        taskType: "draft_message" as TaskType,
        complexity: "medium" as const,
        confidence: 0.87,
        recommendedModel: "anthropic/claude-3-5-haiku",
        reasoning: "test",
      };
      const result = formatRoutingDecision(classification, "anthropic/claude-3-5-haiku", true);
      expect(result).toContain("draft_message");
      expect(result).toContain("87%");
    });
  });
});
