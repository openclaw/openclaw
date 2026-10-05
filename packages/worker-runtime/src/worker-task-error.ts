export class WorkerTaskError extends Error {
  constructor(
    message: string,
    readonly code: "unavailable" | "timeout" | "failed" | "overloaded",
  ) {
    super(message);
    this.name = "WorkerTaskError";
  }
}
