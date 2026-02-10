import { createInternalHookEvent, triggerInternalHook } from "../hooks/internal-hooks.js";

export interface AgentEndHookParams {
  messages: unknown[];
  success: boolean;
  error?: string;
  durationMs: number;
  agentId?: string;
  sessionKey?: string;
  workspaceDir: string;
}

export async function triggerAgentEndHook(params: AgentEndHookParams): Promise<void> {
  const context: Record<string, unknown> = {
    messages: params.messages,
    success: params.success,
    durationMs: params.durationMs,
    workspaceDir: params.workspaceDir,
  };
  if (params.error !== undefined) {
    context.error = params.error;
  }
  if (params.agentId !== undefined) {
    context.agentId = params.agentId;
  }
  const sessionKey = params.sessionKey ?? "unknown";
  const event = createInternalHookEvent("agent", "end", sessionKey, context);
  await triggerInternalHook(event);
}
