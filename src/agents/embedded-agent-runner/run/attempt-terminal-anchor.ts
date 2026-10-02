/**
 * Cache-TTL bookkeeping advances the leaf without adding a message anchor.
 * Other entry kinds retain their terminal semantics.
 */
export function resolveTerminalMessageEntryId(sessionManager: {
  getLeafId(): string | null;
  getEntry(id: string): { type: string; parentId: string | null; customType?: string } | undefined;
}): string | null {
  let entryId = sessionManager.getLeafId();
  while (entryId) {
    const entry = sessionManager.getEntry(entryId);
    if (!entry) {
      return null;
    }
    if (entry.type !== "custom" || entry.customType !== "openclaw.cache-ttl") {
      return entryId;
    }
    entryId = entry.parentId;
  }
  return null;
}
