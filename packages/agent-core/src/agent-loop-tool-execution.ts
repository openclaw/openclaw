import type { AgentEventSink, ExecutedToolCallBatch } from "./agent-stream-response.js";
import {
  getInternalToolExecutionPreparer,
  InternalToolLoopBlocked,
  type InternalToolExecutionPreparation,
  type InternalToolBatchLifecycle,
} from "./internal-hooks.js";
import type { AgentCoreStreamRuntimeDeps } from "./runtime-deps.js";
import { mergeToolExecutionFailure } from "./tool-batch-completion.js";
import {
  createErrorToolResult,
  TOOL_LOOP_BLOCKED_MESSAGE,
  createToolExecutionErrorResult,
  type FinalizedToolCallOutcome,
} from "./tool-call-outcome.js";
import {
  type AgentToolExecutionContext,
  runWithAgentToolExecutionContext,
} from "./tool-execution-context.js";
import type { AgentTool, AgentToolCall, AgentToolResult, ToolLoopIntervention } from "./types.js";

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
  intervention?: ToolLoopIntervention;
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
  isLocalError?: AgentCoreStreamRuntimeDeps["isLocalError"],
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
    scopedExecutionContext.pendingInput = undefined;
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
  const finishUpdates = async (
    primary?: ExecutedToolCallBatch["fatal"],
    disposeSource?: () => void,
  ) => {
    let failure: ExecutedToolCallBatch["fatal"];
    try {
      closeUpdates();
    } catch (error) {
      failure = mergeToolExecutionFailure(primary, error);
    }
    for (const update of await Promise.allSettled(updateEvents)) {
      if (update.status === "rejected") {
        failure = mergeToolExecutionFailure(failure ?? primary, update.reason);
      }
    }
    try {
      disposeSource?.();
    } catch (error) {
      failure = mergeToolExecutionFailure(failure ?? primary, error);
    }
    if (failure) {
      throw failure.error;
    }
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
        let executionFailure: ExecutedToolCallBatch["fatal"];
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
            if (implementationStartError?.error instanceof InternalToolLoopBlocked) {
              const { intervention } = implementationStartError.error;
              return {
                result: createErrorToolResult(TOOL_LOOP_BLOCKED_MESSAGE, {
                  status: "blocked",
                  deniedReason: "tool-loop",
                  intervention,
                }),
                isError: true,
                executionStarted: false,
                intervention,
              };
            }
            executionFailure = { error: implementationStartError?.error ?? error };
            if (implementationStartError) {
              throw implementationStartError.error;
            }
            if (isLocalError?.(error)) {
              throw error;
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
        } catch (error) {
          executionFailure = { error };
          throw error;
        } finally {
          await finishUpdates(executionFailure, dispose);
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
    await finishUpdates({ error });
    if (isLocalError?.(error)) {
      throw error;
    }
    return {
      kind: "immediate",
      outcome: {
        result: createToolExecutionErrorResult(error),
        isError: true,
        executionStarted: false,
      },
    };
  }

  if (internalPreparation.kind === "immediate") {
    await finishUpdates(
      internalPreparation.outcome.kind === "error"
        ? { error: internalPreparation.outcome.error }
        : undefined,
      () => internalPreparation.dispose(),
    );
    if (
      internalPreparation.outcome.kind === "error" &&
      isLocalError?.(internalPreparation.outcome.error)
    ) {
      throw internalPreparation.outcome.error;
    }
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

export type ToolPlanState = {
  executionStarted: boolean;
  /** All tool batches from one provider response share the unseen recovery allowance. */
  repeatedToolErrorRecoveryGranted?: boolean;
  /** Closes all unstarted actions while already-started effects drain. */
  terminalIntervention?: ToolLoopIntervention;
};

export type ReadyPreparedToolCall = PreparedToolCall & { execution: ReadyToolCallExecution };

export type FinalizedToolCallEntry = FinalizedToolCallOutcome | ReadyPreparedToolCall;

export type StartedToolCall = {
  index: number;
  entry: ReadyPreparedToolCall;
  outcome: Promise<ExecutedToolCallOutcome>;
};

type ParallelToolCallLaunches = {
  started: StartedToolCall[];
  completed: Array<Omit<StartedToolCall, "outcome"> & { outcome: ExecutedToolCallOutcome }>;
  rejected?: { index: number; error: unknown };
  blocked?: { index: number; intervention: ToolLoopIntervention };
};

export async function launchParallelToolCalls(
  entries: FinalizedToolCallEntry[],
  batchLifecycle: InternalToolBatchLifecycle | undefined,
  toolPlan: ToolPlanState,
): Promise<ParallelToolCallLaunches> {
  const ready = entries.flatMap((entry, index) => ("kind" in entry ? [{ entry, index }] : []));
  /**
   * Rejected calls never start, so they launch as lifecycle commits when the
   * launch cursor passes their assistant-order position. Admission then records
   * them between the prepared calls that commit as their implementations start.
   */
  let next = 0;
  const launchRejectedBefore = (end: number): ParallelToolCallLaunches["rejected"] => {
    for (; next < end; next += 1) {
      const entry = entries[next];
      if (!entry || "kind" in entry || entry.errorKind !== "argument-validation") {
        continue;
      }
      try {
        batchLifecycle?.commitReadyCalls?.([
          { toolCallId: entry.toolCall.id, args: entry.toolCall.arguments },
        ]);
      } catch (error) {
        return { index: next, error };
      }
    }
    return undefined;
  };
  const result: ParallelToolCallLaunches = { started: [], completed: [] };
  const preparations: Promise<void>[] = [];
  const reject = (index: number, error: unknown) => {
    result.rejected = {
      index: result.rejected?.index ?? index,
      error: mergeToolExecutionFailure(result.rejected, error).error,
    };
  };
  let cursor = 0;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const launchNext = () => {
    const current = ready[cursor++];
    result.rejected ??= launchRejectedBefore(current?.index ?? entries.length);
    if (!current || result.rejected) {
      finish();
      return;
    }
    // Package declarations target ES2023, which lacks Promise.withResolvers.
    let resolvePreparation = () => {};
    preparations.push(
      new Promise<void>((resolve) => {
        resolvePreparation = resolve;
      }),
    );
    const launchState: { outcome?: Promise<ExecutedToolCallOutcome> } = {};
    let started = false;
    let rejected = false;
    const onStart = () => {
      try {
        if (toolPlan.terminalIntervention) {
          throw new InternalToolLoopBlocked(toolPlan.terminalIntervention);
        }
        batchLifecycle?.commitReadyCalls?.([
          { toolCallId: current.entry.toolCall.id, args: current.entry.execution.args },
        ]);
      } catch (error) {
        if (error instanceof InternalToolLoopBlocked) {
          result.blocked = { index: current.index, intervention: error.intervention };
          throw error;
        }
        rejected = true;
        reject(current.index, error);
        finish();
        throw error;
      }
      started = true;
      resolvePreparation();
      toolPlan.executionStarted = true;
      if (launchState.outcome) {
        result.started.push({ ...current, outcome: launchState.outcome });
      }
      // Advance only from the final source-start callback so guard → commit → implementation stays
      // adjacent while started bodies overlap; pre-source completion advances below without commit.
      queueMicrotask(launchNext);
    };
    const outcome = current.entry.execution.execute(onStart);
    launchState.outcome = outcome;
    if (started) {
      result.started.push({ ...current, outcome });
    }
    void outcome.then(
      (completed) => {
        resolvePreparation();
        if (!started && !rejected) {
          result.completed.push({ ...current, outcome: completed });
          if (result.blocked) {
            finish();
          } else {
            queueMicrotask(launchNext);
          }
        }
      },
      (error: unknown) => {
        resolvePreparation();
        reject(current.index, error);
        finish();
      },
    );
  };
  launchNext();
  await done;
  // Already-invoked guards retain custody until they start or settle, even after a sibling fails.
  await Promise.all(preparations);
  return result;
}
