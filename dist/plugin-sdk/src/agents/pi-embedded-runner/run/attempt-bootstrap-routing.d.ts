import type { BootstrapMode } from "../../bootstrap-mode.js";
import { type WorkspaceBootstrapFile } from "../../workspace.js";
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
    includeBootstrapInSystemContext: boolean;
    includeBootstrapInRuntimeContext: boolean;
};
export type AttemptWorkspaceBootstrapRoutingInput = Omit<AttemptBootstrapRoutingInput, "workspaceBootstrapPending"> & {
    isWorkspaceBootstrapPending: (workspaceDir: string) => Promise<boolean>;
    bootstrapFiles?: readonly WorkspaceBootstrapFile[];
};
export declare function resolveBootstrapContextTargets(params: {
    bootstrapMode: BootstrapMode;
}): Pick<AttemptBootstrapRouting, "includeBootstrapInSystemContext" | "includeBootstrapInRuntimeContext">;
export declare function hasBootstrapFileContent(files?: readonly WorkspaceBootstrapFile[]): boolean;
export declare function resolveAttemptWorkspaceBootstrapRouting(params: AttemptWorkspaceBootstrapRoutingInput): Promise<AttemptBootstrapRouting>;
