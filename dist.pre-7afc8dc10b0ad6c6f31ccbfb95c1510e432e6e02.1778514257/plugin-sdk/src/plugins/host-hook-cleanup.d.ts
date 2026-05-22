import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginHostCleanupReason } from "./host-hooks.js";
import type { PluginRegistry } from "./registry-types.js";
export type PluginHostCleanupFailure = {
    pluginId: string;
    hookId: string;
    error: unknown;
};
export type PluginHostCleanupResult = {
    cleanupCount: number;
    failures: PluginHostCleanupFailure[];
};
export declare function clearPluginOwnedSessionState(entry: SessionEntry, pluginId?: string, sessionEntrySlotKeys?: ReadonlySet<string>): void;
export declare function runPluginHostCleanup(params: {
    cfg?: OpenClawConfig;
    registry?: PluginRegistry | null;
    pluginId?: string;
    reason: PluginHostCleanupReason;
    sessionKey?: string;
    runId?: string;
    preserveSchedulerJobIds?: ReadonlySet<string>;
    shouldCleanup?: () => boolean;
    restartPromotedSessionEntrySlotKeys?: ReadonlySet<string>;
}): Promise<PluginHostCleanupResult>;
export declare function cleanupReplacedPluginHostRegistry(params: {
    cfg: OpenClawConfig;
    previousRegistry?: PluginRegistry | null;
    nextRegistry?: PluginRegistry | null;
    shouldCleanup?: () => boolean;
}): Promise<PluginHostCleanupResult>;
