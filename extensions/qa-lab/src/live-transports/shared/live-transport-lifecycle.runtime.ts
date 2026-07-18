export function createLiveTransportQuiesce(params: {
  close?: () => Promise<void>;
  stopPolling: () => void;
  waitForPolling: () => Promise<void>;
}): () => Promise<void> {
  let quiescePromise: Promise<void> | undefined;
  return () => {
    // Cleanup calls this again after gateway shutdown. Reuse the first drain so drivers close once.
    quiescePromise ??= (async () => {
      params.stopPolling();
      await params.waitForPolling();
      await params.close?.();
    })();
    return quiescePromise;
  };
}

export async function runLiveTransportCleanupSteps(
  steps: ReadonlyArray<() => Promise<void>>,
): Promise<void> {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "live transport cleanup failed");
  }
}
