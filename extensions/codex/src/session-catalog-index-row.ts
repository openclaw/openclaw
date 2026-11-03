import type { CodexSessionCatalogPage } from "./session-catalog-types.js";

export type CodexCatalogRolloutFingerprint = { mtimeMs: number; size: number };

export type CodexCatalogIndexRow = {
  threadId: string;
  updatedAt: number | null;
  recencyAt: number | null;
  archived: boolean;
  nativeMetadata: boolean;
  preview?: string;
  /** Stable tie position, initially assigned in native order. */
  sourceOrder?: number;
  rolloutPath?: string;
  fingerprint?: CodexCatalogRolloutFingerprint;
  page: CodexSessionCatalogPage;
};

/** Equal previews share detached text only while resident rows reference it. */
export class CodexCatalogPreviews {
  private readonly values = new Map<string, { value: string; references: number }>();

  retain(row: CodexCatalogIndexRow, previous?: CodexCatalogIndexRow): void {
    const preview = row.preview;
    if (previous?.preview !== preview) {
      this.release(previous?.preview);
    }
    if (preview === undefined) {
      return;
    }
    let shared = this.values.get(preview);
    if (!shared) {
      // Producers already detached this bounded text from native/JSON backing strings.
      shared = { value: preview, references: 0 };
      this.values.set(preview, shared);
    }
    if (previous?.preview !== preview) {
      shared.references++;
    }
    row.preview = shared.value;
    for (const session of row.page.sessions) {
      if (session.fallbackName === preview) {
        session.fallbackName = shared.value;
      }
    }
  }

  release(preview: string | undefined): void {
    if (preview === undefined) {
      return;
    }
    const shared = this.values.get(preview)!;
    if (--shared.references === 0) {
      this.values.delete(preview);
    }
  }

  clear(): void {
    this.values.clear();
  }
}
