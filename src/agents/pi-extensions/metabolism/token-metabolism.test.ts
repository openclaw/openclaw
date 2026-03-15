/**
 * Tests for Homeostatic Token Budget Management System
 */

import { describe, it, expect, beforeEach } from "vitest";
import { TokenMetabolismSystem } from "./token-metabolism.js";

describe("TokenMetabolismSystem", () => {
  let system: TokenMetabolismSystem;

  beforeEach(() => {
    system = new TokenMetabolismSystem(10000);
  });

  describe("Initialization", () => {
    it("should initialize with correct budget", () => {
      const budget = system.getBudgetStatus();
      expect(budget.total).toBe(10000);
      expect(budget.allocated).toBe(0);
      expect(budget.reserved).toBe(1000); // 10% of total
      expect(budget.metabolicRate).toBe(100);
    });

    it("should initialize with baseline metabolic state", () => {
      const state = system.getMetabolicState();
      expect(state.cognitiveLoad).toBe(0.1);
      expect(state.informationDensity).toBe(0.5);
      expect(state.momentum).toBe(0.0);
      expect(state.stabilityPeriod).toBe(0);
    });
  });

  describe("State Updates", () => {
    it("should update metabolic state correctly", () => {
      system.updateState(0.7, 0.8, 0.3, 60);

      const state = system.getMetabolicState();
      expect(state.cognitiveLoad).toBe(0.7);
      expect(state.informationDensity).toBe(0.8);
      expect(state.momentum).toBe(0.3);
      expect(state.stabilityPeriod).toBe(60);
    });

    it("should clamp cognitive load to valid range", () => {
      system.updateState(1.5, 0.5, 0.0, 0);
      expect(system.getMetabolicState().cognitiveLoad).toBe(1.0);

      system.updateState(-0.5, 0.5, 0.0, 0);
      expect(system.getMetabolicState().cognitiveLoad).toBe(0.0);
    });

    it("should adjust metabolic rate based on state", () => {
      // High cognitive load should increase metabolic rate
      system.updateState(0.9, 0.5, 0.0, 0);
      expect(system.getBudgetStatus().metabolicRate).toBeGreaterThan(100);

      // High information density should increase metabolic rate
      system.updateState(0.1, 0.9, 0.0, 0);
      expect(system.getBudgetStatus().metabolicRate).toBeGreaterThan(100);
    });
  });

  describe("Token Allocation", () => {
    it("should allocate tokens when sufficient budget available", () => {
      const success = system.allocateTokens(500);
      expect(success).toBe(true);
      expect(system.getBudgetStatus().allocated).toBe(500);
    });

    it("should reject allocation when insufficient budget", () => {
      // Try to allocate more than available (9000 available after 1000 reserved)
      const success = system.allocateTokens(9500);
      expect(success).toBe(false);
      expect(system.getBudgetStatus().allocated).toBe(0);
    });

    it("should release tokens correctly", () => {
      system.allocateTokens(500);
      system.releaseTokens(200);
      expect(system.getBudgetStatus().allocated).toBe(300);
    });

    it("should not allow negative allocation", () => {
      system.allocateTokens(500);
      system.releaseTokens(600);
      expect(system.getBudgetStatus().allocated).toBe(0);
    });
  });

  describe("Homeostasis Assessment", () => {
    it("should not recommend pruning when utilization is low", () => {
      system.allocateTokens(1000); // 10% utilization
      const decision = system.assessHomeostasis();

      expect(decision.shouldPrune).toBe(false);
      expect(decision.pruneAmount).toBe(0);
    });

    it("should recommend pruning when utilization exceeds threshold", () => {
      system.allocateTokens(8000); // 80% utilization (exceeds 70% threshold)
      const decision = system.assessHomeostasis();

      expect(decision.shouldPrune).toBe(true);
      expect(decision.pruneAmount).toBeGreaterThan(0);
    });

    it("should recommend pruning under high metabolic pressure", () => {
      system.updateState(0.9, 0.9, 0.5, 0); // High metabolic pressure
      const decision = system.assessHomeostasis();

      expect(decision.shouldPrune).toBe(true);
    });

    it("should provide priority scores for context segments", () => {
      const decision = system.assessHomeostasis();
      expect(decision.priorities.has("recent")).toBe(true);
      expect(decision.priorities.has("important")).toBe(true);
      expect(decision.priorities.has("background")).toBe(true);

      expect(decision.priorities.get("recent")).toBeGreaterThan(
        decision.priorities.get("background")!,
      );
    });
  });

  describe("Reset Functionality", () => {
    it("should reset metabolic state to baseline", () => {
      system.updateState(0.8, 0.7, 0.4, 120);
      system.reset();

      const state = system.getMetabolicState();
      expect(state.cognitiveLoad).toBe(0.1);
      expect(state.informationDensity).toBe(0.5);
      expect(state.momentum).toBe(0.0);
      expect(state.stabilityPeriod).toBe(0);
      expect(system.getBudgetStatus().metabolicRate).toBe(100);
    });
  });

  describe("Integration Scenarios", () => {
    it("should handle high cognitive load scenario", () => {
      // Simulate intense conversation
      system.updateState(0.9, 0.8, 0.6, 30);
      system.allocateTokens(2000);

      const decision = system.assessHomeostasis();
      expect(decision.shouldPrune).toBe(true);
      expect(decision.adjustmentFactor).toBeGreaterThan(1.0);
    });

    it("should handle stable low-activity scenario", () => {
      // Simulate quiet period
      system.updateState(0.2, 0.3, -0.1, 300);
      system.allocateTokens(500);

      const decision = system.assessHomeostasis();
      expect(decision.shouldPrune).toBe(false);
      expect(decision.adjustmentFactor).toBeLessThan(1.0);
    });

    it("should maintain homeostasis through pruning cycles", () => {
      // Fill up budget
      system.allocateTokens(8500);

      // Should recommend pruning
      let decision = system.assessHomeostasis();
      expect(decision.shouldPrune).toBe(true);

      // Simulate pruning
      system.releaseTokens(decision.pruneAmount);

      // Should stabilize
      decision = system.assessHomeostasis();
      expect(decision.shouldPrune).toBe(false);
    });
  });
});
