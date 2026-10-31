import type { CopilotClient, CopilotSession, SessionConfig } from "@github/copilot-sdk";
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

export async function compactTrackedSdkSession(params: {
  abortSignal?: AbortSignal;
  assertCurrent: () => void;
  client: CopilotClient;
  customInstructions?: string;
  gitHubToken?: string;
  onSession?: (session: CopilotHistoryCompactSession) => void;
  sessionConfig: SessionConfig;
  sdkSessionId: string;
}): Promise<CopilotHistoryCompactResult> {
  params.assertCurrent();
  throwIfAborted(params.abortSignal);
  const session = await params.client.resumeSession(params.sdkSessionId, {
    ...params.sessionConfig,
    continuePendingWork: false,
    ...(params.gitHubToken ? { gitHubToken: params.gitHubToken } : {}),
    suppressResumeEvent: true,
  });
  params.onSession?.(session);
  const request = params.customInstructions?.trim()
    ? { customInstructions: params.customInstructions }
    : undefined;
  try {
    params.assertCurrent();
    throwIfAborted(params.abortSignal);
    return await session.rpc.history.compact(request);
  } finally {
    try {
      await session.disconnect();
    } catch {
      // Preserve the compaction or cancellation outcome; cleanup is best-effort here.
    }
  }
}
