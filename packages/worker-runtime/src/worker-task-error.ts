export class WorkerTaskError extends Error {
  constructor(
    message: string,
    readonly code: "unavailable" | "timeout" | "failed" | "overloaded",
  ) {
    super(message);
    this.name = "WorkerTaskError";
  }
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
