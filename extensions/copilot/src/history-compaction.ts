import {
  buildAgentHookContextChannelFields,
  type AgentHarnessCompactParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";

export interface CopilotHistoryCompactResult {
  success: boolean;
  tokensRemoved: number;
  messagesRemoved: number;
  summaryContent?: string;
  contextWindow?: {
    tokenLimit: number;
    currentTokens: number;
    messagesLength: number;
    systemTokens?: number;
    conversationTokens?: number;
    toolDefinitionsTokens?: number;
  };
}

export interface CopilotHistoryCompactSession {
  abort(): Promise<void>;
  disconnect(): Promise<void>;
  rpc: {
    history: {
      abortManualCompaction(): Promise<{ aborted: boolean }>;
      compact(params?: { customInstructions?: string }): Promise<CopilotHistoryCompactResult>;
    };
  };
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  const reason = "reason" in signal ? signal.reason : undefined;
  if (reason instanceof Error) {
    throw reason;
  }
  const error = reason ? new Error("aborted", { cause: reason }) : new Error("aborted");
  error.name = "AbortError";
  throw error;
}

export function isStaleSdkSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(404|not found|no such session|unknown session|stale|deleted|does not exist)\b/i.test(
    message,
  );
}

export function buildCopilotCompactionHookContext(params: AgentHarnessCompactParams) {
  return {
    ...(params.runId ? { runId: params.runId } : {}),
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    workspaceDir: params.workspaceDir,
    modelProviderId: params.provider,
    modelId: params.model,
    trigger: params.trigger,
    ...buildAgentHookContextChannelFields(params),
  };
}
