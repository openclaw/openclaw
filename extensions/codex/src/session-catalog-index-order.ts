import type { CodexCatalogIndexRow } from "./session-catalog-index-row.js";
import { CODEX_CATALOG_MAX_ROWS } from "./session-catalog-limits.js";

export type CodexCatalogOrderKey = Pick<
  CodexCatalogIndexRow,
  "threadId" | "updatedAt" | "recencyAt" | "sourceOrder"
>;

export function codexCatalogRowRecency(row: CodexCatalogOrderKey): number {
  return row.recencyAt ?? row.updatedAt ?? 0;
}

export function compareCodexCatalogRows(a: CodexCatalogOrderKey, b: CodexCatalogOrderKey): number {
  return (
    codexCatalogRowRecency(b) - codexCatalogRowRecency(a) ||
    (a.sourceOrder ?? 0) - (b.sourceOrder ?? 0) ||
    (a.threadId < b.threadId ? 1 : a.threadId > b.threadId ? -1 : 0)
  );
}

/** Admission and restoration share the archived-oldest eviction policy. */
export function retainCodexCatalogRow(
  rows: Map<string, CodexCatalogIndexRow>,
  candidate: CodexCatalogIndexRow,
): CodexCatalogIndexRow | undefined {
  rows.set(candidate.threadId, candidate);
  if (rows.size <= CODEX_CATALOG_MAX_ROWS) {
    return undefined;
  }
  let oldest: CodexCatalogIndexRow | undefined;
  for (const row of rows.values()) {
    if (
      !oldest ||
      (row.archived !== oldest.archived ? row.archived : compareCodexCatalogRows(row, oldest) > 0)
    ) {
      oldest = row;
    }
  }
  if (oldest) {
    rows.delete(oldest.threadId);
  }
  return oldest;
}

/** Stable positions keep issued cursors independent of later native page offsets. */
export class CodexCatalogOrdering {
  private nextEventOrder = -1;
  private ordered: CodexCatalogIndexRow[] | undefined;

  read(rows: ReadonlyMap<string, CodexCatalogIndexRow>): readonly CodexCatalogIndexRow[] {
    return (this.ordered ??= [...rows.values()]
      .filter((row) => !row.archived && row.page.sessions.length > 0)
      .toSorted(compareCodexCatalogRows));
  }

  invalidate(): void {
    this.ordered = undefined;
  }

  restore(row: CodexCatalogIndexRow): void {
    this.nextEventOrder = Math.min(this.nextEventOrder, (row.sourceOrder ?? 0) - 1);
  }

  reserveEvent(): number {
    return this.nextEventOrder--;
  }

  private unchangedPosition(row: CodexCatalogIndexRow, previous?: CodexCatalogIndexRow) {
    return previous && codexCatalogRowRecency(row) <= codexCatalogRowRecency(previous)
      ? previous.sourceOrder
      : undefined;
  }

  position(row: CodexCatalogIndexRow, previous?: CodexCatalogIndexRow): number {
    return row.sourceOrder ?? this.unchangedPosition(row, previous) ?? this.reserveEvent();
  }

  captureBatch(hasCompleteSnapshot: boolean) {
    // Initial retries retain positive native positions; later refreshes reserve a newer block.
    const base = hasCompleteSnapshot ? this.nextEventOrder - CODEX_CATALOG_MAX_ROWS : 0;
    if (hasCompleteSnapshot) {
      this.nextEventOrder = base - 1;
    }
    return (
      row: CodexCatalogIndexRow,
      previous: CodexCatalogIndexRow | undefined,
      position: number,
    ) => this.unchangedPosition(row, previous) ?? base + position;
  }
}
