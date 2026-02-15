import type { EmbeddedRunAttemptParams } from "./types.js";
import { createInternalHookEvent, triggerInternalHook } from "../../../hooks/internal-hooks.js";

type LifecycleParams = Pick<
  EmbeddedRunAttemptParams,
  "sessionId" | "runId" | "provider" | "modelId" | "messageProvider" | "messageChannel"
>;

type EmitInternalAgentHook = (action: string, context: Record<string, unknown>) => Promise<void>;

type ResponseLifecycleTrackerOptions = {
  params: LifecycleParams;
  emitInternalAgentHook: EmitInternalAgentHook;
  onAssistantMessageStart?: () => void;
  formatError: (err: unknown) => string;
};

function buildLifecycleContext(params: LifecycleParams): Record<string, unknown> {
  return {
    sessionId: params.sessionId,
    runId: params.runId,
    provider: params.provider,
    model: params.modelId,
    messageProvider: params.messageProvider,
    messageChannel: params.messageChannel,
  };
}

export function createInternalAgentHookEmitter(
  params: Pick<EmbeddedRunAttemptParams, "sessionKey" | "runId">,
  warn: (message: string) => void,
): EmitInternalAgentHook {
  // Internal hook events require a non-empty key; keep real sessionKey when present and
  // otherwise use a run-scoped fallback that cannot be mistaken for a persisted session key.
  const hookSessionKey = params.sessionKey?.trim() || `run:${params.runId}`;

  return async (action: string, context: Record<string, unknown>) => {
    try {
      const hookEvent = createInternalHookEvent("agent", action, hookSessionKey, context);
      await triggerInternalHook(hookEvent);
    } catch (err) {
      warn(`agent:${action} hook failed: ${String(err)}`);
    }
  };
}

export async function emitThinkingStart(
  params: LifecycleParams,
  emitInternalAgentHook: EmitInternalAgentHook,
): Promise<void> {
  await emitInternalAgentHook("thinking:start", buildLifecycleContext(params));
}

export async function emitThinkingEnd(params: {
  lifecycleParams: LifecycleParams;
  emitInternalAgentHook: EmitInternalAgentHook;
  promptStartedAt: number;
  promptError: unknown;
  formatError: (err: unknown) => string;
}): Promise<void> {
  await params.emitInternalAgentHook("thinking:end", {
    ...buildLifecycleContext(params.lifecycleParams),
    durationMs: Date.now() - params.promptStartedAt,
    error: params.promptError ? params.formatError(params.promptError) : undefined,
  });
}

export function createResponseLifecycleTracker(options: ResponseLifecycleTrackerOptions): {
  handleAssistantMessageStart: () => void;
  emitResponseStartIfNeeded: (hasResponseOutput: boolean) => Promise<void>;
  emitResponseEnd: (promptError: unknown) => Promise<void>;
} {
  let responseStartedAt: number | null = null;

  const emitResponseStart = async (startedAt: number) => {
    if (responseStartedAt !== null) {
      return;
    }
    responseStartedAt = startedAt;
    await options.emitInternalAgentHook("response:start", buildLifecycleContext(options.params));
  };

  return {
    handleAssistantMessageStart: () => {
      void emitResponseStart(Date.now());
      void options.onAssistantMessageStart?.();
    },
    emitResponseStartIfNeeded: async (hasResponseOutput: boolean) => {
      if (!hasResponseOutput) {
        return;
      }
      await emitResponseStart(Date.now());
    },
    emitResponseEnd: async (promptError: unknown) => {
      if (responseStartedAt === null) {
        return;
      }
      await options.emitInternalAgentHook("response:end", {
        ...buildLifecycleContext(options.params),
        durationMs: Date.now() - responseStartedAt,
        error: promptError ? options.formatError(promptError) : undefined,
      });
    },
  };
}
