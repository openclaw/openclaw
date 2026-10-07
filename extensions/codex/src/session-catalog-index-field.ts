import { CODEX_CATALOG_MAX_ROWS } from "./session-catalog-limits.js";
import { boundedCatalogString, MAX_SESSION_ID_LENGTH } from "./session-catalog-parsing.js";
import type { codexCatalogThreadStatus } from "./session-catalog-parsing.js";

export type CodexCatalogStatus = ReturnType<typeof codexCatalogThreadStatus>;
type FieldEntry<T> = { revision: number; value?: T };

/** Orders field observations independently from catalog row publication. */
export class CodexCatalogField<T> {
  private revision = 0;
  private minimumCapture = 0;
  private readonly entries = new Map<string, FieldEntry<T>>();

  capture(): number {
    return ++this.revision;
  }

  update(threadId: string, value: T): void {
    this.put(threadId, { revision: ++this.revision, value });
  }

  observe(threadId: string, value: T, capturedRevision: number): boolean {
    if (
      capturedRevision < this.minimumCapture ||
      (this.entries.get(threadId)?.revision ?? 0) > capturedRevision
    ) {
      return false;
    }
    this.put(threadId, { revision: capturedRevision, value });
    return true;
  }

  get(threadId: string): T | undefined {
    return this.entries.get(threadId)?.value;
  }

  some(predicate: (value: T) => boolean): boolean {
    for (const entry of this.entries.values()) {
      if (entry.value !== undefined && predicate(entry.value)) {
        return true;
      }
    }
    return false;
  }

  delete(threadId: string): void {
    this.put(threadId, { revision: ++this.revision });
  }

  deleteWhere(predicate: (value: T) => boolean): void {
    for (const [threadId, entry] of this.entries) {
      if (entry.value !== undefined && predicate(entry.value)) {
        this.delete(threadId);
      }
    }
  }

  invalidate(): void {
    this.minimumCapture = ++this.revision;
    this.entries.clear();
  }

  private put(threadId: string, entry: FieldEntry<T>): void {
    const id = boundedCatalogString(threadId, MAX_SESSION_ID_LENGTH);
    if (!id) {
      return;
    }
    this.entries.delete(id);
    this.entries.set(id, entry);
    if (this.entries.size > CODEX_CATALOG_MAX_ROWS) {
      const oldest = this.entries.entries().next().value;
      if (oldest) {
        // Evicting a field/tombstone must not admit a snapshot predating its mutation.
        this.minimumCapture = Math.max(this.minimumCapture, oldest[1].revision);
        this.entries.delete(oldest[0]);
      }
    }
  }
}
