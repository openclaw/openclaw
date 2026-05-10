import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { resolveLegacyMatrixFlatStoreTarget } from "./doctor-migration-config.js";
import { resolveMatrixLegacyFlatStoragePaths } from "./storage-paths.js";

export type MatrixLegacyStateMigrationResult = {
  migrated: boolean;
  changes: string[];
  warnings: string[];
};

export type MatrixLegacyStatePlan = {
  accountId: string;
  legacyStoragePath: string;
  legacyCryptoPath: string;
  targetRootDir: string;
  targetCryptoPath: string;
  selectionNote?: string;
};

function resolveLegacyMatrixPaths(env: NodeJS.ProcessEnv): {
  rootDir: string;
  syncStorePath: string;
  cryptoPath: string;
} {
  const stateDir = resolveStateDir(env, os.homedir);
  return resolveMatrixLegacyFlatStoragePaths(stateDir);
}

function resolveMatrixMigrationPlan(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): MatrixLegacyStatePlan | { warning: string } | null {
  const legacy = resolveLegacyMatrixPaths(params.env);
  if (!fs.existsSync(legacy.syncStorePath) && !fs.existsSync(legacy.cryptoPath)) {
    return null;
  }

  const target = resolveLegacyMatrixFlatStoreTarget({
    cfg: params.cfg,
    env: params.env,
    detectedPath: legacy.rootDir,
    detectedKind: "state",
  });
  if ("warning" in target) {
    return target;
  }

  return {
    accountId: target.accountId,
    legacyStoragePath: legacy.syncStorePath,
    legacyCryptoPath: legacy.cryptoPath,
    targetRootDir: target.rootDir,
    targetCryptoPath: path.join(target.rootDir, "crypto"),
    selectionNote: target.selectionNote,
  };
}

export function detectLegacyMatrixState(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): MatrixLegacyStatePlan | { warning: string } | null {
  return resolveMatrixMigrationPlan({
    cfg: params.cfg,
    env: params.env ?? process.env,
  });
}
