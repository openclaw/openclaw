import type { InternalToolBatchLifecycle } from "./internal-hooks.js";
import type { AgentTool, AgentToolCall, ToolExecutionMode } from "./types.js";

/** Resolve native and deferred execution constraints before any batch call launches. */
export async function isSequentialToolBatch(params: {
  configuredMode?: ToolExecutionMode;
  calls: readonly AgentToolCall[];
  signal?: AbortSignal;
  resolve: (
    call: AgentToolCall,
  ) => Promise<{ kind: "resolved"; tool?: AgentTool } | { kind: "error"; error: unknown }>;
  lifecycle?: InternalToolBatchLifecycle;
}): Promise<boolean> {
  let hasSequentialToolCall = false;
  if (params.configuredMode !== "sequential") {
    for (const call of params.calls) {
      if (params.signal?.aborted) {
        break;
      }
      const resolution = await params.resolve(call);
      if (resolution.kind === "resolved" && resolution.tool?.executionMode === "sequential") {
        hasSequentialToolCall = true;
        break;
      }
    }
  }
  return (
    params.configuredMode === "sequential" ||
    hasSequentialToolCall ||
    params.lifecycle?.executionMode === "sequential"
  );
}
