export type BackupAssetKind = "state" | "config" | "credentials" | "workspace";
export type BackupSkipReason = "covered" | "missing";
export type BackupAsset = {
    kind: BackupAssetKind;
    sourcePath: string;
    displayPath: string;
    archivePath: string;
};
export type SkippedBackupAsset = {
    kind: BackupAssetKind;
    sourcePath: string;
    displayPath: string;
    reason: BackupSkipReason;
    coveredBy?: string;
};
export type BackupPlan = {
    stateDir: string;
    configPath: string;
    oauthDir: string;
    workspaceDirs: string[];
    included: BackupAsset[];
    skipped: SkippedBackupAsset[];
};
export declare function buildBackupArchiveRoot(nowMs?: number): string;
export declare function buildBackupArchiveBasename(nowMs?: number): string;
export declare function encodeAbsolutePathForBackupArchive(sourcePath: string): string;
export declare function buildBackupArchivePath(archiveRoot: string, sourcePath: string): string;
export declare function resolveBackupPlanFromPaths(params: {
    stateDir: string;
    configPath: string;
    oauthDir: string;
    workspaceDirs?: string[];
    includeWorkspace?: boolean;
    onlyConfig?: boolean;
    configInsideState?: boolean;
    oauthInsideState?: boolean;
    nowMs?: number;
}): Promise<BackupPlan>;
export declare function resolveBackupPlanFromDisk(params?: {
    includeWorkspace?: boolean;
    onlyConfig?: boolean;
    nowMs?: number;
}): Promise<BackupPlan>;
