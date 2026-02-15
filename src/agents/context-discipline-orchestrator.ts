/**
 * Context Discipline Orchestrator
 *
 * Implements the complete Milestone C flow:
 * 1. Validate hot state against budget (C1-C3)
 * 2. Store artifacts by reference (C4)
 * 3. Enforce diff-only for modifications (C5)
 * 4. Apply context budgeter strategy: compress → reference → reject (C6)
 *
 * @module agents/context-discipline-orchestrator
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  type BudgetCheckResult,
  type BudgetViolation,
  DEFAULT_CONTEXT_BUDGET,
  type ContextBudgetLimits,
  validateHotStateBudget,
} from "./context-budget.js";
import { validateDiffOnly, type DiffValidationResult } from "./diff-only-validator.js";
import {
  type ArtifactIndexEntry,
  buildHotState,
  enforceHotStateTokenCap,
  formatHotStateJson,
  type HotState,
} from "./hot-state.js";
import { capturePromptMetrics, type PromptMetrics } from "./prompt-metrics.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContextDisciplineStrategy = "compress" | "reference" | "reject";

export type ContextDisciplineAction =
  | { type: "pass"; hotState: HotState; json: string; tokens: number }
  | { type: "compress"; hotState: HotState; json: string; tokens: number; originalTokens: number }
  | {
      type: "reference";
      hotState: HotState;
      json: string;
      tokens: number;
      referencedFields: string[];
    }
  | { type: "reject"; reason: string; violations: BudgetViolation[] };

export type OrchestratorConfig = {
  /** Budget limits (uses defaults if not provided) */
  limits?: Partial<ContextBudgetLimits>;
  /** Enable compression fallback (default: true) */
  enableCompression?: boolean;
  /** Enable reference extraction (default: true) */
  enableReferenceExtraction?: boolean;
  /** Reject if compression still exceeds budget (default: true) */
  rejectOnPersistentOverflow?: boolean;
};

export type OrchestratorContext = {
  sessionId: string;
  sessionKey?: string;
  runId?: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: Required<OrchestratorConfig> = {
  limits: DEFAULT_CONTEXT_BUDGET,
  enableCompression: true,
  enableReferenceExtraction: true,
  rejectOnPersistentOverflow: true,
};

// Fields that can be extracted to artifact references when compressing
const COMPRESSIBLE_FIELDS: Array<keyof HotState> = [
  "constraints",
  "open_questions",
  "accepted_decisions",
];

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic artifact ID from content.
 */
function generateArtifactId(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Compress hot state by removing non-essential fields.
 */
function compressHotState(hotState: HotState): HotState {
  // Keep only essential fields
  return buildHotState({
    session_id: hotState.session_id,
    session_key: hotState.session_key,
    run_id: hotState.run_id,
    current_plan_id: hotState.current_plan_id,
    risk_level: hotState.risk_level,
    objective: hotState.objective,
    // artifact_index is kept if already present
    artifact_index: hotState.artifact_index,
  });
}

/**
 * Extract large array fields into artifact references.
 */
function extractReferences(hotState: HotState): {
  hotState: HotState;
  references: Array<{ field: string; artifactId: string }>;
} {
  const references: Array<{ field: string; artifactId: string }> = [];
  const newArtifactIndex: ArtifactIndexEntry[] = [...(hotState.artifact_index ?? [])];

  for (const field of COMPRESSIBLE_FIELDS) {
    const value = hotState[field];
    if (Array.isArray(value) && value.length > 5) {
      // Extract to reference
      const content = JSON.stringify(value);
      const artifactId = generateArtifactId(content);
      references.push({ field, artifactId });
      newArtifactIndex.push({
        artifact_id: artifactId,
        type: "data",
        label: `${field}.json`,
        summary: `${value.length} ${field}`,
      });
    }
  }

  // Build new hot state without the extracted fields
  const newHotState = buildHotState({
    ...hotState,
    constraints: undefined,
    open_questions: undefined,
    accepted_decisions: undefined,
    artifact_index: newArtifactIndex.length > 0 ? newArtifactIndex : undefined,
  });

  return { hotState: newHotState, references };
}

// ---------------------------------------------------------------------------
// Main Orchestrator
// ---------------------------------------------------------------------------

/**
 * Apply context discipline to a hot state.
 *
 * Implements the budgeter strategy:
 * 1. First, validate against budget
 * 2. If exceeded, try compression
 * 3. If still exceeded, try reference extraction
 * 4. If still exceeded, reject
 *
 * @param hotState - The hot state to validate and potentially compress
 * @param config - Configuration for the orchestrator
 * @returns Action result indicating pass, compress, reference, or reject
 */
export function applyContextDiscipline(
  hotState: HotState,
  config: OrchestratorConfig = {},
): ContextDisciplineAction {
  const resolved = { ...DEFAULT_CONFIG, ...config };
  const limits = { ...DEFAULT_CONTEXT_BUDGET, ...resolved.limits };

  // Step 1: Initial validation
  const initialCheck = validateHotStateBudget(hotState, limits);
  const initialJson = formatHotStateJson(hotState);
  const initialTokens = estimateHotStateTokensSafe(initialJson);

  if (initialCheck.passed) {
    return {
      type: "pass",
      hotState,
      json: initialJson,
      tokens: initialTokens,
    };
  }

  // Step 2: Try compression (if enabled)
  if (resolved.enableCompression) {
    const compressed = compressHotState(hotState);
    const compressedCheck = validateHotStateBudget(compressed, limits);
    const compressedJson = formatHotStateJson(compressed);
    const compressedTokens = estimateHotStateTokensSafe(compressedJson);

    if (compressedCheck.passed) {
      return {
        type: "compress",
        hotState: compressed,
        json: compressedJson,
        tokens: compressedTokens,
        originalTokens: initialTokens,
      };
    }

    // Step 3: Try reference extraction (if enabled)
    if (resolved.enableReferenceExtraction) {
      const { hotState: referenced, references } = extractReferences(compressed);
      const referencedCheck = validateHotStateBudget(referenced, limits);
      const referencedJson = formatHotStateJson(referenced);
      const referencedTokens = estimateHotStateTokensSafe(referencedJson);

      if (referencedCheck.passed) {
        return {
          type: "reference",
          hotState: referenced,
          json: referencedJson,
          tokens: referencedTokens,
          referencedFields: references.map((r) => r.field),
        };
      }
    }
  }

  // Step 4: Reject (fail closed)
  if (resolved.rejectOnPersistentOverflow) {
    return {
      type: "reject",
      reason:
        `Hot state exceeds budget even after compression and reference extraction. ` +
        `Initial: ${initialTokens} tokens. ` +
        `Violations: ${initialCheck.violations.map((v) => v.message).join("; ")}`,
      violations: initialCheck.violations,
    };
  }

  // Fallback: return compressed version anyway (if rejection disabled)
  const fallback = enforceHotStateTokenCap({ hotState, maxTokens: limits.maxHotStateTokens });
  return {
    type: "compress",
    hotState: fallback.hotState,
    json: fallback.json,
    tokens: fallback.tokens,
    originalTokens: initialTokens,
  };
}

/**
 * Safely estimate tokens (returns -1 on error).
 */
function estimateHotStateTokensSafe(json: string): number {
  try {
    // Import here to avoid circular deps
    const { estimateHotStateTokens } = require("./hot-state.js");
    return estimateHotStateTokens(json);
  } catch {
    // Fallback: rough character-based estimate
    return Math.ceil(json.length / 4);
  }
}

// ---------------------------------------------------------------------------
// Diff-Only Enforcement
// ---------------------------------------------------------------------------

/**
 * Validate that an executor output follows diff-only discipline.
 *
 * @param output - The executor's output text
 * @param taskDescription - Description of the task
 * @param options - Validation options
 */
export function enforceDiffOnly(params: {
  output: string;
  taskDescription?: string;
  forceCheck?: boolean;
}): DiffValidationResult {
  return validateDiffOnly(params);
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * Capture metrics from a context discipline operation.
 */
export function captureDisciplineMetrics(params: {
  sessionId: string;
  runId?: string;
  action: ContextDisciplineAction;
  systemPromptChars?: number;
  userContentChars?: number;
}): PromptMetrics {
  const baseMetrics = {
    sessionId: params.sessionId,
    runId: params.runId,
    hotStateTruncated: params.action.type !== "pass",
    systemPromptChars: params.systemPromptChars ?? 0,
    userContentChars: params.userContentChars ?? 0,
    budgetViolationCount: params.action.type === "reject" ? 1 : 0,
    budgetPassed: params.action.type !== "reject",
  };

  if (params.action.type === "reject") {
    // For rejections, create a minimal hot state for metrics
    const minimalHotState = buildHotState({ session_id: params.sessionId });
    return capturePromptMetrics({
      ...baseMetrics,
      hotState: minimalHotState,
    });
  }

  return capturePromptMetrics({
    ...baseMetrics,
    hotState: params.action.hotState,
  });
}

// ---------------------------------------------------------------------------
// Re-export everything for convenience
// ---------------------------------------------------------------------------

export {
  type BudgetCheckResult,
  type BudgetViolation,
  type ContextBudgetLimits,
  DEFAULT_CONTEXT_BUDGET,
  type DiffValidationResult,
  type HotState,
  type ArtifactIndexEntry,
  validateHotStateBudget,
  validateDiffOnly,
} from "./context-discipline.js";
