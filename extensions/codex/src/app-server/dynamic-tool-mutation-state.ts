import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";

type LastToolError = EmbeddedRunAttemptResult["lastToolError"];
type ToolMutationRuntime = NonNullable<EmbeddedRunAttemptParams["toolMutationRuntime"]>;

/** Apply standard-runtime mutation recovery semantics to one Codex dynamic result. */
export function resolveCodexDynamicToolErrorState(
  current: LastToolError,
  params: {
    errorText: string;
    executionStarted?: boolean;
    mutationState?: ReturnType<ToolMutationRuntime["classify"]>;
    success: boolean;
    terminalType?: "blocked" | "completed" | "error";
    toolName: string;
  },
  mutationRuntime: ToolMutationRuntime | undefined,
): LastToolError {
  if (!params.success) {
    const attemptedMutation =
      params.executionStarted !== false && params.mutationState?.mutatingAction === true;
    const next = {
      toolName: params.toolName,
      error:
        params.errorText ||
        (params.terminalType === "blocked"
          ? "codex dynamic tool blocked"
          : "codex dynamic tool failed"),
      mutatingAction: attemptedMutation,
      ...(attemptedMutation && params.mutationState?.actionFingerprint
        ? { actionFingerprint: params.mutationState.actionFingerprint }
        : {}),
      ...(attemptedMutation && params.mutationState?.fileTarget
        ? { fileTarget: params.mutationState.fileTarget }
        : {}),
    };
    return (
      mutationRuntime?.mergeError(next, current) ??
      (current?.mutatingAction && !attemptedMutation ? current : next)
    );
  }
  // asyncStarted is the terminal success receipt for launching this action;
  // background task completion is tracked by the separate async-task lifecycle.
  const success = params.mutationState
    ? {
        toolName: params.toolName,
        actionFingerprint: params.mutationState.actionFingerprint,
        fileTarget: params.mutationState.fileTarget,
      }
    : { toolName: params.toolName };
  return mutationRuntime
    ? mutationRuntime.resolveSuccess(current, success)
    : current?.mutatingAction
      ? current
      : undefined;
}
