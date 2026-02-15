/**
 * Context Discipline module for OpenClaw.
 *
 * Implements Milestone C: Hot-state limits, artifact references,
 * diff-only validation, and context budgeting.
 *
 * @module agents/context-discipline
 */

// Hot State (C1-C3: limits, JSON-only, schema validation)
export {
  HotStateSchema,
  ArtifactIndexEntrySchema,
  buildHotState,
  formatHotStateJson,
  estimateHotStateTokens,
  enforceHotStateTokenCap,
  type HotState,
  type ArtifactIndexEntry,
  type HotStateRiskLevel,
} from "./hot-state.js";

// Context Budget (C6: budgeter with compress → reference → reject)
export {
  DEFAULT_CONTEXT_BUDGET,
  validateHotStateBudget,
  validatePromptBudget,
  type ContextBudgetLimits,
  type BudgetViolation,
  type BudgetCheckResult,
} from "./context-budget.js";

// Diff-Only Validator (C5: diff-only changes for artifacts)
export {
  looksLikeUnifiedDiff,
  looksLikeJsonPatch,
  looksLikeFullFileRewrite,
  isCodeModificationTask,
  validateDiffOnly,
  extractDiffFilePaths,
  type DiffValidationResult,
} from "./diff-only-validator.js";

// Prompt Metrics (Observability for context discipline)
export {
  capturePromptMetrics,
  detectPromptRegressions,
  formatPromptMetricsLog,
  type PromptMetrics,
  type PromptRegression,
} from "./prompt-metrics.js";
