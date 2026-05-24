import { Sn as KnowledgeBase, Zt as PlaybookStepContext, on as CwObject, un as CwDatabase } from "./config-types-CnpeTEne.mjs";

//#region src/planes/data/db-open.d.ts
type OpenDatabaseResult = {
  db: CwDatabase;
  close: () => void;
  dialect: "sqlite" | "postgresql";
  note?: string;
};
/**
 * Open ClaWorks persistence (SQLite or PostgreSQL).
 */
declare function openDatabase(databaseUrl: string): OpenDatabaseResult;
//#endregion
//#region src/planes/data/db-pg.d.ts
declare function convertPlaceholders(sql: string): string;
declare function isPostgresDatabaseUrl(url: string): boolean;
//#endregion
//#region src/planes/data/db-migrate.d.ts
/** Idempotent schema migrations for SQLite and PostgreSQL. */
declare function migrateClaworksSchema(db: CwDatabase): void;
//#endregion
//#region src/planes/data/knowledge-base.d.ts
/** In-memory KB stub; use `data.kb_provider: memory-core` in claworks-robot for memory-core search. */
declare function createKnowledgeBase(): KnowledgeBase;
//#endregion
//#region src/planes/data/knowledge-base-file.d.ts
/**
 * File-backed knowledge base (JSON). Used when config.data.kb_path is set.
 */
declare function createFileKnowledgeBase(filePath: string): KnowledgeBase;
//#endregion
//#region src/planes/data/mes-dispatch.d.ts
/** MES production dispatch — webhook or simulate per CLAWTWIN_MES_PRODUCTION_* env. */
declare function mesProductionDispatch(params: Record<string, unknown>): Promise<Record<string, unknown>>;
//#endregion
//#region src/planes/data/work-order-events.d.ts
declare function publishWorkOrderCreated(ctx: PlaybookStepContext, wo: CwObject, extra?: Record<string, unknown>): Promise<void>;
//#endregion
export { migrateClaworksSchema as a, OpenDatabaseResult as c, createKnowledgeBase as i, openDatabase as l, mesProductionDispatch as n, convertPlaceholders as o, createFileKnowledgeBase as r, isPostgresDatabaseUrl as s, publishWorkOrderCreated as t };