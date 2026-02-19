/**
 * Decision Context Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  DecisionContext,
  getDecisionContext,
  resetDecisionContext,
} from "./decision-context.js";

describe("DecisionContext", () => {
  beforeEach(() => {
    resetDecisionContext();
  });

  afterEach(() => {
    resetDecisionContext();
  });

  describe("singleton", () => {
    it("should return the same instance", () => {
      const ctx1 = getDecisionContext();
      const ctx2 = getDecisionContext();
      expect(ctx1).toBe(ctx2);
    });

    it("should reset to new instance", () => {
      const ctx1 = getDecisionContext();
      ctx1.createGoal({ description: "test" });

      resetDecisionContext();

      const ctx2 = getDecisionContext();
      expect(ctx2).not.toBe(ctx1);
    });
  });

  describe("goal management", () => {
    it("should create a goal", () => {
      const ctx = getDecisionContext();
      const goal = ctx.createGoal({
        description: "Test goal",
        priority: 7,
        successCriteria: ["Complete task"],
      });

      expect(goal.id).toBeDefined();
      expect(goal.description).toBe("Test goal");
      expect(goal.priority).toBe(7);
      expect(goal.status).toBe("pending");
      expect(goal.progress).toBe(0);
      expect(goal.successCriteria).toContain("Complete task");
    });

    it("should set current goal", () => {
      const ctx = getDecisionContext();
      const goal = ctx.createGoal({ description: "Test" });

      const result = ctx.setCurrentGoal(goal.id);

      expect(result).toBe(true);
      expect(ctx.getCurrentGoal()?.id).toBe(goal.id);
      expect(ctx.getCurrentGoal()?.status).toBe("in_progress");
    });

    it("should update goal progress", () => {
      const ctx = getDecisionContext();
      const goal = ctx.createGoal({ description: "Test" });
      ctx.setCurrentGoal(goal.id);

      ctx.updateGoalProgress(goal.id, 50);

      const updated = ctx.getCurrentGoal();
      expect(updated?.progress).toBe(50);
    });

    it("should mark goal as completed when progress reaches 100", () => {
      const ctx = getDecisionContext();
      const goal = ctx.createGoal({ description: "Test" });
      ctx.setCurrentGoal(goal.id);

      ctx.updateGoalProgress(goal.id, 100);

      const updated = ctx.getCurrentGoal();
      expect(updated?.status).toBe("completed");
    });

    it("should add and remove blockers", () => {
      const ctx = getDecisionContext();
      const goal = ctx.createGoal({ description: "Test" });
      ctx.setCurrentGoal(goal.id);

      ctx.addBlocker(goal.id, "Missing information");

      let updated = ctx.getCurrentGoal();
      expect(updated?.blockers).toContain("Missing information");
      expect(updated?.status).toBe("blocked");

      ctx.removeBlocker(goal.id, "Missing information");

      updated = ctx.getCurrentGoal();
      expect(updated?.blockers).toHaveLength(0);
      expect(updated?.status).toBe("in_progress");
    });

    it("should support sub-goals", () => {
      const ctx = getDecisionContext();
      const parent = ctx.createGoal({ description: "Parent" });
      ctx.createGoal({
        description: "Child",
        parentGoal: parent.id,
      });

      const snapshot = ctx.createSnapshot();
      const updatedParent = snapshot.goals.get(parent.id);
      expect(updatedParent?.subGoals).toHaveLength(1);
    });
  });

  describe("tool call tracking", () => {
    it("should record tool calls", () => {
      const ctx = getDecisionContext();

      ctx.recordToolCall({
        toolName: "test_tool",
        toolCallId: "call-1",
        timestamp: Date.now(),
        args: {},
        success: true,
        confidence: 0.8,
        duration: 100,
      });

      const recent = ctx.getRecentToolCalls(1);
      expect(recent).toHaveLength(1);
      expect(recent[0].toolName).toBe("test_tool");
      expect(recent[0].confidence).toBe(0.8);
    });

    it("should update metrics", () => {
      const ctx = getDecisionContext();

      ctx.recordToolCall({
        toolName: "tool1",
        toolCallId: "call-1",
        timestamp: Date.now(),
        args: {},
        success: true,
        confidence: 0.8,
        duration: 100,
      });

      ctx.recordToolCall({
        toolName: "tool2",
        toolCallId: "call-2",
        timestamp: Date.now(),
        args: {},
        success: false,
        confidence: 0.4,
        duration: 200,
      });

      const metrics = ctx.getMetrics();
      expect(metrics.totalToolCalls).toBe(2);
      expect(metrics.successfulToolCalls).toBe(1);
      expect(metrics.averageConfidence).toBeCloseTo(0.6, 2);
      expect(metrics.totalDuration).toBe(300);
    });

    it("should get tool-specific history", () => {
      const ctx = getDecisionContext();

      ctx.recordToolCall({
        toolName: "tool_a",
        toolCallId: "call-1",
        timestamp: Date.now(),
        args: {},
      });

      ctx.recordToolCall({
        toolName: "tool_b",
        toolCallId: "call-2",
        timestamp: Date.now(),
        args: {},
      });

      ctx.recordToolCall({
        toolName: "tool_a",
        toolCallId: "call-3",
        timestamp: Date.now(),
        args: {},
      });

      const history = ctx.getToolCallHistory("tool_a");
      expect(history).toHaveLength(2);
      expect(history.every((c) => c.toolName === "tool_a")).toBe(true);
    });
  });

  describe("execution instruction", () => {
    it("should set and get instruction", () => {
      const ctx = getDecisionContext();

      ctx.setInstruction({
        thinkingLevel: "medium",
        useTools: ["self_rag", "dynamic_reasoning"],
        maxIterations: 3,
      });

      const instruction = ctx.getInstruction();
      expect(instruction.thinkingLevel).toBe("medium");
      expect(instruction.useTools).toContain("self_rag");
      expect(instruction.maxIterations).toBe(3);
    });

    it("should merge instructions", () => {
      const ctx = getDecisionContext();

      ctx.setInstruction({ thinkingLevel: "low" });
      ctx.setInstruction({ maxIterations: 5 });

      const instruction = ctx.getInstruction();
      expect(instruction.thinkingLevel).toBe("low");
      expect(instruction.maxIterations).toBe(5);
    });

    it("should clear instruction", () => {
      const ctx = getDecisionContext();

      ctx.setInstruction({ thinkingLevel: "high" });
      ctx.clearInstruction();

      const instruction = ctx.getInstruction();
      expect(instruction.thinkingLevel).toBeUndefined();
    });
  });

  describe("decision level inference", () => {
    it("should return fast when no current goal", () => {
      const ctx = getDecisionContext();
      expect(ctx.inferDecisionLevel()).toBe("fast");
    });

    it("should return deep when goal has blockers", () => {
      const ctx = getDecisionContext();
      const goal = ctx.createGoal({ description: "Test" });
      ctx.setCurrentGoal(goal.id);
      ctx.addBlocker(goal.id, "Blocker");

      expect(ctx.inferDecisionLevel()).toBe("deep");
    });

    it("should return deep when recent calls have low confidence", () => {
      const ctx = getDecisionContext();
      const goal = ctx.createGoal({ description: "Test" });
      ctx.setCurrentGoal(goal.id);

      for (let i = 0; i < 4; i++) {
        ctx.recordToolCall({
          toolName: "tool",
          toolCallId: `call-${i}`,
          timestamp: Date.now(),
          args: {},
          confidence: 0.3,
        });
      }

      expect(ctx.inferDecisionLevel()).toBe("deep");
    });
  });

  describe("snapshot", () => {
    it("should create and restore snapshot", () => {
      const ctx = getDecisionContext();
      const goal = ctx.createGoal({ description: "Test goal" });
      ctx.setCurrentGoal(goal.id);
      ctx.setInstruction({ thinkingLevel: "high" });

      const snapshot = ctx.createSnapshot();

      resetDecisionContext();
      const newCtx = getDecisionContext();
      newCtx.restoreFromSnapshot(snapshot);

      expect(newCtx.getCurrentGoal()?.description).toBe("Test goal");
      expect(newCtx.getInstruction().thinkingLevel).toBe("high");
    });
  });

  describe("JSON serialization", () => {
    it("should serialize to JSON and back", () => {
      const ctx = getDecisionContext();
      const goal = ctx.createGoal({ description: "Goal 1" });
      ctx.setCurrentGoal(goal.id);
      ctx.setInstruction({ thinkingLevel: "medium" });

      const json = ctx.toJSON();
      const restored = DecisionContext.fromJSON(json);

      expect(restored).not.toBe(ctx);
      expect(restored.getCurrentGoal()?.description).toBe("Goal 1");
      expect(restored.getInstruction().thinkingLevel).toBe("medium");
    });
  });
});
