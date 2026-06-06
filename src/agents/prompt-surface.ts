import { isOpenClawMainPromptSurface } from "../plugins/agent-prompt-surface-kind.js";
import type { AgentPromptSurfaceKind } from "../plugins/types.js";
import { isAcpSessionKey, isSubagentSessionKey } from "../routing/session-key.js";

export function buildOpenClawToolFallbackText(params: { surface: AgentPromptSurfaceKind }): string {
  if (isOpenClawMainPromptSurface(params.surface)) {
    return "No active OpenClaw tool list was provided. Do not call tools from memory, docs, or prior sessions; use only tools exposed directly by the active backend.";
  }

  return "No OpenClaw tool list is injected for this runtime prompt surface. Use only tools exposed directly by the active backend.";
}

export function shouldRenderOpenClawToolWorkflowHints(params: {
  surface: AgentPromptSurfaceKind;
  hasToolList: boolean;
}): boolean {
  return isOpenClawMainPromptSurface(params.surface);
}

export function resolveAgentPromptSurfaceForSessionKey(
  sessionKey?: string,
): AgentPromptSurfaceKind {
  if (sessionKey && isAcpSessionKey(sessionKey)) {
    return "acp_backend";
  }
  return sessionKey && isSubagentSessionKey(sessionKey) ? "subagent" : "openclaw_main";
}
