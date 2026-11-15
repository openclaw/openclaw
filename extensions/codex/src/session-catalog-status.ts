import { CodexCatalogLiveField, type CodexCatalogStatus } from "./session-catalog-index-field.js";
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
    status: session.catalogError ? "systemError" : (live?.status ?? "notLoaded"),
    ...(live?.activeFlags ? { activeFlags: [...live.activeFlags] } : {}),
  };
}

/** One latest display observation; native actions verify their own current state. */
export class CodexCatalogStatusIndex extends CodexCatalogLiveField<CodexCatalogStatus> {
  update(threadId: string, status: CodexCatalogStatus, source: CodexCatalogSource): void {
    if (source.closed) {
      return;
    }
    const current = this.values.get(threadId);
    // A passive reader's notLoaded does not withdraw another client's loaded thread.
    if (
      status.status === "notLoaded" &&
      current &&
      !current.source.closed &&
      current.source !== source
    ) {
      return;
    }
    this.values.update(threadId, { value: status, source });
  }

  observe(row: CodexCatalogIndexRow): void {
    const session = row.page.sessions[0];
    const source = getCodexCatalogSource(row);
    if (session && source) {
      this.update(
        row.threadId,
        {
          status: session.status,
          ...(session.activeFlags ? { activeFlags: session.activeFlags } : {}),
        },
        source,
      );
    }
  }
}
