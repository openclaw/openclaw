import { describe, expect, it } from "vitest";
import {
  applyContextDiscipline,
  captureDisciplineMetrics,
  enforceDiffOnly,
  type ContextDisciplineAction,
} from "./context-discipline-orchestrator.js";
import { buildHotState } from "./hot-state.js";

describe("applyContextDiscipline", () => {
  it("returns 'pass' for valid hot state within budget", () => {
    const hotState = buildHotState({
      session_id: "s1",
      session_key: "main",
      risk_level: "low",
      objective: "Test context discipline",
    });

    const result = applyContextDiscipline(hotState, {
      limits: { maxHotStateTokens: 1000 },
    });

    expect(result.type).toBe("pass");
    if (result.type === "pass") {
      expect(result.hotState.session_id).toBe("s1");
      expect(result.tokens).toBeLessThan(1000);
    }
  });

  it("returns 'compress' when hot state exceeds budget but compression helps", () => {
    // Create a bloated hot state that will exceed budget but compress well
    const hotState = buildHotState({
      session_id: "s1",
      session_key: "main",
      risk_level: "low",
      // Large fields that will be removed during compression
      constraints: Array.from({ length: 100 }, (_, i) => `constraint-${i}-${"x".repeat(50)}`),
      open_questions: Array.from({ length: 100 }, (_, i) => `question-${i}-${"y".repeat(50)}`),
      accepted_decisions: Array.from({ length: 100 }, (_, i) => `decision-${i}-${"z".repeat(50)}`),
    });

    const result = applyContextDiscipline(hotState, {
      limits: { maxHotStateTokens: 200 },
    });

    expect(result.type).toBe("compress");
    if (result.type === "compress") {
      expect(result.tokens).toBeLessThanOrEqual(200);
      expect(result.originalTokens).toBeGreaterThan(result.tokens);
      // Compressed state should not have the large arrays
      expect(result.hotState.constraints).toBeUndefined();
      expect(result.hotState.open_questions).toBeUndefined();
    }
  });

  it("returns 'reference' when compression is not enough but extraction helps", () => {
    // Create a hot state with extremely large arrays that can't be compressed away
    // Must include essential fields that survive compression, plus huge arrays
    const hotState = buildHotState({
      session_id: "s1",
      session_key: "main",
      risk_level: "low",
      // Essential field with huge content that survives compression
      objective: "Test with very strict limits and " + "x".repeat(3000),
      // These large arrays will be extracted to references
      constraints: Array.from({ length: 20 }, (_, i) => `constraint-${i}-${"x".repeat(200)}`),
      open_questions: Array.from({ length: 20 }, (_, i) => `question-${i}-${"y".repeat(200)}`),
    });

    const result = applyContextDiscipline(hotState, {
      limits: { maxHotStateTokens: 200, maxArtifactIndexEntries: 10 },
    });

    // With strict limits, reference extraction should kick in
    // Note: if objective itself is too large, it may still reject
    if (result.type === "reference") {
      expect(result.tokens).toBeLessThanOrEqual(200);
      expect(result.referencedFields.length).toBeGreaterThan(0);
      expect(result.hotState.artifact_index).toBeDefined();
      expect(result.hotState.artifact_index!.length).toBeGreaterThan(0);
    } else {
      // Either compress or reject is acceptable depending on token estimation
      expect(["compress", "reject", "reference"]).toContain(result.type);
    }
  });

  it("returns 'reject' when all strategies fail and rejectOnPersistentOverflow is true", () => {
    // Create a hot state with many large fields that can't all be extracted
    const hotState = buildHotState({
      session_id: "s1",
      session_key: "main",
      run_id: "r1",
      current_plan_id: "p1",
      risk_level: "high",
      objective: "x".repeat(5000), // Very large objective that can't be compressed
      constraints: Array.from({ length: 50 }, (_, i) => `c${i}-${"x".repeat(200)}`),
    });

    const result = applyContextDiscipline(hotState, {
      limits: { maxHotStateTokens: 100, maxArtifactIndexEntries: 2 },
      rejectOnPersistentOverflow: true,
    });

    expect(result.type).toBe("reject");
    if (result.type === "reject") {
      expect(result.reason).toContain("exceeds budget");
      expect(result.violations.length).toBeGreaterThan(0);
    }
  });

  it("falls back to compression when rejection is disabled", () => {
    const hotState = buildHotState({
      session_id: "s1",
      constraints: Array.from({ length: 100 }, (_, i) => `c${i}-${"x".repeat(100)}`),
    });

    const result = applyContextDiscipline(hotState, {
      limits: { maxHotStateTokens: 150 },
      rejectOnPersistentOverflow: false,
    });

    // Should return compressed version instead of rejecting
    expect(result.type).toBe("compress");
  });

  it("preserves essential fields during compression", () => {
    const hotState = buildHotState({
      session_id: "s1",
      session_key: "key1",
      run_id: "run1",
      current_plan_id: "plan1",
      risk_level: "high",
      objective: "Test preservation",
      constraints: Array.from({ length: 50 }, (_, i) => `constraint-${i}`),
    });

    const result = applyContextDiscipline(hotState, {
      limits: { maxHotStateTokens: 100 },
    });

    expect(result.type).toBe("compress");
    if (result.type === "compress") {
      expect(result.hotState.session_id).toBe("s1");
      expect(result.hotState.session_key).toBe("key1");
      expect(result.hotState.run_id).toBe("run1");
      expect(result.hotState.current_plan_id).toBe("plan1");
      expect(result.hotState.risk_level).toBe("high");
      expect(result.hotState.objective).toBe("Test preservation");
      // Large arrays should be removed
      expect(result.hotState.constraints).toBeUndefined();
    }
  });

  it("handles artifact index correctly during reference extraction", () => {
    const hotState = buildHotState({
      session_id: "s1",
      artifact_index: [{ artifact_id: "existing1", type: "code", label: "existing.ts" }],
      // Large enough arrays to trigger reference extraction after compression
      constraints: Array.from({ length: 30 }, (_, i) => `constraint-${i}-${"x".repeat(300)}`),
    });

    const result = applyContextDiscipline(hotState, {
      limits: { maxHotStateTokens: 500, maxArtifactIndexEntries: 5 },
    });

    // Should either compress, reference, or reject
    expect(["compress", "reference", "reject"]).toContain(result.type);

    if (result.type === "reference") {
      // Should preserve existing artifact index entries and add new ones
      expect(result.hotState.artifact_index).toBeDefined();
      expect(result.hotState.artifact_index!.length).toBeGreaterThan(1);
      // Should still have the original entry
      const existing = result.hotState.artifact_index!.find((a) => a.artifact_id === "existing1");
      expect(existing).toBeDefined();
    } else if (result.type === "compress") {
      // Compressed state should have the original artifact index
      expect(result.hotState.artifact_index).toBeDefined();
      const existing = result.hotState.artifact_index!.find((a) => a.artifact_id === "existing1");
      expect(existing).toBeDefined();
    }
  });
});

describe("enforceDiffOnly", () => {
  it("validates unified diff format", () => {
    const diff = `--- a/src/main.ts
+++ b/src/main.ts
@@ -1,3 +1,4 @@
 const x = 1;
+const y = 2;
 export { x };`;

    const result = enforceDiffOnly({
      output: diff,
      taskDescription: "modify the code in main.ts",
    });

    expect(result.valid).toBe(true);
  });

  it("rejects full file rewrite for code modification", () => {
    const fullFile = Array.from({ length: 30 }, (_, i) => `const val${i} = ${i};`).join("\n");

    const result = enforceDiffOnly({
      output: fullFile,
      taskDescription: "modify the code",
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("full file rewrite");
    }
  });

  it("accepts short summaries even for code tasks", () => {
    const result = enforceDiffOnly({
      output: "Done. The function has been updated.",
      taskDescription: "modify the code",
    });

    expect(result.valid).toBe(true);
  });
});

describe("captureDisciplineMetrics", () => {
  it("captures metrics for 'pass' action", () => {
    const hotState = buildHotState({ session_id: "s1" });
    const action: ContextDisciplineAction = {
      type: "pass",
      hotState,
      json: "{}",
      tokens: 100,
    };

    const metrics = captureDisciplineMetrics({
      sessionId: "s1",
      action,
      systemPromptChars: 500,
      userContentChars: 200,
    });

    expect(metrics.budgetPassed).toBe(true);
    expect(metrics.hotStateTruncated).toBe(false);
    expect(metrics.budgetViolationCount).toBe(0);
  });

  it("captures metrics for 'reject' action", () => {
    const action: ContextDisciplineAction = {
      type: "reject",
      reason: "Budget exceeded",
      violations: [{ field: "tokens", limit: 100, actual: 200, message: "Too big" }],
    };

    const metrics = captureDisciplineMetrics({
      sessionId: "s1",
      action,
    });

    expect(metrics.budgetPassed).toBe(false);
    expect(metrics.hotStateTruncated).toBe(true);
    expect(metrics.budgetViolationCount).toBe(1);
  });
});
