import { CodexCatalogField, type CodexCatalogStatus } from "./session-catalog-index-field.js";
import type { CodexCatalogIndexRow } from "./session-catalog-index-row.js";
import {
  getCodexCatalogSource,
  hasLiveCodexCatalogSource,
  type CodexCatalogSource,
} from "./session-catalog-source.js";

type SourcedStatus = { status: CodexCatalogStatus; sources: Set<CodexCatalogSource> };
const MAX_STATUS_SOURCE_WITNESSES = 64;

/** Equivalent broadcasts retain at most 64 source witnesses for each bounded resident row. */
export class CodexCatalogStatusIndex {
  private readonly values = new CodexCatalogField<SourcedStatus>();

  capture(): number {
    return this.values.capture();
  }

  update(threadId: string, status: CodexCatalogStatus, source: CodexCatalogSource): void {
    const next = this.next(threadId, status, source);
    if (next) {
      this.values.update(threadId, next);
    }
  }

  observe(row: CodexCatalogIndexRow, revision: number): void {
    const session = row.page.sessions[0];
    const source = getCodexCatalogSource(row);
    if (session && source) {
      const next = this.next(
        row.threadId,
        {
          status: session.status,
          ...(session.activeFlags ? { activeFlags: session.activeFlags } : {}),
        },
        source,
      );
      if (next) {
        this.values.observe(row.threadId, next, revision);
      }
    }
  }

  get(threadId: string): CodexCatalogStatus | undefined {
    const current = this.values.get(threadId);
    return current && hasLiveCodexCatalogSource(current.sources) ? current.status : undefined;
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

  private next(
    threadId: string,
    status: CodexCatalogStatus,
    source: CodexCatalogSource,
  ): SourcedStatus | undefined {
    if (source.closed) {
      return undefined;
    }
    const current = this.values.get(threadId);
    const sources = new Set([...(current?.sources ?? [])].filter((witness) => !witness.closed));
    if (
      status.status === "notLoaded" &&
      current &&
      current.status.status !== "notLoaded" &&
      sources.size
    ) {
      // An unobserved source's withdrawal still fences its older pending reads.
      sources.delete(source);
      if (sources.size) {
        return { status: current.status, sources };
      }
    }
    const flags = status.activeFlags ?? [];
    const previousFlags = current?.status.activeFlags ?? [];
    if (
      current?.status.status === status.status &&
      flags.length === previousFlags.length &&
      flags.every((flag, index) => flag === previousFlags[index])
    ) {
      if (sources.size < MAX_STATUS_SOURCE_WITNESSES) {
        sources.add(source);
      }
      return { status, sources };
    }
    return { status, sources: new Set([source]) };
  }
}
