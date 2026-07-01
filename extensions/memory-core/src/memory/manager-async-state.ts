// Memory Core plugin module implements manager async state behavior.
export async function startAsyncSearchSync(params: {
  enabled: boolean;
  dirty: boolean;
  sessionsDirty: boolean;
  // A clean index can still need a self-healable FTS text-format rebuild (e.g. a
  // legacy body-only sessions-only index). The format self-heal lives inside
  // sync(), so search must trigger sync for it too, or those indexes fail closed
  // on filename/date queries until a manual sync. Narrow to the format case only:
  // provider/model/scope mismatches keep their existing cli/force-gated behavior.
  ftsTextFormatSelfHealPending: boolean;
  sync: (params: { reason: string }) => Promise<void>;
  onError: (err: unknown) => void;
}): Promise<void> {
  if (
    !params.enabled ||
    (!params.dirty && !params.sessionsDirty && !params.ftsTextFormatSelfHealPending)
  ) {
    return;
  }
  try {
    await params.sync({ reason: "search" });
  } catch (err: unknown) {
    params.onError(err);
  }
}

export async function awaitPendingManagerWork(params: {
  pendingSync?: Promise<void> | null;
  pendingProviderInit?: Promise<void> | null;
}): Promise<void> {
  if (params.pendingSync) {
    try {
      await params.pendingSync;
    } catch {}
  }
  if (params.pendingProviderInit) {
    try {
      await params.pendingProviderInit;
    } catch {}
  }
}
