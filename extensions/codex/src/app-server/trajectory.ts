import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { attemptTerminal, type EmbeddedRunAttemptResult } from "./attempt-terminal.js";
import { flattenCodexDynamicToolFunctions, type CodexDynamicToolSpec } from "./protocol.js";

export type CodexTrajectoryRecorder = {
  recordEvent: (type: string, data?: Record<string, unknown>) => void;
  flush: () => Promise<void>;
};

type CodexTrajectoryInit = {
  attempt: EmbeddedRunAttemptParams;
  cwd: string;
  developerInstructions?: string;
  prompt?: string;
  trajectory?: NonNullable<EmbeddedRunAttemptParams["hostCapabilities"]["trajectory"]> | null;
  tools?: CodexDynamicToolSpec[];
};

export function createCodexTrajectoryRecorder(
  params: CodexTrajectoryInit,
): CodexTrajectoryRecorder | null {
  if (!params.trajectory) {
    return null;
  }
  const trajectory = params.trajectory;

  return {
    recordEvent: (type, data) => {
      try {
        trajectory.recordEvent(type, data);
      } catch {
        // Host authority can close before transport callbacks finish during shutdown.
        // Optional diagnostics must not interrupt the owning run lifecycle.
      }
    },
    flush: trajectory.flush,
  };
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
    tools: toTrajectoryToolDefinitions(params.tools),
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
  const terminal = attemptTerminal.project(params.result.terminal);
  recorder.recordEvent("model.completed", {
    threadId: params.threadId,
    turnId: params.turnId,
    timedOut: params.timedOut,
    yieldDetected: params.yieldDetected ?? false,
    aborted: terminal.aborted,
    promptError: normalizeCodexTrajectoryError(terminal.promptError),
    ...(terminal.settlementWarning ? { settlementWarning: terminal.settlementWarning } : {}),
    usage: params.result.attemptUsage,
    assistantTexts: params.result.assistantTexts,
    messagesSnapshot: params.result.messagesSnapshot,
  });
}

function toTrajectoryToolDefinitions(
  tools: readonly CodexDynamicToolSpec[] | undefined,
): Array<{ name: string; description?: string; parameters?: unknown }> | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }
  return flattenCodexDynamicToolFunctions(tools)
    .flatMap((tool) => {
      const name = tool.name?.trim();
      if (!name) {
        return [];
      }
      return [
        {
          name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      ];
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
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
