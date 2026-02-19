/**
 * Dynamic Reasoning 单元测试
 */

import { describe, it, expect } from "vitest";
import {
  DynamicReasoningEngine,
  createDynamicReasoningTool,
  type ReasoningLevel,
  type TaskDifficulty,
} from "./dynamic-reasoning.js";

describe("Dynamic Reasoning", () => {
  describe("DynamicReasoningEngine class", () => {
    it("should create instance with default config", () => {
      const engine = new DynamicReasoningEngine();
      expect(engine).toBeDefined();
    });

    it("should create instance with custom config", () => {
      const engine = new DynamicReasoningEngine({
        fastThreshold: 0.2,
        balancedThreshold: 0.5,
        enableModelSelection: true,
      });
      expect(engine).toBeDefined();
    });

    it("should assess simple task as fast", async () => {
      const engine = new DynamicReasoningEngine();

      const difficulty = await engine.assessTaskDifficulty("Hello");

      expect(difficulty.level).toBe("fast");
      expect(difficulty.score).toBeGreaterThanOrEqual(0);
      expect(difficulty.score).toBeLessThan(0.3);
      expect(difficulty.factors).toBeDefined();
    });

    it("should assess complex task as deep or balanced", async () => {
      const engine = new DynamicReasoningEngine();

      const complexTask = `
        Design and implement a complete e-commerce platform with:
        1. User authentication with OAuth2
        2. Product catalog with search
        3. Shopping cart and checkout
        4. Payment integration
        5. Order management
        6. Admin dashboard
        
        Requirements:
        - Use microservices architecture
        - Deploy on Kubernetes
        - Implement CI/CD pipeline
        - Ensure GDPR compliance
      `;

      const difficulty = await engine.assessTaskDifficulty(complexTask);

      // Complex task should be balanced or deep
      expect(["balanced", "deep"]).toContain(difficulty.level);
      expect(difficulty.score).toBeGreaterThanOrEqual(0.3);
    });

    it("should assess medium task as fast or balanced", async () => {
      const engine = new DynamicReasoningEngine();

      const mediumTask = `
        Write a Python function to sort a list of dictionaries
        by a specific key, with error handling for missing keys.
      `;

      const difficulty = await engine.assessTaskDifficulty(mediumTask);

      // Medium task could be fast or balanced
      expect(["fast", "balanced"]).toContain(difficulty.level);
      expect(difficulty.score).toBeGreaterThanOrEqual(0);
      expect(difficulty.score).toBeLessThan(0.6);
    });

    it("should analyze complexity factor", async () => {
      const engine = new DynamicReasoningEngine();
      const analyzeComplexity = (engine as any).analyzeComplexity.bind(engine);

      const short = "Hi";
      const long = "This is a very long and complex task with multiple requirements and detailed specifications...";

      const shortComplexity = await analyzeComplexity(short);
      const longComplexity = await analyzeComplexity(long);

      expect(shortComplexity.name).toBe("complexity");
      expect(longComplexity.score).toBeGreaterThan(shortComplexity.score);
    });

    it("should detect ambiguity", async () => {
      const engine = new DynamicReasoningEngine();
      const detectAmbiguity = (engine as any).detectAmbiguity.bind(engine);

      const clear = "Write a function to add two numbers";
      const ambiguous = "Maybe create something better, perhaps optimal?";

      const clearAmbiguity = await detectAmbiguity(clear);
      const ambiguousAmbiguity = await detectAmbiguity(ambiguous);

      expect(ambiguousAmbiguity.score).toBeGreaterThan(clearAmbiguity.score);
    });

    it("should estimate domain knowledge", async () => {
      const engine = new DynamicReasoningEngine();
      const estimateDomainKnowledge = (engine as any).estimateDomainKnowledge.bind(engine);

      const simple = "Write a hello world program";
      const technical = "Implement a Kubernetes operator for custom resource management";

      const simpleDomain = await estimateDomainKnowledge(simple);
      const technicalDomain = await estimateDomainKnowledge(technical);

      expect(technicalDomain.score).toBeGreaterThan(simpleDomain.score);
    });

    it("should estimate steps", async () => {
      const engine = new DynamicReasoningEngine();
      const estimateSteps = (engine as any).estimateSteps.bind(engine);

      const single = "Write a function";
      const multi = "First create a database, then add API endpoints, then deploy";

      const singleSteps = await estimateSteps(single);
      const multiSteps = await estimateSteps(multi);

      expect(multiSteps.score).toBeGreaterThan(singleSteps.score);
    });

    it("should execute adaptive reasoning with fast path", async () => {
      const engine = new DynamicReasoningEngine();

      let fastCalled = false;
      let balancedCalled = false;
      let deepCalled = false;

      const result = await engine.executeWithAdaptiveReasoning(
        "Simple",
        async () => { fastCalled = true; return "fast"; },
        async () => { balancedCalled = true; return "balanced"; },
        async () => { deepCalled = true; return "deep"; },
      );

      expect(fastCalled).toBe(true);
      expect(balancedCalled).toBe(false);
      expect(deepCalled).toBe(false);
      expect(result.result).toBe("fast");
      expect(result.level).toBe("fast");
    });

    it("should select appropriate model", async () => {
      const engine = new DynamicReasoningEngine({ enableModelSelection: true });
      const selectModel = (engine as any).selectModel.bind(engine);

      expect(selectModel("fast")).toBe("fast-model");
      expect(selectModel("balanced")).toBe("balanced-model");
      expect(selectModel("deep")).toBe("deep-model");
    });

    it("should estimate tokens", async () => {
      const engine = new DynamicReasoningEngine();
      const estimateTokens = (engine as any).estimateTokens.bind(engine);

      const shortTokens = await estimateTokens(0.1, 50);
      const longTokens = await estimateTokens(0.8, 500);

      expect(longTokens).toBeGreaterThan(shortTokens);
    });

    it("should optimize compute budget", async () => {
      const engine = new DynamicReasoningEngine();

      const result = await engine.optimizeComputeBudget(
        "Simple task",
        {
          maxTokens: 1000,
          maxTime: 5000,
          maxCost: 0.01,
        },
      );

      // Result should have required fields
      expect(result).toBeDefined();
      expect("feasible" in result).toBe(true);
      expect("recommendedLevel" in result).toBe(true);
      expect("tradeoffs" in result).toBe(true);
    });
  });

  describe("createDynamicReasoningTool", () => {
    it("should create tool with correct schema", () => {
      const tool = createDynamicReasoningTool();

      expect(tool.name).toBe("dynamic_reasoning");
      expect(tool.label).toBe("Dynamic Reasoning");
      expect(tool.description).toBeDefined();
      expect(tool.parameters).toBeDefined();
      expect(tool.execute).toBeDefined();
    });

    it("should have required parameters", () => {
      const tool = createDynamicReasoningTool();
      const params = tool.parameters as any;

      expect(params.type).toBe("object");
      expect(params.required).toContain("task");
      expect(params.properties.task).toBeDefined();
      expect(params.properties.includeModelRecommendation).toBeDefined();
    });

    it("should execute successfully", async () => {
      const tool = createDynamicReasoningTool();

      const result = await tool.execute(
        "test-call-id",
        { task: "Test task" },
        undefined,
        undefined,
      );

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      expect(result.details).toBeDefined();
    });

    it("should return difficulty assessment", async () => {
      const tool = createDynamicReasoningTool();

      const result = await tool.execute(
        "test-call-id",
        { task: "Complex task with multiple requirements", includeModelRecommendation: true },
        undefined,
        undefined,
      );

      const details = result.details as TaskDifficulty;

      expect(details.level).toBeDefined();
      expect(typeof details.score).toBe("number");
      expect(details.factors).toBeDefined();
      expect(Array.isArray(details.factors)).toBe(true);
    });
  });

  describe("ReasoningLevel type", () => {
    it("should have valid levels", () => {
      const levels: ReasoningLevel[] = ["fast", "balanced", "deep"];
      expect(levels).toHaveLength(3);
    });
  });

  describe("TaskDifficulty type", () => {
    it("should have all required fields", () => {
      const difficulty: TaskDifficulty = {
        level: "balanced",
        score: 0.5,
        factors: [
          { name: "complexity", score: 0.4, weight: 0.35 },
          { name: "ambiguity", score: 0.3, weight: 0.25 },
        ],
        recommendedModel: "balanced-model",
        estimatedTokens: 1000,
      };

      expect(difficulty.level).toBeDefined();
      expect(difficulty.score).toBeDefined();
      expect(difficulty.factors).toBeDefined();
    });
  });
});
