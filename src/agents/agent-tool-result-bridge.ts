/**
 * Bridge between raw pi-embedded tool execution state and the AgentToolResult envelope.
 *
 * This module is intentionally pure — it takes only scalar values that the
 * existing handleToolExecutionEnd already computes. That keeps it free from heavy
 * runtime module imports (channels, plugins, compaction) and safe to use in any layer.
 *
 * Typical call site: after handleToolExecutionEnd extracts the error message
 * and status fields, call buildToolResultEnvelope() with those values to produce
 * a machine-readable AgentToolResult that can be forwarded to hooks, telemetry,
 * or memory judgment.
 *
 * Phase 2 of: docs/reference/agent-architecture-upgrade.md
 */

import { inferNextHint } from "./agent-tool-result-next-hint.js";
import {
  classifyToolError,
  isRetryableErrorCode,
  wrapToolError,
  wrapToolOk,
  type AgentToolResult,
} from "./agent-tool-result.js";

/**
 * Pre-extracted fields from a completed tool call.
 * These match what handleToolExecutionEnd already has in scope after its
 * existing extraction logic runs — no new raw-result parsing needed here.
 */
export type ToolResultBridgeInput = {
  /** Normalized tool name (e.g. "exec", "read", "message"). */
  toolName: string;
  /** Combined error flag: evt.isError || isToolResultError(sanitizedResult). */
  isToolError: boolean;
  /** Whether the tool timed out: isToolResultTimedOut(sanitizedResult). */
  isTimedOut: boolean;
  /**
   * First-line error text: extractToolErrorMessage(sanitizedResult).
   * Undefined when the result is success or when error extraction finds nothing.
   */
  errorMessage: string | undefined;
  /**
   * Plain text output from content blocks: extractToolResultText(sanitizedResult).
   * Used as the summary basis for successful results.
   */
  outputText: string | undefined;
  /** Optional caller-provided override for the success summary line. */
  summaryHint?: string;
  /**
   * Optional caller-provided next_hint. When omitted, a generic hint is
   * inferred from the tool name (Phase 10). Pass an empty string to suppress
   * any inferred hint without providing a custom one.
   */
  nextHint?: string;
};

const SUMMARY_MAX_LEN = 200;

function truncateSummary(text: string): string {
  const firstLine = text.split(/\r?\n/)[0]?.trim() ?? "";
  const line = firstLine || text.slice(0, SUMMARY_MAX_LEN);
  return line.length <= SUMMARY_MAX_LEN ? line : `${line.slice(0, SUMMARY_MAX_LEN)}…`;
}

/**
 * Build an AgentToolResult envelope from pre-extracted tool result fields.
 *
 * Safe to call from after_tool_call hooks, telemetry paths, and memory judgment.
 * Never throws — falls back to sensible defaults on unexpected input.
 *
 * Integration note: the natural call site in handleToolExecutionEnd is just
 * before the after_tool_call hook fires (line ~1260). The inputs are already
 * available there as local variables: toolName, isToolError,
 * isToolResultTimedOut(sanitizedResult), extractToolErrorMessage(sanitizedResult),
 * extractToolResultText(sanitizedResult).
 */
export function buildToolResultEnvelope(input: ToolResultBridgeInput): AgentToolResult {
  const { toolName, isToolError, isTimedOut, errorMessage, outputText, summaryHint, nextHint } =
    input;

  if (isToolError) {
    const message = errorMessage ?? `Tool ${toolName} failed`;
    // Timeout maps directly to "temporary"; other messages are heuristically classified.
    const code = isTimedOut ? "temporary" : classifyToolError(message);
    return wrapToolError({
      code,
      message,
      retryable: isRetryableErrorCode(code),
    });
  }

  const summary =
    summaryHint ?? (outputText ? truncateSummary(outputText) : `${toolName} completed`);
  // Phase 10: attach contextual next_hint. Explicit nextHint wins; empty string suppresses.
  // Otherwise fall back to pattern-inferred hint from the tool name.
  const resolvedNextHint = nextHint !== undefined ? nextHint || undefined : inferNextHint(toolName);
  return wrapToolOk({
    summary,
    data: null, // Callers may extend with structured data in the future.
    sources: [],
    next_hint: resolvedNextHint,
  });
}
