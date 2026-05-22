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
type ExecSyncFn = typeof execSync;
declare function readClaudeCliCredentialsCached(options?: {
  allowKeychainPrompt?: boolean;
  ttlMs?: number;
  platform?: NodeJS.Platform;
  homeDir?: string;
  execSync?: ExecSyncFn;
}): ClaudeCliCredential | null;
//#endregion
export { readClaudeCliCredentialsCached as n, ClaudeCliCredential as t };