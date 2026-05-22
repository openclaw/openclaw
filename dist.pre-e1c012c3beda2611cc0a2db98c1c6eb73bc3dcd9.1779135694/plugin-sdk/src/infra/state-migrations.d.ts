import type { ChannelLegacyStateMigrationPlan } from "../channels/plugins/types.core.js";
import type { SessionScope } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export type LegacyStateDetection = {
    targetAgentId: string;
    targetMainKey: string;
    targetScope?: SessionScope;
    stateDir: string;
    oauthDir: string;
    sessions: {
        legacyDir: string;
        legacyStorePath: string;
        targetDir: string;
        targetStorePath: string;
        hasLegacy: boolean;
        legacyKeys: string[];
    };
    agentDir: {
        legacyDir: string;
        targetDir: string;
        hasLegacy: boolean;
    };
    channelPlans: {
        hasLegacy: boolean;
        plans: ChannelLegacyStateMigrationPlan[];
    };
    preview: string[];
};
type MigrationLogger = {
    info: (message: string) => void;
    warn: (message: string) => void;
};
export declare function resetAutoMigrateLegacyStateForTest(): void;
export declare function resetAutoMigrateLegacyAgentDirForTest(): void;
export declare function resetAutoMigrateLegacyStateDirForTest(): void;
type StateDirMigrationResult = {
    migrated: boolean;
    skipped: boolean;
    changes: string[];
    warnings: string[];
};
export declare function autoMigrateLegacyStateDir(params: {
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
    log?: MigrationLogger;
}): Promise<StateDirMigrationResult>;
export declare function detectLegacyStateMigrations(params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
}): Promise<LegacyStateDetection>;
export declare function migrateLegacyAgentDir(detected: LegacyStateDetection, now: () => number): Promise<{
    changes: string[];
    warnings: string[];
}>;
export declare function runLegacyStateMigrations(params: {
    detected: LegacyStateDetection;
    now?: () => number;
}): Promise<{
    changes: string[];
    warnings: string[];
}>;
export declare function autoMigrateLegacyAgentDir(params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
    log?: MigrationLogger;
    now?: () => number;
}): Promise<{
    migrated: boolean;
    skipped: boolean;
    changes: string[];
    warnings: string[];
}>;
/**
 * Canonicalize orphaned raw session keys in all known agent session stores.
 *
 * Keys written by resolveSessionKey() used DEFAULT_AGENT_ID="main" regardless
 * of the configured default agent; reads always use resolveSessionStoreKey()
 * which canonicalizes via canonicalizeMainSessionAlias. This migration renames
 * any orphaned raw keys to their canonical form in-place, merging with any
 * existing canonical entry by preferring the most recently updated.
 *
 * Safe to run multiple times (idempotent). See #29683.
 */
export declare function migrateOrphanedSessionKeys(params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
}): Promise<{
    changes: string[];
    warnings: string[];
}>;
export declare function autoMigrateLegacyState(params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
    log?: MigrationLogger;
    now?: () => number;
}): Promise<{
    migrated: boolean;
    skipped: boolean;
    changes: string[];
    warnings: string[];
}>;
export {};
