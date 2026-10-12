/**
 * Shared before_tool_call state for adjusted tool params.
 * The adapter and wrapper both consult this map so later execution can use the
 * normalized payload selected by hook processing.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { DiagnosticSkillUsedEvent } from "../infra/diagnostic-events.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";

export const adjustedParamsByToolCallId = new Map<string, unknown>();
export const preExecutionBlockedToolCallIds = new Set<string>();
export const structuredReplaySafeToolCallIds = new Set<string>();
// A tracked call starts pending (false), then crosses the implementation boundary (true).
const trackedToolCallIds = new Map<string, boolean>();
const batchAdmittedToolCallIds = new Set<string>();

/** The public skill.used identity of one completed tool call. */
export type ToolCallSkillUsage = Pick<
  DiagnosticSkillUsedEvent,
  "skillName" | "skillSource" | "activation"
>;
const MAX_PENDING_TOOL_CALL_SKILL_USAGE = 1024;
const skillUsageByToolCallId = new Map<string, ToolCallSkillUsage>();

export function buildAdjustedParamsKey(params: { runId?: string; toolCallId: string }): string {
  if (params.runId && params.runId.trim()) {
    return `${params.runId}:${params.toolCallId}`;
  }
  return params.toolCallId;
}

/** Consume and remove hook-adjusted params for a completed tool call. */
export function consumeAdjustedParamsForToolCall(toolCallId: string, runId?: string): unknown {
  const key = buildAdjustedParamsKey({ runId, toolCallId });
  const params = adjustedParamsByToolCallId.get(key);
  adjustedParamsByToolCallId.delete(key);
  return params;
}

/** Snapshot hook-adjusted params without consuming later outcome bookkeeping. */
export function peekAdjustedParamsForToolCall(toolCallId: string, runId?: string): unknown {
  const key = buildAdjustedParamsKey({ runId, toolCallId });
  const params = adjustedParamsByToolCallId.get(key);
  return params === undefined ? undefined : structuredClone(params);
}

/** Consume whether policy prevented the target tool from starting. */
export function consumePreExecutionBlockedToolCall(toolCallId: string, runId?: string): boolean {
  return preExecutionBlockedToolCallIds.delete(buildAdjustedParamsKey({ runId, toolCallId }));
}

/** Snapshot whether policy prevented execution without stealing cleanup from the tool owner. */
export function peekPreExecutionBlockedToolCall(toolCallId: string, runId?: string): boolean {
  return preExecutionBlockedToolCallIds.has(buildAdjustedParamsKey({ runId, toolCallId }));
}

/** Record active wrapper ownership so a racing timeout can inspect the boundary. */
export function recordToolExecutionTracked(toolCallId: string, runId?: string): void {
  const key = buildAdjustedParamsKey({ runId, toolCallId });
  if (!trackedToolCallIds.has(key)) {
    trackedToolCallIds.set(key, false);
  }
}

export function recordToolExecutionStarted(toolCallId: string, runId?: string): void {
  trackedToolCallIds.set(buildAdjustedParamsKey({ runId, toolCallId }), true);
}

/** Release execution-boundary evidence when the wrapped invocation settles. */
export function clearTrackedToolExecution(toolCallId: string, runId?: string): void {
  trackedToolCallIds.delete(buildAdjustedParamsKey({ runId, toolCallId }));
}

/**
 * Consume exact in-flight execution state. Undefined means the wrapper already
 * settled or the producer does not participate in OpenClaw boundary tracking.
 */
export function consumeTrackedToolExecutionStarted(
  toolCallId: string,
  runId?: string,
): boolean | undefined {
  const key = buildAdjustedParamsKey({ runId, toolCallId });
  const started = trackedToolCallIds.get(key);
  trackedToolCallIds.delete(key);
  return started;
}

export function recordStructuredReplaySafeToolCall(toolCallId: string, runId?: string): void {
  structuredReplaySafeToolCallIds.add(buildAdjustedParamsKey({ runId, toolCallId }));
}

export function consumeStructuredReplaySafeToolCall(toolCallId: string, runId?: string): boolean {
  return structuredReplaySafeToolCallIds.delete(buildAdjustedParamsKey({ runId, toolCallId }));
}

/** Mark a call whose loop policy was already admitted with its whole assistant batch. */
export function recordBatchAdmittedToolCall(toolCallId: string, runId?: string): void {
  batchAdmittedToolCallIds.add(buildAdjustedParamsKey({ runId, toolCallId }));
}

/** Consume whole-batch loop admission while leaving the remaining tool policies intact. */
export function consumeBatchAdmittedToolCall(toolCallId: string, runId?: string): boolean {
  return batchAdmittedToolCallIds.delete(buildAdjustedParamsKey({ runId, toolCallId }));
}

/** Release exact batch-admission markers for prepared calls suppressed by steering. */
export function releaseBatchAdmittedToolCalls(
  toolCallIds: readonly string[],
  runId?: string,
): void {
  for (const toolCallId of toolCallIds) {
    batchAdmittedToolCallIds.delete(buildAdjustedParamsKey({ runId, toolCallId }));
  }
}

/** Remove unused batch-admission markers when their embedded run ends. */
export function clearBatchAdmittedToolCallsForRun(runId: string): void {
  const prefix = `${runId}:`;
  for (const key of batchAdmittedToolCallIds) {
    if (key.startsWith(prefix)) {
      batchAdmittedToolCallIds.delete(key);
    }
  }
}

/**
 * Hold a completed call's skill use until its harness finalizes the transcript result.
 * Best effort: a call that never reaches finalization (skill command dispatch, a
 * cancellation-ignoring tool finishing after its run ended) leaves an entry that only
 * the size cap removes.
 */
export function recordToolCallSkillUsage(
  toolCallId: string,
  runId: string | undefined,
  usage: ToolCallSkillUsage,
): void {
  skillUsageByToolCallId.set(buildAdjustedParamsKey({ runId, toolCallId }), usage);
  pruneMapToMaxSize(skillUsageByToolCallId, MAX_PENDING_TOOL_CALL_SKILL_USAGE);
}

/**
 * Moves a call's recorded skill use into the result its transcript entry keeps. Harnesses
 * call this on their final result, after middleware and extensions; the tool's own
 * return value stays exactly as declared for output-schema validation. String or array
 * details stay as returned, without attribution.
 */
export function attachToolCallSkillUsage<T>(result: T, toolCallId: string, runId?: string): T {
  const key = buildAdjustedParamsKey({ runId, toolCallId });
  const usage = skillUsageByToolCallId.get(key);
  skillUsageByToolCallId.delete(key);
  if (!usage || !isRecord(result)) {
    return result;
  }
  const details = result.details ?? undefined;
  if (details !== undefined && !isRecord(details)) {
    return result;
  }
  return { ...result, details: { ...details, openclawSkillUsage: usage } };
}

/** Clear adjusted tool parameters between isolated tests. */
export function resetAdjustedParamsByToolCallIdForTests(): void {
  adjustedParamsByToolCallId.clear();
  preExecutionBlockedToolCallIds.clear();
  trackedToolCallIds.clear();
  structuredReplaySafeToolCallIds.clear();
  batchAdmittedToolCallIds.clear();
  skillUsageByToolCallId.clear();
}
