import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
type SessionRouteRepairResult = {
    changed: boolean;
    sessionKeys: string[];
};
type CodexSessionRouteRepairSummary = {
    scannedStores: number;
    repairedStores: number;
    repairedSessions: number;
    warnings: string[];
    changes: string[];
};
export declare function collectCodexRouteWarnings(params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
}): string[];
export declare function maybeRepairCodexRoutes(params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    shouldRepair: boolean;
    codexRuntimeReady?: boolean;
}): {
    cfg: OpenClawConfig;
    warnings: string[];
    changes: string[];
};
export declare function repairCodexSessionStoreRoutes(params: {
    store: Record<string, SessionEntry>;
    now?: number;
}): SessionRouteRepairResult;
export declare function maybeRepairCodexSessionRoutes(params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    shouldRepair: boolean;
    codexRuntimeReady?: boolean;
}): Promise<CodexSessionRouteRepairSummary>;
export {};
