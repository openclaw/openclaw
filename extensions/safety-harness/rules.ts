import type { HarnessTier } from "./types.js";
import { classifyVerb } from "./verb-classifier.js";

export type RuleCondition = {
  /** e.g. ">10" — numeric threshold on a param named "count" */
  count?: string;
  /** Match by verb category (read, write, delete, export) */
  verb?: string;
  /** Match tool source: "bundled" | "community" (Gap 3 resolution) */
  source?: string;
  /** Match if a "path" param contains this substring (Gap 4, 6 resolution) */
  path_contains?: string;
  /** Match if a "path" param matches this regex (Gap 6 resolution) */
  path_matches?: string;
  /** Match if a "command" param contains any of these pipe-separated substrings (Gap 6 resolution) */
  command_contains?: string;
  /** Placeholder for future: recipient_not_in, has_attachments, etc. */
  [key: string]: string | boolean | undefined;
};

export type HarnessRule = {
  /** Tool name pattern. Supports "*" (all) and "namespace.*" (namespace wildcard). */
  tool: string;
  /** Optional conditions that must all be true for the rule to match. */
  when?: RuleCondition;
  /** Tier to assign if rule matches. */
  tier: HarnessTier;
  /** Reason for the classification (logged, shown to operator). */
  reason: string;
  /** Message shown to client on confirm tier. Supports {param} interpolation. */
  message?: string;
};

/**
 * Check if a tool name matches a rule's tool pattern.
 * Case-insensitive. Supports "*" (global wildcard) and "namespace.*" (prefix wildcard).
 */
function toolPatternMatches(pattern: string, toolName: string): boolean {
  const p = pattern.toLowerCase();
  const t = toolName.toLowerCase();

  if (p === "*") return true;
  if (p.endsWith(".*")) {
    const prefix = p.slice(0, -2);
    return t.startsWith(prefix + ".");
  }
  return p === t;
}

/**
 * Parse a numeric threshold condition like ">10", ">=5", "<3", "<=100", "=42".
 */
function parseThreshold(
  condition: string,
): { op: ">" | ">=" | "<" | "<=" | "="; value: number } | null {
  const match = condition.match(/^(>=?|<=?|=)(\d+)$/);
  if (!match) return null;
  return { op: match[1] as ">" | ">=" | "<" | "<=" | "=", value: parseInt(match[2], 10) };
}

/**
 * Check if all conditions in a rule are met.
 * All conditions are ANDed — every specified condition must pass.
 */
function conditionsMatch(
  when: RuleCondition,
  toolName: string,
  params: Record<string, unknown>,
): boolean {
  for (const [key, expected] of Object.entries(when)) {
    if (expected === undefined) continue;

    if (key === "count") {
      const threshold = parseThreshold(expected as string);
      if (!threshold) continue;
      const actual = typeof params.count === "number" ? params.count : Number(params.count);
      if (isNaN(actual)) return false;
      switch (threshold.op) {
        case ">":
          if (!(actual > threshold.value)) return false;
          break;
        case ">=":
          if (!(actual >= threshold.value)) return false;
          break;
        case "<":
          if (!(actual < threshold.value)) return false;
          break;
        case "<=":
          if (!(actual <= threshold.value)) return false;
          break;
        case "=":
          if (actual !== threshold.value) return false;
          break;
      }
    } else if (key === "verb") {
      const verb = classifyVerb(toolName);
      if (verb !== expected) return false;
    } else if (key === "source") {
      // Gap 3: Check tool source (bundled vs community)
      const toolSource = params.__toolSource;
      if (toolSource && toolSource !== expected) return false;
      // If no source info, condition is vacuously true (forward-compatible)
      if (!toolSource) return false;
    } else if (key === "path_contains") {
      // Gap 4, 6: Check if a "path" param contains substring
      const pathParam = String(params.path ?? params.filePath ?? params.file ?? "");
      if (!pathParam.toLowerCase().includes(String(expected).toLowerCase())) return false;
    } else if (key === "path_matches") {
      // Gap 6: Check if a "path" param matches regex
      const pathParam = String(params.path ?? params.filePath ?? params.file ?? "");
      try {
        if (!new RegExp(String(expected), "i").test(pathParam)) return false;
      } catch {
        return false; // Invalid regex — fail safe (don't match)
      }
    } else if (key === "command_contains") {
      // Gap 6: Check if a "command" param contains any pipe-separated substring
      const cmdParam = String(params.command ?? params.cmd ?? "").toLowerCase();
      const patterns = String(expected).toLowerCase().split("|");
      if (!patterns.some((p) => cmdParam.includes(p))) return false;
    }
    // Unrecognized condition keys are silently ignored (forward-compatible)
  }
  return true;
}

/**
 * Check if a rule matches a given tool call.
 *
 * @param rule - The rule to evaluate
 * @param toolName - The tool being called (e.g. "email.delete")
 * @param params - The parameters passed to the tool call
 * @returns true if the rule matches
 */
export function matchRule(
  rule: HarnessRule,
  toolName: string,
  params: Record<string, unknown>,
): boolean {
  if (!toolPatternMatches(rule.tool, toolName)) return false;
  if (rule.when && !conditionsMatch(rule.when, toolName, params)) return false;
  return true;
}
