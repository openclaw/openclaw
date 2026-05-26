import type { DatabaseSync } from "node:sqlite";
import { type SqliteWalMaintenance, type SqliteWalMaintenanceOptions } from "./sqlite-wal.js";
export declare function requireNodeSqlite(): typeof import("node:sqlite");
export declare function configureMemorySqliteWalMaintenance(db: DatabaseSync, options?: SqliteWalMaintenanceOptions): SqliteWalMaintenance;
export declare function closeMemorySqliteWalMaintenance(db: DatabaseSync): boolean;
