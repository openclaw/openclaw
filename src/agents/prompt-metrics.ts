import type { ArtifactIndexEntry, HotState } from "./hot-state.js";
import { estimateHotStateTokens, formatHotStateJson } from "./hot-state.js";

/**
 * Per-turn prompt metrics for observability.
 *
 * From spec: "Log for every model call: latency, prompt/completion tokens, artifacts bytes, status."
 * These metrics enable closed-loop optimization and regression detection.
 */

export type PromptMetrics = {
  /** ISO timestamp when metrics were captured */
  timestamp: string;
  /** Session identifier */
  sessionId: string;
  /** Unique turn/run identifier */
  runId?: string;
  /** Hot state size in tokens */
  hotStateTokens: number;
  /** Hot state size in bytes (JSON serialized) */
  hotStateBytes: number;
  /** Whether the hot state was truncated to fit the token cap */
  hotStateTruncated: boolean;
  /** Number of artifact references in hot state index */
  artifactIndexCount: number;
  /** Artifact types in the index */
  artifactTypes: string[];
  /** System prompt size in characters */
  systemPromptChars: number;
  /** User content size in characters */
  userContentChars: number;
  /** Estimated total prompt tokens (heuristic: chars/4) */
  estimatedPromptTokens: number;
  /** Number of bootstrap files with ArtifactRef (not inlined) */
  artifactRefBootstrapFiles: number;
  /** Number of budget violations detected */
  budgetViolationCount: number;
  /** Whether the context budget passed all checks */
  budgetPassed: boolean;
};

export type PromptMetricsInput = {
  sessionId: string;
  runId?: string;
  hotState: HotState;
  hotStateTruncated: boolean;
  systemPromptChars: number;
  userContentChars: number;
  artifactRefBootstrapFiles?: number;
  budgetViolationCount?: number;
  budgetPassed?: boolean;
};

/**
 * Capture prompt metrics for a single turn.
 */
export function capturePromptMetrics(input: PromptMetricsInput): PromptMetrics {
  const json = formatHotStateJson(input.hotState);
  const hotStateTokens = estimateHotStateTokens(json);
  const hotStateBytes = Buffer.byteLength(json, "utf-8");
  const artifactIndex = input.hotState.artifact_index ?? [];
  const artifactTypes = [...new Set(artifactIndex.map((a) => a.type))].sort();

  const totalChars = input.systemPromptChars + input.userContentChars + json.length;
  const estimatedPromptTokens = Math.ceil(totalChars / 4);

  return {
    timestamp: new Date().toISOString(),
    sessionId: input.sessionId,
    runId: input.runId,
    hotStateTokens,
    hotStateBytes,
    hotStateTruncated: input.hotStateTruncated,
    artifactIndexCount: artifactIndex.length,
    artifactTypes,
    systemPromptChars: input.systemPromptChars,
    userContentChars: input.userContentChars,
    estimatedPromptTokens,
    artifactRefBootstrapFiles: input.artifactRefBootstrapFiles ?? 0,
    budgetViolationCount: input.budgetViolationCount ?? 0,
    budgetPassed: input.budgetPassed ?? true,
  };
}

/**
 * Format prompt metrics as a compact one-line log string.
 * Suitable for structured logging / JSON log ingestion.
 */
export function formatPromptMetricsLog(metrics: PromptMetrics): string {
  return JSON.stringify({
    type: "prompt_metrics",
    ts: metrics.timestamp,
    session: metrics.sessionId,
    run: metrics.runId,
    hs_tokens: metrics.hotStateTokens,
    hs_bytes: metrics.hotStateBytes,
    hs_truncated: metrics.hotStateTruncated,
    artifacts: metrics.artifactIndexCount,
    artifact_types: metrics.artifactTypes,
    sys_chars: metrics.systemPromptChars,
    user_chars: metrics.userContentChars,
    est_tokens: metrics.estimatedPromptTokens,
    ref_files: metrics.artifactRefBootstrapFiles,
    budget_violations: metrics.budgetViolationCount,
    budget_ok: metrics.budgetPassed,
  });
}

/**
 * Check if metrics indicate potential regression (prompt getting bloated).
 * Returns warning messages for any detected regressions.
 */
export function detectPromptRegressions(metrics: PromptMetrics): string[] {
  const warnings: string[] = [];

  if (metrics.hotStateTokens > 800) {
    warnings.push(`Hot state approaching token limit: ${metrics.hotStateTokens}/1000 tokens`);
  }

  if (metrics.artifactIndexCount > 15) {
    warnings.push(`High artifact index count: ${metrics.artifactIndexCount} entries`);
  }

  if (metrics.estimatedPromptTokens > 6000) {
    warnings.push(`High estimated prompt tokens: ${metrics.estimatedPromptTokens}`);
  }

  if (!metrics.budgetPassed) {
    warnings.push(`Context budget violated (${metrics.budgetViolationCount} violations)`);
  }

  return warnings;
}
