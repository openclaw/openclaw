import path from "node:path";

// Leaf module shared by `config.ts` (for post-bridge approval-policy
// downgrade detection) and `auth-bridge.ts` (for the actual CODEX_HOME
// injection). Both modules need the same path math, but `config.ts` cannot
// import from `auth-bridge.ts` without re-introducing the
// auth-bridge -> client -> config -> transport madge cycle, so the constant
// and resolver live here.

export const CODEX_APP_SERVER_HOME_DIRNAME = "codex-home";
export const CODEX_APP_SERVER_NATIVE_HOME_DIRNAME = "home";

export function resolveCodexAppServerHomeDir(agentDir: string): string {
  return path.join(path.resolve(agentDir), CODEX_APP_SERVER_HOME_DIRNAME);
}

export function resolveCodexAppServerNativeHomeDir(agentDir: string): string {
  return path.join(resolveCodexAppServerHomeDir(agentDir), CODEX_APP_SERVER_NATIVE_HOME_DIRNAME);
}
