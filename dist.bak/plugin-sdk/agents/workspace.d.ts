export declare function resolveDefaultAgentWorkspaceDir(env?: NodeJS.ProcessEnv, homedir?: () => string): string;
export declare const DEFAULT_AGENT_WORKSPACE_DIR: string;
export declare const DEFAULT_AGENTS_FILENAME = "AGENTS.md";
export declare const DEFAULT_SOUL_FILENAME = "SOUL.md";
export declare const DEFAULT_TOOLS_FILENAME = "TOOLS.md";
export declare const DEFAULT_IDENTITY_FILENAME = "IDENTITY.md";
export declare const DEFAULT_USER_FILENAME = "USER.md";
export declare const DEFAULT_HEARTBEAT_FILENAME = "HEARTBEAT.md";
export declare const DEFAULT_BOOTSTRAP_FILENAME = "BOOTSTRAP.md";
export declare const DEFAULT_MEMORY_FILENAME = "MEMORY.md";
export declare const DEFAULT_MEMORY_ALT_FILENAME = "memory.md";
export type WorkspaceBootstrapFileName = typeof DEFAULT_AGENTS_FILENAME | typeof DEFAULT_SOUL_FILENAME | typeof DEFAULT_TOOLS_FILENAME | typeof DEFAULT_IDENTITY_FILENAME | typeof DEFAULT_USER_FILENAME | typeof DEFAULT_HEARTBEAT_FILENAME | typeof DEFAULT_BOOTSTRAP_FILENAME | typeof DEFAULT_MEMORY_FILENAME | typeof DEFAULT_MEMORY_ALT_FILENAME;
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
export declare function isWorkspaceOnboardingCompleted(dir: string): Promise<boolean>;
export declare function ensureAgentWorkspace(params?: {
    dir?: string;
    ensureBootstrapFiles?: boolean;
}): Promise<{
    dir: string;
    agentsPath?: string;
    soulPath?: string;
    toolsPath?: string;
    identityPath?: string;
    userPath?: string;
    heartbeatPath?: string;
    bootstrapPath?: string;
}>;
export declare function loadWorkspaceBootstrapFiles(dir: string): Promise<WorkspaceBootstrapFile[]>;
export declare function filterBootstrapFilesForSession(files: WorkspaceBootstrapFile[], sessionKey?: string): WorkspaceBootstrapFile[];
export declare function loadExtraBootstrapFiles(dir: string, extraPatterns: string[]): Promise<WorkspaceBootstrapFile[]>;
export declare function loadExtraBootstrapFilesWithDiagnostics(dir: string, extraPatterns: string[]): Promise<{
    files: WorkspaceBootstrapFile[];
    diagnostics: ExtraBootstrapLoadDiagnostic[];
}>;
