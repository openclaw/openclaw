import { describe, it, expect, beforeEach } from "vitest";
import {
  createBehavioralHealthMonitor,
  type BehavioralHealthMonitor,
  type HealthEvent,
} from "./behavioral-health-monitor.js";

describe("BehavioralHealthMonitor", () => {
  let monitor: BehavioralHealthMonitor;

  beforeEach(() => {
    monitor = createBehavioralHealthMonitor();
  });

  describe("initial state", () => {
    it("should start healthy with no events", () => {
      const assessment = monitor.assess();
      expect(assessment.status).toBe("healthy");
      expect(assessment.score).toBe(100);
      expect(assessment.degradations).toHaveLength(0);
      expect(assessment.suggestedAction).toBe("none");
    });

    it("should report zero event count initially", () => {
      expect(monitor.getEventCount()).toBe(0);
    });

    it("should have healthy status on quick check", () => {
      expect(monitor.getStatus()).toBe("healthy");
    });
  });

  describe("recording events", () => {
    it("should track event count", () => {
      monitor.recordEvent(makeEvent({ toolName: "read", success: true }));
      monitor.recordEvent(makeEvent({ toolName: "write", success: true }));
      expect(monitor.getEventCount()).toBe(2);
    });

    it("should remain healthy with successful events", () => {
      // Use varying tool names and params to avoid loop detection
      const tools = ["read", "write", "exec", "edit", "search"];
      for (let i = 0; i < 10; i++) {
        monitor.recordEvent(
          makeEvent({
            toolName: tools[i % tools.length],
            success: true,
            params: { id: i },
          }),
        );
      }
      const assessment = monitor.assess();
      expect(assessment.status).toBe("healthy");
      expect(assessment.score).toBe(100);
    });

    it("should bound event buffer to 2x window size", () => {
      const m = createBehavioralHealthMonitor({ windowSize: 5 });
      for (let i = 0; i < 20; i++) {
        m.recordEvent(makeEvent({ toolName: "read", success: true }));
      }
      // Buffer should be capped at 2 * 5 = 10
      expect(m.getEventCount()).toBe(10);
    });
  });

  describe("failure streak detection", () => {
    it("should detect 3 consecutive failures (default threshold)", () => {
      monitor.recordEvent(makeEvent({ toolName: "exec", success: true }));
      monitor.recordEvent(makeEvent({ toolName: "exec", success: false }));
      monitor.recordEvent(makeEvent({ toolName: "read", success: false }));
      monitor.recordEvent(makeEvent({ toolName: "write", success: false }));

      const assessment = monitor.assess();
      const streakReport = assessment.degradations.find((d) => d.signal === "failure_streak");
      expect(streakReport).toBeDefined();
      expect(streakReport!.affectedTools).toContain("exec");
      expect(streakReport!.affectedTools).toContain("read");
      expect(streakReport!.affectedTools).toContain("write");
    });

    it("should not trigger for 2 failures (below threshold)", () => {
      monitor.recordEvent(makeEvent({ toolName: "exec", success: false }));
      monitor.recordEvent(makeEvent({ toolName: "read", success: false }));

      const assessment = monitor.assess();
      const streakReport = assessment.degradations.find((d) => d.signal === "failure_streak");
      expect(streakReport).toBeUndefined();
    });

    it("should reset streak on success", () => {
      monitor.recordEvent(makeEvent({ toolName: "exec", success: false }));
      monitor.recordEvent(makeEvent({ toolName: "exec", success: false }));
      monitor.recordEvent(makeEvent({ toolName: "exec", success: true })); // resets
      monitor.recordEvent(makeEvent({ toolName: "exec", success: false }));

      const assessment = monitor.assess();
      const streakReport = assessment.degradations.find((d) => d.signal === "failure_streak");
      expect(streakReport).toBeUndefined();
    });

    it("should use custom threshold", () => {
      const m = createBehavioralHealthMonitor({ failureStreakThreshold: 5 });
      for (let i = 0; i < 4; i++) {
        m.recordEvent(makeEvent({ toolName: "exec", success: false }));
      }
      expect(m.assess().degradations.find((d) => d.signal === "failure_streak")).toBeUndefined();

      m.recordEvent(makeEvent({ toolName: "exec", success: false }));
      expect(m.assess().degradations.find((d) => d.signal === "failure_streak")).toBeDefined();
    });
  });

  describe("execution loop detection", () => {
    it("should detect 3 identical consecutive calls", () => {
      const params = { path: "/test/file.ts" };
      monitor.recordEvent(makeEvent({ toolName: "read", success: true, params }));
      monitor.recordEvent(makeEvent({ toolName: "read", success: true, params }));
      monitor.recordEvent(makeEvent({ toolName: "read", success: true, params }));

      const assessment = monitor.assess();
      const loopReport = assessment.degradations.find((d) => d.signal === "execution_loop");
      expect(loopReport).toBeDefined();
      expect(loopReport!.affectedTools).toContain("read");
      expect(loopReport!.detail).toContain("3 times");
    });

    it("should not trigger for different params", () => {
      monitor.recordEvent(
        makeEvent({ toolName: "read", success: true, params: { path: "/a.ts" } }),
      );
      monitor.recordEvent(
        makeEvent({ toolName: "read", success: true, params: { path: "/b.ts" } }),
      );
      monitor.recordEvent(
        makeEvent({ toolName: "read", success: true, params: { path: "/c.ts" } }),
      );

      const assessment = monitor.assess();
      expect(assessment.degradations.find((d) => d.signal === "execution_loop")).toBeUndefined();
    });

    it("should not trigger for different tools", () => {
      monitor.recordEvent(makeEvent({ toolName: "read", success: true }));
      monitor.recordEvent(makeEvent({ toolName: "write", success: true }));
      monitor.recordEvent(makeEvent({ toolName: "exec", success: true }));

      const assessment = monitor.assess();
      expect(assessment.degradations.find((d) => d.signal === "execution_loop")).toBeUndefined();
    });

    it("should handle param key ordering consistently", () => {
      monitor.recordEvent(makeEvent({ toolName: "edit", success: true, params: { a: 1, b: 2 } }));
      monitor.recordEvent(makeEvent({ toolName: "edit", success: true, params: { b: 2, a: 1 } }));
      monitor.recordEvent(makeEvent({ toolName: "edit", success: true, params: { a: 1, b: 2 } }));

      const assessment = monitor.assess();
      const loopReport = assessment.degradations.find((d) => d.signal === "execution_loop");
      expect(loopReport).toBeDefined();
    });
  });

  describe("rising error rate detection", () => {
    it("should detect high error rate in window", () => {
      // 4 failures out of 5 = 80% > 60% threshold
      monitor.recordEvent(makeEvent({ toolName: "exec", success: false }));
      monitor.recordEvent(makeEvent({ toolName: "exec", success: false }));
      monitor.recordEvent(makeEvent({ toolName: "read", success: true }));
      monitor.recordEvent(makeEvent({ toolName: "write", success: false }));
      monitor.recordEvent(makeEvent({ toolName: "exec", success: false }));

      const assessment = monitor.assess();
      const errorReport = assessment.degradations.find((d) => d.signal === "rising_error_rate");
      expect(errorReport).toBeDefined();
      expect(errorReport!.detail).toContain("80%");
    });

    it("should not trigger with low error rate", () => {
      // 1 failure out of 5 = 20% < 60% threshold
      monitor.recordEvent(makeEvent({ toolName: "exec", success: true }));
      monitor.recordEvent(makeEvent({ toolName: "exec", success: true }));
      monitor.recordEvent(makeEvent({ toolName: "read", success: true }));
      monitor.recordEvent(makeEvent({ toolName: "write", success: true }));
      monitor.recordEvent(makeEvent({ toolName: "exec", success: false }));

      const assessment = monitor.assess();
      expect(assessment.degradations.find((d) => d.signal === "rising_error_rate")).toBeUndefined();
    });

    it("should not trigger with fewer than 5 events", () => {
      monitor.recordEvent(makeEvent({ toolName: "exec", success: false }));
      monitor.recordEvent(makeEvent({ toolName: "exec", success: false }));
      monitor.recordEvent(makeEvent({ toolName: "exec", success: false }));

      const assessment = monitor.assess();
      expect(assessment.degradations.find((d) => d.signal === "rising_error_rate")).toBeUndefined();
    });

    it("should rank affected tools by failure count", () => {
      monitor.recordEvent(makeEvent({ toolName: "exec", success: false }));
      monitor.recordEvent(makeEvent({ toolName: "exec", success: false }));
      monitor.recordEvent(makeEvent({ toolName: "exec", success: false }));
      monitor.recordEvent(makeEvent({ toolName: "read", success: false }));
      monitor.recordEvent(makeEvent({ toolName: "read", success: false }));

      const assessment = monitor.assess();
      const errorReport = assessment.degradations.find((d) => d.signal === "rising_error_rate");
      expect(errorReport).toBeDefined();
      expect(errorReport!.affectedTools[0]).toBe("exec"); // More failures
      expect(errorReport!.affectedTools[1]).toBe("read");
    });
  });

  describe("context exhaustion detection", () => {
    it("should detect critical context usage (>= 90%)", () => {
      monitor.recordEvent(makeEvent({ toolName: "read", success: true, contextUsagePercent: 92 }));

      const assessment = monitor.assess();
      const contextReport = assessment.degradations.find((d) => d.signal === "context_exhaustion");
      expect(contextReport).toBeDefined();
      expect(contextReport!.severity).toBe(1);
      expect(contextReport!.suggestedAction).toBe("compact_context");
    });

    it("should detect warning-level context usage (>= 70%, < 90%)", () => {
      monitor.recordEvent(makeEvent({ toolName: "read", success: true, contextUsagePercent: 78 }));

      const assessment = monitor.assess();
      const contextReport = assessment.degradations.find((d) => d.signal === "context_exhaustion");
      expect(contextReport).toBeDefined();
      expect(contextReport!.severity).toBeLessThan(1);
      expect(contextReport!.suggestedAction).toBe("warn");
    });

    it("should not trigger below warning threshold", () => {
      monitor.recordEvent(makeEvent({ toolName: "read", success: true, contextUsagePercent: 50 }));

      const assessment = monitor.assess();
      expect(
        assessment.degradations.find((d) => d.signal === "context_exhaustion"),
      ).toBeUndefined();
    });

    it("should use most recent context usage", () => {
      monitor.recordEvent(makeEvent({ toolName: "read", success: true, contextUsagePercent: 95 }));
      monitor.recordEvent(makeEvent({ toolName: "write", success: true, contextUsagePercent: 50 }));

      const assessment = monitor.assess();
      // Most recent is 50%, which is below warning threshold
      expect(
        assessment.degradations.find((d) => d.signal === "context_exhaustion"),
      ).toBeUndefined();
    });

    it("should use custom thresholds", () => {
      const m = createBehavioralHealthMonitor({
        contextWarningThreshold: 50,
        contextCriticalThreshold: 80,
      });
      m.recordEvent(makeEvent({ toolName: "read", success: true, contextUsagePercent: 55 }));

      const assessment = m.assess();
      expect(assessment.degradations.find((d) => d.signal === "context_exhaustion")).toBeDefined();
    });
  });

  describe("stalled progress detection", () => {
    it("should detect stalled progress after threshold failures", () => {
      for (let i = 0; i < 8; i++) {
        monitor.recordEvent(makeEvent({ toolName: "exec", success: false }));
      }

      const assessment = monitor.assess();
      const stalledReport = assessment.degradations.find((d) => d.signal === "stalled_progress");
      expect(stalledReport).toBeDefined();
      expect(stalledReport!.detail).toContain("8");
    });

    it("should not trigger if recent success exists", () => {
      for (let i = 0; i < 6; i++) {
        monitor.recordEvent(makeEvent({ toolName: "exec", success: false }));
      }
      monitor.recordEvent(makeEvent({ toolName: "exec", success: true })); // breaks the stall
      monitor.recordEvent(makeEvent({ toolName: "exec", success: false }));

      const assessment = monitor.assess();
      expect(assessment.degradations.find((d) => d.signal === "stalled_progress")).toBeUndefined();
    });
  });

  describe("overall health assessment", () => {
    it("should combine multiple degradation signals", () => {
      // Create a scenario with both failure streak and rising error rate
      for (let i = 0; i < 5; i++) {
        monitor.recordEvent(makeEvent({ toolName: "exec", success: false }));
      }

      const assessment = monitor.assess();
      expect(assessment.degradations.length).toBeGreaterThanOrEqual(2);
      expect(assessment.status).not.toBe("healthy");
    });

    it("should compute degraded status for moderate issues", () => {
      // 3 consecutive failures (just above threshold)
      monitor.recordEvent(makeEvent({ toolName: "exec", success: true }));
      monitor.recordEvent(makeEvent({ toolName: "exec", success: true }));
      monitor.recordEvent(makeEvent({ toolName: "exec", success: true }));
      monitor.recordEvent(makeEvent({ toolName: "exec", success: true }));
      monitor.recordEvent(makeEvent({ toolName: "exec", success: true }));
      monitor.recordEvent(makeEvent({ toolName: "exec", success: false }));
      monitor.recordEvent(makeEvent({ toolName: "read", success: false }));
      monitor.recordEvent(makeEvent({ toolName: "write", success: false }));

      const assessment = monitor.assess();
      // Should be degraded but not necessarily critical
      expect(assessment.score).toBeLessThan(100);
    });

    it("should reach critical status with severe degradation", () => {
      // Many failures + context exhaustion
      for (let i = 0; i < 10; i++) {
        monitor.recordEvent(
          makeEvent({
            toolName: "exec",
            success: false,
            contextUsagePercent: 95,
          }),
        );
      }

      const assessment = monitor.assess();
      expect(assessment.status).toBe("critical");
      expect(assessment.score).toBeLessThan(40);
    });

    it("should pick the highest-priority intervention", () => {
      // Context exhaustion should suggest compact_context
      monitor.recordEvent(
        makeEvent({
          toolName: "read",
          success: false,
          contextUsagePercent: 95,
        }),
      );
      monitor.recordEvent(makeEvent({ toolName: "read", success: false }));
      monitor.recordEvent(makeEvent({ toolName: "read", success: false }));

      const assessment = monitor.assess();
      // compact_context should be present among degradations
      const hasCompact = assessment.degradations.some(
        (d) => d.suggestedAction === "compact_context",
      );
      expect(hasCompact).toBe(true);
    });

    it("should produce meaningful summaries", () => {
      const healthyAssessment = monitor.assess();
      expect(healthyAssessment.summary).toBe("Agent is operating normally.");

      // Create degraded state
      for (let i = 0; i < 5; i++) {
        monitor.recordEvent(makeEvent({ toolName: "exec", success: false }));
      }

      const degradedAssessment = monitor.assess();
      expect(degradedAssessment.summary).not.toBe("Agent is operating normally.");
      expect(degradedAssessment.summary.length).toBeGreaterThan(0);
    });
  });

  describe("reset", () => {
    it("should clear all events and restore healthy state", () => {
      for (let i = 0; i < 10; i++) {
        monitor.recordEvent(makeEvent({ toolName: "exec", success: false }));
      }

      expect(monitor.getStatus()).not.toBe("healthy");

      monitor.reset();

      expect(monitor.getEventCount()).toBe(0);
      expect(monitor.getStatus()).toBe("healthy");
      expect(monitor.assess().score).toBe(100);
    });
  });

  describe("custom configuration", () => {
    it("should respect custom window size", () => {
      // Use a window of 5 (minimum for rising_error_rate detection)
      const m = createBehavioralHealthMonitor({ windowSize: 5, errorRateThreshold: 0.5 });

      // Fill with successes then failures so the window slides
      m.recordEvent(makeEvent({ toolName: "exec", success: true }));
      m.recordEvent(makeEvent({ toolName: "read", success: true }));
      m.recordEvent(makeEvent({ toolName: "write", success: false }));
      m.recordEvent(makeEvent({ toolName: "exec", success: false }));
      m.recordEvent(makeEvent({ toolName: "read", success: false }));
      // Window is [success, success, fail, fail, fail] — 60% error rate >= 50%

      const assessment = m.assess();
      const errorReport = assessment.degradations.find((d) => d.signal === "rising_error_rate");
      expect(errorReport).toBeDefined();
    });

    it("should respect custom loop detection threshold", () => {
      const m = createBehavioralHealthMonitor({ loopDetectionThreshold: 2 });

      const params = { path: "/test" };
      m.recordEvent(makeEvent({ toolName: "read", success: true, params }));
      m.recordEvent(makeEvent({ toolName: "read", success: true, params }));

      const assessment = m.assess();
      expect(assessment.degradations.find((d) => d.signal === "execution_loop")).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(
  overrides: Partial<HealthEvent> & { toolName: string; success: boolean },
): HealthEvent {
  return {
    timestamp: Date.now(),
    ...overrides,
  };
}
