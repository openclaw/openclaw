/**
 * Agentic Workflow 单元测试
 */

import { describe, it, expect } from "vitest";
import {
  AgenticWorkflow,
  createAgenticWorkflowTool,
  type SolutionEvaluation,
  type ReflectionConfig,
} from "./agentic-workflow.js";

describe("Agentic Workflow", () => {
  describe("AgenticWorkflow class", () => {
    it("should create instance with default config", () => {
      const workflow = new AgenticWorkflow();
      expect(workflow).toBeDefined();
    });

    it("should create instance with custom config", () => {
      const config: Partial<ReflectionConfig> = {
        maxIterations: 3,
        minScore: 0.9,
        enableParallelVerify: false,
      };
      const workflow = new AgenticWorkflow(config);
      expect(workflow).toBeDefined();
    });

    it("should execute reflection loop with mock functions", async () => {
      const workflow = new AgenticWorkflow({
        maxIterations: 3,
        minScore: 0.8,
      });

      let callCount = 0;
      const mockGenerate = async () => {
        callCount++;
        return `Solution ${callCount}`;
      };

      const mockEvaluate = async (): Promise<SolutionEvaluation> => {
        return {
          score: 0.85,
          feedback: "Good solution",
          issues: [],
          strengths: ["Clear", "Complete"],
        };
      };

      const result = await workflow.executeWithReflection(
        mockGenerate,
        mockEvaluate,
        "Test task",
      );

      expect(result.solution).toBe("Solution 1");
      expect(result.iterations).toBe(1);
      expect(result.finalScore).toBe(0.85);
      expect(result.evaluation.score).toBe(0.85);
    });

    it("should iterate until minScore is reached", async () => {
      const workflow = new AgenticWorkflow({
        maxIterations: 5,
        minScore: 0.9,
      });

      let callCount = 0;
      const mockGenerate = async () => {
        callCount++;
        return `Solution ${callCount}`;
      };

      const scores = [0.5, 0.7, 0.9, 0.95];
      let evalIndex = 0;
      const mockEvaluate = async (): Promise<SolutionEvaluation> => {
        const score = scores[evalIndex % scores.length];
        evalIndex++;
        return {
          score,
          feedback: `Score: ${score}`,
          issues: score < 0.9 ? ["Needs improvement"] : [],
          strengths: score >= 0.9 ? ["Excellent"] : [],
        };
      };

      const result = await workflow.executeWithReflection(
        mockGenerate,
        mockEvaluate,
        "Test task",
      );

      // Should stop at iteration 3 when score reaches 0.9
      expect(result.iterations).toBe(3);
      expect(result.finalScore).toBe(0.9);
    });

    it("should respect maxIterations", async () => {
      const workflow = new AgenticWorkflow({
        maxIterations: 2,
        minScore: 0.99, // Unreachable
      });

      const mockGenerate = async () => "Solution";
      const mockEvaluate = async (): Promise<SolutionEvaluation> => ({
        score: 0.5, // Always low
        feedback: "Low score",
        issues: ["Issue"],
        strengths: [],
      });

      const result = await workflow.executeWithReflection(
        mockGenerate,
        mockEvaluate,
        "Test task",
      );

      expect(result.iterations).toBe(2);
    });

    it("should verify with multiple agents", async () => {
      const workflow = new AgenticWorkflow();

      const mockVerify = async (agentName: string, _solution: string) => {
        return {
          passed: agentName !== "critic", // Critic finds issues
          issues: agentName === "critic" ? ["Logical flaw"] : [],
          suggestions: [],
        };
      };

      const result = await workflow.verifyWithMultipleAgents(
        mockVerify,
        "Test solution",
      );

      expect(result.passed).toBe(false); // One agent failed
      expect(result.issues).toContain("Logical flaw");
      expect(result.suggestions).toHaveLength(0);
    });

    it("should pass verification when all agents pass", async () => {
      const workflow = new AgenticWorkflow();

      const mockVerify = async () => ({
        passed: true,
        issues: [],
        suggestions: [],
      });

      const result = await workflow.verifyWithMultipleAgents(
        mockVerify,
        "Test solution",
      );

      expect(result.passed).toBe(true);
      expect(result.issues).toHaveLength(0);
    });
  });

  describe("createAgenticWorkflowTool", () => {
    it("should create tool with correct schema", () => {
      const tool = createAgenticWorkflowTool();

      expect(tool.name).toBe("agentic_workflow");
      expect(tool.label).toBe("Agentic Workflow");
      expect(tool.description).toBeDefined();
      expect(tool.parameters).toBeDefined();
      expect(tool.execute).toBeDefined();
    });

    it("should have required parameters", () => {
      const tool = createAgenticWorkflowTool();
      const params = tool.parameters as any;

      expect(params.type).toBe("object");
      expect(params.required).toContain("task");
      expect(params.properties.task).toBeDefined();
      expect(params.properties.useDivideAndConquer).toBeDefined();
    });

    it("should execute successfully", async () => {
      const tool = createAgenticWorkflowTool();

      const result = await tool.execute(
        "test-call-id",
        { task: "Test task" },
        undefined,
        undefined,
      );

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      expect(result.details.frameworkReady).toBe(true);
    });

    it("should handle errors gracefully", async () => {
      const tool = createAgenticWorkflowTool();

      const result = await tool.execute(
        "test-call-id",
        { task: null }, // Invalid input
        undefined,
        undefined,
      );

      // Should not crash, should return error details
      expect(result).toBeDefined();
    });
  });

  describe("Solution Evaluation", () => {
    it("should handle low score evaluation", async () => {
      const workflow = new AgenticWorkflow({ maxIterations: 2 });

      const mockGenerate = async () => "Solution";
      const mockEvaluate = async (): Promise<SolutionEvaluation> => ({
        score: 0.3, // Low but not zero
        feedback: "Low score",
        issues: ["Issue"],
        strengths: [],
      });

      const result = await workflow.executeWithReflection(
        mockGenerate,
        mockEvaluate,
        "Test task",
      );

      expect(result.finalScore).toBe(0.3);
      expect(result.iterations).toBe(2); // Should iterate max times
    });

    it("should handle perfect evaluation", async () => {
      const workflow = new AgenticWorkflow({ minScore: 1.0 });

      const mockGenerate = async () => "Solution";
      const mockEvaluate = async (): Promise<SolutionEvaluation> => ({
        score: 1.0,
        feedback: "Perfect",
        issues: [],
        strengths: ["Perfect"],
      });

      const result = await workflow.executeWithReflection(
        mockGenerate,
        mockEvaluate,
        "Test task",
      );

      expect(result.finalScore).toBe(1.0);
      expect(result.iterations).toBe(1); // Should stop immediately
    });
  });
});
