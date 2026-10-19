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
