/**
 * Agentic Workflow 单元测试
 */

import { describe, it, expect, vi } from "vitest";
import {
  AgenticWorkflow,
  createAgenticWorkflowTool,
  type ReflectionConfig,
} from "./agentic-workflow.js";

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

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
      expect(workflow.getConfig().maxIterations).toBe(3);
      expect(workflow.getConfig().minScore).toBe(0.9);
    });
  });

  describe("createAgenticWorkflowTool", () => {
    it("should return null when no config provided", () => {
      const tool = createAgenticWorkflowTool();
      expect(tool).toBeNull();
    });

    it("should create tool when config provided", () => {
      const tool = createAgenticWorkflowTool({
        config: {} as Record<string, unknown>,
      });
      expect(tool).not.toBeNull();
      expect(tool!.name).toBe("agentic_workflow");
      expect(tool!.label).toBe("Agentic Workflow");
      expect(tool!.description).toBeDefined();
      expect(tool!.parameters).toBeDefined();
      expect(tool!.execute).toBeDefined();
    });

    it("should have required parameters", () => {
      const tool = createAgenticWorkflowTool({ config: {} as Record<string, unknown> });
      const params = tool?.parameters as {
        type: string;
        required: string[];
        properties: Record<string, unknown>;
      };

      expect(params.type).toBe("object");
      expect(params.required).toContain("task");
      expect(params.properties.task).toBeDefined();
      expect(params.properties.strategy).toBeDefined();
      expect(params.properties.maxIterations).toBeDefined();
      expect(params.properties.qualityThreshold).toBeDefined();
    });

    it("should return structured execution plan", async () => {
      const tool = createAgenticWorkflowTool({
        config: {} as Record<string, unknown>,
      });

      const result = await tool!.execute(
        "test-call-id",
        { task: "Test task" },
        undefined,
        undefined,
      );

      expect(result).toBeDefined();
      const details = result.details as {
        task: string;
        strategy: string;
        plan: {
          phases: Array<{
            id: string;
            name: string;
            steps: string[];
            checkpoints: string[];
          }>;
          expectedIterations: number;
          qualityThreshold: number;
        };
        execution: {
          currentPhase: number;
          currentStep: number;
          completedPhases: string[];
        };
        nextActions: string[];
        toolRecommendations: Array<{
          tool: string;
          purpose: string;
          priority: string;
        }>;
        recommendation: string;
      };

      expect(details.task).toBe("Test task");
      expect(details.strategy).toBe("reflection");
      expect(details.plan).toBeDefined();
      expect(Array.isArray(details.plan.phases)).toBe(true);
      expect(details.plan.phases.length).toBeGreaterThan(0);
      expect(details.execution).toBeDefined();
      expect(Array.isArray(details.nextActions)).toBe(true);
      expect(Array.isArray(details.toolRecommendations)).toBe(true);
      expect(typeof details.recommendation).toBe("string");
    });

    it("should support different strategies", async () => {
      const tool = createAgenticWorkflowTool({
        config: {} as Record<string, unknown>,
      });

      const strategies = ["reflection", "divide_and_conquer", "parallel_verify"];

      for (const strategy of strategies) {
        const result = await tool!.execute(
          "test-call-id",
          { task: "Test task", strategy },
          undefined,
          undefined,
        );

        const details = result.details as { strategy: string };
        expect(details.strategy).toBe(strategy);
      }
    });

    it("should respect custom config", async () => {
      const tool = createAgenticWorkflowTool({
        config: {} as Record<string, unknown>,
      });

      const result = await tool!.execute(
        "test-call-id",
        { task: "Test task", maxIterations: 5, qualityThreshold: 0.9 },
        undefined,
        undefined,
      );

      const details = result.details as {
        plan: { expectedIterations: number; qualityThreshold: number };
      };

      expect(details.plan.expectedIterations).toBe(5);
      expect(details.plan.qualityThreshold).toBe(0.9);
    });

    it("should throw on missing task", async () => {
      const tool = createAgenticWorkflowTool({
        config: {} as Record<string, unknown>,
      });

      await expect(
        tool!.execute("test-call-id", { task: null }, undefined, undefined),
      ).rejects.toThrow();
    });
  });

  describe("Workflow Phases", () => {
    it("should have correct phases for reflection strategy", async () => {
      const tool = createAgenticWorkflowTool({
        config: {} as Record<string, unknown>,
      });

      const result = await tool!.execute(
        "test-call-id",
        { task: "Test task", strategy: "reflection" },
        undefined,
        undefined,
      );

      const details = result.details as {
        plan: { phases: Array<{ name: string }> };
      };

      const phaseNames = details.plan.phases.map((p) => p.name);
      expect(phaseNames).toContain("Initial Solution");
      expect(phaseNames).toContain("Self-Evaluation");
      expect(phaseNames).toContain("Iteration");
    });

    it("should have correct phases for divide_and_conquer strategy", async () => {
      const tool = createAgenticWorkflowTool({
        config: {} as Record<string, unknown>,
      });

      const result = await tool!.execute(
        "test-call-id",
        { task: "Test task", strategy: "divide_and_conquer" },
        undefined,
        undefined,
      );

      const details = result.details as {
        plan: { phases: Array<{ name: string }> };
      };

      const phaseNames = details.plan.phases.map((p) => p.name);
      expect(phaseNames).toContain("Decomposition");
      expect(phaseNames).toContain("Parallel Execution");
      expect(phaseNames).toContain("Integration");
    });

    it("should have correct phases for parallel_verify strategy", async () => {
      const tool = createAgenticWorkflowTool({
        config: {} as Record<string, unknown>,
      });

      const result = await tool!.execute(
        "test-call-id",
        { task: "Test task", strategy: "parallel_verify" },
        undefined,
        undefined,
      );

      const details = result.details as {
        plan: { phases: Array<{ name: string }> };
      };

      const phaseNames = details.plan.phases.map((p) => p.name);
      expect(phaseNames).toContain("Solution Generation");
      expect(phaseNames).toContain("Multi-Perspective Verification");
      expect(phaseNames).toContain("Consolidation");
    });
  });

  describe("Tool Recommendations", () => {
    it("should recommend appropriate tools for each strategy", async () => {
      const tool = createAgenticWorkflowTool({
        config: {} as Record<string, unknown>,
      });

      const strategies = ["reflection", "divide_and_conquer", "parallel_verify"];

      for (const strategy of strategies) {
        const result = await tool!.execute(
          "test-call-id",
          { task: "Test task", strategy },
          undefined,
          undefined,
        );

        const details = result.details as {
          toolRecommendations: Array<{ tool: string; priority: string }>;
        };

        expect(details.toolRecommendations.length).toBeGreaterThan(0);

        const toolNames = details.toolRecommendations.map((r) => r.tool);
        expect(toolNames).toContain("memory_search");
      }
    });

    it("should require task_decompose for divide_and_conquer", async () => {
      const tool = createAgenticWorkflowTool({
        config: {} as Record<string, unknown>,
      });

      const result = await tool!.execute(
        "test-call-id",
        { task: "Test task", strategy: "divide_and_conquer" },
        undefined,
        undefined,
      );

      const details = result.details as {
        toolRecommendations: Array<{ tool: string; priority: string }>;
      };

      const taskDecomp = details.toolRecommendations.find(
        (r) => r.tool === "task_decompose",
      );
      expect(taskDecomp).toBeDefined();
      expect(taskDecomp!.priority).toBe("required");
    });
  });
});
