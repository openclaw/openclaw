import { racePromiseWithAbortSignal, raceWithTimeout } from "@openclaw/retry";
import { toErrorObject } from "../../infra/errors.js";
import { recordAgentCleanupFailure } from "../run-cleanup-timeout.js";

const PLUGIN_ITERATOR_CLOSE_TIMEOUT_MS = 5_000;

export function waitForIteratorValue<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T>> {
  return racePromiseWithAbortSignal(
    () =>
      iterator.next().catch((error: unknown) => {
        throw toErrorObject(error, "CLI plugin execution stream failed.");
      }),
    signal,
    () => toErrorObject(signal.reason, "CLI plugin execution was aborted."),
  );
}

export async function closePluginIterator(
  iterator: AsyncIterator<Record<string, unknown>> | undefined,
): Promise<void> {
  if (!iterator?.return) {
    return;
  }
  try {
    await raceWithTimeout(
      iterator.return(),
      PLUGIN_ITERATOR_CLOSE_TIMEOUT_MS,
      () => {
        throw new Error("CLI plugin runtime did not close after its run ended.");
      },
      { ref: false },
    );
  } catch (error) {
    recordAgentCleanupFailure();
    throw error;
  }
}
