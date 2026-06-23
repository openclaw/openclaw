/**
 * E2E Integration Test for PR #90561
 *
 * Tests the actual modified functions to verify:
 * - Retry count increased to 5
 * - Jitter applied to delays
 * - Error messages don't leak task text
 */

import { describe, it, expect } from "vitest";
import {
  formatDefaultGiveUpError,
  resolveAnnounceRetryDelayMs,
  MAX_ANNOUNCE_RETRY_COUNT,
} from "./subagent-registry-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function createMockEntry(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "test-run-123",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "Sensitive task description with private data that should never leak",
    cleanup: "keep",
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("PR #90561 - Retry Constants", () => {
  it("MAX_ANNOUNCE_RETRY_COUNT should be 5", () => {
    expect(MAX_ANNOUNCE_RETRY_COUNT).toBe(5);
  });

  // MAX_ANNOUNCE_RETRY_DELAY_MS is a private constant, tested via behavior in delay tests
});

describe("PR #90561 - Retry Delay Jitter", () => {
  it("should apply jitter to retry delays", () => {
    const delays = new Set<number>();

    // Generate 20 delay samples for retry count 2
    for (let i = 0; i < 20; i++) {
      delays.add(resolveAnnounceRetryDelayMs(2));
    }

    // With jitter, we should get varied delays (not all the same)
    expect(delays.size).toBeGreaterThan(1);

    // All delays should be around 1500ms (base 2000ms * 0.75)
    delays.forEach((delay) => {
      expect(delay).toBeGreaterThanOrEqual(1000); // min: 2000/2
      expect(delay).toBeLessThanOrEqual(2000); // max: 2000
    });
  });

  it("should increase delays exponentially with retry count", () => {
    const delays = [1, 2, 3, 4, 5].map((count) => resolveAnnounceRetryDelayMs(count));

    // With jitter, delays should generally increase but not necessarily monotonically
    // Check that later delays are significantly larger than earlier ones
    expect(delays[4]).toBeGreaterThan(delays[0] * 4); // 5th should be >4x 1st
    expect(delays[3]).toBeGreaterThan(delays[1]); // 4th should be > 2nd

    // Check that delays are in reasonable ranges (with jitter)
    expect(delays[0]).toBeGreaterThanOrEqual(500); // 1st: ~1s base, jitter [0.5-1.0]
    expect(delays[0]).toBeLessThanOrEqual(1000);
    expect(delays[4]).toBeGreaterThanOrEqual(4000); // 5th: ~16s base, jitter [8-16]
    expect(delays[4]).toBeLessThanOrEqual(16000);
  });

  it("should cap delays at maximum retry delay", () => {
    // Test with high retry count (e.g., 10)
    for (let i = 0; i < 10; i++) {
      const delay = resolveAnnounceRetryDelayMs(10);
      // Should be capped at 30000ms with jitter range [15000, 30000]
      expect(delay).toBeGreaterThanOrEqual(15000);
      expect(delay).toBeLessThanOrEqual(30000);
    }
  });
});

describe("PR #90561 - Error Message Privacy", () => {
  it("should use label when available", () => {
    const entry = createMockEntry({
      label: "Data Analysis",
      task: "Sensitive task description with private data",
    });

    const error = formatDefaultGiveUpError(entry, "retry-limit");

    expect(error).toContain("Data Analysis");
    expect(error).not.toContain("Sensitive task description");
    expect(error).not.toContain("private data");
    expect(error).toContain("0 retries"); // no delivery attempts in mock
  });

  it("should use taskName when label is missing", () => {
    const entry = createMockEntry({
      taskName: "Code Review",
      task: "Another sensitive task",
    });

    const error = formatDefaultGiveUpError(entry, "retry-limit");

    expect(error).toContain("Code Review");
    expect(error).not.toContain("Another sensitive task");
  });

  it("should use generic 'subagent' when no label or taskName", () => {
    const entry = createMockEntry({
      task: "Top secret mission",
    });

    const error = formatDefaultGiveUpError(entry, "retry-limit");

    expect(error).toContain("subagent");
    expect(error).not.toContain("Top secret mission");
  });

  it("should include attempt count in error message", () => {
    const entry = createMockEntry({
      label: "Test",
      delivery: {
        status: "pending",
        attemptCount: 3,
      },
    });

    const error = formatDefaultGiveUpError(entry, "retry-limit");

    expect(error).toContain("3 retries");
  });

  it("should include reason in error message", () => {
    const entry = createMockEntry({
      label: "Test",
    });

    const retryLimitError = formatDefaultGiveUpError(entry, "retry-limit");
    const expiryError = formatDefaultGiveUpError(entry, "expiry");

    expect(retryLimitError).toContain("retry-limit");
    expect(expiryError).toContain("expiry");
  });
});
