/**
 * Judge gate types and persistence for OpenClaw control plane.
 *
 * Provides structured judge verdicts, deterministic gate results,
 * and file-based persistence under .openclaw/reviews/<task-id>/.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Structured judge verdict. */
export type JudgeVerdict = "ACCEPT" | "REVISE" | "ESCALATE";

/** Result of a deterministic preflight gate (tests, lint, typecheck). */
export interface DeterministicGateResult {
  /** Whether all deterministic checks passed. */
  passed: boolean;
  /** Individual check results. */
  checks: DeterministicCheck[];
  /** ISO-8601 timestamp when the gate ran. */
  timestamp: string;
}

export interface DeterministicCheck {
  name: string;
  passed: boolean;
  /** Command that was run. */
  command?: string;
  /** Brief output or error summary. */
  summary?: string;
  /** Duration in milliseconds. */
  durationMs?: number;
}

/** Full judge outcome for a task. */
export interface JudgeOutcome {
  /** The verdict: ACCEPT, REVISE, or ESCALATE. */
  verdict: JudgeVerdict;
  /** Human-readable rationale for the verdict. */
  rationale: string;
  /** Specific blocking issues (for REVISE/ESCALATE). */
  blockingIssues?: string[];
  /** How many REVISE loops have occurred. */
  reviseCount: number;
  /** Result of deterministic preflight gate, if run. */
  deterministicGateResult?: DeterministicGateResult;
  /** ISO-8601 timestamp of the verdict. */
  timestamp: string;
  /** Model used for the semantic judge. */
  judgeModel?: string;
  /** Task ID this verdict applies to. */
  taskId?: string;
}

const JUDGE_FILENAME = "judge.json";

/**
 * Resolve the reviews directory for a task.
 */
export function resolveReviewsDir(repoRoot: string, taskId: string): string {
  return join(repoRoot, ".openclaw", "reviews", taskId);
}

/**
 * Persist a judge outcome to disk.
 */
export function persistJudgeOutcome(
  repoRoot: string,
  taskId: string,
  outcome: JudgeOutcome,
): string {
  const dir = resolveReviewsDir(repoRoot, taskId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const filePath = join(dir, JUDGE_FILENAME);
  const enriched = { ...outcome, taskId };
  writeFileSync(filePath, JSON.stringify(enriched, null, 2) + "\n", "utf-8");
  return filePath;
}

/**
 * Load a judge outcome from disk. Returns null if not found.
 */
export function loadJudgeOutcome(repoRoot: string, taskId: string): JudgeOutcome | null {
  const filePath = join(resolveReviewsDir(repoRoot, taskId), JUDGE_FILENAME);
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as JudgeOutcome;
  } catch {
    return null;
  }
}

/**
 * Check whether a judge outcome meets the acceptance bar.
 */
export function isJudgeAccepted(outcome: JudgeOutcome | null): boolean {
  return outcome?.verdict === "ACCEPT";
}

/**
 * Check whether a REVISE loop should continue or escalate.
 * Default max revise count is 2.
 */
export function shouldEscalateAfterRevise(outcome: JudgeOutcome, maxReviseCount = 2): boolean {
  return outcome.verdict === "REVISE" && outcome.reviseCount >= maxReviseCount;
}
