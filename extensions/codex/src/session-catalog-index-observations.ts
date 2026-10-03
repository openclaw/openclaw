import { CODEX_CATALOG_MAX_ROWS } from "./session-catalog-limits.js";
import { boundedCatalogString, MAX_SESSION_ID_LENGTH } from "./session-catalog-parsing.js";
/** Fences asynchronous observations against later catalog mutations. */
export class CodexCatalogObservations {
  private revision = 0;
  private minimumCapture = 0;
  private readonly mutations = new Map<string, number>();
  private readonly observations = new Map<symbol, number>();

  hasActiveWork(): boolean {
    return this.observations.size > 0;
  }

  mark(threadId: string): void {
    this.revision++;
    if (this.observations.size) {
      const id = boundedCatalogString(threadId, MAX_SESSION_ID_LENGTH);
      if (!id) {
        return;
      }
      this.mutations.delete(id);
      this.mutations.set(id, this.revision);
      if (this.mutations.size > CODEX_CATALOG_MAX_ROWS) {
        const oldest = this.mutations.entries().next().value!;
        this.minimumCapture = Math.max(this.minimumCapture, oldest[1]);
        this.mutations.delete(oldest[0]);
      }
    }
  }

  async observe<T>(read: (isCurrent: (id: string) => boolean) => Promise<T>): Promise<T> {
    const token = Symbol("catalog observation");
    const revision = this.revision;
    this.observations.set(token, revision);
    try {
      return await read(
        (id) => revision >= this.minimumCapture && (this.mutations.get(id) ?? 0) <= revision,
      );
    } finally {
      this.observations.delete(token);
      const oldest = this.observations.values().next().value ?? Infinity;
      for (const [id, changed] of this.mutations) {
        if (changed > oldest) {
          break;
        }
        this.mutations.delete(id);
      }
    }
  }
}
