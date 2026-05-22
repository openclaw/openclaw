import { type BackupAsset } from "../commands/backup-shared.js";
export type BackupCreateOptions = {
    output?: string;
    dryRun?: boolean;
    includeWorkspace?: boolean;
    onlyConfig?: boolean;
    verify?: boolean;
    json?: boolean;
    nowMs?: number;
    /**
     * Optional info logger invoked for non-fatal backup events such as tar
     * retry notices or volatile-file skip counts. When omitted, events are
     * silent aside from the final result.
     */
    log?: (message: string) => void;
};
export type BackupCreateResult = {
    createdAt: string;
    archiveRoot: string;
    archivePath: string;
    dryRun: boolean;
    includeWorkspace: boolean;
    onlyConfig: boolean;
    verified: boolean;
    assets: BackupAsset[];
    skipped: Array<{
        kind: string;
        sourcePath: string;
        displayPath: string;
        reason: string;
        coveredBy?: string;
    }>;
    /**
     * Count of files the archiver actively skipped because they matched the
     * known-volatile filter (live sessions, cron logs, queues, sockets, pid/tmp).
     * Populated on real writes only; dry runs report 0.
     */
    skippedVolatileCount: number;
};
declare function isTarEofRaceError(err: unknown): boolean;
export type BackupTarRetryLogger = (message: string) => void;
declare function writeTarArchiveWithRetry(params: {
    tempArchivePath: string;
    runTar: () => Promise<void>;
    log?: BackupTarRetryLogger;
    sleepMs?: (ms: number) => Promise<void>;
}): Promise<void>;
export declare const testApi: {
    writeTarArchiveWithRetry: typeof writeTarArchiveWithRetry;
    isTarEofRaceError: typeof isTarEofRaceError;
};
export { testApi as __test };
export declare function formatBackupCreateSummary(result: BackupCreateResult): string[];
export declare function buildExtensionsNodeModulesFilter(stateDir: string): (filePath: string) => boolean;
export declare function createBackupArchive(opts?: BackupCreateOptions): Promise<BackupCreateResult>;
