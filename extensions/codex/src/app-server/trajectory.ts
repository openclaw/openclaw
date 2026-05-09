import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "openclaw/plugin-sdk/agent-harness";
import {
  createTrajectoryRuntimeRecorder,
  toRuntimeTrajectoryToolDefinitions,
} from "openclaw/plugin-sdk/agent-harness-runtime";

type CodexTrajectoryRecorder = NonNullable<ReturnType<typeof createTrajectoryRuntimeRecorder>>;

type CodexTrajectoryInit = {
  attempt: EmbeddedRunAttemptParams;
  cwd: string;
  developerInstructions?: string;
  prompt?: string;
  tools?: Array<{ name?: string; description?: string; inputSchema?: unknown }>;
  env?: NodeJS.ProcessEnv;
};

export function createCodexTrajectoryRecorder(
  params: CodexTrajectoryInit,
): CodexTrajectoryRecorder | null {
  return createTrajectoryRuntimeRecorder({
    cfg: params.attempt.config,
    env: params.env,
    runId: params.attempt.runId,
    sessionId: params.attempt.sessionId,
    sessionKey: params.attempt.sessionKey,
    provider: params.attempt.provider,
    modelId: params.attempt.modelId,
    modelApi: params.attempt.model.api,
    workspaceDir: params.cwd,
  });
}

export function recordCodexTrajectoryContext(
  recorder: CodexTrajectoryRecorder | null,
  params: CodexTrajectoryInit,
): void {
  if (!recorder) {
    return;
  }
  recorder.recordEvent("context.compiled", {
    systemPrompt: params.developerInstructions,
    prompt: params.prompt ?? params.attempt.prompt,
    imagesCount: params.attempt.images?.length ?? 0,
    tools: toCodexTrajectoryToolDefinitions(params.tools),
  });
}

export function recordCodexTrajectoryCompletion(
  recorder: CodexTrajectoryRecorder | null,
  params: {
    attempt: EmbeddedRunAttemptParams;
    result: EmbeddedRunAttemptResult;
    threadId: string;
    turnId: string;
    timedOut: boolean;
    yieldDetected?: boolean;
  },
): void {
  if (!recorder) {
    return;
  }
  recorder.recordEvent("model.completed", {
    threadId: params.threadId,
    turnId: params.turnId,
    timedOut: params.timedOut,
    yieldDetected: params.yieldDetected ?? false,
    aborted: params.result.aborted,
    promptError: normalizeCodexTrajectoryError(params.result.promptError),
    usage: params.result.attemptUsage,
    assistantTexts: params.result.assistantTexts,
    messagesSnapshot: params.result.messagesSnapshot,
  });
}

function toCodexTrajectoryToolDefinitions(
  tools: Array<{ name?: string; description?: string; inputSchema?: unknown }> | undefined,
): ReturnType<typeof toRuntimeTrajectoryToolDefinitions> | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }
  return toRuntimeTrajectoryToolDefinitions(
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    })),
  );
}

export function normalizeCodexTrajectoryError(value: unknown): string | null {
  if (!value) {
    return null;
  }
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "Unknown error";
  }
}
