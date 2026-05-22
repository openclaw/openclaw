import { type RuntimeEnv } from "../runtime.js";
export type BackupVerifyOptions = {
    archive: string;
    json?: boolean;
};
export type BackupVerifyResult = {
    ok: true;
    archivePath: string;
    archiveRoot: string;
    createdAt: string;
    runtimeVersion: string;
    assetCount: number;
    entryCount: number;
};
export declare function backupVerifyCommand(runtime: RuntimeEnv, opts: BackupVerifyOptions): Promise<BackupVerifyResult>;
