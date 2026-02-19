/**
 * Decision Engine Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DecisionEngine,
  type ExecutionEvaluation,
} from "./decision-engine.js";
import { resetDecisionContext } from "./decision-context.js";

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe("DecisionEngine", () => {
  let engine: DecisionEngine;

  beforeEach(() => {
    resetDecisionContext();
    engine = new DecisionEngine();
  });

  afterEach(() => {
    resetDecisionContext();
  });

  describe("analyzeTask", () => {
    it("should analyze simple information retrieval task", async () => {
      const analysis = await engine.analyzeTask("Tell me about typescript programming");

      expect(analysis.type).toBe("information_retrieval");
      expect(analysis.keywords.length).toBeGreaterThan(0);
      expect(analysis.keywords).toContain("typescript");
      expect(analysis.contextNeeded).toBe(true);
    });

    it("should analyze code modification task", async () => {
      const analysis = await engine.analyzeTask(
        "Create a function to calculate factorial",
      );

      expect(analysis.type).toBe("code_modification");
      expect(analysis.suggestedTools).toBeDefined();
    });

    it("should analyze multi-step task", async () => {
      const analysis = await engine.analyzeTask(
        "First get the data, then process it, next validate results, finally save to database",
      );

      expect(analysis.type).toBe("multi_step");
      expect(analysis.estimatedSteps).toBeGreaterThan(1);
    });

    it("should detect clarification needed", async () => {
      const analysis = await engine.analyzeTask("something");

      expect(analysis.clarificationNeeded).toBe(true);
      expect(analysis.clarificationQuestions).toBeDefined();
      expect(analysis.clarificationQuestions!.length).toBeGreaterThan(0);
    });

    it("should assess complexity correctly", async () => {
      const simpleAnalysis = await engine.analyzeTask("Say hello");
      const complexAnalysis = await engine.analyzeTask(
        "Design and implement a distributed database system with ACID guarantees, " +
          "horizontal scaling, automatic failover, and comprehensive monitoring",
      );

      expect(simpleAnalysis.complexity).toBeLessThan(complexAnalysis.complexity);
    });

    it("should suggest appropriate tools", async () => {
      const analysis = await engine.analyzeTask(
        "Search for information about React hooks",
      );

      expect(analysis.suggestedTools.length).toBeGreaterThan(0);
      expect(
        analysis.suggestedTools.some(
          (t) => t === "self_rag" || t === "memory_search",
        ),
      ).toBe(true);
    });
  });

  describe("selectStrategy", () => {
    it("should select fast strategy for simple tasks", async () => {
      const analysis = await engine.analyzeTask("Say hello");
      const strategy = await engine.selectStrategy(analysis);

      expect(strategy.level).toBe("fast");
      expect(strategy.maxIterations).toBe(1);
    });

    it("should select balanced strategy for moderate tasks", async () => {
      const analysis = await engine.analyzeTask(
        "Explain how React hooks work and provide comprehensive examples with detailed explanations of each hook",
      );
      const strategy = await engine.selectStrategy(analysis);

      expect(["balanced", "deep"]).toContain(strategy.level);
    });

    it("should select deep strategy for complex tasks", async () => {
      const analysis = await engine.analyzeTask(
        "Design and implement a complete microservices architecture with kubernetes deployment, monitoring, and automatic scaling. " +
          "Additionally, include comprehensive testing, documentation, and CI/CD pipeline configuration with multiple environments.",
      );
      const strategy = await engine.selectStrategy(analysis);

      expect(strategy.level).toBe("deep");
      expect(strategy.maxIterations).toBe(5);
    });

    it("should determine execution order", async () => {
      const analysis = await engine.analyzeTask(
        "Analyze the codebase and create a comprehensive report",
      );
      const strategy = await engine.selectStrategy(analysis);

      expect(strategy.executionOrder.length).toBeGreaterThan(0);
      expect(strategy.primaryTool).toBeDefined();
    });

    it("should provide fallback strategy", async () => {
      const analysis = await engine.analyzeTask("Something unclear");
      const strategy = await engine.selectStrategy(analysis);

      expect(strategy.fallbackStrategy).toBeDefined();
    });
  });

  describe("evaluateExecution", () => {
    it("should evaluate successful execution", async () => {
      const evaluation = await engine.evaluateExecution({
        toolName: "self_rag",
        toolCallId: "call-1",
        args: {},
        result: {
          details: {
            confidence: 0.9,
            results: ["result1", "result2"],
          },
        },
        duration: 100,
      });

      expect(evaluation.success).toBe(true);
      expect(evaluation.confidence).toBe(0.9);
      expect(evaluation.completeness).toBeGreaterThan(0.5);
    });

    it("should evaluate failed execution", async () => {
      const evaluation = await engine.evaluateExecution({
        toolName: "self_rag",
        toolCallId: "call-1",
        args: {},
        result: {
          details: {
            error: "Search failed",
          },
        },
        duration: 100,
      });

      expect(evaluation.success).toBe(false);
      expect(evaluation.issues).toContain("Search failed");
    });

    it("should recommend next action based on evaluation", async () => {
      const goodEvaluation = await engine.evaluateExecution({
        toolName: "self_rag",
        toolCallId: "call-1",
        args: {},
        result: {
          details: {
            confidence: 0.95,
            results: ["result1", "result2", "result3"],
          },
        },
        duration: 100,
      });

      expect(goodEvaluation.nextAction).toBe("complete");

      const poorEvaluation = await engine.evaluateExecution({
        toolName: "self_rag",
        toolCallId: "call-2",
        args: {},
        result: {
          details: {
            confidence: 0.2,
            results: [],
          },
        },
        duration: 100,
      });

      expect(poorEvaluation.nextAction).toBe("retry");
    });

    it("should track tool calls in decision context", async () => {
      await engine.evaluateExecution({
        toolName: "test_tool",
        toolCallId: "call-1",
        args: { arg1: "value1" },
        result: { data: "test" },
        duration: 50,
      });

      const state = engine.getCurrentState();
      expect(state.metrics.totalToolCalls).toBe(1);
    });
  });

  describe("generateInstruction", () => {
    it("should generate instruction from analysis and strategy", async () => {
      const analysis = await engine.analyzeTask("Test task");
      const strategy = await engine.selectStrategy(analysis);

      const instruction = engine.generateInstruction({ analysis, strategy });

      expect(instruction.thinkingLevel).toBeDefined();
      expect(instruction.useTools).toBeDefined();
      expect(instruction.maxIterations).toBeGreaterThan(0);
    });

    it("should adjust instruction based on evaluation", async () => {
      const analysis = await engine.analyzeTask("Test task");
      const strategy = await engine.selectStrategy(analysis);

      const evaluation: ExecutionEvaluation = {
        success: true,
        confidence: 0.95,
        completeness: 0.9,
        issues: [],
        recommendations: [],
        nextAction: "complete",
      };

      const instruction = engine.generateInstruction({
        analysis,
        strategy,
        evaluation,
      });

      expect(instruction.stopExecution).toBe(true);
    });

    it("should escalate on poor evaluation", async () => {
      const analysis = await engine.analyzeTask("Test task");
      const strategy = await engine.selectStrategy(analysis);

      const evaluation: ExecutionEvaluation = {
        success: false,
        confidence: 0.2,
        completeness: 0.1,
        issues: ["issue1", "issue2", "issue3"],
        recommendations: [],
        nextAction: "escalate",
      };

      const instruction = engine.generateInstruction({
        analysis,
        strategy,
        evaluation,
      });

      expect(instruction.thinkingLevel).toBe("high");
    });
  });

  describe("goal management", () => {
    it("should create goal from task", async () => {
      const goal = engine.createGoalFromTask("Complete the project");

      expect(goal.description).toBe("Complete the project");
      expect(goal.status).toBe("in_progress");

      const state = engine.getCurrentState();
      expect(state.goal?.id).toBe(goal.id);
    });

    it("should update goal progress", async () => {
      engine.createGoalFromTask("Test task");

      const evaluation: ExecutionEvaluation = {
        success: true,
        confidence: 0.8,
        completeness: 0.7,
        issues: [],
        recommendations: [],
        nextAction: "continue",
      };

      engine.updateGoalProgress(evaluation);

      const state = engine.getCurrentState();
      expect(state.goal?.progress).toBeGreaterThan(0);
    });

    it("should complete goal when evaluation is complete", async () => {
      engine.createGoalFromTask("Test task");

      const evaluation: ExecutionEvaluation = {
        success: true,
        confidence: 0.95,
        completeness: 0.95,
        issues: [],
        recommendations: [],
        nextAction: "complete",
      };

      engine.updateGoalProgress(evaluation);

      const state = engine.getCurrentState();
      expect(state.goal?.progress).toBe(100);
    });
  });

  describe("auto continuation", () => {
    it("should determine if auto continue is enabled", () => {
      expect(engine.shouldAutoContinue()).toBe(true);
    });

    it("should get recommended next tool", async () => {
      const analysis = await engine.analyzeTask("Test task");
      const strategy = await engine.selectStrategy(analysis);
      engine.generateInstruction({ analysis, strategy });

      const nextTool = engine.getRecommendedNextTool();

      expect(nextTool).toBeDefined();
    });
  });

  describe("getCurrentState", () => {
    it("should return current state", async () => {
      engine.createGoalFromTask("Test task");

      const state = engine.getCurrentState();

      expect(state.goal).toBeDefined();
      expect(state.instruction).toBeDefined();
      expect(state.metrics).toBeDefined();
    });
  });
});
