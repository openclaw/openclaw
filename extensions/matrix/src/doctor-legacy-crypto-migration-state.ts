import { createHash } from "node:crypto";
import path from "node:path";
import { createPluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

export const MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME = "legacy-crypto-migration.json";
export const MATRIX_LEGACY_CRYPTO_MIGRATION_NAMESPACE = "legacy-crypto-migration";
export const MATRIX_LEGACY_CRYPTO_MIGRATION_MAX_ENTRIES = 512;

export type MatrixLegacyCryptoCounts = {
  total: number;
  backedUp: number;
};

export type MatrixLegacyCryptoMigrationState = {
  version: 1;
  source?: "matrix-bot-sdk-rust";
  accountId: string;
  deviceId?: string | null;
  roomKeyCounts: MatrixLegacyCryptoCounts | null;
  backupVersion?: string | null;
  decryptionKeyImported?: boolean;
  restoreStatus: "pending" | "completed" | "manual-action-required";
  detectedAt?: string;
  restoredAt?: string;
  importedCount?: number;
  totalCount?: number;
  lastError?: string | null;
};

const STORE = createPluginStateKeyedStore<MatrixLegacyCryptoMigrationState>("matrix", {
  namespace: MATRIX_LEGACY_CRYPTO_MIGRATION_NAMESPACE,
  maxEntries: MATRIX_LEGACY_CRYPTO_MIGRATION_MAX_ENTRIES,
});

export function isMatrixLegacyCryptoMigrationState(
  value: unknown,
): value is MatrixLegacyCryptoMigrationState {
  return (
    Boolean(value) && typeof value === "object" && (value as { version?: unknown }).version === 1
  );
}

export function resolveMatrixLegacyCryptoMigrationStateKey(statePath: string): string {
  return createHash("sha256").update(path.resolve(statePath), "utf8").digest("hex");
}

export async function readMatrixLegacyCryptoMigrationState(
  statePath: string,
): Promise<MatrixLegacyCryptoMigrationState | null> {
  const value = await STORE.lookup(resolveMatrixLegacyCryptoMigrationStateKey(statePath));
  return isMatrixLegacyCryptoMigrationState(value) ? value : null;
}

export async function writeMatrixLegacyCryptoMigrationState(
  statePath: string,
  state: MatrixLegacyCryptoMigrationState,
): Promise<void> {
  await STORE.register(resolveMatrixLegacyCryptoMigrationStateKey(statePath), state);
}

export async function writeMatrixLegacyCryptoMigrationStateByKey(
  key: string,
  state: MatrixLegacyCryptoMigrationState,
): Promise<void> {
  await STORE.register(key, state);
}

export async function findPendingMatrixLegacyCryptoMigrationState(
  accountId: string | undefined,
): Promise<{ key: string; value: MatrixLegacyCryptoMigrationState } | null> {
  const normalizedAccountId = accountId?.trim();
  if (!normalizedAccountId) {
    return null;
  }
  for (const entry of await STORE.entries()) {
    if (
      isMatrixLegacyCryptoMigrationState(entry.value) &&
      entry.value.accountId === normalizedAccountId &&
      entry.value.restoreStatus === "pending"
    ) {
      return { key: entry.key, value: entry.value };
    }
  }
  return null;
}
