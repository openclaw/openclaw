import { CODEX_CATALOG_MAX_ROWS } from "./session-catalog-limits.js";
import { boundedCatalogString, MAX_SESSION_ID_LENGTH } from "./session-catalog-parsing.js";
import type { codexCatalogThreadStatus } from "./session-catalog-parsing.js";
import { hasLiveCodexCatalogSource, type CodexCatalogSource } from "./session-catalog-source.js";

export type CodexCatalogStatus = ReturnType<typeof codexCatalogThreadStatus>;
/** Bounded display observations; later publications replace earlier ones. */
export class CodexCatalogField<T> {
  private readonly entries = new Map<string, T>();

  update(threadId: string, value: T): void {
    this.put(threadId, value);
  }

  get(threadId: string): T | undefined {
    return this.entries.get(threadId);
  }

  some(predicate: (value: T) => boolean): boolean {
    for (const entry of this.entries.values()) {
      if (predicate(entry)) {
        return true;
      }
    }
    return false;
  }

  delete(threadId: string): void {
    this.entries.delete(threadId);
  }

  deleteWhere(predicate: (value: T) => boolean): void {
    for (const [threadId, entry] of this.entries) {
      if (predicate(entry)) {
        this.delete(threadId);
      }
    }
  }

  invalidate(): void {
    this.entries.clear();
  }

  private put(threadId: string, entry: T): void {
    const id = boundedCatalogString(threadId, MAX_SESSION_ID_LENGTH);
    if (!id) {
      return;
    }
    this.entries.delete(id);
    this.entries.set(id, entry);
    if (this.entries.size > CODEX_CATALOG_MAX_ROWS) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }
}

export type CodexCatalogSourcedValue<T> = { value: T; sources: Set<CodexCatalogSource> };

/** Live field values retain source-lifetime invalidation. */
export class CodexCatalogLiveField<T> {
  protected readonly values = new CodexCatalogField<CodexCatalogSourcedValue<T>>();

  get(threadId: string): T | undefined {
    const current = this.values.get(threadId);
    return current && hasLiveCodexCatalogSource(current.sources) ? current.value : undefined;
  }

  delete(threadId: string): void {
    this.values.delete(threadId);
  }

  invalidate(source?: CodexCatalogSource): void {
    if (!source) {
      this.values.invalidate();
      return;
    }
    this.values.deleteWhere((entry) => {
      entry.sources.delete(source);
      return !hasLiveCodexCatalogSource(entry.sources);
    });
  }
}
