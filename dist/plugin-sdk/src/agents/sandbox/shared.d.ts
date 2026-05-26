export declare function slugifySessionKey(value: string): string;
export declare function resolveSandboxWorkspaceDir(root: string, sessionKey: string): string;
export declare function resolveSandboxScopeKey(scope: "session" | "agent" | "shared", sessionKey: string): string;
export declare function resolveSandboxAgentId(scopeKey: string): string | undefined;
