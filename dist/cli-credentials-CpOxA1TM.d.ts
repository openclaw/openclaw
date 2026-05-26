import { l as OAuthProvider } from "./types-BwDj5PsX.js";
import { execFileSync, execSync } from "node:child_process";

//#region src/agents/cli-credentials.d.ts
type ClaudeCliCredential = {
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
type CodexCliCredential = {
  type: "oauth";
  provider: OAuthProvider;
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  idToken?: string;
};
type ExecSyncFn = typeof execSync;
/** @deprecated Anthropic provider-owned CLI credential helper; do not use from third-party plugins. */
declare function readClaudeCliCredentialsCached(options?: {
  allowKeychainPrompt?: boolean;
  ttlMs?: number;
  platform?: NodeJS.Platform;
  homeDir?: string;
  execSync?: ExecSyncFn;
}): ClaudeCliCredential | null;
declare function readCodexCliCredentialsCached(options?: {
  codexHome?: string;
  allowKeychainPrompt?: boolean;
  ttlMs?: number;
  platform?: NodeJS.Platform;
  execSync?: ExecSyncFn;
}): CodexCliCredential | null;
//#endregion
export { readClaudeCliCredentialsCached as n, readCodexCliCredentialsCached as r, ClaudeCliCredential as t };