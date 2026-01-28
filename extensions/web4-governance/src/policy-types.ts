/**
 * Policy Engine Types - Rule definitions and evaluation results.
 *
 * Rules are evaluated in priority order (ascending). First match wins.
 * Match criteria within a rule are AND'd.
 */

import type { ToolCategory } from "./r6.js";

export type PolicyDecision = "allow" | "deny" | "warn";

export type PolicyMatch = {
  /** Tool names to match (e.g. ["Bash", "Write"]) */
  tools?: string[];
  /** Tool categories to match (e.g. ["network", "command"]) */
  categories?: ToolCategory[];
  /** Target patterns - glob by default, regex if targetPatternsAreRegex is true */
  targetPatterns?: string[];
  /** Treat targetPatterns as regex instead of glob */
  targetPatternsAreRegex?: boolean;
};

export type PolicyRule = {
  id: string;
  name: string;
  /** Lower priority = evaluated first. First match wins. */
  priority: number;
  decision: PolicyDecision;
  /** Human-readable reason for the decision */
  reason?: string;
  match: PolicyMatch;
};

export type PolicyConfig = {
  /** Default decision when no rule matches */
  defaultPolicy: PolicyDecision;
  /** When false, deny decisions are logged as warnings but not enforced (dry-run) */
  enforce: boolean;
  rules: PolicyRule[];
};

export type PolicyEvaluation = {
  decision: PolicyDecision;
  /** The rule that matched, or undefined if default policy applied */
  matchedRule?: PolicyRule;
  /** Whether the decision was enforced (false in dry-run mode) */
  enforced: boolean;
  /** Reason string for audit/logging */
  reason: string;
  /** Constraints to record in R6 */
  constraints: string[];
};
