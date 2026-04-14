import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isJudgeAccepted,
  loadJudgeOutcome,
  persistJudgeOutcome,
  shouldEscalateAfterRevise,
  type JudgeOutcome,
} from "./judge-gate.js";

describe("judge-gate", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "judge-gate-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const makeOutcome = (overrides: Partial<JudgeOutcome> = {}): JudgeOutcome => ({
    verdict: "ACCEPT",
    rationale: "All tests pass, contract satisfied.",
    reviseCount: 0,
    timestamp: new Date().toISOString(),
    ...overrides,
  });

  describe("persistJudgeOutcome / loadJudgeOutcome", () => {
    it("round-trips a judge outcome", () => {
      const outcome = makeOutcome({ taskId: "test-task-1" });
      persistJudgeOutcome(tempDir, "test-task-1", outcome);
      const loaded = loadJudgeOutcome(tempDir, "test-task-1");
      expect(loaded).toEqual({ ...outcome, taskId: "test-task-1" });
    });

    it("returns null for missing outcome", () => {
      expect(loadJudgeOutcome(tempDir, "nonexistent")).toBeNull();
    });

    it("creates nested directories", () => {
      const outcome = makeOutcome();
      const path = persistJudgeOutcome(tempDir, "deep/nested/task", outcome);
      expect(path).toContain("deep/nested/task/judge.json");
      expect(loadJudgeOutcome(tempDir, "deep/nested/task")).not.toBeNull();
    });
  });

  describe("isJudgeAccepted", () => {
    it("returns true for ACCEPT", () => {
      expect(isJudgeAccepted(makeOutcome({ verdict: "ACCEPT" }))).toBe(true);
    });

    it("returns false for REVISE", () => {
      expect(isJudgeAccepted(makeOutcome({ verdict: "REVISE" }))).toBe(false);
    });

    it("returns false for ESCALATE", () => {
      expect(isJudgeAccepted(makeOutcome({ verdict: "ESCALATE" }))).toBe(false);
    });

    it("returns false for null", () => {
      expect(isJudgeAccepted(null)).toBe(false);
    });
  });

  describe("shouldEscalateAfterRevise", () => {
    it("returns true when revise count meets threshold", () => {
      expect(shouldEscalateAfterRevise(makeOutcome({ verdict: "REVISE", reviseCount: 2 }))).toBe(
        true,
      );
    });

    it("returns false when below threshold", () => {
      expect(shouldEscalateAfterRevise(makeOutcome({ verdict: "REVISE", reviseCount: 1 }))).toBe(
        false,
      );
    });

    it("returns false for ACCEPT verdict", () => {
      expect(shouldEscalateAfterRevise(makeOutcome({ verdict: "ACCEPT", reviseCount: 5 }))).toBe(
        false,
      );
    });

    it("respects custom max revise count", () => {
      expect(shouldEscalateAfterRevise(makeOutcome({ verdict: "REVISE", reviseCount: 3 }), 4)).toBe(
        false,
      );
      expect(shouldEscalateAfterRevise(makeOutcome({ verdict: "REVISE", reviseCount: 4 }), 4)).toBe(
        true,
      );
    });
  });
});
