import { execFileSync, execSync } from "node:child_process";
import type { OAuthCredentials, OAuthProvider } from "@mariozechner/pi-ai";
export declare function resetCliCredentialCachesForTest(): void;
export type ClaudeCliCredential = {
    type: "oauth";
    provider: "anthropic";
    access: string;
    refresh: string;
    expires: number;
} | {
    type: "token";
    provider: "anthropic";
    token: string;
    expires: number;
};
export type CodexCliCredential = {
    type: "oauth";
    provider: OAuthProvider;
    access: string;
    refresh: string;
    expires: number;
    accountId?: string;
};
export type QwenCliCredential = {
    type: "oauth";
    provider: "qwen-portal";
    access: string;
    refresh: string;
    expires: number;
};
export type MiniMaxCliCredential = {
    type: "oauth";
    provider: "minimax-portal";
    access: string;
    refresh: string;
    expires: number;
};
type ClaudeCliFileOptions = {
    homeDir?: string;
};
type ClaudeCliWriteOptions = ClaudeCliFileOptions & {
    platform?: NodeJS.Platform;
    writeKeychain?: (credentials: OAuthCredentials) => boolean;
    writeFile?: (credentials: OAuthCredentials, options?: ClaudeCliFileOptions) => boolean;
};
type ExecSyncFn = typeof execSync;
type ExecFileSyncFn = typeof execFileSync;
export declare function readClaudeCliCredentials(options?: {
    allowKeychainPrompt?: boolean;
    platform?: NodeJS.Platform;
    homeDir?: string;
    execSync?: ExecSyncFn;
}): ClaudeCliCredential | null;
export declare function readClaudeCliCredentialsCached(options?: {
    allowKeychainPrompt?: boolean;
    ttlMs?: number;
    platform?: NodeJS.Platform;
    homeDir?: string;
    execSync?: ExecSyncFn;
}): ClaudeCliCredential | null;
export declare function writeClaudeCliKeychainCredentials(newCredentials: OAuthCredentials, options?: {
    execFileSync?: ExecFileSyncFn;
}): boolean;
export declare function writeClaudeCliFileCredentials(newCredentials: OAuthCredentials, options?: ClaudeCliFileOptions): boolean;
export declare function writeClaudeCliCredentials(newCredentials: OAuthCredentials, options?: ClaudeCliWriteOptions): boolean;
export declare function readCodexCliCredentials(options?: {
    platform?: NodeJS.Platform;
    execSync?: ExecSyncFn;
}): CodexCliCredential | null;
export declare function readCodexCliCredentialsCached(options?: {
    ttlMs?: number;
    platform?: NodeJS.Platform;
    execSync?: ExecSyncFn;
}): CodexCliCredential | null;
export declare function readQwenCliCredentialsCached(options?: {
    ttlMs?: number;
    homeDir?: string;
}): QwenCliCredential | null;
export declare function readMiniMaxCliCredentialsCached(options?: {
    ttlMs?: number;
    homeDir?: string;
}): MiniMaxCliCredential | null;
export {};
