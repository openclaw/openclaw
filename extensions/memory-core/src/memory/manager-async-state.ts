// Memory Core plugin module implements manager async state behavior.
export function startAsyncSearchSync(params: {
  enabled: boolean;
  dirty: boolean;
  sessionsDirty: boolean;
  sync: (params: { reason: string }) => Promise<void>;
  onError: (err: unknown) => void;
}): void {
  if (!params.enabled || (!params.dirty && !params.sessionsDirty)) {
    return;
  }
  try {
    // Existing indexes may be stale, but recall should not fail just because
    // dirty sync is catching up after a restart or file watcher burst.
    void params.sync({ reason: "search" }).catch((err: unknown) => {
      params.onError(err);
    });
  } catch (err: unknown) {
    params.onError(err);
  }
}

export async function awaitPendingManagerWork(params: {
  pendingSync?: Promise<void> | null;
  pendingProviderInit?: Promise<void> | null;
  onError?: (err: unknown) => void;
}): Promise<void> {
  if (params.pendingSync) {
    try {
      await params.pendingSync;
    } catch (err: unknown) {
      params.onError?.(err);
    }
  }
  if (params.pendingProviderInit) {
    try {
      await params.pendingProviderInit;
    } catch (err: unknown) {
      params.onError?.(err);
    }
  }
}
