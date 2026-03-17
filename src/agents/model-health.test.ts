import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ModelHealthTracker,
  resetModelHealthTracker,
  getModelHealthTracker,
} from "./model-health.js";

describe("ModelHealthTracker", () => {
  beforeEach(() => {
    resetModelHealthTracker();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-17T10:00:00Z"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("circuit breaker state machine", () => {
    it("keeps circuit closed when failure rate is below threshold", () => {
      const tracker = new ModelHealthTracker({
        enabled: true,
        failureThreshold: 0.7,
        minSamples: 5,
      });

      // 4 successes, 1 failure = 20% failure rate (below 70% threshold)
      tracker.record("anthropic", "claude-opus", true);
      tracker.record("anthropic", "claude-opus", true);
      tracker.record("anthropic", "claude-opus", true);
      tracker.record("anthropic", "claude-opus", true);
      tracker.record("anthropic", "claude-opus", false);

      const health = tracker.getHealth("anthropic", "claude-opus");
      expect(health?.state).toBe("closed");
      expect(tracker.canAttempt("anthropic", "claude-opus")).toBe(true);
    });

    it("opens circuit when failure rate exceeds threshold", () => {
      const tracker = new ModelHealthTracker({
        enabled: true,
        failureThreshold: 0.7,
        minSamples: 5,
        openDurationMs: 2 * 60_000,
      });

      // 1 success, 4 failures = 80% failure rate (above 70% threshold)
      tracker.record("anthropic", "claude-opus", true);
      tracker.record("anthropic", "claude-opus", false);
      tracker.record("anthropic", "claude-opus", false);
      tracker.record("anthropic", "claude-opus", false);
      tracker.record("anthropic", "claude-opus", false);

      const health = tracker.getHealth("anthropic", "claude-opus");
      expect(health?.state).toBe("open");
      expect(tracker.canAttempt("anthropic", "claude-opus")).toBe(false);
    });

    it("transitions to half-open after open duration expires", () => {
      const tracker = new ModelHealthTracker({
        enabled: true,
        failureThreshold: 0.7,
        minSamples: 5,
        openDurationMs: 2 * 60_000,
      });

      // Trip the circuit
      for (let i = 0; i < 5; i++) {
        tracker.record("anthropic", "claude-opus", i === 0);
      }
      expect(tracker.getHealth("anthropic", "claude-opus")?.state).toBe("open");

      // Try immediately - should be blocked
      expect(tracker.canAttempt("anthropic", "claude-opus")).toBe(false);

      // Advance past open duration
      vi.advanceTimersByTime(2 * 60_000 + 1000);

      // Now should be half-open and allow one probe
      expect(tracker.canAttempt("anthropic", "claude-opus")).toBe(true);
      const health = tracker.getHealth("anthropic", "claude-opus");
      expect(health?.state).toBe("half-open");
    });

    it("recovers to closed after successful half-open probe", () => {
      const tracker = new ModelHealthTracker({
        enabled: true,
        failureThreshold: 0.7,
        minSamples: 5,
        openDurationMs: 2 * 60_000,
      });

      // Trip the circuit
      for (let i = 0; i < 5; i++) {
        tracker.record("anthropic", "claude-opus", i === 0);
      }

      // Advance past open duration
      vi.advanceTimersByTime(2 * 60_000 + 1000);

      // Half-open should allow a probe
      expect(tracker.canAttempt("anthropic", "claude-opus")).toBe(true);

      // Record success
      tracker.record("anthropic", "claude-opus", true);

      // Should be closed again
      const health = tracker.getHealth("anthropic", "claude-opus");
      expect(health?.state).toBe("closed");
    });

    it("reopens circuit if half-open probe fails", () => {
      const tracker = new ModelHealthTracker({
        enabled: true,
        failureThreshold: 0.7,
        minSamples: 5,
        openDurationMs: 2 * 60_000,
        backoffMultiplier: 2,
      });

      // Trip the circuit
      for (let i = 0; i < 5; i++) {
        tracker.record("anthropic", "claude-opus", i === 0);
      }

      // Advance past open duration
      vi.advanceTimersByTime(2 * 60_000 + 1000);

      // Half-open allows a probe
      expect(tracker.canAttempt("anthropic", "claude-opus")).toBe(true);

      // Probe fails - circuit should reopen with backoff
      tracker.record("anthropic", "claude-opus", false);

      // Should still be open
      const health = tracker.getHealth("anthropic", "claude-opus");
      expect(health?.state).toBe("open");
      expect(tracker.canAttempt("anthropic", "claude-opus")).toBe(false);
    });
  });

  describe("sliding window", () => {
    it("resets counters when window expires", () => {
      const tracker = new ModelHealthTracker({
        enabled: true,
        windowMs: 5 * 60_000,
        failureThreshold: 0.7,
        minSamples: 5,
      });

      // Record 5 failures in first window
      for (let i = 0; i < 5; i++) {
        tracker.record("anthropic", "claude-opus", false);
      }

      let health = tracker.getHealth("anthropic", "claude-opus");
      expect(health?.failures).toBe(5);
      expect(health?.failureRate).toBeCloseTo(1.0); // 100% failure

      // Advance past window duration
      vi.advanceTimersByTime(5 * 60_000 + 1000);

      // Record a success in new window
      tracker.record("anthropic", "claude-opus", true);

      health = tracker.getHealth("anthropic", "claude-opus");
      expect(health?.failures).toBe(0);
      expect(health?.successes).toBe(1);
    });
  });

  describe("exponential backoff", () => {
    it("multiplies open duration on consecutive failures", () => {
      const tracker = new ModelHealthTracker({
        enabled: true,
        failureThreshold: 0.7,
        minSamples: 5,
        openDurationMs: 60_000, // 1 minute
        backoffMultiplier: 2,
      });

      // First trip: 1 min open
      for (let i = 0; i < 5; i++) {
        tracker.record("anthropic", "claude-opus", i === 0);
      }
      let health = tracker.getHealth("anthropic", "claude-opus");
      expect(health?.circuitTrips).toBe(1);

      // Advance past first open duration
      vi.advanceTimersByTime(60_000 + 1000);
      tracker.canAttempt("anthropic", "claude-opus"); // transition to half-open

      // Second trip: should be 2 min open now
      tracker.record("anthropic", "claude-opus", false);
      health = tracker.getHealth("anthropic", "claude-opus");
      expect(health?.circuitTrips).toBe(2);
      expect(health?.state).toBe("open");

      // Verify we can't attempt for 2 minutes
      vi.advanceTimersByTime(1 * 60_000 + 1000); // advance 1 min
      expect(tracker.canAttempt("anthropic", "claude-opus")).toBe(false);

      // After 2 minutes, should transition to half-open
      vi.advanceTimersByTime(1 * 60_000); // advance another 1 min
      expect(tracker.canAttempt("anthropic", "claude-opus")).toBe(true);
    });
  });

  describe("multiple models", () => {
    it("tracks health independently for each model", () => {
      const tracker = new ModelHealthTracker({
        enabled: true,
        failureThreshold: 0.7,
        minSamples: 5,
      });

      // Opus: 4 successes, 1 failure = healthy
      for (let i = 0; i < 4; i++) {
        tracker.record("anthropic", "claude-opus", true);
      }
      tracker.record("anthropic", "claude-opus", false);

      // Sonnet: 1 success, 4 failures = circuit opens
      tracker.record("anthropic", "claude-sonnet", true);
      for (let i = 0; i < 4; i++) {
        tracker.record("anthropic", "claude-sonnet", false);
      }

      const opusHealth = tracker.getHealth("anthropic", "claude-opus");
      const sonnetHealth = tracker.getHealth("anthropic", "claude-sonnet");

      expect(opusHealth?.state).toBe("closed");
      expect(sonnetHealth?.state).toBe("open");
    });
  });

  describe("disabled mode", () => {
    it("returns true for canAttempt when disabled", () => {
      const tracker = new ModelHealthTracker({
        enabled: false,
      });

      for (let i = 0; i < 10; i++) {
        tracker.record("anthropic", "claude-opus", false);
      }

      expect(tracker.canAttempt("anthropic", "claude-opus")).toBe(true);
    });

    it("doesn't track failures when disabled", () => {
      const tracker = new ModelHealthTracker({
        enabled: false,
      });

      for (let i = 0; i < 5; i++) {
        tracker.record("anthropic", "claude-opus", false);
      }

      const health = tracker.getHealth("anthropic", "claude-opus");
      expect(health).toBeNull();
    });
  });

  describe("singleton instance", () => {
    it("returns same instance on multiple calls", () => {
      resetModelHealthTracker();
      const tracker1 = getModelHealthTracker();
      const tracker2 = getModelHealthTracker();
      expect(tracker1).toBe(tracker2);
    });

    it("initializes with config on first call", () => {
      resetModelHealthTracker();
      const config = { enabled: true, failureThreshold: 0.5 };
      const tracker = getModelHealthTracker(config);
      expect(tracker.getConfig().failureThreshold).toBe(0.5);
    });
  });
});
