import { a as SqliteWalMaintenance, o as SqliteWalMaintenanceOptions } from "./openclaw-runtime-8bI5lw2r.js";
import { DatabaseSync } from "node:sqlite";

//#region packages/memory-host-sdk/src/host/memory-schema.d.ts
declare function ensureMemoryIndexSchema(params: {
  db: DatabaseSync;
  embeddingCacheTable: string;
  cacheEnabled: boolean;
  ftsTable: string;
  ftsEnabled: boolean;
  ftsTokenizer?: "unicode61" | "trigram";
}): {
  ftsAvailable: boolean;
  ftsError?: string;
};
//#endregion
//#region packages/memory-host-sdk/src/host/sqlite-vec.d.ts
declare function loadSqliteVecExtension(params: {
  db: DatabaseSync;
  extensionPath?: string;
}): Promise<{
  ok: boolean;
  extensionPath?: string;
  error?: string;
}>;
//#endregion
//#region packages/memory-host-sdk/src/host/sqlite.d.ts
declare function requireNodeSqlite(): typeof import("node:sqlite");
declare function configureMemorySqliteWalMaintenance(db: DatabaseSync, options?: SqliteWalMaintenanceOptions): SqliteWalMaintenance;
declare function closeMemorySqliteWalMaintenance(db: DatabaseSync): boolean;
//#endregion
//#region src/plugin-sdk/memory-core-host-engine-storage.d.ts
type MemorySource = "memory" | "sessions";
type MemorySearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  vectorScore?: number;
  textScore?: number;
  snippet: string;
  source: MemorySource;
  citation?: string;
};
type MemoryEmbeddingProbeResult = {
  ok: boolean;
  error?: string;
  checked?: boolean;
  cached?: boolean;
  checkedAtMs?: number;
  cacheExpiresAtMs?: number;
};
//#endregion
export { configureMemorySqliteWalMaintenance as a, ensureMemoryIndexSchema as c, closeMemorySqliteWalMaintenance as i, MemorySearchResult as n, requireNodeSqlite as o, MemorySource as r, loadSqliteVecExtension as s, MemoryEmbeddingProbeResult as t };