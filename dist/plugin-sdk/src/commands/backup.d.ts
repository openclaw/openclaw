import { type BackupCreateOptions, type BackupCreateResult } from "../infra/backup-create.js";
import { type RuntimeEnv } from "../runtime.js";
export type { BackupCreateOptions, BackupCreateResult } from "../infra/backup-create.js";
export declare function backupCreateCommand(runtime: RuntimeEnv, opts?: BackupCreateOptions): Promise<BackupCreateResult>;
