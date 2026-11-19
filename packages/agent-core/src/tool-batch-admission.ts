import type { FinalizedToolCallOutcome, ImmediateToolCallOutcome } from "./tool-call-outcome.js";
import type { AgentTool, AgentToolCall, InternalToolBatchCall } from "./types.js";

/** Validation outcomes read by whole-batch admission; outcome producers own failure provenance. */
type ToolBatchValidation =
  | { kind: "prepared"; args: unknown; tool: AgentTool }
  | Pick<ImmediateToolCallOutcome, "kind" | "result" | "errorKind">;

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

type ToolBatchEntry = Pick<FinalizedToolCallOutcome, "toolCall" | "errorKind"> & {
  kind?: "prepared";
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
