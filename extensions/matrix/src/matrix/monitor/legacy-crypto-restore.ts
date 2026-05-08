import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  findPendingMatrixLegacyCryptoMigrationState,
  isMatrixLegacyCryptoMigrationState,
  MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME,
  readMatrixLegacyCryptoMigrationState,
  resolveMatrixLegacyCryptoMigrationStateKey,
  writeMatrixLegacyCryptoMigrationStateByKey,
  type MatrixLegacyCryptoMigrationState,
} from "../../legacy-crypto-migration-state.js";
import { getMatrixRuntime } from "../../runtime.js";
import { resolveMatrixStoragePaths } from "../client/storage.js";
import type { MatrixAuth } from "../client/types.js";
import type { MatrixClient } from "../sdk.js";

export type MatrixLegacyCryptoRestoreResult =
  | { kind: "skipped" }
  | {
      kind: "restored";
      imported: number;
      total: number;
      localOnlyKeys: number;
    }
  | {
      kind: "failed";
      error: string;
      localOnlyKeys: number;
    };

async function resolvePendingMigrationStatePath(params: {
  stateDir: string;
  auth: Pick<MatrixAuth, "homeserver" | "userId" | "accessToken" | "accountId" | "deviceId">;
}): Promise<{
  statePath: string;
  stateKey: string;
  value: MatrixLegacyCryptoMigrationState | null;
}> {
  const { rootDir } = resolveMatrixStoragePaths({
    homeserver: params.auth.homeserver,
    userId: params.auth.userId,
    accessToken: params.auth.accessToken,
    accountId: params.auth.accountId,
    deviceId: params.auth.deviceId,
    stateDir: params.stateDir,
  });
  const directStatePath = path.join(rootDir, MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME);
  const directStateKey = resolveMatrixLegacyCryptoMigrationStateKey(directStatePath);
  const directValue = await readMatrixLegacyCryptoMigrationState(directStatePath);
  if (isMatrixLegacyCryptoMigrationState(directValue) && directValue.restoreStatus === "pending") {
    return { statePath: directStatePath, stateKey: directStateKey, value: directValue };
  }

  const accountStorageDir = path.dirname(rootDir);
  let siblingEntries: string[] = [];
  try {
    siblingEntries = (await fs.readdir(accountStorageDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((entry) => path.join(accountStorageDir, entry) !== rootDir)
      .toSorted((left, right) => left.localeCompare(right));
  } catch {
    siblingEntries = [];
  }

  for (const sibling of siblingEntries) {
    const siblingStatePath = path.join(
      accountStorageDir,
      sibling,
      MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME,
    );
    const value = await readMatrixLegacyCryptoMigrationState(siblingStatePath);
    if (isMatrixLegacyCryptoMigrationState(value) && value.restoreStatus === "pending") {
      return {
        statePath: siblingStatePath,
        stateKey: resolveMatrixLegacyCryptoMigrationStateKey(siblingStatePath),
        value,
      };
    }
  }
  const accountPending = await findPendingMatrixLegacyCryptoMigrationState(params.auth.accountId);
  if (accountPending) {
    return {
      statePath: directStatePath,
      stateKey: accountPending.key,
      value: accountPending.value,
    };
  }
  return { statePath: directStatePath, stateKey: directStateKey, value: directValue };
}

export async function maybeRestoreLegacyMatrixBackup(params: {
  client: Pick<MatrixClient, "restoreRoomKeyBackup">;
  auth: Pick<MatrixAuth, "homeserver" | "userId" | "accessToken" | "accountId" | "deviceId">;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}): Promise<MatrixLegacyCryptoRestoreResult> {
  const env = params.env ?? process.env;
  const stateDir = params.stateDir ?? getMatrixRuntime().state.resolveStateDir(env, os.homedir);
  const { stateKey, value } = await resolvePendingMigrationStatePath({
    stateDir,
    auth: params.auth,
  });
  if (!isMatrixLegacyCryptoMigrationState(value) || value.restoreStatus !== "pending") {
    return { kind: "skipped" };
  }

  const restore = await params.client.restoreRoomKeyBackup();
  const localOnlyKeys =
    value.roomKeyCounts && value.roomKeyCounts.total > value.roomKeyCounts.backedUp
      ? value.roomKeyCounts.total - value.roomKeyCounts.backedUp
      : 0;

  if (restore.success) {
    await writeMatrixLegacyCryptoMigrationStateByKey(stateKey, {
      ...value,
      restoreStatus: "completed",
      restoredAt: restore.restoredAt ?? new Date().toISOString(),
      importedCount: restore.imported,
      totalCount: restore.total,
      lastError: null,
    } satisfies MatrixLegacyCryptoMigrationState);
    return {
      kind: "restored",
      imported: restore.imported,
      total: restore.total,
      localOnlyKeys,
    };
  }

  await writeMatrixLegacyCryptoMigrationStateByKey(stateKey, {
    ...value,
    lastError: restore.error ?? "unknown",
  } satisfies MatrixLegacyCryptoMigrationState);
  return {
    kind: "failed",
    error: restore.error ?? "unknown",
    localOnlyKeys,
  };
}
