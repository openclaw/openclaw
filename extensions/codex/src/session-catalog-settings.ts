import { CodexCatalogLiveField } from "./session-catalog-index-field.js";
import { boundedCatalogString, MAX_CWD_LENGTH } from "./session-catalog-parsing.js";
import type { CodexCatalogSource } from "./session-catalog-source.js";

export type CodexCatalogSettings = { cwd?: string; modelProvider?: string };

/** Live settings overlay native stored metadata only while a supporting source stays open. */
export class CodexCatalogSettingsIndex extends CodexCatalogLiveField<CodexCatalogSettings> {
  update(
    threadId: string,
    settings: { cwd?: unknown; modelProvider?: unknown },
    source: CodexCatalogSource,
  ): void {
    if (source.closed) {
      return;
    }
    const cwd = boundedCatalogString(settings.cwd, MAX_CWD_LENGTH);
    const modelProvider = boundedCatalogString(settings.modelProvider, 500, "truncate");
    if (!cwd && !modelProvider) {
      return;
    }
    const bounded = {
      ...(cwd ? { cwd } : {}),
      ...(modelProvider ? { modelProvider } : {}),
    };
    this.values.update(threadId, { value: bounded, source });
  }

  hasLiveCwd(): boolean {
    return this.values.some(({ value, source }) => Boolean(value.cwd) && !source.closed);
  }

  withdraw(threadId: string, source: CodexCatalogSource): void {
    const current = this.values.get(threadId);
    if (current?.source === source) {
      this.values.delete(threadId);
    }
  }
}
