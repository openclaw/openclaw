import type { BootstrapMode } from "../../bootstrap-mode.js";
export type AttemptBootstrapRoutingInput = {
    workspaceBootstrapPending: boolean;
    bootstrapContextRunKind?: "default" | "heartbeat" | "cron";
    trigger?: string;
    sessionKey?: string;
    isPrimaryRun: boolean;
    isCanonicalWorkspace?: boolean;
    effectiveWorkspace: string;
    resolvedWorkspace: string;
    hasBootstrapFileAccess: boolean;
};
export type AttemptBootstrapRouting = {
    bootstrapMode: BootstrapMode;
    shouldStripBootstrapFromContext: boolean;
    userPromptPrefixText?: string;
};
export type AttemptWorkspaceBootstrapRoutingInput = Omit<AttemptBootstrapRoutingInput, "workspaceBootstrapPending"> & {
    isWorkspaceBootstrapPending: (workspaceDir: string) => Promise<boolean>;
};
export declare function shouldStripBootstrapFromEmbeddedContext(_params: {
    bootstrapMode: BootstrapMode;
}): boolean;
export declare function resolveAttemptBootstrapRouting(params: AttemptBootstrapRoutingInput): AttemptBootstrapRouting;
export declare function resolveAttemptWorkspaceBootstrapRouting(params: AttemptWorkspaceBootstrapRoutingInput): Promise<AttemptBootstrapRouting>;
