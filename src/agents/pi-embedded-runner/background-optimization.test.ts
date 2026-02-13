import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkBackgroundOptimization,
  clearOptimizationState,
  markOptimizationDone,
  maybeScheduleBackgroundOptimization,
  __testing,
} from "./background-optimization.js";

const { SESSION_STATE, countUserTurns } = __testing;

function makeMessages(userCount: number, assistantCount = userCount): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (let i = 0; i < Math.max(userCount, assistantCount); i++) {
    if (i < userCount) {
      messages.push({ role: "user", content: `msg ${i}`, timestamp: Date.now() });
    }
    if (i < assistantCount) {
      messages.push({ role: "assistant", content: `reply ${i}`, timestamp: Date.now() });
    }
  }
  return messages;
}

afterEach(() => {
  SESSION_STATE.clear();
});

describe("countUserTurns", () => {
  it("counts user messages only", () => {
    const messages = makeMessages(5);
    expect(countUserTurns(messages)).toBe(5);
  });

  it("returns 0 for empty array", () => {
    expect(countUserTurns([])).toBe(0);
  });
});

describe("checkBackgroundOptimization", () => {
  it("does not trigger when turns <= verbatimTurns", () => {
    const messages = makeMessages(20); // default verbatimTurns=30
    const result = checkBackgroundOptimization("test-session", messages);
    expect(result.shouldOptimize).toBe(false);
  });

  it("does not trigger on first check when turns are only slightly above verbatimTurns", () => {
    const messages = makeMessages(35); // 35 > 30 but < 30+15
    const result = checkBackgroundOptimization("test-session", messages);
    expect(result.shouldOptimize).toBe(false);
  });

  it("triggers on first check when turns exceed verbatimTurns + optimizeAfterTurns", () => {
    const messages = makeMessages(50); // 50 > 30+15=45
    const result = checkBackgroundOptimization("test-session", messages);
    expect(result.shouldOptimize).toBe(true);
    expect(result.reason).toContain("first check");
  });

  it("respects optimizeAfterTurns threshold after first optimization", () => {
    const sessionId = "turns-test";
    markOptimizationDone(sessionId, 40);
    // Simulate time passing (set lastOptimizedAt to 30 min ago)
    SESSION_STATE.get(sessionId)!.lastOptimizedAt = Date.now() - 30 * 60_000;

    // Only 5 new turns since last (40 → 45): below 15 threshold
    const messages45 = makeMessages(45);
    expect(checkBackgroundOptimization(sessionId, messages45).shouldOptimize).toBe(false);

    // 20 new turns since last (40 → 60): above 15 threshold
    const messages60 = makeMessages(60);
    expect(checkBackgroundOptimization(sessionId, messages60).shouldOptimize).toBe(true);
  });

  it("respects optimizeIntervalMin threshold", () => {
    const sessionId = "interval-test";
    markOptimizationDone(sessionId, 40);
    // lastOptimizedAt is "now", so interval not met

    const messages = makeMessages(60); // enough turns
    expect(checkBackgroundOptimization(sessionId, messages).shouldOptimize).toBe(false);

    // Simulate 25 min passing (default interval=20)
    SESSION_STATE.get(sessionId)!.lastOptimizedAt = Date.now() - 25 * 60_000;
    expect(checkBackgroundOptimization(sessionId, messages).shouldOptimize).toBe(true);
  });

  it("uses custom config when provided", () => {
    const messages = makeMessages(12); // custom verbatimTurns=5, optimizeAfterTurns=5 → triggers at 5+5=10
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            backgroundOptimization: {
              verbatimTurns: 5,
              optimizeAfterTurns: 5,
              optimizeIntervalMin: 1,
            },
          },
        },
      },
    };
    const result = checkBackgroundOptimization("custom-session", messages, cfg as any);
    expect(result.shouldOptimize).toBe(true);
  });
});

describe("clearOptimizationState", () => {
  it("removes tracked state", () => {
    markOptimizationDone("clear-test", 50);
    expect(SESSION_STATE.has("clear-test")).toBe(true);
    clearOptimizationState("clear-test");
    expect(SESSION_STATE.has("clear-test")).toBe(false);
  });
});

describe("maybeScheduleBackgroundOptimization", () => {
  it("does not call triggerCompaction when thresholds not met", () => {
    const trigger = vi.fn();
    maybeScheduleBackgroundOptimization({
      sessionId: "no-trigger",
      messages: makeMessages(10), // below verbatimTurns
      triggerCompaction: trigger,
    });
    expect(trigger).not.toHaveBeenCalled();
  });

  it("calls triggerCompaction when thresholds are met", async () => {
    const trigger = vi.fn().mockResolvedValue({ compacted: true });
    maybeScheduleBackgroundOptimization({
      sessionId: "trigger-test",
      messages: makeMessages(50),
      triggerCompaction: trigger,
    });
    // Fire-and-forget — wait for microtask
    await vi.waitFor(() => expect(trigger).toHaveBeenCalledTimes(1));
  });

  it("marks state immediately to prevent concurrent triggers", () => {
    const trigger = vi.fn().mockResolvedValue({ compacted: true });
    maybeScheduleBackgroundOptimization({
      sessionId: "concurrent-test",
      messages: makeMessages(50),
      triggerCompaction: trigger,
    });
    // State should be set immediately
    expect(SESSION_STATE.has("concurrent-test")).toBe(true);
    // Second call should NOT trigger (turns haven't increased)
    const trigger2 = vi.fn();
    maybeScheduleBackgroundOptimization({
      sessionId: "concurrent-test",
      messages: makeMessages(50),
      triggerCompaction: trigger2,
    });
    expect(trigger2).not.toHaveBeenCalled();
  });
});
