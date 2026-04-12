// RI-011 — Anti-Rationalization Rules Engine
//
// Pure, stateless engine. Evaluates assistant text + tool-call params
// against a rule catalog and returns an action + rebuttal. No I/O, no
// network, no session state — caller passes everything in.
//
// Wire point: `pi-tools.before-tool-call.ts::runBeforeToolCallHook`,
// between loop detection and the plugin hook. Block actions return
// the same `{blocked: true, reason}` shape the existing hook already
// produces, so the call-site diff is tiny.

import rulesJson from "./rationalization-rules.json" with { type: "json" };

export type RationalizationAction = "warn" | "require_override" | "block";
export type RationalizationSeverity = "low" | "medium" | "high" | "critical";

export interface RationalizationRule {
  id: string;
  category: string;
  severity: RationalizationSeverity;
  /** Regex source (compiled on first use per rule instance). */
  pattern: string;
  rebuttal: string;
  action: RationalizationAction;
}

export interface CompiledRule extends RationalizationRule {
  compiled: RegExp;
}

export interface RationalizationEvaluation {
  matched: boolean;
  rule?: CompiledRule;
  /** Which text source produced the match: "assistant-text" or "tool-params". */
  matchedIn?: "assistant-text" | "tool-params";
  action?: RationalizationAction;
  rebuttal?: string;
  /** A short reason string suitable for surfacing in block outcomes. */
  reason?: string;
}

export interface EvaluateToolCallInput {
  toolName: string;
  params: unknown;
  /**
   * Recent assistant prose, typically the last few user-visible messages from
   * the run loop. A rolling window of ~4k chars is plenty. Empty string when
   * there's nothing to inspect — we still check tool params.
   */
  recentAssistantText: string;
  /**
   * When true, a matched "require_override" rule is treated as blocked
   * (the caller hasn't explicitly authorized it). Callers can set this
   * to false when they've already captured an override justification.
   */
  requireOverrideBlocks?: boolean;
}

const DEFAULT_RULES: CompiledRule[] = (
  (rulesJson as { rules: RationalizationRule[] }).rules ?? []
).map(compileRule);

let activeRules: CompiledRule[] = DEFAULT_RULES;

/** Override the rule catalog (tests only). */
export function __setRationalizationRulesForTest(
  rules: RationalizationRule[] | null,
): void {
  activeRules = rules === null ? DEFAULT_RULES : rules.map(compileRule);
}

export function getRationalizationRules(): readonly CompiledRule[] {
  return activeRules;
}

/**
 * Evaluate a proposed tool call against the rule catalog.
 *
 * Matching order:
 *   1. Walk rules in catalog order.
 *   2. For each rule, test first `recentAssistantText`, then stringified
 *      `params`. First match wins — so rule ORDER in the JSON matters
 *      for overlapping patterns.
 *   3. Return a populated evaluation for the first match, or a matched=false
 *      result if nothing hits.
 *
 * The engine is intentionally greedy about matching — false positives are
 * surfaced as warnings, not blocks, unless the rule is explicitly marked
 * `block` or `require_override`. Callers should treat warnings as diagnostic
 * hints, not forced-fail.
 */
export function evaluateToolCall(
  input: EvaluateToolCallInput,
): RationalizationEvaluation {
  const prose = input.recentAssistantText || "";
  const paramsString = stringifyParams(input.params);
  const requireOverrideBlocks = input.requireOverrideBlocks ?? true;

  for (const rule of activeRules) {
    // Reset regex state between tests — a global-ish pattern would otherwise
    // carry lastIndex across calls. Our patterns are anchorless so we
    // re-run them as simple .test() which is stateless for non-/g flags.
    const inProse = prose.length > 0 && rule.compiled.test(prose);
    if (inProse) {
      return buildEvaluation(rule, "assistant-text", requireOverrideBlocks);
    }
    const inParams = paramsString.length > 0 && rule.compiled.test(paramsString);
    if (inParams) {
      return buildEvaluation(rule, "tool-params", requireOverrideBlocks);
    }
  }

  return { matched: false };
}

function buildEvaluation(
  rule: CompiledRule,
  matchedIn: "assistant-text" | "tool-params",
  requireOverrideBlocks: boolean,
): RationalizationEvaluation {
  const action: RationalizationAction =
    rule.action === "require_override" && !requireOverrideBlocks
      ? "warn"
      : rule.action;

  const reason =
    action === "block" || action === "require_override"
      ? `Rationalization rule "${rule.id}" (${rule.severity}, ${rule.category}) matched: ${rule.rebuttal}`
      : undefined;

  return {
    matched: true,
    rule,
    matchedIn,
    action,
    rebuttal: rule.rebuttal,
    reason,
  };
}

function compileRule(rule: RationalizationRule): CompiledRule {
  try {
    // Case-insensitive by default. No global flag — we want stateless .test().
    return { ...rule, compiled: new RegExp(rule.pattern, "i") };
  } catch (err) {
    // A malformed rule should not break the whole engine. Replace with a
    // no-match pattern so iteration skips it silently.
    return {
      ...rule,
      compiled: /$a/,
      rebuttal: `${rule.rebuttal} (rule regex invalid: ${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

function stringifyParams(params: unknown): string {
  if (params === null || params === undefined) return "";
  if (typeof params === "string") return params;
  try {
    return JSON.stringify(params);
  } catch {
    return "";
  }
}

/**
 * Push a line onto a rolling assistant-text window, enforcing a character
 * cap. Used by the run loop to build the `recentAssistantText` input that
 * `evaluateToolCall` consumes.
 */
export function appendToAssistantWindow(
  window: string,
  nextText: string,
  maxChars: number = 4096,
): string {
  const next = (window ? `${window}\n` : "") + nextText;
  if (next.length <= maxChars) return next;
  // Trim from the left — we want to keep the MOST RECENT text in the window.
  return next.slice(next.length - maxChars);
}
