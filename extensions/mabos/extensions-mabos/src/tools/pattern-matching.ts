/**
 * Pattern Matching — Shared inference utilities
 *
 * Extracted from inference-tools.ts so both the inference engine and
 * the reflexive processor can use the same pattern matching logic.
 */

// ── Types ─────────────────────────────────────────────────────

export type Binding = Record<string, string>;

export type ConditionPattern = {
  subject?: string;
  predicate: string;
  object?: string;
  variable?: string;
  operator?: "eq" | "gt" | "lt" | "gte" | "lte" | "ne" | "contains";
};

export type Fact = {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  source: string;
  derived_from?: string[];
  rule_id?: string;
  created_at: string;
  updated_at: string;
  valid_from?: string;
  valid_until?: string;
};

export type Rule = {
  id: string;
  name: string;
  description?: string;
  type: "inference" | "constraint" | "policy";
  conditions: ConditionPattern[];
  conclusion?: { subject?: string; predicate: string; object?: string; variable?: string };
  violation_message?: string;
  severity?: "info" | "warning" | "error" | "critical";
  action?: string;
  escalate?: boolean;
  confidence_factor: number;
  enabled: boolean;
  domain?: string;
  created_at?: string;
};

// ── Pattern Matching ──────────────────────────────────────────

/**
 * Match a single condition against a single fact under an existing binding.
 * Returns a new binding if the match succeeds, or null if it fails.
 */
function matchSingle(cond: ConditionPattern, fact: Fact, binding: Binding): Binding | null {
  const b = { ...binding };
  if (cond.predicate && cond.predicate !== fact.predicate) return null;

  if (cond.subject) {
    if (cond.subject.startsWith("?")) {
      if (b[cond.subject] && b[cond.subject] !== fact.subject) return null;
      b[cond.subject] = fact.subject;
    } else if (cond.subject !== fact.subject) return null;
  }

  if (cond.object) {
    if (cond.object.startsWith("?")) {
      if (b[cond.object] && b[cond.object] !== fact.object) return null;
      b[cond.object] = fact.object;
    } else if (cond.object !== fact.object) return null;
  }

  return b;
}

/**
 * Find all variable bindings that satisfy all conditions against the given facts.
 * Uses recursive conjunctive matching.
 */
export function matchConditions(conditions: ConditionPattern[], facts: Fact[]): Binding[] {
  if (conditions.length === 0) return [{}];

  function solve(condIdx: number, binding: Binding): Binding[] {
    if (condIdx >= conditions.length) return [binding];
    const results: Binding[] = [];
    for (const fact of facts) {
      const b = matchSingle(conditions[condIdx], fact, binding);
      if (b) results.push(...solve(condIdx + 1, b));
    }
    return results;
  }

  return solve(0, {});
}

/**
 * Substitute variable bindings into a conclusion template to produce a concrete triple.
 */
export function resolveBinding(
  template: { subject?: string; predicate: string; object?: string; variable?: string },
  binding: Binding,
): { subject: string; predicate: string; object: string } {
  return {
    subject:
      (template.subject?.startsWith("?") ? binding[template.subject] : template.subject) ||
      "unknown",
    predicate: template.predicate,
    object:
      (template.object?.startsWith("?") ? binding[template.object] : template.object) || "unknown",
  };
}

/**
 * Find fact objects that support a rule's conditions under a given binding.
 */
export function findSupportingFacts(
  conditions: ConditionPattern[],
  facts: Fact[],
  binding: Binding,
): Fact[] {
  const result: Fact[] = [];
  for (const cond of conditions) {
    const s = cond.subject?.startsWith("?") ? binding[cond.subject] : cond.subject;
    const o = cond.object?.startsWith("?") ? binding[cond.object] : cond.object;
    const match = facts.find(
      (f) => f.predicate === cond.predicate && (!s || f.subject === s) && (!o || f.object === o),
    );
    if (match) result.push(match);
  }
  return result;
}

/**
 * Match a condition against a fact with operator support (from rule-engine.ts).
 * Returns true if the fact satisfies the condition.
 */
export function matchConditionToFact(cond: ConditionPattern, fact: Fact): boolean {
  if (cond.predicate !== fact.predicate) return false;
  if (cond.subject && !cond.subject.startsWith("?") && cond.subject !== fact.subject) return false;
  if (cond.object && !cond.object.startsWith("?")) {
    const op = cond.operator || "eq";
    switch (op) {
      case "gt":
        return parseFloat(fact.object) > parseFloat(cond.object);
      case "lt":
        return parseFloat(fact.object) < parseFloat(cond.object);
      case "gte":
        return parseFloat(fact.object) >= parseFloat(cond.object);
      case "lte":
        return parseFloat(fact.object) <= parseFloat(cond.object);
      case "ne":
        return fact.object !== cond.object;
      case "contains":
        return fact.object.includes(cond.object);
      case "eq":
      default:
        return fact.object === cond.object;
    }
  }
  return true;
}
