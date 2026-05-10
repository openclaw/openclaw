import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  requiresExplicitMatrixDefaultAccount,
  resolveMatrixDefaultOrOnlyAccountId,
} from "./account-selection.js";
import {
  loadMatrixCredentials,
  normalizeMatrixCredentials,
  saveMatrixCredentialsState,
} from "./matrix/credentials-read.js";
import { getMatrixRuntime } from "./runtime.js";
import { resolveMatrixCredentialsPath } from "./storage-paths.js";

function resolveStateDir(env: NodeJS.ProcessEnv): string {
  try {
    return getMatrixRuntime().state.resolveStateDir(env, os.homedir);
  } catch {
    const override = env.OPENCLAW_STATE_DIR?.trim();
    if (override) {
      return path.resolve(override);
    }
    const homeDir = env.OPENCLAW_HOME?.trim() || env.HOME?.trim() || os.homedir();
    return path.join(homeDir, ".openclaw");
  }
}

function resolveLegacyMatrixCredentialsPath(stateDir: string): string {
  return resolveMatrixCredentialsPath({ stateDir, accountId: DEFAULT_ACCOUNT_ID });
}

function resolveLegacyCredentialsTargetAccountId(cfg: OpenClawConfig): string | null {
  if (!cfg.channels?.matrix || typeof cfg.channels.matrix !== "object") {
    return DEFAULT_ACCOUNT_ID;
  }
  if (requiresExplicitMatrixDefaultAccount(cfg)) {
    return null;
  }
  const accountId = normalizeAccountId(resolveMatrixDefaultOrOnlyAccountId(cfg));
  return accountId || DEFAULT_ACCOUNT_ID;
}

export function autoMigrateLegacyMatrixCredentials(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): { changes: string[]; warnings: string[] } {
  const changes: string[] = [];
  const warnings: string[] = [];
  const stateDir = resolveStateDir(params.env);
  const accountId = resolveLegacyCredentialsTargetAccountId(params.cfg);
  if (!accountId || accountId === DEFAULT_ACCOUNT_ID) {
    return { changes, warnings };
  }

  const sourcePath = resolveLegacyMatrixCredentialsPath(stateDir);
  const targetPath = resolveMatrixCredentialsPath({ stateDir, accountId });
  if (sourcePath === targetPath || !fs.existsSync(sourcePath)) {
    return { changes, warnings };
  }
  if (loadMatrixCredentials(params.env, accountId)) {
    warnings.push(
      `Matrix legacy credentials were not imported for account "${accountId}" because SQLite credentials already exist.`,
    );
    return { changes, warnings };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(sourcePath, "utf8")) as unknown;
  } catch (error) {
    warnings.push(
      `Matrix legacy credentials were not imported from ${sourcePath}: ${String(error)}`,
    );
    return { changes, warnings };
  }
  const credentials = normalizeMatrixCredentials(parsed);
  if (!credentials) {
    warnings.push(`Matrix legacy credentials were not imported because ${sourcePath} is invalid.`);
    return { changes, warnings };
  }

  saveMatrixCredentialsState(credentials, params.env, accountId);
  fs.rmSync(sourcePath, { force: true });
  changes.push(`Imported Matrix legacy credentials into SQLite for account "${accountId}".`);
  return { changes, warnings };
}
