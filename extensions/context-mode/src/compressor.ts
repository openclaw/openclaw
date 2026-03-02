/**
 * Tool output compression strategies.
 *
 * Compresses large tool results into concise summaries while preserving
 * key information (URLs, error messages, counts, structure shape).
 * Full text is stored in the knowledge base for on-demand retrieval.
 */

import type { CompressionResult, ContextModeConfig } from "./types.js";

let refCounter = 0;

/** Generate a short, session-unique reference ID. */
export function generateRefId(): string {
  return `ctx_${Date.now().toString(36)}_${(refCounter++).toString(36)}`;
}

/** Reset the ref counter (for tests). */
export function resetRefCounter(): void {
  refCounter = 0;
}

// Patterns worth extracting from large outputs
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/g;
const ERROR_PATTERN =
  /(?:error|Error|ERROR|exception|Exception|EXCEPTION|failed|FAILED)[:\s].{0,120}/g;
const COUNT_PATTERN = /(?:total|count|found|returned|results?|items?|rows?)[:\s]*\d+/gi;

/**
 * Extract key signals from text: URLs, errors, and counts.
 * Returns deduplicated, truncated extractions.
 * Scans only the first 50KB to avoid expensive regex on huge inputs.
 */
function extractKeySignals(text: string): string[] {
  const scanText = text.length > 50_000 ? text.slice(0, 50_000) : text;
  const signals: string[] = [];

  const urls = [...new Set(scanText.match(URL_PATTERN) ?? [])];
  if (urls.length > 0) {
    const shown = urls.slice(0, 5);
    signals.push(`URLs (${urls.length}): ${shown.join(", ")}${urls.length > 5 ? " ..." : ""}`);
  }

  const errors = [...new Set(scanText.match(ERROR_PATTERN) ?? [])];
  if (errors.length > 0) {
    signals.push(`Errors: ${errors.slice(0, 3).join("; ")}`);
  }

  const counts = [...new Set(scanText.match(COUNT_PATTERN) ?? [])];
  if (counts.length > 0) {
    signals.push(`Counts: ${counts.slice(0, 5).join(", ")}`);
  }

  return signals;
}

/**
 * Try to detect and summarize JSON-structured data.
 * Returns a shape summary if the text looks like JSON.
 */
const MAX_JSON_PARSE_SIZE = 100_000; // 100KB — skip JSON.parse for larger inputs

function tryJsonSummary(text: string): string | null {
  // Scan for first non-whitespace char without allocating a trimmed copy
  let firstChar = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    // skip whitespace: space, tab, newline, carriage return
    if (ch !== 32 && ch !== 9 && ch !== 10 && ch !== 13) {
      firstChar = text[i]!;
      break;
    }
  }

  if (firstChar !== "{" && firstChar !== "[") {
    return null;
  }

  // Guard: only attempt JSON.parse for inputs under 100KB
  if (text.length > MAX_JSON_PARSE_SIZE) {
    return null;
  }

  try {
    const parsed = JSON.parse(text);

    if (Array.isArray(parsed)) {
      const len = parsed.length;
      if (len === 0) {
        return "JSON array (empty)";
      }
      const first = parsed[0];
      const keys =
        first && typeof first === "object" && !Array.isArray(first)
          ? Object.keys(first).slice(0, 8).join(", ")
          : typeof first;
      const sample = JSON.stringify(first).slice(0, 200);
      return `JSON array (${len} items), keys: [${keys}], sample: ${sample}`;
    }

    if (typeof parsed === "object" && parsed !== null) {
      const keys = Object.keys(parsed);
      const preview: Record<string, string> = {};
      for (const key of keys.slice(0, 6)) {
        const val = parsed[key];
        if (typeof val === "string") {
          preview[key] = val.length > 60 ? `${val.slice(0, 60)}...` : val;
        } else if (typeof val === "number" || typeof val === "boolean") {
          preview[key] = String(val);
        } else if (Array.isArray(val)) {
          preview[key] = `[array, ${val.length} items]`;
        } else if (val && typeof val === "object") {
          preview[key] = `{object, ${Object.keys(val).length} keys}`;
        }
      }
      const extra = keys.length > 6 ? `, +${keys.length - 6} more keys` : "";
      return `JSON object (${keys.length} keys${extra}): ${JSON.stringify(preview)}`;
    }
  } catch {
    // not valid JSON
  }

  return null;
}

/**
 * Compress a tool result text into a summary.
 *
 * Strategy:
 * 1. If text is JSON, produce a structural summary
 * 2. Keep the first N characters as head context
 * 3. Extract key signals (URLs, errors, counts)
 * 4. Include a retrieval reference for the full text
 */
export function compressToolResult(
  text: string,
  toolName: string,
  config: ContextModeConfig,
): CompressionResult {
  const refId = generateRefId();
  const originalChars = text.length;
  const parts: string[] = [];

  parts.push(`[Context Mode: compressed from ${originalChars.toLocaleString()} chars]`);

  // Try JSON structural summary first
  const jsonSummary = tryJsonSummary(text);
  if (jsonSummary) {
    parts.push(`Structure: ${jsonSummary}`);
  }

  // Keep head of the original text
  const headChars = config.summaryHeadChars;
  const head = text.slice(0, headChars);
  const headTrimmed = head.includes("\n") ? head.slice(0, head.lastIndexOf("\n")) : head;
  if (headTrimmed.length > 0) {
    parts.push(`Head:\n${headTrimmed}`);
  }

  // Extract key signals
  const signals = extractKeySignals(text);
  if (signals.length > 0) {
    parts.push(signals.join("\n"));
  }

  // Line count for multiline outputs (char-scan avoids split allocation)
  let lineCount = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lineCount++;
  }
  if (lineCount > 10) {
    parts.push(`Total lines: ${lineCount}`);
  }

  parts.push(
    `\nFull output stored as ref="${refId}". ` +
      `Use context_retrieve tool with this ref to get the complete text.`,
  );

  return {
    summary: parts.join("\n\n"),
    refId,
    originalChars,
  };
}
