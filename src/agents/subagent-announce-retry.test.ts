import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  calculateRetryTimeout,
  listFailedAnnounces,
  loadFailedAnnounce,
  persistFailedAnnounce,
  removeFailedAnnounce,
  resolveFailedAnnounceDir,
  withAnnounceRetry,
  type FailedAnnouncePayload,
} from "./subagent-announce-retry.js";

// Mock the config and runtime
vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    agents: {
      defaults: {
        subagents: {
          announceTimeoutMs: 60_000,
        },
      },
    },
  })),
  resolveStateDir: vi.fn(() => "/tmp/openclaw-test-state"),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

describe("subagent-announce-retry", () => {
  const testStateDir = "/tmp/openclaw-test-state";
  const testFailedDir = path.join(testStateDir, "announce-failed");

  beforeEach(() => {
    // Clean up test directory
    if (fs.existsSync(testFailedDir)) {
      fs.rmSync(testFailedDir, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up test directory
    if (fs.existsSync(testFailedDir)) {
      fs.rmSync(testFailedDir, { recursive: true });
    }
    vi.clearAllMocks();
  });

  describe("calculateRetryTimeout", () => {
    it("returns base timeout for first attempt", () => {
      const config = { baseTimeoutMs: 60_000, maxRetries: 3, backoffMultiplier: 2 };
      expect(calculateRetryTimeout(1, config)).toBe(60_000);
    });

    it("doubles timeout for second attempt", () => {
      const config = { baseTimeoutMs: 60_000, maxRetries: 3, backoffMultiplier: 2 };
      expect(calculateRetryTimeout(2, config)).toBe(120_000);
    });

    it("quadruples timeout for third attempt", () => {
      const config = { baseTimeoutMs: 60_000, maxRetries: 3, backoffMultiplier: 2 };
      expect(calculateRetryTimeout(3, config)).toBe(240_000);
    });

    it("caps timeout at 5 minutes", () => {
      const config = { baseTimeoutMs: 200_000, maxRetries: 3, backoffMultiplier: 2 };
      expect(calculateRetryTimeout(3, config)).toBe(300_000);
    });
  });

  describe("persistFailedAnnounce", () => {
    it("creates directory and writes payload", () => {
      const payload: FailedAnnouncePayload = {
        sessionId: "test-session-123",
        childSessionKey: "agent:worker:subagent:abc",
        childRunId: "run-456",
        requesterSessionKey: "agent:main:slack:dm:u1",
        task: "Test task",
        result: "Task completed",
        timestamp: Date.now(),
        attempts: 3,
        lastAttemptAt: Date.now(),
        lastError: "gateway timeout",
      };

      const filepath = persistFailedAnnounce(payload);

      expect(fs.existsSync(filepath)).toBe(true);
      const saved = JSON.parse(fs.readFileSync(filepath, "utf-8"));
      expect(saved.sessionId).toBe("test-session-123");
      expect(saved.task).toBe("Test task");
    });

    it("sanitizes sessionId for filename", () => {
      const payload: FailedAnnouncePayload = {
        sessionId: "agent:main:slack/dm:u1:thread",
        childSessionKey: "agent:worker:subagent:abc",
        childRunId: "run-456",
        requesterSessionKey: "agent:main:slack:dm:u1",
        task: "Test task",
        result: "Result",
        timestamp: Date.now(),
        attempts: 1,
        lastAttemptAt: Date.now(),
      };

      const filepath = persistFailedAnnounce(payload);
      expect(path.basename(filepath)).not.toContain(":");
      expect(path.basename(filepath)).not.toContain("/");
    });
  });

  describe("loadFailedAnnounce", () => {
    it("returns undefined for non-existent session", () => {
      const result = loadFailedAnnounce("non-existent");
      expect(result).toBeUndefined();
    });

    it("loads persisted payload", () => {
      const payload: FailedAnnouncePayload = {
        sessionId: "load-test-session",
        childSessionKey: "agent:worker:subagent:abc",
        childRunId: "run-456",
        requesterSessionKey: "agent:main:slack:dm:u1",
        task: "Load test",
        result: "Result",
        timestamp: 1234567890,
        attempts: 2,
        lastAttemptAt: 1234567900,
      };

      persistFailedAnnounce(payload);
      const loaded = loadFailedAnnounce("load-test-session");

      expect(loaded).toBeDefined();
      expect(loaded?.task).toBe("Load test");
      expect(loaded?.attempts).toBe(2);
    });
  });

  describe("listFailedAnnounces", () => {
    it("returns empty array when no failures", () => {
      const list = listFailedAnnounces();
      expect(list).toEqual([]);
    });

    it("lists all failed announcements sorted by timestamp", () => {
      const older: FailedAnnouncePayload = {
        sessionId: "older-session",
        childSessionKey: "agent:worker:subagent:old",
        childRunId: "run-old",
        requesterSessionKey: "agent:main:slack:dm:u1",
        task: "Older task",
        result: "Result",
        timestamp: 1000,
        attempts: 1,
        lastAttemptAt: 1000,
      };

      const newer: FailedAnnouncePayload = {
        sessionId: "newer-session",
        childSessionKey: "agent:worker:subagent:new",
        childRunId: "run-new",
        requesterSessionKey: "agent:main:slack:dm:u1",
        task: "Newer task",
        result: "Result",
        timestamp: 2000,
        attempts: 1,
        lastAttemptAt: 2000,
      };

      persistFailedAnnounce(older);
      persistFailedAnnounce(newer);

      const list = listFailedAnnounces();
      expect(list).toHaveLength(2);
      expect(list[0].sessionId).toBe("newer-session");
      expect(list[1].sessionId).toBe("older-session");
    });
  });

  describe("removeFailedAnnounce", () => {
    it("returns false for non-existent session", () => {
      const result = removeFailedAnnounce("non-existent");
      expect(result).toBe(false);
    });

    it("removes persisted payload and returns true", () => {
      const payload: FailedAnnouncePayload = {
        sessionId: "remove-test",
        childSessionKey: "agent:worker:subagent:abc",
        childRunId: "run-456",
        requesterSessionKey: "agent:main:slack:dm:u1",
        task: "Remove test",
        result: "Result",
        timestamp: Date.now(),
        attempts: 1,
        lastAttemptAt: Date.now(),
      };

      persistFailedAnnounce(payload);
      expect(loadFailedAnnounce("remove-test")).toBeDefined();

      const removed = removeFailedAnnounce("remove-test");
      expect(removed).toBe(true);
      expect(loadFailedAnnounce("remove-test")).toBeUndefined();
    });
  });

  describe("withAnnounceRetry", () => {
    it("returns success on first attempt if no error", async () => {
      const fn = vi.fn().mockResolvedValue("success");

      const result = await withAnnounceRetry(fn, { sessionId: "test-session" });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toBe("success");
      }
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("retries on failure with exponential backoff", async () => {
      const timeouts: number[] = [];
      const fn = vi.fn().mockImplementation((attempt, timeoutMs) => {
        timeouts.push(timeoutMs);
        if (attempt < 3) {
          throw new Error(`Attempt ${attempt} failed`);
        }
        return "success";
      });

      const result = await withAnnounceRetry(fn, { sessionId: "test-session" });

      expect(result.success).toBe(true);
      expect(fn).toHaveBeenCalledTimes(3);
      expect(timeouts[0]).toBe(60_000);
      expect(timeouts[1]).toBe(120_000);
      expect(timeouts[2]).toBe(240_000);
    });

    it("returns failure after max retries exhausted", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("persistent failure"));

      const result = await withAnnounceRetry(fn, { sessionId: "test-session" });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.attempts).toBe(3);
        expect(result.lastError).toBe("persistent failure");
      }
    });

    it("calls onAttempt callback for each attempt", async () => {
      const onAttempt = vi.fn();
      const fn = vi.fn().mockRejectedValue(new Error("fail"));

      await withAnnounceRetry(fn, {
        sessionId: "test-session",
        onAttempt,
      });

      expect(onAttempt).toHaveBeenCalledTimes(3);
      expect(onAttempt).toHaveBeenCalledWith(1, 60_000);
      expect(onAttempt).toHaveBeenCalledWith(2, 120_000);
      expect(onAttempt).toHaveBeenCalledWith(3, 240_000);
    });

    it("calls onFailure callback for each failed attempt", async () => {
      const onFailure = vi.fn();
      const fn = vi.fn().mockRejectedValue(new Error("test error"));

      await withAnnounceRetry(fn, {
        sessionId: "test-session",
        onFailure,
      });

      expect(onFailure).toHaveBeenCalledTimes(3);
    });
  });
});
