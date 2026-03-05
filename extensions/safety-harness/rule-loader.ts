import fs from "node:fs";
import { parse } from "yaml";
import type { HarnessRule } from "./rules.js";

/**
 * Validate that an unknown value has the required fields for a HarnessRule.
 */
function isValidRule(value: unknown): value is HarnessRule {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return typeof r.tool === "string" && typeof r.tier === "string" && typeof r.reason === "string";
}

/**
 * Parse YAML content containing a `rules:` list of HarnessRule objects.
 * Uses the `yaml` npm package for parsing.
 * Returns empty array on any parse error (fail-safe).
 */
export function parseRulesYaml(content: string): HarnessRule[] {
  try {
    const doc = parse(content) as { rules?: unknown[] };
    if (!Array.isArray(doc?.rules)) return [];
    return doc.rules.filter(isValidRule) as HarnessRule[];
  } catch {
    return [];
  }
}

/**
 * Load rules from a YAML file path. Returns empty array if file doesn't exist or can't be read.
 */
export function loadRulesFromYaml(filePath: string): HarnessRule[] {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return parseRulesYaml(content);
  } catch {
    return [];
  }
}
