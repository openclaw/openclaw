import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { MigrationProviderPlugin } from "./types.js";
export declare function ensureStandaloneMigrationProviderRegistryLoaded(params?: {
    cfg?: OpenClawConfig;
}): void;
export declare function resolvePluginMigrationProvider(params: {
    providerId: string;
    cfg?: OpenClawConfig;
}): MigrationProviderPlugin | undefined;
export declare function resolvePluginMigrationProviders(params?: {
    cfg?: OpenClawConfig;
}): MigrationProviderPlugin[];
