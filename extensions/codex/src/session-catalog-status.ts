import {
  CodexCatalogLiveField,
  type CodexCatalogSourcedValue,
  type CodexCatalogStatus,
} from "./session-catalog-index-field.js";
import type { CodexCatalogIndexRow } from "./session-catalog-index-row.js";
import type { CodexCatalogSettings } from "./session-catalog-settings.js";
import { getCodexCatalogSource, type CodexCatalogSource } from "./session-catalog-source.js";
import type { CodexSessionCatalogSession } from "./session-catalog-types.js";

export function applyCodexCatalogLiveFields(
  { status: _storedStatus, activeFlags: _storedFlags, ...session }: CodexSessionCatalogSession,
  live: CodexCatalogStatus | undefined,
  settings: CodexCatalogSettings | undefined,
): CodexSessionCatalogSession {
  return {
    ...session,
    ...settings,
    status: live?.status ?? "notLoaded",
    ...(live?.activeFlags ? { activeFlags: [...live.activeFlags] } : {}),
  };
}

const MAX_STATUS_SOURCE_WITNESSES = 64;

/** Equivalent broadcasts retain at most 64 source witnesses for each bounded resident row. */
export class CodexCatalogStatusIndex extends CodexCatalogLiveField<CodexCatalogStatus> {
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

  private next(
    threadId: string,
    status: CodexCatalogStatus,
    source: CodexCatalogSource,
  ): CodexCatalogSourcedValue<CodexCatalogStatus> | undefined {
    if (source.closed) {
      return undefined;
    }
    const current = this.values.get(threadId);
    const sources = new Set([...(current?.sources ?? [])].filter((witness) => !witness.closed));
    if (
      status.status === "notLoaded" &&
      current &&
      current.value.status !== "notLoaded" &&
      sources.size
    ) {
      // An unobserved source's withdrawal still fences its older pending reads.
      sources.delete(source);
      if (sources.size) {
        return { value: current.value, sources };
      }
    }
    const flags = status.activeFlags ?? [];
    const previousFlags = current?.value.activeFlags ?? [];
    if (
      current?.value.status === status.status &&
      flags.length === previousFlags.length &&
      flags.every((flag, index) => flag === previousFlags[index])
    ) {
      if (sources.size < MAX_STATUS_SOURCE_WITNESSES) {
        sources.add(source);
      }
      return { value: status, sources };
    }
    return { value: status, sources: new Set([source]) };
  }
}
