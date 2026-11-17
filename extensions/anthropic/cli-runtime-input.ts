import type { CliBackendExecuteContext } from "openclaw/plugin-sdk/cli-backend";

export function createClaudeCliUserInput(
  context: CliBackendExecuteContext,
  text: string,
  uuid: string,
  hostGenerated = false,
) {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    uuid,
    // Claude saves synthetic input as a meta row: the model reads it, history never shows it.
    ...(hostGenerated ? { isSynthetic: true } : {}),
    ...(context.sessionId ? { session_id: context.sessionId } : {}),
  };
}
