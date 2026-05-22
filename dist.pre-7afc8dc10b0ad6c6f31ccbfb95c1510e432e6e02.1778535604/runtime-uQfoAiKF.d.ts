//#region src/commands/backup-shared.d.ts
type BackupAssetKind = "state" | "config" | "credentials" | "workspace";
type BackupAsset = {
  kind: BackupAssetKind;
  sourcePath: string;
  displayPath: string;
  archivePath: string;
};
//#endregion
//#region src/infra/backup-create.d.ts
type BackupCreateOptions = {
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
type BackupCreateResult = {
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
declare function createBackupArchive(opts?: BackupCreateOptions): Promise<BackupCreateResult>;
//#endregion
export { createBackupArchive as t };