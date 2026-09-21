import {
  HEARTBEAT_RESPONSE_TOOL_NAME,
  normalizeHeartbeatToolResponse,
  type AnyAgentTool,
} from "openclaw/plugin-sdk/agent-harness-runtime";

/** Keeps the thread-stable heartbeat endpoint executable on ordinary Codex turns. */
export function createInactiveCodexHeartbeatResponseTool(tool: AnyAgentTool): AnyAgentTool {
  if (tool.name !== HEARTBEAT_RESPONSE_TOOL_NAME) {
    throw new Error(`Expected ${HEARTBEAT_RESPONSE_TOOL_NAME}, received ${tool.name}`);
  }
  return {
    ...tool,
    execute: async (_toolCallId, args) => {
      const response = normalizeHeartbeatToolResponse(args);
      if (!response) {
        throw new Error(
          "Invalid heartbeat response. Provide outcome, notify, and non-empty summary.",
        );
      }
      if (response.notify) {
        throw new Error("heartbeat_respond cannot send notifications outside a heartbeat turn");
      }
      return {
        content: [],
        details: { status: "ignored", reason: "non-heartbeat-turn" },
        terminate: true,
      };
    },
  };
}
