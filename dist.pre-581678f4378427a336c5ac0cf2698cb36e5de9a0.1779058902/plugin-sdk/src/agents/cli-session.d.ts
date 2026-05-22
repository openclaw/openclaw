import type { CliSessionBinding, SessionEntry } from "../config/sessions.js";
export declare function hashCliSessionText(value: string | undefined): string | undefined;
export declare function getCliSessionBinding(entry: SessionEntry | undefined, provider: string): CliSessionBinding | undefined;
export declare function getCliSessionId(entry: SessionEntry | undefined, provider: string): string | undefined;
export declare function setCliSessionId(entry: SessionEntry, provider: string, sessionId: string): void;
export declare function setCliSessionBinding(entry: SessionEntry, provider: string, binding: CliSessionBinding): void;
export declare function clearCliSession(entry: SessionEntry, provider: string): void;
export declare function clearAllCliSessions(entry: SessionEntry): void;
export declare function resolveCliSessionReuse(params: {
    binding?: CliSessionBinding;
    authProfileId?: string;
    authEpoch?: string;
    authEpochVersion: number;
    extraSystemPromptHash?: string;
    mcpConfigHash?: string;
    mcpResumeHash?: string;
}): {
    sessionId?: string;
    invalidatedReason?: "auth-profile" | "auth-epoch" | "system-prompt" | "mcp";
};
