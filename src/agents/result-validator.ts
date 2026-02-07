/**
 * Result validator: post-response validation layer.
 *
 * Combines output budget enforcement + diff-only validation into a single
 * entry point that can be called after any model response.
 *
 * Validation flow:
 *   1. Check output budget for the inferred role
 *   2. If code modification context, validate diff-only format
 *   3. On budget violation: build summary + artifact ref fallback
 *   4. On diff violation: hard reject
 *
 * "Violations = hard reject" per spec.
 */

import type { ArtifactRegistry } from "../artifacts/artifact-registry.js";
import { validateDiffOnly, type DiffValidationResult } from "./diff-only-validator.js";
import {
  buildSummaryFallback,
  inferOutputRole,
  resolveOutputBudget,
  validateOutputBudget,
  type OutputBudgetViolation,
  type OutputRole,
} from "./output-budget.js";

export type ResultValidation =
  | {
      valid: true;
      role: OutputRole | undefined;
      budgetTokens: number | undefined;
      outputTokens: number;
    }
  | {
      valid: false;
      role: OutputRole | undefined;
      reason: "budget_exceeded";
      violation: OutputBudgetViolation;
      fallbackOutput: string;
      artifactId?: string;
    }
  | {
      valid: false;
      role: OutputRole | undefined;
      reason: "diff_only_violation";
      diffResult: DiffValidationResult & { valid: false };
    };

export type ResultValidatorParams = {
  /** The raw assistant output text. */
  output: string;
  /** Session key for role inference. */
  sessionKey?: string;
  /** Explicit subagent label for role inference. */
  subagentLabel?: string;
  /** Explicit role override (skips inference). */
  role?: OutputRole;
  /** Task description for diff-only detection. */
  taskDescription?: string;
  /** Force diff-only check even without code modification heuristic. */
  forceDiffCheck?: boolean;
  /** Per-role budget overrides. */
  budgetOverrides?: Partial<Record<OutputRole, number>>;
  /** Artifact registry for storing oversized outputs. */
  artifactRegistry?: ArtifactRegistry;
  /** Skip budget validation (for testing or explicit exemptions). */
  skipBudget?: boolean;
  /** Skip diff validation. */
  skipDiff?: boolean;
};

/**
 * Validate a model result against output budget and diff-only rules.
 *
 * Returns a validation result. If invalid, includes the reason and
 * either a fallback output (budget) or rejection details (diff).
 */
export async function validateResult(params: ResultValidatorParams): Promise<ResultValidation> {
  const role =
    params.role ??
    inferOutputRole({
      sessionKey: params.sessionKey,
      subagentLabel: params.subagentLabel,
    });

  // Step 1: Output budget check
  if (!params.skipBudget && role) {
    const budgetViolation = validateOutputBudget({
      role,
      output: params.output,
      configOverrides: params.budgetOverrides,
    });

    if (budgetViolation) {
      // Store oversized output as artifact if registry available
      let artifactId: string | undefined;
      if (params.artifactRegistry) {
        try {
          const meta = await params.artifactRegistry.storeText({
            content: params.output,
            mime: "text/plain",
          });
          artifactId = meta.id;
        } catch {
          // Storage failure is non-fatal; fallback without artifact ref
        }
      }

      const fallbackOutput = buildSummaryFallback({
        role,
        output: params.output,
        violation: budgetViolation,
        artifactId,
      });

      return {
        valid: false,
        role,
        reason: "budget_exceeded",
        violation: budgetViolation,
        fallbackOutput,
        artifactId,
      };
    }
  }

  // Step 2: Diff-only check
  if (!params.skipDiff) {
    const diffResult = validateDiffOnly({
      output: params.output,
      taskDescription: params.taskDescription,
      forceCheck: params.forceDiffCheck,
    });

    if (!diffResult.valid) {
      return {
        valid: false,
        role,
        reason: "diff_only_violation",
        diffResult,
      };
    }
  }

  // All checks passed
  const budgetTokens = role
    ? resolveOutputBudget({ role, configOverrides: params.budgetOverrides })
    : undefined;
  const { estimateOutputTokens } = await import("./output-budget.js");
  const outputTokens = estimateOutputTokens(params.output);

  return {
    valid: true,
    role,
    budgetTokens,
    outputTokens,
  };
}

/**
 * Quick synchronous check — budget only, no artifact storage.
 * Useful for hot paths where async is undesirable.
 */
export function validateResultSync(params: {
  output: string;
  role: OutputRole;
  budgetOverrides?: Partial<Record<OutputRole, number>>;
}): OutputBudgetViolation | null {
  return validateOutputBudget({
    role: params.role,
    output: params.output,
    configOverrides: params.budgetOverrides,
  });
}
