import type {
  CliBackendExecuteContext,
  CliBackendToolPermissionResult,
} from "openclaw/plugin-sdk/cli-backend";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

/** Native permission and successful-mutation hooks share one protocol boundary. */
export async function handleClaudeToolHook(params: {
  request: Record<string, unknown>;
  input: Record<string, unknown>;
  context: CliBackendExecuteContext | undefined;
  isCurrent: () => boolean;
  signal: AbortSignal;
  authorize: (request: Record<string, unknown>) => Promise<CliBackendToolPermissionResult>;
}): Promise<unknown> {
  const { request, input, context, isCurrent, signal, authorize } = params;
  if (request.callback_id === "PreToolUse" && input.hook_event_name === "PreToolUse") {
    if (
      context &&
      !signal.aborted &&
      typeof input.tool_name === "string" &&
      input.tool_name.startsWith("mcp__openclaw__")
    ) {
      return { continue: true };
    }
    // Native settings can grant tools before can_use_tool. This hook preserves host policy.
    const decision = await authorize({
      tool_name: input.tool_name,
      input: input.tool_input,
      cwd: input.cwd,
      tool_use_id: request.tool_use_id ?? input.tool_use_id,
    });
    const toolCallId = request.tool_use_id ?? input.tool_use_id;
    if (
      decision.behavior === "allow" &&
      context &&
      isCurrent() &&
      !signal.aborted &&
      (input.tool_name === "Edit" || input.tool_name === "Write") &&
      typeof toolCallId === "string"
    ) {
      await context.observeToolMutation?.({
        phase: "before",
        toolName: input.tool_name,
        toolCallId,
        toolInput: decision.updatedInput,
        cwd: typeof input.cwd === "string" ? input.cwd : undefined,
      });
    }
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision.behavior,
        ...(decision.behavior === "allow"
          ? { updatedInput: decision.updatedInput }
          : { permissionDecisionReason: decision.message }),
      },
    };
  }
  if (request.callback_id === "PostToolUse" && input.hook_event_name === "PostToolUse") {
    const toolCallId = request.tool_use_id ?? input.tool_use_id;
    if (
      context &&
      !signal.aborted &&
      (input.tool_name === "Edit" || input.tool_name === "Write") &&
      typeof toolCallId === "string" &&
      isRecord(input.tool_input)
    ) {
      await context.observeToolMutation?.({
        phase: "after",
        toolName: input.tool_name,
        toolCallId,
        toolInput: input.tool_input,
        cwd: typeof input.cwd === "string" ? input.cwd : undefined,
      });
    }
    return {};
  }
  return undefined;
}
