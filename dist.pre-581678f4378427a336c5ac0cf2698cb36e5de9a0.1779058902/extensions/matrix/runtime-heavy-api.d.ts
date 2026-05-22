import { i as OpenClawConfig } from "../../types.openclaw-BMMD0Ykw.js";
import { t as createBackupArchive } from "../../runtime-KejdFF1C.js";
import { i as writeJsonFileAtomically } from "../../json-store-CWpPCSWT.js";

//#region extensions/matrix/src/legacy-state.d.ts
type MatrixLegacyStateMigrationResult = {
  migrated: boolean;
  changes: string[];
  warnings: string[];
};
type MatrixLegacyStatePlan = {
  accountId: string;
  legacyStoragePath: string;
  legacyCryptoPath: string;
  targetRootDir: string;
  targetStoragePath: string;
  targetCryptoPath: string;
  selectionNote?: string;
};
declare function detectLegacyMatrixState(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): MatrixLegacyStatePlan | {
  warning: string;
} | null;
declare function autoMigrateLegacyMatrixState(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  log?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
  };
}): Promise<MatrixLegacyStateMigrationResult>;
//#endregion
//#region extensions/matrix/src/legacy-crypto.d.ts
type MatrixLegacyCryptoPlan = {
  accountId: string;
  rootDir: string;
  recoveryKeyPath: string;
  statePath: string;
  legacyCryptoPath: string;
  homeserver: string;
  userId: string;
  accessToken: string;
  deviceId: string | null;
};
type MatrixLegacyCryptoDetection = {
  inspectorAvailable: boolean;
  plans: MatrixLegacyCryptoPlan[];
  warnings: string[];
};
type MatrixLegacyCryptoPreparationResult = {
  migrated: boolean;
  changes: string[];
  warnings: string[];
};
type MatrixLegacyCryptoPrepareDeps = {
  inspectLegacyStore: MatrixLegacyCryptoInspector;
  writeJsonFileAtomically: typeof writeJsonFileAtomically;
};
type MatrixLegacyCryptoInspectorParams = {
  cryptoRootDir: string;
  userId: string;
  deviceId: string;
  log?: (message: string) => void;
};
type MatrixLegacyCryptoInspectorResult = {
  deviceId: string | null;
  roomKeyCounts: {
    total: number;
    backedUp: number;
  } | null;
  backupVersion: string | null;
  decryptionKeyBase64: string | null;
};
type MatrixLegacyCryptoInspector = (params: MatrixLegacyCryptoInspectorParams) => Promise<MatrixLegacyCryptoInspectorResult>;
declare function detectLegacyMatrixCrypto(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): MatrixLegacyCryptoDetection;
declare function autoPrepareLegacyMatrixCrypto(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  log?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
  };
  deps?: Partial<MatrixLegacyCryptoPrepareDeps>;
}): Promise<MatrixLegacyCryptoPreparationResult>;
//#endregion
//#region extensions/matrix/src/migration-snapshot-backup.d.ts
type MatrixMigrationSnapshotResult = {
  created: boolean;
  archivePath: string;
  markerPath: string;
};
declare function maybeCreateMatrixMigrationSnapshot(params: {
  trigger: string;
  env?: NodeJS.ProcessEnv;
  outputDir?: string;
  createBackupArchive?: typeof createBackupArchive;
  log?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
  };
}): Promise<MatrixMigrationSnapshotResult>;
//#endregion
//#region extensions/matrix/src/migration-snapshot.d.ts
type MatrixMigrationStatus = {
  legacyState: ReturnType<typeof detectLegacyMatrixState>;
  legacyCrypto: ReturnType<typeof detectLegacyMatrixCrypto>;
  pending: boolean;
  actionable: boolean;
};
declare function resolveMatrixMigrationStatus(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): MatrixMigrationStatus;
declare function hasPendingMatrixMigration(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean;
declare function hasActionableMatrixMigration(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean;
//#endregion
export { type MatrixMigrationStatus, autoMigrateLegacyMatrixState, autoPrepareLegacyMatrixCrypto, detectLegacyMatrixCrypto, detectLegacyMatrixState, hasActionableMatrixMigration, hasPendingMatrixMigration, maybeCreateMatrixMigrationSnapshot, resolveMatrixMigrationStatus };