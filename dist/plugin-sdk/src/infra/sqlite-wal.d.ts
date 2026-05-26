import type { DatabaseSync } from "node:sqlite";
export declare const DEFAULT_SQLITE_WAL_AUTOCHECKPOINT_PAGES = 1000;
export declare const DEFAULT_SQLITE_WAL_TRUNCATE_INTERVAL_MS: number;
type SqliteWalCheckpointMode = "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE";
export type SqliteWalMaintenance = {
    checkpoint: () => boolean;
    close: () => boolean;
};
export type SqliteWalMaintenanceOptions = {
    autoCheckpointPages?: number;
    checkpointIntervalMs?: number;
    checkpointMode?: SqliteWalCheckpointMode;
    onCheckpointError?: (error: unknown) => void;
};
export declare function configureSqliteWalMaintenance(db: DatabaseSync, options?: SqliteWalMaintenanceOptions): SqliteWalMaintenance;
export {};
