/**
 * Shared before_tool_call state for adjusted tool params.
 * The adapter and wrapper both consult this map so later execution can use the
 * normalized payload selected by hook processing.
 */
export const adjustedParamsByToolCallId = new Map<string, unknown>();

export function buildAdjustedParamsKey(params: { runId?: string; toolCallId: string }): string {
  if (params.runId && params.runId.trim()) {
    return `${params.runId}:${params.toolCallId}`;
  }
  return params.toolCallId;
}

export function consumeAdjustedParamsForToolCall(toolCallId: string, runId?: string): unknown {
  const adjustedParamsKey = buildAdjustedParamsKey({ runId, toolCallId });
  const params = adjustedParamsByToolCallId.get(adjustedParamsKey);
  adjustedParamsByToolCallId.delete(adjustedParamsKey);
  return params;
}

/** Clear adjusted tool parameters between isolated tests. */
export function resetAdjustedParamsByToolCallIdForTests(): void {
  adjustedParamsByToolCallId.clear();
}
