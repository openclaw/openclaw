import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MigrationProviderContext } from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";
export declare function createMigrationLogger(runtime: RuntimeEnv, opts?: {
    json?: boolean;
}): {
    debug: (message: string) => void;
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
};
export declare function buildMigrationReportDir(providerId: string, stateDir: string, nowMs?: number): string;
export declare function buildMigrationContext(params: {
    source?: string;
    includeSecrets?: boolean;
    overwrite?: boolean;
    providerOptions?: Record<string, unknown>;
    backupPath?: string;
    configOverride?: OpenClawConfig;
    runtime: RuntimeEnv;
    reportDir?: string;
    json?: boolean;
}): MigrationProviderContext;
