/**
 * AXIOM validation rules — orphan, self-loop, duplicate.
 *
 * Pure functions with dependency injection for DB access.
 */

import type { Fact, FactInput } from "./db.js";

export type ValidationRuleId = "self_loop" | "orphan" | "duplicate";

export interface ValidationViolation {
  rule: ValidationRuleId;
  message: string;
  field?: string;
}

export interface ValidationResult {
  valid: boolean;
  violations: ValidationViolation[];
}

export type FactLookup = (subject: string, predicate: string, object: string) => Fact[];

/** Validates a fact input against all AXIOM rules. Collects all violations (no short-circuit). */
export function validateFact(
  input: FactInput,
  existingFacts: FactLookup = () => [],
): ValidationResult {
  const violations: ValidationViolation[] = [];

  // Rule 1 — orphan: subject or object is empty/whitespace-only
  const subjectEmpty = !input.subject?.trim();
  const objectEmpty = !input.object?.trim();

  if (subjectEmpty) {
    violations.push({
      rule: "orphan",
      message: "Fact is missing subject — relationship has no endpoints",
      field: "subject",
    });
  }
  if (objectEmpty) {
    violations.push({
      rule: "orphan",
      message: "Fact is missing object — relationship has no endpoints",
      field: "object",
    });
  }

  // Rule 2 — self_loop: subject equals object (only if both are present)
  if (!subjectEmpty && !objectEmpty) {
    if (input.subject.trim().toLowerCase() === input.object.trim().toLowerCase()) {
      violations.push({
        rule: "self_loop",
        message: `Subject equals object: "${input.subject.trim()}"`,
      });
    }
  }

  // Rule 3 — duplicate: same triple already exists at trust level blue or green
  if (!subjectEmpty && !objectEmpty) {
    const existing = existingFacts(
      input.subject.trim(),
      input.predicate.trim(),
      input.object.trim(),
    );
    const isDuplicate = existing.some((f) => f.trust_level !== "red");
    if (isDuplicate) {
      violations.push({
        rule: "duplicate",
        message: `Fact already exists: "${input.subject.trim()} ${input.predicate.trim()} ${input.object.trim()}"`,
      });
    }
  }

  // TODO: orphan_isolated check — requires full DB scan

  return { valid: violations.length === 0, violations };
}

/** Formats validation violations for CLI display. */
export function formatViolations(violations: ValidationViolation[]): string {
  if (violations.length === 0) return "Validation passed";

  const lines = violations.map(
    (v) => `  \u2717 [${v.rule}] ${v.message}`,
  );
  return `Validation failed:\n${lines.join("\n")}`;
}
