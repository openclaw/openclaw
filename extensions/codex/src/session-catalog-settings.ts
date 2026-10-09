import { CodexCatalogLiveField } from "./session-catalog-index-field.js";
import { boundedCatalogString, MAX_CWD_LENGTH } from "./session-catalog-parsing.js";
import { hasLiveCodexCatalogSource, type CodexCatalogSource } from "./session-catalog-source.js";

export type CodexCatalogSettings = { cwd?: string; modelProvider?: string };
const MAX_SETTINGS_SOURCE_WITNESSES = 64;

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
    const current = this.values.get(threadId);
    const sources = new Set<CodexCatalogSource>();
    if (
      current &&
      current.value.cwd === bounded.cwd &&
      current.value.modelProvider === bounded.modelProvider
    ) {
      for (const witness of current.sources) {
        if (!witness.closed) {
          sources.add(witness);
        }
      }
    }
    if (sources.size < MAX_SETTINGS_SOURCE_WITNESSES) {
      sources.add(source);
    }
    this.values.update(threadId, { value: bounded, sources });
  }

  hasLiveCwd(): boolean {
    return this.values.some(
      ({ value, sources }) => Boolean(value.cwd) && hasLiveCodexCatalogSource(sources),
    );
  }

  withdraw(threadId: string, source: CodexCatalogSource): void {
    const current = this.values.get(threadId);
    if (!current?.sources.delete(source)) {
      return;
    }
    if (!hasLiveCodexCatalogSource(current.sources)) {
      this.values.delete(threadId);
    }
  }
}
