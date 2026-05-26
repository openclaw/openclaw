export { DEFAULT_AGENT_WORKSPACE_DIR, resolveDefaultAgentWorkspaceDir, } from "./workspace-default.js";
export declare const DEFAULT_AGENTS_FILENAME = "AGENTS.md";
export declare const DEFAULT_SOUL_FILENAME = "SOUL.md";
export declare const DEFAULT_TOOLS_FILENAME = "TOOLS.md";
export declare const DEFAULT_IDENTITY_FILENAME = "IDENTITY.md";
export declare const DEFAULT_USER_FILENAME = "USER.md";
export declare const DEFAULT_HEARTBEAT_FILENAME = "HEARTBEAT.md";
export declare const DEFAULT_BOOTSTRAP_FILENAME = "BOOTSTRAP.md";
export declare const DEFAULT_MEMORY_FILENAME = "MEMORY.md";
declare const WORKSPACE_STATE_VERSION = 1;
export type WorkspaceBootstrapFileName = typeof DEFAULT_AGENTS_FILENAME | typeof DEFAULT_SOUL_FILENAME | typeof DEFAULT_TOOLS_FILENAME | typeof DEFAULT_IDENTITY_FILENAME | typeof DEFAULT_USER_FILENAME | typeof DEFAULT_HEARTBEAT_FILENAME | typeof DEFAULT_BOOTSTRAP_FILENAME | typeof DEFAULT_MEMORY_FILENAME;
export type WorkspaceBootstrapFile = {
    name: WorkspaceBootstrapFileName;
    path: string;
    content?: string;
    missing: boolean;
};
export type ExtraBootstrapLoadDiagnosticCode = "invalid-bootstrap-filename" | "missing" | "security" | "io";
export type ExtraBootstrapLoadDiagnostic = {
    path: string;
    reason: ExtraBootstrapLoadDiagnosticCode;
    detail: string;
};
type WorkspaceSetupState = {
    version: typeof WORKSPACE_STATE_VERSION;
    bootstrapSeededAt?: string;
    setupCompletedAt?: string;
};
type WorkspaceBootstrapCompletionReconcileResult = {
    repaired: boolean;
    bootstrapExists: boolean;
    state: WorkspaceSetupState;
};
export declare function isWorkspaceSetupCompleted(dir: string): Promise<boolean>;
export declare function resolveWorkspaceBootstrapStatus(dir: string): Promise<"pending" | "complete">;
export declare function isWorkspaceBootstrapPending(dir: string): Promise<boolean>;
export declare function reconcileWorkspaceBootstrapCompletion(dir: string): Promise<WorkspaceBootstrapCompletionReconcileResult>;
export declare function ensureAgentWorkspace(params?: {
    dir?: string;
    ensureBootstrapFiles?: boolean;
    /**
     * List of optional bootstrap filenames to skip writing.
     * Applies only to SOUL.md, USER.md, HEARTBEAT.md, IDENTITY.md.
     * Required workspace setup such as AGENTS.md and TOOLS.md still runs.
     */
    skipOptionalBootstrapFiles?: string[];
}): Promise<{
    dir: string;
    agentsPath?: string;
    soulPath?: string;
    toolsPath?: string;
    identityPath?: string;
    userPath?: string;
    heartbeatPath?: string;
    bootstrapPath?: string;
    identityPathCreated?: boolean;
}>;
export declare function loadWorkspaceBootstrapFiles(dir: string): Promise<WorkspaceBootstrapFile[]>;
export declare function filterBootstrapFilesForSession(files: WorkspaceBootstrapFile[], sessionKey?: string): WorkspaceBootstrapFile[];
export declare function loadExtraBootstrapFiles(dir: string, extraPatterns: string[]): Promise<WorkspaceBootstrapFile[]>;
export declare function loadExtraBootstrapFilesWithDiagnostics(dir: string, extraPatterns: string[]): Promise<{
    files: WorkspaceBootstrapFile[];
    diagnostics: ExtraBootstrapLoadDiagnostic[];
}>;
