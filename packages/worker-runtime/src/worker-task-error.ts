import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import type { Slot } from "./worker-task-pool.types.js";

export class WorkerTaskError extends Error {
  readonly capacityAvailable?: Promise<void>;
  constructor(
    message: string,
    readonly code: "unavailable" | "timeout" | "failed" | "overloaded",
    options?: ErrorOptions & { capacityAvailable?: Promise<void> },
  ) {
    super(message, options);
    this.name = "WorkerTaskError";
    this.capacityAvailable = options?.capacityAvailable;
  }
}

export function workerTaskUnavailableError<Input, Output>(
  slot: Slot<Input, Output>,
  message: string,
  cause?: unknown,
  task = slot.task,
): Error {
  const stage = slot.ready === false ? "startup" : task?.exchange ? "exchange" : "running";
  // Reuse owned estimates/progress without sizing or retaining input.
  const detail = task?.diagnosticLabel
    ? ` [task=${task.diagnosticLabel} admittedInputBytes=${task.inputBytes} exchanges=${task.exchangeSequence} stage=${stage}]`
    : "";
  return new WorkerTaskError(message + detail, "unavailable", { cause });
}

export function workerTaskRetirementError(taskError: Error | undefined, failure: unknown): unknown {
  return taskError
    ? new AggregateError(
        [taskError, failure],
        `Worker retirement failed: ${toErrorObject(failure, "worker retirement failed").message}; task failed: ${taskError.message}`,
        { cause: failure },
      )
    : failure;
}

export function workerTaskTimeoutError(
  exchange: { name: string; sent: boolean } | undefined,
  workerUrl: URL,
): WorkerTaskError {
  let callback = exchange?.sent === false ? exchange.name : undefined;
  if (callback === "unknown") {
    callback =
      workerUrl.protocol === "file:"
        ? workerUrl.pathname.split("/").at(-1)?.slice(0, 96) || "worker"
        : `${workerUrl.protocol} worker`;
  }
  const error = new WorkerTaskError(
    callback
      ? `worker task timed out waiting for host callback ${callback}`
      : "worker task timed out",
    "timeout",
  );
  if (callback) {
    process.emitWarning(error.message, { code: "WORKER_HOST_CALLBACK_TIMEOUT" });
  }
  return error;
}
