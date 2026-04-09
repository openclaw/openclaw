import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { isMatrixLegacyCryptoInspectorAvailable } from "./legacy-crypto-inspector-availability.js";
import { detectLegacyMatrixCrypto } from "./legacy-crypto.js";
import { detectLegacyMatrixState } from "./legacy-state.js";
import {
  maybeCreateMatrixMigrationSnapshot,
  resolveMatrixMigrationSnapshotMarkerPath,
  resolveMatrixMigrationSnapshotOutputDir,
  type MatrixMigrationSnapshotResult,
} from "./migration-snapshot-backup.js";

export function hasPendingMatrixMigration(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const env = params.env ?? process.env;
  const legacyState = detectLegacyMatrixState({ cfg: params.cfg, env });
  if (legacyState) {
    return true;
  }
  const legacyCrypto = detectLegacyMatrixCrypto({ cfg: params.cfg, env });
  return legacyCrypto.plans.length > 0 || legacyCrypto.warnings.length > 0;
}

export function hasActionableMatrixMigration(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const env = params.env ?? process.env;
  const legacyState = detectLegacyMatrixState({ cfg: params.cfg, env });
  if (legacyState && !("warning" in legacyState)) {
    return true;
  }
  const legacyCrypto = detectLegacyMatrixCrypto({ cfg: params.cfg, env });
  return legacyCrypto.plans.length > 0 && isMatrixLegacyCryptoInspectorAvailable();
}

export {
  maybeCreateMatrixMigrationSnapshot,
  resolveMatrixMigrationSnapshotMarkerPath,
  resolveMatrixMigrationSnapshotOutputDir,
};
export type { MatrixMigrationSnapshotResult };
