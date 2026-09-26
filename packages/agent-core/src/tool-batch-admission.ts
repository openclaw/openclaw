import type { InternalToolBatchLifecycle } from "./internal-hooks.js";
import type { AgentTool, AgentToolCall, AgentToolResult, InternalToolBatchCall } from "./types.js";

/** Validation outcomes read by whole-batch admission; agent-loop owns the full shapes. */
type ToolBatchValidation =
  | { kind: "prepared"; args: unknown; tool: AgentTool }
  | { kind: "immediate"; result: AgentToolResult<unknown>; errorKind?: "argument-validation" };

/** Map validated calls to admission candidates in assistant order. */
export function toToolBatchCalls(
  toolCalls: readonly AgentToolCall[],
  validated: ReadonlyMap<AgentToolCall, ToolBatchValidation>,
): InternalToolBatchCall[] {
  return toolCalls.flatMap((toolCall): InternalToolBatchCall[] => {
    const validation = validated.get(toolCall);
    if (validation?.kind === "prepared") {
      return [{ toolCall, args: validation.args, tool: validation.tool }];
    }
    // Rejected arguments never execute, but repeating them is still a tool loop.
    return validation?.errorKind === "argument-validation"
      ? [{ toolCall, args: toolCall.arguments, validationFailure: validation.result }]
      : [];
  });
}

type ToolBatchEntry = {
  kind?: "prepared";
  toolCall: AgentToolCall;
  errorKind?: "argument-validation";
};

/** Admitted calls, prepared or rejected, whose admission a skipped batch must release. */
export function admittedIds(
  toolCalls: readonly AgentToolCall[],
  validated: ReadonlyMap<AgentToolCall, ToolBatchValidation>,
): string[] {
  return toToolBatchCalls(toolCalls, validated).map((call) => call.toolCall.id);
}

/** Admitted entries among prepared batch entries: ready calls and rejected calls. */
export function admittedEntryIds(entries: readonly ToolBatchEntry[]): string[] {
  return entries.flatMap((entry) =>
    entry.kind === "prepared" || entry.errorKind === "argument-validation"
      ? [entry.toolCall.id]
      : [],
  );
}

/**
 * Rejected calls never start, so they launch as lifecycle commits when the
 * launch cursor passes their assistant-order position. Admission then records
 * them between the prepared calls that commit as their implementations start.
 */
export function createRejectedToolCallLauncher(
  entries: readonly ToolBatchEntry[],
  lifecycle: InternalToolBatchLifecycle | undefined,
): (end: number) => { index: number; error: unknown } | undefined {
  let next = 0;
  return (end) => {
    for (; next < end; next += 1) {
      const entry = entries[next];
      if (entry?.errorKind !== "argument-validation") {
        continue;
      }
      try {
        lifecycle?.commitReadyCalls([
          { toolCallId: entry.toolCall.id, args: entry.toolCall.arguments },
        ]);
      } catch (error) {
        return { index: next, error };
      }
    }
    return undefined;
  };
}
