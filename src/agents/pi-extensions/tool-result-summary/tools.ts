/**
 * Tool filtering utilities for Tool Result Vector extension.
 *
 * Determines which tool results should be processed based on configuration.
 */

import type { ToolsFilterConfig } from "./types.js";

/**
 * Compiled pattern for tool matching.
 */
type CompiledPattern =
  | { kind: "all" }
  | { kind: "exact"; value: string }
  | { kind: "regex"; value: RegExp };

/**
 * Normalize pattern strings to lowercase and filter empty values.
 */
function normalizePatterns(patterns?: string[]): string[] {
  if (!Array.isArray(patterns)) {
    return [];
  }
  return patterns
    .map((p) =>
      String(p ?? "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
}

/**
 * Compile a single pattern string into a matcher.
 */
function compilePattern(pattern: string): CompiledPattern {
  if (pattern === "*") {
    return { kind: "all" };
  }
  if (!pattern.includes("*")) {
    return { kind: "exact", value: pattern };
  }

  // Convert glob pattern to regex
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped.replaceAll("\\*", ".*")}$`);
  return { kind: "regex", value: re };
}

/**
 * Compile multiple patterns into matchers.
 */
function compilePatterns(patterns?: string[]): CompiledPattern[] {
  return normalizePatterns(patterns).map(compilePattern);
}

/**
 * Check if a tool name matches any of the compiled patterns.
 */
function matchesAny(toolName: string, patterns: CompiledPattern[]): boolean {
  const normalized = toolName.trim().toLowerCase();
  for (const p of patterns) {
    if (p.kind === "all") {
      return true;
    }
    if (p.kind === "exact" && normalized === p.value) {
      return true;
    }
    if (p.kind === "regex" && p.value.test(normalized)) {
      return true;
    }
  }
  return false;
}

/**
 * Create a predicate function to check if a tool should be processed.
 */
export function makeToolFilterPredicate(config: ToolsFilterConfig): (toolName: string) => boolean {
  const denyPatterns = compilePatterns(config.exclude);
  const allowPatterns = compilePatterns(config.include);

  return (toolName: string): boolean => {
    const normalized = toolName.trim().toLowerCase();

    // Check deny list first
    if (matchesAny(normalized, denyPatterns)) {
      return false;
    }

    // If no include list, allow all (except denied)
    if (allowPatterns.length === 0) {
      return true;
    }

    // Check include list
    return matchesAny(normalized, allowPatterns);
  };
}

/**
 * Estimate the character length of tool result content.
 */
export function estimateContentLength(content: Array<{ type: string; text?: string }>): number {
  let length = 0;
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      length += block.text.length;
    } else if (block.type === "image") {
      // Rough estimate for image content
      length += 1000;
    }
  }
  return length;
}

/**
 * Truncate content to a maximum character length.
 * Preserves structure by keeping head and tail.
 */
export function truncateContent(
  content: Array<{ type: string; text?: string }>,
  maxChars: number,
): Array<{ type: string; text?: string }> {
  const result: Array<{ type: string; text?: string }> = [];
  let remaining = maxChars;

  for (const block of content) {
    if (remaining <= 0) {
      break;
    }

    if (block.type === "text" && typeof block.text === "string") {
      if (block.text.length <= remaining) {
        result.push(block);
        remaining -= block.text.length;
      } else {
        // Truncate and add ellipsis
        result.push({
          type: "text",
          text: block.text.slice(0, remaining) + "...",
        });
        remaining = 0;
      }
    }
    // Skip images when truncating
  }

  return result;
}
