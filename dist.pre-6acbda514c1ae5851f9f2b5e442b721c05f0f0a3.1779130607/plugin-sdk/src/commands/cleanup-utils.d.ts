import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
type RemovalResult = {
    ok: boolean;
    skipped?: boolean;
};
type CleanupResolvedPaths = {
    stateDir: string;
    configPath: string;
    oauthDir: string;
    configInsideState: boolean;
    oauthInsideState: boolean;
};
export declare function buildCleanupPlan(params: {
    cfg: OpenClawConfig | undefined;
    stateDir: string;
    configPath: string;
    oauthDir: string;
}): {
    configInsideState: boolean;
    oauthInsideState: boolean;
    workspaceDirs: string[];
};
export declare function isPathWithin(child: string, parent: string): boolean;
export declare function removePath(target: string, runtime: RuntimeEnv, opts?: {
    dryRun?: boolean;
    label?: string;
}): Promise<RemovalResult>;
export declare function removeStateAndLinkedPaths(cleanup: CleanupResolvedPaths, runtime: RuntimeEnv, opts?: {
    dryRun?: boolean;
}): Promise<void>;
export declare function removeWorkspaceDirs(workspaceDirs: readonly string[], runtime: RuntimeEnv, opts?: {
    dryRun?: boolean;
}): Promise<void>;
export declare function listAgentSessionDirs(stateDir: string): Promise<string[]>;
export {};
