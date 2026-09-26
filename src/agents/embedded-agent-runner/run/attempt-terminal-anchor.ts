/**
 * Terminal transcript anchor helpers for durable context-engine turns.
 *
 * Walks the leaf's ancestry to the nearest non-custom entry. Side-appended
 * extension entries (the cache-TTL marker, projection snapshots) own the leaf
 * after a turn but never carry an active message position, so the durable
 * turn anchor has to come from the message below them (#156425).
 */
export function resolveTerminalMessageEntryId(sessionManager: {
  getLeafId(): string | null;
  getEntry(id: string): unknown;
}): string | null {
  const leafId = sessionManager.getLeafId();
  if (!leafId) {
    return null;
  }
  let entry: unknown = sessionManager.getEntry(leafId);
  let entryId: string | null = leafId;
  const maxDepth = 32;
  for (let depth = 0; entry && depth <= maxDepth; depth += 1) {
    if (typeof entry !== "object") {
      return null;
    }
    if ((entry as { type?: unknown }).type !== "custom") {
      return entryId;
    }
    const { parentId } = entry as { parentId?: string | null };
    if (!parentId) {
      return null;
    }
    entryId = parentId;
    entry = sessionManager.getEntry(parentId);
  }
  return null;
}
