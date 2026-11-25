import { pruneMapToMaxSize } from "../infra/map-size.js";

/** Detached execution facts; internal readers borrow the same snapshot. */
const adjustedParamsByToolCallId = new Map<string, unknown>();
export const preExecutionBlockedToolCallIds = new Set<string>();
export const structuredReplaySafeToolCallIds = new Set<string>();
// A tracked call starts pending (false), then crosses the implementation boundary (true).
const trackedToolCallIds = new Map<string, boolean>();

export function buildAdjustedParamsKey(params: { runId?: string; toolCallId: string }): string {
  if (params.runId && params.runId.trim()) {
    return `${params.runId}:${params.toolCallId}`;
  }
  return params.toolCallId;
}

/** Detach before mutable execution; mutable hook/middleware inputs get their own copies. */
export function recordAdjustedParamsForToolCall(
  toolCallId: string | undefined,
  params: unknown,
  runId?: string,
): void {
  if (!toolCallId) {
    return;
  }
  let snapshot: unknown;
  try {
    snapshot = structuredClone(params);
  } catch {
    return;
  }
  adjustedParamsByToolCallId.set(buildAdjustedParamsKey({ runId, toolCallId }), snapshot);
  pruneMapToMaxSize(adjustedParamsByToolCallId, 1024);
}

/** Consume and remove hook-adjusted params for a completed tool call. */
export function consumeAdjustedParamsForToolCall(toolCallId: string, runId?: string): unknown {
  const key = buildAdjustedParamsKey({ runId, toolCallId });
  const params = adjustedParamsByToolCallId.get(key);
  adjustedParamsByToolCallId.delete(key);
  return params;
}

/** Borrow execution facts without consuming later outcome bookkeeping. */
export function peekAdjustedParamsForToolCall(toolCallId: string, runId?: string): unknown {
  return adjustedParamsByToolCallId.get(buildAdjustedParamsKey({ runId, toolCallId }));
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

export function resetAdjustedParamsByToolCallIdForTests(): void {
  adjustedParamsByToolCallId.clear();
  preExecutionBlockedToolCallIds.clear();
  trackedToolCallIds.clear();
  structuredReplaySafeToolCallIds.clear();
}
