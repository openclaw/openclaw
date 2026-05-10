import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { upsertPluginStateMigrationEntry } from "openclaw/plugin-sdk/migration-runtime";
import {
  detectLegacyMatrixState,
  type MatrixLegacyStateMigrationResult,
} from "./doctor-legacy-state-detection.js";
import {
  MATRIX_SYNC_STORE_NAMESPACE,
  parsePersistedMatrixSyncStore,
  resolveMatrixSyncStoreKey,
} from "./matrix/client/sqlite-sync-store.js";

const MATRIX_PLUGIN_ID = "matrix";

function moveLegacyPath(params: {
  sourcePath: string;
  targetPath: string;
  label: string;
  changes: string[];
  warnings: string[];
}): void {
  if (!fs.existsSync(params.sourcePath)) {
    return;
  }
  if (fs.existsSync(params.targetPath)) {
    params.warnings.push(
      `Matrix legacy ${params.label} not migrated because the target already exists (${params.targetPath}).`,
    );
    return;
  }
  try {
    fs.mkdirSync(path.dirname(params.targetPath), { recursive: true });
    fs.renameSync(params.sourcePath, params.targetPath);
    params.changes.push(
      `Migrated Matrix legacy ${params.label}: ${params.sourcePath} -> ${params.targetPath}`,
    );
  } catch (err) {
    params.warnings.push(
      `Failed migrating Matrix legacy ${params.label} (${params.sourcePath} -> ${params.targetPath}): ${String(err)}`,
    );
  }
}

function importLegacySyncStore(params: {
  sourcePath: string;
  targetRootDir: string;
  changes: string[];
  warnings: string[];
  env: NodeJS.ProcessEnv;
}): void {
  if (!fs.existsSync(params.sourcePath)) {
    return;
  }
  let parsed: ReturnType<typeof parsePersistedMatrixSyncStore> | null = null;
  try {
    parsed = parsePersistedMatrixSyncStore(fs.readFileSync(params.sourcePath, "utf8"));
  } catch (err) {
    params.warnings.push(
      `Failed reading Matrix legacy sync store (${params.sourcePath}): ${String(err)}`,
    );
    return;
  }
  if (!parsed) {
    params.warnings.push(`Skipped invalid Matrix legacy sync store: ${params.sourcePath}`);
    return;
  }
  upsertPluginStateMigrationEntry({
    pluginId: MATRIX_PLUGIN_ID,
    namespace: MATRIX_SYNC_STORE_NAMESPACE,
    key: resolveMatrixSyncStoreKey(params.targetRootDir),
    value: parsed,
    createdAt: fs.statSync(params.sourcePath).mtimeMs || Date.now(),
    env: params.env,
  });
  fs.rmSync(params.sourcePath, { force: true });
  params.changes.push(
    `Imported Matrix legacy sync store into SQLite: ${params.sourcePath} -> matrix plugin state (${params.targetRootDir})`,
  );
}

export async function autoMigrateLegacyMatrixState(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  log?: { info?: (message: string) => void; warn?: (message: string) => void };
}): Promise<MatrixLegacyStateMigrationResult> {
  const env = params.env ?? process.env;
  const detection = detectLegacyMatrixState({ cfg: params.cfg, env });
  if (!detection) {
    return { migrated: false, changes: [], warnings: [] };
  }
  if ("warning" in detection) {
    params.log?.warn?.(`matrix: ${detection.warning}`);
    return { migrated: false, changes: [], warnings: [detection.warning] };
  }

  const changes: string[] = [];
  const warnings: string[] = [];
  importLegacySyncStore({
    sourcePath: detection.legacyStoragePath,
    targetRootDir: detection.targetRootDir,
    changes,
    warnings,
    env,
  });
  moveLegacyPath({
    sourcePath: detection.legacyCryptoPath,
    targetPath: detection.targetCryptoPath,
    label: "crypto store",
    changes,
    warnings,
  });

  if (changes.length > 0) {
    const details = [
      ...changes.map((entry) => `- ${entry}`),
      ...(detection.selectionNote ? [`- ${detection.selectionNote}`] : []),
      "- No user action required.",
    ];
    params.log?.info?.(
      `matrix: plugin upgraded in place for account "${detection.accountId}".\n${details.join("\n")}`,
    );
  }
  if (warnings.length > 0) {
    params.log?.warn?.(
      `matrix: legacy state migration warnings:\n${warnings.map((entry) => `- ${entry}`).join("\n")}`,
    );
  }

  return {
    migrated: changes.length > 0,
    changes,
    warnings,
  };
}
