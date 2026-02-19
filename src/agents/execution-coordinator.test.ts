import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ExecutionCoordinator,
  resetExecutionCoordinator,
} from "./execution-coordinator.js";
import { resetDecisionContext } from "./decision-context.js";

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe("ExecutionCoordinator", () => {
  let coordinator: ExecutionCoordinator;

  beforeEach(() => {
    resetDecisionContext();
    resetExecutionCoordinator();
    coordinator = new ExecutionCoordinator();
  });

  afterEach(() => {
    resetDecisionContext();
    resetExecutionCoordinator();
  });

  describe("initializeSession", () => {
    it("should initialize session with user message", async () => {
      const response = await coordinator.initializeSession(
        "Tell me about typescript programming language",
      );

      expect(response.shouldExecute).toBe(true);
      expect(response.analysis).toBeDefined();
      expect(response.strategy).toBeDefined();
      expect(response.instruction).toBeDefined();
    });

    it("should detect clarification needed", async () => {
      const response = await coordinator.initializeSession("something");

      expect(response.shouldExecute).toBe(false);
      expect(response.stopReason).toBe("clarification_needed");
      expect(response.instruction?.requestClarification).toBe(true);
    });
  });

  describe("beforeToolExecution", () => {
    it("should allow tool execution", async () => {
      await coordinator.initializeSession("Test task");

      const response = await coordinator.beforeToolExecution({
        toolName: "self_rag",
        toolCallId: "call-1",
        args: {},
        timestamp: Date.now(),
      });

      expect(response.shouldExecute).toBe(true);
    });

    it("should block execution after max iterations", async () => {
      const limitedCoordinator = new ExecutionCoordinator({
        coordinatorConfig: { maxAutoIterations: 1 },
      });
      await limitedCoordinator.initializeSession("Test task");

      await limitedCoordinator.afterToolExecution({
        toolName: "self_rag",
        toolCallId: "call-1",
        args: {},
        result: { data: "test" },
        duration: 100,
      });

      const response = await limitedCoordinator.beforeToolExecution({
        toolName: "self_rag",
        toolCallId: "call-2",
        args: {},
        timestamp: Date.now(),
      });

      expect(response.shouldExecute).toBe(false);
      expect(response.stopReason).toBe("max_iterations_reached");
    });
  });

  describe("afterToolExecution", () => {
    it("should evaluate successful execution", async () => {
      await coordinator.initializeSession("Test task");

      const response = await coordinator.afterToolExecution({
        toolName: "self_rag",
        toolCallId: "call-1",
        args: {},
        result: {
          details: {
            confidence: 0.9,
            results: ["result1", "result2", "result3"],
          },
        },
        duration: 100,
      });

      expect(response.evaluation).toBeDefined();
      expect(response.evaluation?.success).toBe(true);
    });

    it("should recommend next tool after execution", async () => {
      await coordinator.initializeSession("Test task");

      const response = await coordinator.afterToolExecution({
        toolName: "self_rag",
        toolCallId: "call-1",
        args: {},
        result: {
          details: {
            confidence: 0.5,
            results: ["result1"],
          },
        },
        duration: 100,
      });

      expect(response.nextRecommendedTool).toBeDefined();
    });

    it("should stop on complete action", async () => {
      await coordinator.initializeSession("Test task");

      const response = await coordinator.afterToolExecution({
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

      expect(response.stopReason).toBe("task_completed");
      expect(response.shouldExecute).toBe(false);
    });
  });

  describe("getCurrentState", () => {
    it("should return current coordinator state", async () => {
      await coordinator.initializeSession("Test task");

      const state = coordinator.getCurrentState();

      expect(state.instruction).toBeDefined();
      expect(state.metrics).toBeDefined();
      expect(state.iterationCount).toBe(0);
    });
  });

  describe("shouldAutoContinue", () => {
    it("should return true initially", async () => {
      await coordinator.initializeSession("Test task");

      expect(coordinator.shouldAutoContinue()).toBe(true);
    });

    it("should return false when execution stopped", async () => {
      await coordinator.initializeSession("Test task");
      await coordinator.afterToolExecution({
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

      expect(coordinator.shouldAutoContinue()).toBe(false);
    });
  });

  describe("reset", () => {
    it("should reset coordinator state", async () => {
      await coordinator.initializeSession("Test task");
      await coordinator.afterToolExecution({
        toolName: "self_rag",
        toolCallId: "call-1",
        args: {},
        result: { data: "test" },
        duration: 100,
      });

      coordinator.reset();

      const state = coordinator.getCurrentState();
      expect(state.iterationCount).toBe(0);
      expect(state.analysis).toBeUndefined();
      expect(state.strategy).toBeUndefined();
    });
  });
});
