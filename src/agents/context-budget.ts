import type { HotState } from "./hot-state.js";
import { estimateHotStateTokens, formatHotStateJson } from "./hot-state.js";

/**
 * Context budget validator — enforces hard limits on prompt composition to prevent
 * gradual regression back to bloated prompts.
 *
 * From spec: "If budget exceeded → compress → replace with references → reject (last resort).
 * No silent truncation allowed."
 *
 * Fail-closed: if any check is ambiguous or data is missing, the budget is treated as exceeded.
 */

export type ContextBudgetLimits = {
  /** Maximum tokens for the hot state JSON blob. Default: 1000 */
  maxHotStateTokens: number;
  /** Maximum number of artifact refs in the hot state index. Default: 20 */
  maxArtifactIndexEntries: number;
  /** Maximum total prompt tokens (system + user + context). Default: 8000 */
  maxPromptTokens: number;
  /** Maximum number of RAG chunks that may be included. Default: 10 */
  maxRagChunks: number;
  /** Maximum bytes for a single inline artifact (above this → must be a reference). Default: 2000 */
  maxInlineArtifactChars: number;
};

export const DEFAULT_CONTEXT_BUDGET: ContextBudgetLimits = {
  maxHotStateTokens: 1000,
  maxArtifactIndexEntries: 20,
  maxPromptTokens: 8000,
  maxRagChunks: 10,
  maxInlineArtifactChars: 2000,
};

export type BudgetViolation = {
  field: string;
  limit: number;
  actual: number;
  message: string;
};

export type BudgetCheckResult = {
  passed: boolean;
  violations: BudgetViolation[];
  /** True if any check could not be performed (fail closed → treated as violation). */
  ambiguous: boolean;
};

/**
 * Validate hot state against context budget limits.
 * Returns all violations found (not just the first).
 */
export function validateHotStateBudget(
  hotState: HotState,
  limits?: Partial<ContextBudgetLimits>,
): BudgetCheckResult {
  const resolved = { ...DEFAULT_CONTEXT_BUDGET, ...limits };
  const violations: BudgetViolation[] = [];
  let ambiguous = false;

  // 1. Hot state token count
  try {
    const json = formatHotStateJson(hotState);
    const tokens = estimateHotStateTokens(json);
    if (tokens > resolved.maxHotStateTokens) {
      violations.push({
        field: "hot_state_tokens",
        limit: resolved.maxHotStateTokens,
        actual: tokens,
        message: `Hot state is ${tokens} tokens (max ${resolved.maxHotStateTokens})`,
      });
    }
  } catch {
    ambiguous = true;
    violations.push({
      field: "hot_state_tokens",
      limit: resolved.maxHotStateTokens,
      actual: -1,
      message: "Failed to estimate hot state tokens (fail closed)",
    });
  }

  // 2. Artifact index size
  const indexSize = hotState.artifact_index?.length ?? 0;
  if (indexSize > resolved.maxArtifactIndexEntries) {
    violations.push({
      field: "artifact_index_entries",
      limit: resolved.maxArtifactIndexEntries,
      actual: indexSize,
      message: `Artifact index has ${indexSize} entries (max ${resolved.maxArtifactIndexEntries})`,
    });
  }

  return {
    passed: violations.length === 0 && !ambiguous,
    violations,
    ambiguous,
  };
}

/**
 * Validate full prompt context against budget limits.
 * Includes hot state + system prompt + user content.
 */
export function validatePromptBudget(params: {
  systemPromptChars: number;
  userContentChars: number;
  hotState: HotState;
  ragChunkCount?: number;
  inlineArtifactChars?: number[];
  limits?: Partial<ContextBudgetLimits>;
}): BudgetCheckResult {
  const resolved = { ...DEFAULT_CONTEXT_BUDGET, ...params.limits };
  const hotStateResult = validateHotStateBudget(params.hotState, resolved);
  const violations = [...hotStateResult.violations];
  let ambiguous = hotStateResult.ambiguous;

  // 3. RAG chunks
  const ragCount = params.ragChunkCount ?? 0;
  if (ragCount > resolved.maxRagChunks) {
    violations.push({
      field: "rag_chunks",
      limit: resolved.maxRagChunks,
      actual: ragCount,
      message: `RAG chunk count ${ragCount} exceeds limit ${resolved.maxRagChunks}`,
    });
  }

  // 4. Inline artifact size
  const inlineArtifacts = params.inlineArtifactChars ?? [];
  for (let i = 0; i < inlineArtifacts.length; i++) {
    const chars = inlineArtifacts[i]!;
    if (chars > resolved.maxInlineArtifactChars) {
      violations.push({
        field: `inline_artifact[${i}]`,
        limit: resolved.maxInlineArtifactChars,
        actual: chars,
        message: `Inline artifact #${i} is ${chars} chars (max ${resolved.maxInlineArtifactChars}; should be a reference)`,
      });
    }
  }

  // 5. Rough total prompt token estimate (chars / 4 as a heuristic)
  const totalChars =
    params.systemPromptChars + params.userContentChars + formatHotStateJson(params.hotState).length;
  const estimatedTokens = Math.ceil(totalChars / 4);
  if (estimatedTokens > resolved.maxPromptTokens) {
    violations.push({
      field: "total_prompt_tokens",
      limit: resolved.maxPromptTokens,
      actual: estimatedTokens,
      message: `Estimated total prompt tokens ${estimatedTokens} exceeds budget ${resolved.maxPromptTokens}`,
    });
  }

  return {
    passed: violations.length === 0 && !ambiguous,
    violations,
    ambiguous,
  };
}
