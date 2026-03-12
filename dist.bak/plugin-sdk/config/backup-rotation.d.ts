export declare const CONFIG_BACKUP_COUNT = 5;
export declare function rotateConfigBackups(configPath: string, ioFs: {
    unlink: (path: string) => Promise<void>;
    rename: (from: string, to: string) => Promise<void>;
}): Promise<void>;
