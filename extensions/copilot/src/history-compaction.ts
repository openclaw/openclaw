import type { CopilotSession } from "@github/copilot-sdk";
import {
  buildAgentHookContextChannelFields,
  type AgentHarnessCompactParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createCopilotAbortError } from "./prompt-error.js";

export type CopilotHistoryCompactResult = Awaited<
  ReturnType<CopilotSession["rpc"]["history"]["compact"]>
>;

export type CopilotHistoryCompactSession = Pick<CopilotSession, "abort" | "disconnect"> & {
  rpc: {
    history: Pick<CopilotSession["rpc"]["history"], "abortManualCompaction" | "compact">;
  };
};

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createCopilotAbortError(signal.reason);
  }
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
