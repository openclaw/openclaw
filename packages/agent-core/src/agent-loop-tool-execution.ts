import type { AgentEventSink } from "./agent-stream-response.js";
import {
  getInternalToolExecutionPreparer,
  type InternalToolExecutionPreparation,
} from "./internal-hooks.js";
import { createErrorToolResult, createToolExecutionErrorResult } from "./tool-call-outcome.js";
import {
  type AgentToolExecutionContext,
  runWithAgentToolExecutionContext,
} from "./tool-execution-context.js";
import type { AgentTool, AgentToolCall, AgentToolResult } from "./types.js";

export type PreparedToolCall = {
  kind: "prepared";
  toolCall: AgentToolCall;
  tool: AgentTool;
  args: unknown;
};

export type ExecutedToolCallOutcome = {
  result: AgentToolResult<unknown>;
  isError: boolean;
  executionStarted: boolean;
  callerCancelled?: true;
};

export type ReadyToolCallExecution = {
  kind: "ready";
  args: unknown;
  execute: (onImplementationStart?: () => void) => Promise<ExecutedToolCallOutcome>;
  dispose: () => void;
};

export type PreparedToolCallExecution =
  | { kind: "immediate"; outcome: ExecutedToolCallOutcome }
  | ReadyToolCallExecution;

export async function prepareToolCallExecution(
  prepared: PreparedToolCall,
  executionContext: AgentToolExecutionContext,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<PreparedToolCallExecution> {
  const updateEvents: Promise<void>[] = [];
  let acceptingUpdates = true;
  let pendingInput = executionContext.pendingInput;
  const inputSubscriptions = new Set<() => void>();
  const scopedExecutionContext: AgentToolExecutionContext = {
    ...executionContext,
    pendingInput: pendingInput
      ? {
          hasPending: () =>
            acceptingUpdates && !signal?.aborted && pendingInput?.hasPending() === true,
          subscribe: (listener) => {
            if (!acceptingUpdates || signal?.aborted || !pendingInput) {
              return () => {};
            }
            const unsubscribe = pendingInput.subscribe(() => {
              if (acceptingUpdates && !signal?.aborted) {
                listener();
              }
            });
            const release = () => {
              inputSubscriptions.delete(release);
              unsubscribe();
            };
            inputSubscriptions.add(release);
            return release;
          },
        }
      : undefined,
  };
  const closeUpdates = () => {
    acceptingUpdates = false;
    pendingInput = undefined;
    for (const release of inputSubscriptions) {
      release();
    }
  };
  const onUpdate = (partialResult: AgentToolResult<unknown>) => {
    if (!acceptingUpdates) {
      return;
    }
    updateEvents.push(
      Promise.resolve(
        emit({
          type: "tool_execution_update",
          toolCallId: prepared.toolCall.id,
          toolName: prepared.toolCall.name,
          args: prepared.toolCall.arguments,
          partialResult,
          ...(prepared.tool.hideFromChannelProgress === true
            ? { hideFromChannelProgress: true }
            : {}),
        }),
      ),
    );
  };
  const finishUpdates = async () => {
    closeUpdates();
    await Promise.all(updateEvents);
  };
  const immediateError = async (error: unknown): Promise<PreparedToolCallExecution> => {
    await finishUpdates();
    return {
      kind: "immediate",
      outcome: {
        result: createToolExecutionErrorResult(error),
        isError: true,
        executionStarted: false,
      },
    };
  };
  const readyExecution = (
    args: unknown,
    run: (onImplementationStart: () => void) => Promise<AgentToolResult<unknown>>,
    disposeSource: () => void = () => {},
  ): ReadyToolCallExecution => {
    let disposed = false;
    const dispose = () => {
      if (!disposed) {
        disposed = true;
        closeUpdates();
        disposeSource();
      }
    };
    return {
      kind: "ready",
      args,
      dispose,
      async execute(onImplementationStart) {
        let executionStarted = false;
        let implementationStartError: { error: unknown } | undefined;
        try {
          if (signal?.aborted) {
            return {
              result: createErrorToolResult("Operation aborted"),
              isError: true,
              executionStarted: false,
            };
          }
          try {
            const result = await run(() => {
              try {
                onImplementationStart?.();
              } catch (error) {
                implementationStartError = { error };
                throw error;
              }
              executionStarted = true;
            });
            if (implementationStartError) {
              throw implementationStartError.error;
            }
            return { result, isError: false, executionStarted };
          } catch (error) {
            if (implementationStartError) {
              throw implementationStartError.error;
            }
            return {
              result: createToolExecutionErrorResult(error),
              isError: true,
              executionStarted,
              ...(executionStarted && signal?.aborted && error === signal.reason
                ? { callerCancelled: true }
                : {}),
            };
          }
        } finally {
          await finishUpdates();
          dispose();
        }
      },
    };
  };
  const preparer = getInternalToolExecutionPreparer(prepared.tool);

  if (!preparer) {
    return readyExecution(prepared.args, async (onImplementationStart) => {
      if (signal?.aborted) {
        throw signal.reason ?? new Error("Operation aborted");
      }
      return await runWithAgentToolExecutionContext(scopedExecutionContext, () => {
        onImplementationStart();
        return prepared.tool.execute(
          prepared.toolCall.id,
          // SAFETY: prepareToolCall validated these arguments against this exact tool's schema.
          prepared.args as never,
          signal,
          onUpdate,
        );
      });
    });
  }

  let internalPreparation: InternalToolExecutionPreparation;
  try {
    internalPreparation = await runWithAgentToolExecutionContext(scopedExecutionContext, () =>
      preparer({
        toolCallId: prepared.toolCall.id,
        args: prepared.args,
        ...(signal ? { signal } : {}),
        onUpdate,
      }),
    );
  } catch (error) {
    return await immediateError(error);
  }

  if (internalPreparation.kind === "immediate") {
    closeUpdates();
    internalPreparation.dispose();
    await finishUpdates();
    return {
      kind: "immediate",
      outcome:
        internalPreparation.outcome.kind === "result"
          ? {
              result: internalPreparation.outcome.result,
              isError: internalPreparation.outcome.isError,
              executionStarted: false,
            }
          : {
              result: createToolExecutionErrorResult(internalPreparation.outcome.error),
              isError: true,
              executionStarted: false,
            },
    };
  }

  const readyPreparation = internalPreparation;
  return readyExecution(
    readyPreparation.args,
    (onImplementationStart) =>
      runWithAgentToolExecutionContext(scopedExecutionContext, () =>
        readyPreparation.execute(onImplementationStart),
      ),
    readyPreparation.dispose,
  );
}
