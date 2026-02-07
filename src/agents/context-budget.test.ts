import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_BUDGET,
  validateHotStateBudget,
  validatePromptBudget,
} from "./context-budget.js";
import { buildHotState, type HotState } from "./hot-state.js";

describe("validateHotStateBudget", () => {
  it("passes for a small, valid hot state", () => {
    const hs = buildHotState({ session_id: "s1", risk_level: "low" });
    const result = validateHotStateBudget(hs);
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.ambiguous).toBe(false);
  });

  it("fails when hot state tokens exceed budget", () => {
    const hs = buildHotState({
      session_id: "s1",
      constraints: Array.from({ length: 500 }, (_, i) => `constraint-${i}-${"x".repeat(40)}`),
    });
    const result = validateHotStateBudget(hs, { maxHotStateTokens: 50 });
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.field === "hot_state_tokens")).toBe(true);
  });

  it("fails when artifact index exceeds limit", () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({
      artifact_id: `${"a".repeat(63)}${String(i % 10)}`,
      type: "doc" as const,
      label: `file${i}.md`,
    }));
    const hs = buildHotState({
      session_id: "s1",
      artifact_index: entries,
    });
    const result = validateHotStateBudget(hs, { maxArtifactIndexEntries: 20 });
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.field === "artifact_index_entries")).toBe(true);
    expect(result.violations.find((v) => v.field === "artifact_index_entries")?.actual).toBe(25);
  });

  it("passes when artifact index is within limit", () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      artifact_id: `${"b".repeat(63)}${String(i % 10)}`,
      type: "code" as const,
    }));
    const hs = buildHotState({
      session_id: "s1",
      artifact_index: entries,
    });
    const result = validateHotStateBudget(hs);
    expect(result.passed).toBe(true);
  });

  it("uses default limits when none provided", () => {
    const hs = buildHotState({ session_id: "s1" });
    const result = validateHotStateBudget(hs);
    expect(result.passed).toBe(true);
  });

  it("reports multiple violations simultaneously", () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({
      artifact_id: `${"c".repeat(63)}${String(i % 10)}`,
      type: "log" as const,
    }));
    const hs = buildHotState({
      session_id: "s1",
      artifact_index: entries,
      constraints: Array.from({ length: 500 }, (_, i) => `constraint-${i}-${"x".repeat(40)}`),
    });
    const result = validateHotStateBudget(hs, {
      maxHotStateTokens: 50,
      maxArtifactIndexEntries: 20,
    });
    expect(result.passed).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(2);
  });
});

describe("validatePromptBudget", () => {
  const minimalHotState = buildHotState({ session_id: "s1" });

  it("passes for small prompt within budget", () => {
    const result = validatePromptBudget({
      systemPromptChars: 500,
      userContentChars: 200,
      hotState: minimalHotState,
    });
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("fails when RAG chunks exceed limit", () => {
    const result = validatePromptBudget({
      systemPromptChars: 500,
      userContentChars: 200,
      hotState: minimalHotState,
      ragChunkCount: 15,
      limits: { maxRagChunks: 10 },
    });
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.field === "rag_chunks")).toBe(true);
  });

  it("fails when inline artifact is too large", () => {
    const result = validatePromptBudget({
      systemPromptChars: 500,
      userContentChars: 200,
      hotState: minimalHotState,
      inlineArtifactChars: [100, 5000, 200],
      limits: { maxInlineArtifactChars: 2000 },
    });
    expect(result.passed).toBe(false);
    const violation = result.violations.find((v) => v.field.startsWith("inline_artifact"));
    expect(violation).toBeDefined();
    expect(violation?.actual).toBe(5000);
  });

  it("fails when total prompt tokens exceed budget", () => {
    const result = validatePromptBudget({
      systemPromptChars: 20000,
      userContentChars: 15000,
      hotState: minimalHotState,
      limits: { maxPromptTokens: 5000 },
    });
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.field === "total_prompt_tokens")).toBe(true);
  });

  it("includes hot state violations in prompt budget check", () => {
    const bigHotState = buildHotState({
      session_id: "s1",
      constraints: Array.from({ length: 500 }, (_, i) => `c${i}-${"x".repeat(40)}`),
    });
    const result = validatePromptBudget({
      systemPromptChars: 500,
      userContentChars: 200,
      hotState: bigHotState,
      limits: { maxHotStateTokens: 50 },
    });
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.field === "hot_state_tokens")).toBe(true);
  });

  it("passes with multiple inline artifacts all within limit", () => {
    const result = validatePromptBudget({
      systemPromptChars: 500,
      userContentChars: 200,
      hotState: minimalHotState,
      inlineArtifactChars: [100, 500, 1999],
    });
    // This should pass unless total tokens exceed budget
    const inlineViolations = result.violations.filter((v) => v.field.startsWith("inline_artifact"));
    expect(inlineViolations).toHaveLength(0);
  });
});

describe("DEFAULT_CONTEXT_BUDGET", () => {
  it("has sensible defaults", () => {
    expect(DEFAULT_CONTEXT_BUDGET.maxHotStateTokens).toBe(1000);
    expect(DEFAULT_CONTEXT_BUDGET.maxArtifactIndexEntries).toBe(20);
    expect(DEFAULT_CONTEXT_BUDGET.maxPromptTokens).toBe(8000);
    expect(DEFAULT_CONTEXT_BUDGET.maxRagChunks).toBe(10);
    expect(DEFAULT_CONTEXT_BUDGET.maxInlineArtifactChars).toBe(2000);
  });
});
