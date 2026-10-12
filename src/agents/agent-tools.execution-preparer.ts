import { createDeferredCore } from "../shared/deferred.js";
import type { AgentToolResult } from "./runtime/index.js";
import type { InternalToolExecutionPreparer } from "./runtime/internal-hooks.js";

const INTERNAL_EXECUTION_CONTROL = Symbol("openclawInternalExecutionControl");

type InternalExecutionControl = {
  [INTERNAL_EXECUTION_CONTROL]: true;
  ready: Promise<unknown>;
  pause: (args: unknown) => Promise<{ launch: boolean; start?: () => void }>;
  launch: (start?: () => void) => void;
  dispose: () => void;
};

function createControl(): InternalExecutionControl {
  const ready = createDeferredCore<unknown>();
  const decision = createDeferredCore<{ launch: boolean; start?: () => void }>();
  return {
    [INTERNAL_EXECUTION_CONTROL]: true,
    ready: ready.promise,
    pause: (args) => {
      ready.resolve(args);
      return decision.promise;
    },
    launch: (start) => decision.resolve({ launch: true, start }),
    dispose: () => decision.resolve({ launch: false }),
  };
}

export function readInternalExecutionControl(value: unknown): InternalExecutionControl | undefined {
  return value &&
    typeof value === "object" &&
    (value as Partial<InternalExecutionControl>)[INTERNAL_EXECUTION_CONTROL] === true
    ? (value as InternalExecutionControl)
    : undefined;
}

export function createInternalExecutionPreparer(
  startExecution: (
    params: Parameters<InternalToolExecutionPreparer>[0],
    control: InternalExecutionControl,
  ) => Promise<AgentToolResult<unknown>>,
): InternalToolExecutionPreparer {
  return async (params) => {
    const control = createControl();
    const execution = startExecution(params, control);
    const settled = await Promise.race([
      control.ready.then((args) => ({ kind: "ready" as const, args })),
      execution.then(
        (result) => ({ kind: "result" as const, result }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
    ]);
    if (settled.kind !== "ready") {
      return {
        kind: "immediate",
        outcome:
          settled.kind === "result"
            ? { kind: "result", result: settled.result, isError: false }
            : { kind: "error", error: settled.error },
        dispose() {},
      };
    }
    let disposed = false;
    return {
      kind: "ready",
      args: settled.args,
      execute(start) {
        if (!disposed) {
          control.launch(start);
        }
        return execution;
      },
      dispose() {
        if (!disposed) {
          disposed = true;
          control.dispose();
          void execution.catch(() => undefined);
        }
      },
    };
  };
}
