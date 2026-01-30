import { describe, it, expect } from "vitest";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  checkContextLimit,
  calculateContextUsage,
  estimateOutputTokenBudget,
  formatContextWarningMessage,
  resolveContextThresholds,
  resolveMaxContextTokens,
  DEFAULT_CONTEXT_THRESHOLDS,
} from "./context-limit-warnings.js";

describe("context-limit-warnings", () => {
  describe("resolveContextThresholds", () => {
    it("should return default thresholds when no config provided", () => {
      const result = resolveContextThresholds(undefined);
      expect(result).toEqual(DEFAULT_CONTEXT_THRESHOLDS);
    });

    it("should use configured thresholds when provided", () => {
      const config = {
        agents: {
          defaults: {
            contextLimits: {
              softWarnPercent: 75,
              hardGatePercent: 85,
              blockPercent: 92,
            },
          },
        },
      };
      const result = resolveContextThresholds(config);
      expect(result.softWarnPercent).toBe(75);
      expect(result.hardGatePercent).toBe(85);
      expect(result.blockPercent).toBe(92);
    });

    it("should fall back to defaults for missing values", () => {
      const config = {
        agents: {
          defaults: {
            contextLimits: {
              softWarnPercent: 75,
            },
          },
        },
      };
      const result = resolveContextThresholds(config);
      expect(result.softWarnPercent).toBe(75);
      expect(result.hardGatePercent).toBe(DEFAULT_CONTEXT_THRESHOLDS.hardGatePercent);
      expect(result.blockPercent).toBe(DEFAULT_CONTEXT_THRESHOLDS.blockPercent);
    });
  });

  describe("estimateOutputTokenBudget", () => {
    it("should calculate output budget with default safety margin", () => {
      const result = estimateOutputTokenBudget({
        model: { maxOutputTokens: 4096 },
      });
      expect(result).toBe(Math.ceil(4096 * 1.2)); // 4916
    });

    it("should use custom safety margin when provided", () => {
      const result = estimateOutputTokenBudget({
        model: { maxOutputTokens: 4096 },
        safetyMargin: 1.5,
      });
      expect(result).toBe(Math.ceil(4096 * 1.5)); // 6144
    });

    it("should use default max output when model not provided", () => {
      const result = estimateOutputTokenBudget({});
      expect(result).toBeGreaterThan(0);
    });
  });

  describe("calculateContextUsage", () => {
    it("should calculate total usage from messages and system prompt", () => {
      const messages: AgentMessage[] = [
        {
          role: "user",
          content: "Hello, how are you?",
          timestamp: Date.now(),
        },
        {
          role: "assistant",
          content: "I'm doing well, thank you!",
          timestamp: Date.now(),
        },
      ];
      const systemPrompt = "You are a helpful assistant.";
      const result = calculateContextUsage({
        messages,
        systemPrompt,
      });
      expect(result).toBeGreaterThan(0);
    });

    it("should include estimated output tokens when provided", () => {
      const messages: AgentMessage[] = [
        {
          role: "user",
          content: "Hello",
          timestamp: Date.now(),
        },
      ];
      const withoutOutput = calculateContextUsage({ messages });
      const withOutput = calculateContextUsage({
        messages,
        estimatedOutputTokens: 1000,
      });
      expect(withOutput).toBe(withoutOutput + 1000);
    });
  });

  describe("formatContextWarningMessage", () => {
    it("should format soft warning message correctly", () => {
      const result = formatContextWarningMessage({
        usagePercent: 82,
        currentTokens: 164000,
        maxTokens: 200000,
        action: "soft_warn",
      });
      expect(result).toContain("82%");
      expect(result).toContain("164K");
      expect(result).toContain("200K");
      expect(result).toContain("Save important work");
    });

    it("should format hard gate message correctly", () => {
      const result = formatContextWarningMessage({
        usagePercent: 91,
        currentTokens: 182000,
        maxTokens: 200000,
        action: "hard_gate",
      });
      expect(result).toContain("91%");
      expect(result).toContain("SAVE YOUR WORK");
      expect(result).toContain("auto-compacting");
    });

    it("should format block message correctly", () => {
      const result = formatContextWarningMessage({
        usagePercent: 96,
        currentTokens: 192000,
        maxTokens: 200000,
        action: "block",
      });
      expect(result).toContain("96%");
      expect(result).toContain("limit reached");
      expect(result).toContain("Compacting");
    });
  });

  describe("checkContextLimit", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "x".repeat(1000), // Roughly 250 tokens
        timestamp: Date.now(),
      },
    ];

    it("should return 'proceed' action when usage is low", () => {
      const result = checkContextLimit({
        messages,
        maxContextTokens: 100000,
        thresholds: DEFAULT_CONTEXT_THRESHOLDS,
      });
      expect(result.action).toBe("proceed");
      expect(result.shouldAutoCompact).toBe(false);
      expect(result.warningMessage).toBeUndefined();
    });

    it("should return 'soft_warn' action when usage is ≥80%", () => {
      const result = checkContextLimit({
        messages,
        maxContextTokens: 312, // 250/312 = 80.1%
        thresholds: DEFAULT_CONTEXT_THRESHOLDS,
      });
      expect(result.action).toBe("soft_warn");
      expect(result.shouldAutoCompact).toBe(false);
      expect(result.warningMessage).toBeDefined();
      expect(result.usagePercent).toBeGreaterThanOrEqual(80);
    });

    it("should return 'hard_gate' action when usage is ≥90%", () => {
      const result = checkContextLimit({
        messages,
        maxContextTokens: 277, // 250/277 = 90.3%
        thresholds: DEFAULT_CONTEXT_THRESHOLDS,
      });
      expect(result.action).toBe("hard_gate");
      expect(result.shouldAutoCompact).toBe(true);
      expect(result.warningMessage).toBeDefined();
      expect(result.usagePercent).toBeGreaterThanOrEqual(90);
    });

    it("should return 'block' action when usage is ≥95%", () => {
      const result = checkContextLimit({
        messages,
        maxContextTokens: 263, // 250/263 = 95.1%
        thresholds: DEFAULT_CONTEXT_THRESHOLDS,
      });
      expect(result.action).toBe("block");
      expect(result.shouldAutoCompact).toBe(true);
      expect(result.warningMessage).toBeDefined();
      expect(result.usagePercent).toBeGreaterThanOrEqual(95);
    });

    it("should account for estimated output tokens", () => {
      const withoutOutput = checkContextLimit({
        messages,
        maxContextTokens: 10000,
      });
      const withOutput = checkContextLimit({
        messages,
        maxContextTokens: 10000,
        estimatedOutputTokens: 8000, // Large output budget
      });
      expect(withOutput.usagePercent).toBeGreaterThan(withoutOutput.usagePercent);
    });

    it("should use custom thresholds when provided", () => {
      const customThresholds = {
        softWarnPercent: 70,
        hardGatePercent: 85,
        blockPercent: 92,
      };
      const result = checkContextLimit({
        messages,
        maxContextTokens: 350, // 250/350 = 71.4% (between 70-85%)
        thresholds: customThresholds,
      });
      expect(result.action).toBe("soft_warn");
    });
  });

  describe("resolveMaxContextTokens", () => {
    it("should prefer session entry contextTokens", () => {
      const result = resolveMaxContextTokens({
        sessionEntry: { contextTokens: 150000 } as any,
        modelContextWindow: 100000,
        defaultTokens: 50000,
      });
      expect(result).toBe(150000);
    });

    it("should fall back to model context window when session entry not available", () => {
      const result = resolveMaxContextTokens({
        sessionEntry: null,
        modelContextWindow: 100000,
        defaultTokens: 50000,
      });
      expect(result).toBe(100000);
    });

    it("should use default when neither session nor model available", () => {
      const result = resolveMaxContextTokens({
        sessionEntry: null,
        modelContextWindow: undefined,
        defaultTokens: 50000,
      });
      expect(result).toBe(50000);
    });

    it("should ignore invalid session entry contextTokens", () => {
      const result = resolveMaxContextTokens({
        sessionEntry: { contextTokens: 0 } as any,
        modelContextWindow: 100000,
        defaultTokens: 50000,
      });
      expect(result).toBe(100000);
    });
  });
});
