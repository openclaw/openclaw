import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { withSqliteWorkerCleanupFailure } from "../../infra/sqlite-worker-broker-reply.js";
import { withAuthProfileCleanup } from "./operation-cleanup.js";

/** Dispose every captured reader and retain the original read failure when cleanup also fails. */
export function withAuthProfileReaderCleanup<T>(
  operation: () => Promise<T>,
  readers: Iterable<{ dispose(): Promise<void> }>,
  messages: { read: string; cleanup: string },
): Promise<T> {
  return withAuthProfileCleanup(operation, async (outcome) => {
    const results = await Promise.allSettled(Array.from(readers, (reader) => reader.dispose()));
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length === 0) {
      return;
    }
    const error =
      failures.length === 1
        ? failures[0]
        : new AggregateError(failures, messages.cleanup, { cause: failures[0] });
    throw outcome.ok
      ? error
      : withSqliteWorkerCleanupFailure(toErrorObject(outcome.error, messages.read), error);
  });
}
