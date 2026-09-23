import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { invokeNativeHookRelay } from "./native-hook-relay.js";

export function createPermissionRequestFixture(
  relayId: string,
  toolUseId: string,
): Parameters<typeof invokeNativeHookRelay>[0] {
  return {
    provider: "codex",
    relayId,
    event: "permission_request",
    rawPayload: {
      hook_event_name: "PermissionRequest",
      cwd: "/repo",
      tool_name: "Bash",
      tool_use_id: toolUseId,
      tool_input: { command: "git status" },
    },
  };
}

export function readTestNativeAgentId(rawPayload: unknown): string | undefined {
  if (!isRecord(rawPayload) || typeof rawPayload.agent_id !== "string") {
    return undefined;
  }
  return rawPayload.agent_id.trim() || undefined;
}
