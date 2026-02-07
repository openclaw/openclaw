import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildArtifactRecordFromMeta,
  validateArtifactRecord,
} from "../artifacts/artifact-record.js";
import { createArtifactRegistry } from "../artifacts/artifact-registry.js";
import { validateHotStateBudget, validatePromptBudget } from "./context-budget.js";
import {
  buildHotState,
  enforceHotStateTokenCap,
  formatHotStateJson,
  type ArtifactIndexEntry,
} from "./hot-state.js";
import {
  capturePromptMetrics,
  detectPromptRegressions,
  formatPromptMetricsLog,
} from "./prompt-metrics.js";

/**
 * Integration test: Full artifact references pipeline.
 *
 * Tests the complete flow from storing artifacts → building hot state with artifact index →
 * validating budgets → capturing metrics → detecting regressions.
 */
describe("Artifact References Integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-artref-integration-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("stores artifacts, builds hot state with index, validates budget, captures metrics", async () => {
    // 1. Store artifacts
    const registry = createArtifactRegistry({ rootDir: tmpDir });

    const codeArtifact = await registry.storeText({
      content: 'export function main() { console.log("hello"); }',
      mime: "text/plain",
    });
    const docArtifact = await registry.storeText({
      content: "# Spec\n\nThis is the specification document with lots of content...",
      mime: "text/markdown",
    });

    // 2. Build ArtifactRecords (full schema validation)
    const codeRecord = buildArtifactRecordFromMeta({
      meta: codeArtifact,
      storageUri: `file://${tmpDir}/${codeArtifact.sha256.slice(0, 2)}/${codeArtifact.sha256}`,
      type: "code",
      producer: "executor",
      summary: "Main entry point",
    });
    expect(codeRecord.artifact_id).toBe(codeArtifact.id);
    expect(codeRecord.type).toBe("code");

    const docRecord = buildArtifactRecordFromMeta({
      meta: docArtifact,
      storageUri: `file://${tmpDir}/${docArtifact.sha256.slice(0, 2)}/${docArtifact.sha256}`,
      type: "doc",
      producer: "dispatcher",
    });

    // 3. Build hot state with artifact index
    const artifactIndex: ArtifactIndexEntry[] = [
      {
        artifact_id: codeRecord.artifact_id,
        type: "code",
        label: "main.ts",
        version: codeRecord.content_hash.slice(0, 8),
      },
      {
        artifact_id: docRecord.artifact_id,
        type: "doc",
        label: "spec.md",
        version: docRecord.content_hash.slice(0, 8),
      },
    ];

    const hotState = buildHotState({
      session_id: "integration-test-1",
      session_key: "main",
      run_id: "run-1",
      objective: "Build artifact references system",
      current_plan_id: null,
      accepted_decisions: ["Use SHA256 content-addressable storage"],
      open_questions: [],
      constraints: ["Hot state < 1KB", "Fail closed on ambiguity"],
      last_successful_step: "S2",
      risk_level: "low",
      artifact_index: artifactIndex,
    });

    // 4. Enforce token cap
    const capped = enforceHotStateTokenCap({ hotState, maxTokens: 1000 });
    expect(capped.wasTruncated).toBe(false);
    expect(capped.tokens).toBeLessThan(1000);

    // 5. Validate budget
    const budgetResult = validateHotStateBudget(hotState);
    expect(budgetResult.passed).toBe(true);
    expect(budgetResult.violations).toHaveLength(0);

    // 6. Validate full prompt budget
    const systemPrompt = "You are a helpful assistant."; // simplified
    const userContent = "Please review the code artifact.";

    const fullBudgetResult = validatePromptBudget({
      systemPromptChars: systemPrompt.length,
      userContentChars: userContent.length,
      hotState,
    });
    expect(fullBudgetResult.passed).toBe(true);

    // 7. Capture metrics
    const metrics = capturePromptMetrics({
      sessionId: "integration-test-1",
      runId: "run-1",
      hotState: capped.hotState,
      hotStateTruncated: capped.wasTruncated,
      systemPromptChars: systemPrompt.length,
      userContentChars: userContent.length,
      budgetViolationCount: fullBudgetResult.violations.length,
      budgetPassed: fullBudgetResult.passed,
    });

    expect(metrics.artifactIndexCount).toBe(2);
    expect(metrics.artifactTypes).toEqual(["code", "doc"]);
    expect(metrics.budgetPassed).toBe(true);
    expect(metrics.hotStateTruncated).toBe(false);

    // 8. Check for regressions
    const warnings = detectPromptRegressions(metrics);
    expect(warnings).toHaveLength(0);

    // 9. Verify log format is parseable
    const logLine = formatPromptMetricsLog(metrics);
    const parsed = JSON.parse(logLine);
    expect(parsed.type).toBe("prompt_metrics");
    expect(parsed.artifacts).toBe(2);
  });

  it("retrieves stored artifact by ID from hot state index", async () => {
    const registry = createArtifactRegistry({ rootDir: tmpDir });

    const largeContent = "x".repeat(50_000);
    const meta = await registry.storeText({ content: largeContent, mime: "text/plain" });

    // Build hot state with reference
    const hotState = buildHotState({
      session_id: "s2",
      artifact_index: [{ artifact_id: meta.id, type: "data", label: "large-dataset.txt" }],
    });

    // Verify the artifact can be retrieved by the ID in the index
    const entry = hotState.artifact_index![0]!;
    const retrieved = await registry.get(entry.artifact_id);
    expect(retrieved.content).toBe(largeContent);
    expect(retrieved.meta.sha256).toBe(meta.sha256);
  });

  it("content-addressable deduplication works across stores", async () => {
    const registry = createArtifactRegistry({ rootDir: tmpDir });

    const content = "deduplicated content";
    const meta1 = await registry.storeText({ content, mime: "text/plain" });
    const meta2 = await registry.storeText({ content, mime: "text/plain" });

    // Same content → same ID (content-addressable)
    expect(meta1.id).toBe(meta2.id);
    expect(meta1.sha256).toBe(meta2.sha256);
  });

  it("fails closed when budget is exceeded", () => {
    // Simulate a bloated hot state that exceeds all budgets
    const entries = Array.from({ length: 25 }, (_, i) => ({
      artifact_id: `${"e".repeat(63)}${String(i % 10)}`,
      type: "doc" as const,
      label: `file${i}.md`,
      summary: `Summary of file ${i} with extra content ${"x".repeat(50)}`,
    }));

    const hotState = buildHotState({
      session_id: "s3",
      constraints: Array.from({ length: 100 }, (_, i) => `constraint-${i}-${"y".repeat(30)}`),
      artifact_index: entries,
    });

    // Budget should fail
    const result = validateHotStateBudget(hotState, {
      maxHotStateTokens: 200,
      maxArtifactIndexEntries: 20,
    });
    expect(result.passed).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);

    // Token cap enforcement should truncate to minimal
    const capped = enforceHotStateTokenCap({ hotState, maxTokens: 200 });
    expect(capped.wasTruncated).toBe(true);
    // Minimal hot state should NOT have the bloated fields
    expect(capped.hotState.constraints).toBeUndefined();
    expect(capped.hotState.artifact_index).toBeUndefined();
  });

  it("hot state JSON is always valid, parseable JSON", () => {
    const hotState = buildHotState({
      session_id: "json-test",
      objective: 'Test "quotes" and \\ backslashes and\nnewlines',
      constraints: ["no <script> tags", "emoji: 🚀"],
      artifact_index: [{ artifact_id: "f".repeat(64), type: "code", label: "file with spaces.ts" }],
    });

    const json = formatHotStateJson(hotState);
    expect(() => JSON.parse(json)).not.toThrow();

    const parsed = JSON.parse(json);
    expect(parsed.session_id).toBe("json-test");
    expect(parsed.objective).toContain("quotes");
    expect(parsed.artifact_index).toHaveLength(1);
  });

  it("ArtifactRecord schema rejects malformed records (fail closed)", () => {
    // Missing required field
    expect(() =>
      validateArtifactRecord({
        artifact_id: "a".repeat(64),
        type: "code",
        // content_uri missing!
        content_hash: "a".repeat(64),
        size_bytes: 100,
        created_at: "2026-02-06T12:00:00Z",
      }),
    ).toThrow();

    // Invalid hash format
    expect(() =>
      validateArtifactRecord({
        artifact_id: "not-a-hash",
        type: "code",
        content_uri: "file:///tmp/test",
        content_hash: "a".repeat(64),
        size_bytes: 100,
        created_at: "2026-02-06T12:00:00Z",
      }),
    ).toThrow();
  });
});
