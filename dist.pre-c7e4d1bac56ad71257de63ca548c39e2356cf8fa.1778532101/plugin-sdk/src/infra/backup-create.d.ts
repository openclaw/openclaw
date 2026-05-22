import { type BackupAsset } from "../commands/backup-shared.js";
export type BackupCreateOptions = {
    output?: string;
    dryRun?: boolean;
    includeWorkspace?: boolean;
    onlyConfig?: boolean;
    verify?: boolean;
    json?: boolean;
    nowMs?: number;
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
};
export declare function formatBackupCreateSummary(result: BackupCreateResult): string[];
export declare function buildExtensionsNodeModulesFilter(stateDir: string): (filePath: string) => boolean;
export declare function createBackupArchive(opts?: BackupCreateOptions): Promise<BackupCreateResult>;
