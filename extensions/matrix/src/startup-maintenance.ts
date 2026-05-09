import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolveMatrixMigrationStatus,
  type MatrixMigrationStatus,
} from "./matrix-migration.runtime.js";

type MatrixStartupLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

function logWarningOnlyMatrixMigrationReasons(params: {
  status: MatrixMigrationStatus;
  log: MatrixStartupLogger;
}): void {
  if (params.status.legacyState && "warning" in params.status.legacyState) {
    params.log.warn?.(`matrix: ${params.status.legacyState.warning}`);
  }

  if (params.status.legacyCrypto.warnings.length > 0) {
    params.log.warn?.(
      `matrix: legacy encrypted-state warnings:\n${params.status.legacyCrypto.warnings.map((entry) => `- ${entry}`).join("\n")}`,
    );
  }
}

export async function runMatrixStartupMaintenance(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  log: MatrixStartupLogger;
  trigger?: string;
  logPrefix?: string;
}): Promise<void> {
  const env = params.env ?? process.env;
  const logPrefix = params.logPrefix?.trim() || "gateway";
  const migrationStatus = resolveMatrixMigrationStatus({ cfg: params.cfg, env });

  if (!migrationStatus.pending) {
    return;
  }
  if (!migrationStatus.actionable) {
    params.log.info?.(
      "matrix: migration remains in a warning-only state; no pre-migration snapshot was needed yet",
    );
    logWarningOnlyMatrixMigrationReasons({ status: migrationStatus, log: params.log });
    return;
  }

  params.log.warn?.(
    `${logPrefix}: legacy Matrix state needs migration. Run "openclaw doctor --fix" to create a migration snapshot and move legacy files; startup will not mutate legacy state.`,
  );
  logWarningOnlyMatrixMigrationReasons({ status: migrationStatus, log: params.log });
}
