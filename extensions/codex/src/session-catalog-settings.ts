import { CodexCatalogField } from "./session-catalog-index-field.js";
import { boundedCatalogString, MAX_CWD_LENGTH } from "./session-catalog-parsing.js";
import { hasLiveCodexCatalogSource, type CodexCatalogSource } from "./session-catalog-source.js";

export type CodexCatalogSettings = { cwd?: string; modelProvider?: string };
type SourcedSettings = { settings: CodexCatalogSettings; sources: Set<CodexCatalogSource> };
const MAX_SETTINGS_SOURCE_WITNESSES = 64;

/** Live settings overlay native stored metadata only while a supporting source stays open. */
export class CodexCatalogSettingsIndex {
  private readonly values = new CodexCatalogField<SourcedSettings>();

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
      current.settings.cwd === bounded.cwd &&
      current.settings.modelProvider === bounded.modelProvider
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
    this.values.update(threadId, { settings: bounded, sources });
  }

  get(threadId: string): CodexCatalogSettings | undefined {
    const current = this.values.get(threadId);
    return current && hasLiveCodexCatalogSource(current.sources) ? current.settings : undefined;
  }

  hasLiveCwd(): boolean {
    return this.values.some(
      ({ settings, sources }) => Boolean(settings.cwd) && hasLiveCodexCatalogSource(sources),
    );
  }

  delete(threadId: string): void {
    this.values.delete(threadId);
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
