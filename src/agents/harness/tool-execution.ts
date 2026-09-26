import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  consumeAdjustedParamsForToolCall,
  consumePreExecutionBlockedToolCall,
} from "../agent-tools.before-tool-call.state.js";

/** Retains the exact execution promise, including failure, for each native call tuple. */
export function createAgentHarnessToolExecutionRegistry<TIdentity, TResult>(
  correlationKey: (call: TIdentity) => readonly string[],
) {
  const executions = new Map<string, Promise<TResult>>();
  const keyFor = (call: TIdentity) => JSON.stringify(correlationKey(call));

  return {
    get(call: TIdentity) {
      return executions.get(keyFor(call));
    },
    claim(call: TIdentity, start: () => Promise<TResult>) {
      const existing = executions.get(keyFor(call));
      if (existing) {
        return { execution: existing } as const;
      }
      const execution = start();
      executions.set(keyFor(call), execution);
      return { execution } as const;
    },
  };
}

/** Records the tool boundary independently of backend result presentation. */
export function createAgentHarnessToolExecutionBoundaryRegistry() {
  const states = new Map<string, ToolExecutionBoundaryState>();

  return {
    consume(this: void, toolCallId: string): AgentHarnessToolExecutionSnapshot | undefined {
      const state = states.get(toolCallId);
      states.delete(toolCallId);
      if (state) {
        state.consumed = true;
      }
      return state?.snapshot;
    },
    begin(params: {
      toolCallId: string;
      runId?: string;
      arguments: Record<string, unknown>;
      retainAfterCompletion?: boolean;
    }) {
      let executedArguments = structuredClone(params.arguments);
      let didDispatchExecution = false;
      let didStartExecution = false;
      let executionPrevented = false;
      const state: ToolExecutionBoundaryState = {
        consumed: false,
        retainAfterCompletion: params.retainAfterCompletion === true,
      };
      states.set(params.toolCallId, state);
      const consumeBlocked = () => {
        executionPrevented =
          executionPrevented || consumePreExecutionBlockedToolCall(params.toolCallId, params.runId);
      };

      return {
        get executedArguments() {
          return executedArguments;
        },
        get didStartExecution() {
          return didStartExecution;
        },
        get executionPrevented() {
          return executionPrevented;
        },
        get executionStarted() {
          return didStartExecution && !executionPrevented;
        },
        setArguments(args: Record<string, unknown>) {
          executedArguments = structuredClone(args);
        },
        markDispatched() {
          didDispatchExecution = true;
        },
        capture(options?: { noStart?: boolean }) {
          executionPrevented ||= options?.noStart === true;
          didStartExecution ||= didDispatchExecution;
          consumeBlocked();
          const adjustedArguments = consumeAdjustedParamsForToolCall(
            params.toolCallId,
            params.runId,
          );
          if (isRecord(adjustedArguments)) {
            executedArguments = adjustedArguments;
          }
          // Consumption closes this invocation's publication even if its body or
          // middleware completes after the timeout owner has detached the row.
          if (!state.consumed) {
            state.snapshot = {
              executedArguments: structuredClone(executedArguments),
              executionStarted: didStartExecution && !executionPrevented,
            };
          }
        },
        consumeBlocked,
        dispose() {
          if (
            states.get(params.toolCallId) === state &&
            (state.consumed || !state.retainAfterCompletion)
          ) {
            states.delete(params.toolCallId);
          }
          consumeAdjustedParamsForToolCall(params.toolCallId, params.runId);
        },
      };
    },
  };
}

export type AgentHarnessToolExecutionSnapshot = {
  executedArguments: Record<string, unknown>;
  executionStarted: boolean;
};

type ToolExecutionBoundaryState = {
  consumed: boolean;
  retainAfterCompletion: boolean;
  snapshot?: AgentHarnessToolExecutionSnapshot;
};
