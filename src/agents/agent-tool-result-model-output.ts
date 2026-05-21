/**
 * Helpers for injecting structured AgentToolResult metadata into the
 * tool_result content block text that the model receives.
 *
 * The metadata is appended after the existing tool output text, delimited
 * by recognizable XML-style tags. This keeps the original text byte-for-byte
 * intact and makes the block easy to strip, parse, or ignore by any consumer.
 *
 * Design constraints:
 * - Never mutates or truncates the original text.
 * - Never throws — falls back to returning the original text on any error.
 * - Round-trippable: extractStructuredResultFromText undoes appendStructuredResultMetadata.
 * - Only appends when called; callers control whether to opt in.
 *
 * Phase 4 of: docs/reference/agent-architecture-upgrade.md
 */

import type { AgentToolResult } from "./agent-tool-result.js";

/** Opening tag that delimits the structured result metadata block. */
export const OC_RESULT_META_OPEN = "<oc_result_meta>";

/** Closing tag that delimits the structured result metadata block. */
export const OC_RESULT_META_CLOSE = "</oc_result_meta>";

/**
 * Append a compact JSON metadata block to tool output text.
 *
 * The result of this function is what the model receives in the
 * tool_result content block. The original `text` is completely unchanged —
 * only the tagged metadata block is appended on a new line.
 *
 * Example output:
 *   "file contents here\n<oc_result_meta>{"ok":true,...}</oc_result_meta>"
 *
 * Never throws — if JSON serialization fails for any reason, the original
 * text is returned unmodified.
 */
export function appendStructuredResultMetadata(text: string, envelope: AgentToolResult): string {
  try {
    const compact = JSON.stringify(envelope);
    return `${text}\n${OC_RESULT_META_OPEN}${compact}${OC_RESULT_META_CLOSE}`;
  } catch {
    // JSON.stringify should not fail for AgentToolResult (no circular refs,
    // all fields are serializable), but guard defensively.
    return text;
  }
}

/**
 * Extract an AgentToolResult from text that was previously annotated by
 * appendStructuredResultMetadata.
 *
 * Returns undefined if:
 * - No metadata block is present (backwards-compatible text without metadata).
 * - The JSON inside the tags is malformed.
 * - The parsed value does not look like an AgentToolResult.
 *
 * Never throws.
 */
export function extractStructuredResultFromText(text: string): AgentToolResult | undefined {
  try {
    const openIdx = text.indexOf(OC_RESULT_META_OPEN);
    if (openIdx < 0) {
      return undefined;
    }
    const jsonStart = openIdx + OC_RESULT_META_OPEN.length;
    const closeIdx = text.indexOf(OC_RESULT_META_CLOSE, jsonStart);
    if (closeIdx < 0) {
      return undefined;
    }
    const json = text.slice(jsonStart, closeIdx);
    const parsed: unknown = JSON.parse(json);
    if (parsed !== null && typeof parsed === "object" && "ok" in parsed) {
      return parsed as AgentToolResult;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Strip the metadata block from tool output text, returning only the
 * original text that was passed to appendStructuredResultMetadata.
 *
 * Returns the input unchanged if no metadata block is present.
 * Never throws.
 */
export function stripStructuredResultMetadata(text: string): string {
  try {
    const openIdx = text.indexOf(OC_RESULT_META_OPEN);
    if (openIdx < 0) {
      return text;
    }
    const closeIdx = text.indexOf(OC_RESULT_META_CLOSE, openIdx);
    if (closeIdx < 0) {
      return text;
    }
    const before = text.slice(0, openIdx);
    const after = text.slice(closeIdx + OC_RESULT_META_CLOSE.length);
    // Trim the newline we prepended before the open tag.
    return (before.endsWith("\n") ? before.slice(0, -1) : before) + after;
  } catch {
    return text;
  }
}
