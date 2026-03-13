export declare const CONFIG_BACKUP_COUNT = 5;
export interface BackupRotationFs {
    unlink: (path: string) => Promise<void>;
    rename: (from: string, to: string) => Promise<void>;
    chmod?: (path: string, mode: number) => Promise<void>;
    readdir?: (path: string) => Promise<string[]>;
}
export interface BackupMaintenanceFs extends BackupRotationFs {
    copyFile: (from: string, to: string) => Promise<void>;
}
export declare function rotateConfigBackups(configPath: string, ioFs: BackupRotationFs): Promise<void>;
/**
 * Harden file permissions on all .bak files in the rotation ring.
 * copyFile does not guarantee permission preservation on all platforms
 * (e.g. Windows, some NFS mounts), so we explicitly chmod each backup
 * to owner-only (0o600) to match the main config file.
 */
export declare function hardenBackupPermissions(configPath: string, ioFs: BackupRotationFs): Promise<void>;
/**
 * Remove orphan .bak files that fall outside the managed rotation ring.
 * These can accumulate from interrupted writes, manual copies, or PID-stamped
 * backups (e.g. openclaw.json.bak.1772352289, openclaw.json.bak.before-marketing).
 *
 * Only files matching `<configBasename>.bak.*` are considered; the primary
 * `.bak` and numbered `.bak.1` through `.bak.{N-1}` are preserved.
 */
export declare function cleanOrphanBackups(configPath: string, ioFs: BackupRotationFs): Promise<void>;
/**
 * Run the full backup maintenance cycle around config writes.
 * Order matters: rotate ring -> create new .bak -> harden modes -> prune orphan .bak.* files.
 */
export declare function maintainConfigBackups(configPath: string, ioFs: BackupMaintenanceFs): Promise<void>;
