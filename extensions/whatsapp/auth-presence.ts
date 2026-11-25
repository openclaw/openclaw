import path from "node:path";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveUserPath } from "openclaw/plugin-sdk/account-resolution";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveOAuthDir } from "openclaw/plugin-sdk/state-paths";
import { collectWhatsAppAuthDirs, hasWebCredsSync } from "./src/creds-files.js";

function addAccountAuthDirs(
  authDirs: Set<string>,
  accountId: string,
  authDir: string | undefined,
  accountsRoot: string,
  env: NodeJS.ProcessEnv,
): void {
  authDirs.add(path.join(accountsRoot, normalizeAccountId(accountId)));
  const configuredAuthDir = authDir?.trim();
  if (configuredAuthDir) {
    authDirs.add(resolveUserPath(configuredAuthDir, env));
  }
}

function listWhatsAppAuthDirs(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const oauthDir = resolveOAuthDir(env);
  const accountsRoot = path.join(oauthDir, "whatsapp");
  const channel = cfg.channels?.whatsapp;
  const authDirs = new Set<string>([path.join(accountsRoot, DEFAULT_ACCOUNT_ID)]);

  if (channel?.defaultAccount?.trim()) {
    addAccountAuthDirs(
      authDirs,
      channel.defaultAccount,
      channel.accounts?.[channel.defaultAccount]?.authDir,
      accountsRoot,
      env,
    );
  }

  const accounts = channel?.accounts;
  if (accounts) {
    for (const [accountId, account] of Object.entries(accounts)) {
      addAccountAuthDirs(authDirs, accountId, account?.authDir, accountsRoot, env);
    }
  }

  return collectWhatsAppAuthDirs(accountsRoot, authDirs);
}

export function hasAnyWhatsAppAuth(
  params:
    | {
        cfg: OpenClawConfig;
        env?: NodeJS.ProcessEnv;
      }
    | OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const cfg = params && typeof params === "object" && "cfg" in params ? params.cfg : params;
  const resolvedEnv =
    params && typeof params === "object" && "cfg" in params ? (params.env ?? env) : env;
  return listWhatsAppAuthDirs(cfg, resolvedEnv).some((authDir) => hasWebCredsSync(authDir));
}
