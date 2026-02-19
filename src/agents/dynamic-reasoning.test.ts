/**
 * Dynamic Reasoning 单元测试
 */

import { describe, it, expect, vi } from "vitest";
import {
  DynamicReasoningEngine,
  createDynamicReasoningTool,
  type ReasoningLevel,
  type TaskDifficulty,
} from "./dynamic-reasoning.js";

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe("Dynamic Reasoning", () => {
  describe("DynamicReasoningEngine", () => {
    it("should create instance with default config", () => {
      const engine = new DynamicReasoningEngine();
      expect(engine).toBeDefined();
    });

    it("should create instance with custom config", () => {
      const engine = new DynamicReasoningEngine({
        fastThreshold: 0.2,
        balancedThreshold: 0.5,
      });
      expect(engine).toBeDefined();
    });

    it("should assess simple task as fast", async () => {
      const engine = new DynamicReasoningEngine();
      const assessment = await engine.assessTaskDifficulty("Say hello");

      expect(assessment.level).toBe("fast");
      expect(assessment.score).toBeLessThan(0.3);
    });

    it("should assess complex task as deep or balanced", async () => {
      const engine = new DynamicReasoningEngine();
      const assessment = await engine.assessTaskDifficulty(
        "Design and implement a distributed database system with ACID guarantees, " +
          "horizontal scaling, and automatic failover, then write comprehensive tests " +
          "and documentation for the API",
      );

      expect(["balanced", "deep"]).toContain(assessment.level);
      expect(assessment.score).toBeGreaterThan(0.3);
    });

    it("should return all factors in assessment", async () => {
      const engine = new DynamicReasoningEngine();
      const assessment = await engine.assessTaskDifficulty("Test task");

      expect(assessment.factors).toBeDefined();
      expect(assessment.factors.length).toBe(4);
      expect(assessment.factors.map((f) => f.name)).toEqual(
        expect.arrayContaining(["complexity", "ambiguity", "domain_knowledge", "steps"]),
      );
    });

    it("should estimate tokens based on task length", async () => {
      const engine = new DynamicReasoningEngine();

      const shortTask = await engine.assessTaskDifficulty("Hi");
      const longTask = await engine.assessTaskDifficulty("A".repeat(1000));

      expect(longTask.estimatedTokens).toBeGreaterThan(shortTask.estimatedTokens);
    });
  });

  describe("createDynamicReasoningTool", () => {
    it("should return null when no config provided", () => {
      const tool = createDynamicReasoningTool();
      expect(tool).toBeNull();
    });

    it("should create tool when config provided", () => {
      const tool = createDynamicReasoningTool({
        config: {} as Record<string, unknown>,
      });
      expect(tool).not.toBeNull();
      expect(tool!.name).toBe("dynamic_reasoning");
      expect(tool!.label).toBe("Dynamic Reasoning");
      expect(tool!.description).toBeDefined();
      expect(tool!.parameters).toBeDefined();
      expect(tool!.execute).toBeDefined();
    });

    it("should have required parameters", () => {
      const tool = createDynamicReasoningTool({ config: {} as Record<string, unknown> });
      const params = tool?.parameters as {
        type: string;
        required: string[];
        properties: Record<string, unknown>;
      };

      expect(params.type).toBe("object");
      expect(params.required).toContain("task");
      expect(params.properties.task).toBeDefined();
    });

    it("should return assessment with instruction", async () => {
      const tool = createDynamicReasoningTool({
        config: {} as Record<string, unknown>,
      });

      const result = await tool!.execute(
        "test-call-id",
        { task: "Complex task with multiple requirements" },
        undefined,
        undefined,
      );

      expect(result).toBeDefined();
      const details = result.details as {
        assessment: {
          level: string;
          score: number;
          factors: unknown[];
          estimatedTokens: number;
        };
        guidance: {
          approach: string;
          actions: string[];
          tips: string[];
        };
        instruction: {
          thinkingLevel: string;
          tools: {
            taskDecompose: boolean;
            reflection: boolean;
            memorySearch: boolean;
            webSearch: boolean;
          };
          maxIterations: number;
          verifyResults: boolean;
        };
      };

      expect(details.assessment).toBeDefined();
      expect(details.assessment.level).toBeDefined();
      expect(typeof details.assessment.score).toBe("number");
      expect(Array.isArray(details.assessment.factors)).toBe(true);

      expect(details.guidance).toBeDefined();
      expect(typeof details.guidance.approach).toBe("string");
      expect(Array.isArray(details.guidance.actions)).toBe(true);
      expect(Array.isArray(details.guidance.tips)).toBe(true);

      expect(details.instruction).toBeDefined();
      expect(details.instruction.thinkingLevel).toBeDefined();
      expect(details.instruction.tools).toBeDefined();
      expect(typeof details.instruction.maxIterations).toBe("number");
      expect(typeof details.instruction.verifyResults).toBe("boolean");
    });

    it("should return correct instruction for fast tasks", async () => {
      const tool = createDynamicReasoningTool({
        config: {} as Record<string, unknown>,
      });

      const result = await tool!.execute(
        "test-call-id",
        { task: "Say hello" },
        undefined,
        undefined,
      );

      const details = result.details as { instruction: { thinkingLevel: string } };
      expect(details.instruction.thinkingLevel).toBe("off");
    });

    it("should return correct instruction for deep tasks", async () => {
      const tool = createDynamicReasoningTool({
        config: {} as Record<string, unknown>,
      });

      const result = await tool!.execute(
        "test-call-id",
        { task: "Design and implement a complex distributed system with API database kubernetes deployment" },
        undefined,
        undefined,
      );

      const details = result.details as { instruction: { thinkingLevel: string } };
      expect(["medium", "low"]).toContain(details.instruction.thinkingLevel);
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
        estimatedTokens: 1000,
      };

      expect(difficulty.level).toBeDefined();
      expect(difficulty.score).toBeDefined();
      expect(difficulty.factors).toBeDefined();
      expect(difficulty.estimatedTokens).toBeDefined();
    });
  });
});
