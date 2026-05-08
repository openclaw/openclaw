import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ChannelLegacyStateMigrationPlan } from "openclaw/plugin-sdk/channel-contract";
import {
  upsertPluginBlobMigrationEntry,
  upsertPluginStateMigrationEntry,
} from "openclaw/plugin-sdk/migration-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  isMatrixLegacyCryptoMigrationState,
  MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME,
  MATRIX_LEGACY_CRYPTO_MIGRATION_NAMESPACE,
  resolveMatrixLegacyCryptoMigrationStateKey,
} from "./legacy-crypto-migration-state.js";
import {
  MATRIX_SYNC_STORE_NAMESPACE,
  parsePersistedMatrixSyncStore,
  resolveMatrixSyncStoreKey,
} from "./matrix/client/file-sync-store.js";
import {
  MATRIX_STORAGE_META_NAMESPACE,
  normalizeStoredRootMetadata,
  resolveMatrixStorageMetaKey,
} from "./matrix/client/storage-meta-state.js";
import {
  MATRIX_IDB_SNAPSHOT_NAMESPACE,
  parseMatrixIdbSnapshotPayload,
  resolveMatrixIdbSnapshotKey,
} from "./matrix/sdk/idb-persistence.js";
import type { MatrixThreadBindingRecord } from "./matrix/thread-bindings-shared.js";

const MATRIX_PLUGIN_ID = "matrix";
const SYNC_STORE_FILENAME = "bot-storage.json";
const THREAD_BINDINGS_FILENAME = "thread-bindings.json";
const INBOUND_DEDUPE_FILENAME = "inbound-dedupe.json";
const STARTUP_VERIFICATION_FILENAME = "startup-verification.json";
const STORAGE_META_FILENAME = "storage-meta.json";
const IDB_SNAPSHOT_FILENAME = "crypto-idb-snapshot.json";
const INBOUND_DEDUPE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type ImportResult = {
  imported: number;
  warnings: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
}

function removeEmptyDir(dir: string): void {
  try {
    fs.rmdirSync(dir);
  } catch {
    // Best effort: migration correctness is the imported row + removed source file.
  }
}

function collectFiles(root: string, filename: string): string[] {
  const matches: string[] = [];
  function visit(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name === filename) {
        matches.push(entryPath);
      }
    }
  }
  visit(root);
  return matches.toSorted();
}

function readAccountIdForLegacyFile(filePath: string): string {
  const metaPath = path.join(path.dirname(filePath), STORAGE_META_FILENAME);
  try {
    const meta = readJsonFile(metaPath);
    if (isRecord(meta) && typeof meta.accountId === "string" && meta.accountId.trim()) {
      return meta.accountId.trim();
    }
  } catch {
    // Fall back to the account-scoped path shape below.
  }
  const parts = filePath.split(path.sep);
  const accountsIndex = parts.lastIndexOf("accounts");
  const accountFromPath = accountsIndex >= 0 ? parts[accountsIndex + 1] : undefined;
  return accountFromPath?.trim() || "default";
}

function buildThreadBindingStoreKey(record: {
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
}): string {
  const digest = createHash("sha256")
    .update(record.accountId)
    .update("\0")
    .update(record.parentConversationId ?? "")
    .update("\0")
    .update(record.conversationId)
    .digest("hex");
  return `${record.accountId}:${digest}`;
}

function buildInboundDedupeStoreKey(params: {
  accountId: string;
  roomId: string;
  eventId: string;
}): string {
  const digest = createHash("sha256")
    .update(params.accountId)
    .update("\0")
    .update(params.roomId)
    .update("\0")
    .update(params.eventId)
    .digest("hex");
  return `${params.accountId}:${digest}`;
}

function parseThreadBinding(accountId: string, raw: unknown): MatrixThreadBindingRecord | null {
  if (!isRecord(raw)) {
    return null;
  }
  const conversationId = normalizeOptionalString(raw.conversationId);
  const parentConversationId = normalizeOptionalString(raw.parentConversationId);
  const targetSessionKey = normalizeOptionalString(raw.targetSessionKey) ?? "";
  if (!conversationId || !targetSessionKey) {
    return null;
  }
  const boundAt =
    typeof raw.boundAt === "number" && Number.isFinite(raw.boundAt)
      ? Math.floor(raw.boundAt)
      : Date.now();
  const lastActivityAt =
    typeof raw.lastActivityAt === "number" && Number.isFinite(raw.lastActivityAt)
      ? Math.floor(raw.lastActivityAt)
      : boundAt;
  return {
    accountId,
    conversationId,
    ...(parentConversationId ? { parentConversationId } : {}),
    targetKind: raw.targetKind === "subagent" ? "subagent" : "acp",
    targetSessionKey,
    agentId: normalizeOptionalString(raw.agentId) || undefined,
    label: normalizeOptionalString(raw.label) || undefined,
    boundBy: normalizeOptionalString(raw.boundBy) || undefined,
    boundAt,
    lastActivityAt: Math.max(lastActivityAt, boundAt),
    idleTimeoutMs:
      typeof raw.idleTimeoutMs === "number" && Number.isFinite(raw.idleTimeoutMs)
        ? Math.max(0, Math.floor(raw.idleTimeoutMs))
        : undefined,
    maxAgeMs:
      typeof raw.maxAgeMs === "number" && Number.isFinite(raw.maxAgeMs)
        ? Math.max(0, Math.floor(raw.maxAgeMs))
        : undefined,
  };
}

function importThreadBindingFiles(root: string, env: NodeJS.ProcessEnv): ImportResult {
  let imported = 0;
  const warnings: string[] = [];
  for (const filePath of collectFiles(root, THREAD_BINDINGS_FILENAME)) {
    const raw = readJsonFile(filePath);
    if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.bindings)) {
      warnings.push(`Skipped invalid Matrix thread binding file: ${filePath}`);
      continue;
    }
    const accountId = readAccountIdForLegacyFile(filePath);
    for (const entry of raw.bindings) {
      const parsed = parseThreadBinding(accountId, entry);
      if (!parsed) {
        warnings.push(`Skipped invalid Matrix thread binding entry in: ${filePath}`);
        continue;
      }
      upsertPluginStateMigrationEntry({
        pluginId: MATRIX_PLUGIN_ID,
        namespace: "thread-bindings",
        key: buildThreadBindingStoreKey(parsed),
        value: parsed,
        createdAt: parsed.lastActivityAt,
        env,
      });
      imported++;
    }
    fs.rmSync(filePath, { force: true });
    removeEmptyDir(path.dirname(filePath));
  }
  return { imported, warnings };
}

function importSyncStoreFiles(root: string, env: NodeJS.ProcessEnv): ImportResult {
  let imported = 0;
  const warnings: string[] = [];
  for (const filePath of collectFiles(root, SYNC_STORE_FILENAME)) {
    const parsed = parsePersistedMatrixSyncStore(fs.readFileSync(filePath, "utf8"));
    if (!parsed) {
      warnings.push(`Skipped invalid Matrix sync store file: ${filePath}`);
      continue;
    }
    upsertPluginStateMigrationEntry({
      pluginId: MATRIX_PLUGIN_ID,
      namespace: MATRIX_SYNC_STORE_NAMESPACE,
      key: resolveMatrixSyncStoreKey(filePath),
      value: parsed,
      createdAt: fs.statSync(filePath).mtimeMs || Date.now(),
      env,
    });
    imported++;
    fs.rmSync(filePath, { force: true });
    removeEmptyDir(path.dirname(filePath));
  }
  return { imported, warnings };
}

function splitLegacyInboundDedupeKey(key: string): { roomId: string; eventId: string } | null {
  const separator = key.indexOf("|");
  if (separator <= 0 || separator === key.length - 1) {
    return null;
  }
  return {
    roomId: key.slice(0, separator).trim(),
    eventId: key.slice(separator + 1).trim(),
  };
}

function importInboundDedupeFiles(root: string, env: NodeJS.ProcessEnv): ImportResult {
  let imported = 0;
  const warnings: string[] = [];
  for (const filePath of collectFiles(root, INBOUND_DEDUPE_FILENAME)) {
    const raw = readJsonFile(filePath);
    if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.entries)) {
      warnings.push(`Skipped invalid Matrix inbound dedupe file: ${filePath}`);
      continue;
    }
    const accountId = readAccountIdForLegacyFile(filePath);
    for (const entry of raw.entries) {
      if (!isRecord(entry) || typeof entry.key !== "string") {
        warnings.push(`Skipped invalid Matrix inbound dedupe entry in: ${filePath}`);
        continue;
      }
      const event = splitLegacyInboundDedupeKey(entry.key.trim());
      const ts =
        typeof entry.ts === "number" && Number.isFinite(entry.ts) ? Math.floor(entry.ts) : null;
      if (!event || ts === null) {
        warnings.push(`Skipped invalid Matrix inbound dedupe entry in: ${filePath}`);
        continue;
      }
      upsertPluginStateMigrationEntry({
        pluginId: MATRIX_PLUGIN_ID,
        namespace: "inbound-dedupe",
        key: buildInboundDedupeStoreKey({
          accountId,
          roomId: event.roomId,
          eventId: event.eventId,
        }),
        value: {
          roomId: event.roomId,
          eventId: event.eventId,
          ts,
        },
        createdAt: ts,
        expiresAt: ts + INBOUND_DEDUPE_TTL_MS,
        env,
      });
      imported++;
    }
    fs.rmSync(filePath, { force: true });
    removeEmptyDir(path.dirname(filePath));
  }
  return { imported, warnings };
}

function importStartupVerificationFiles(root: string, env: NodeJS.ProcessEnv): ImportResult {
  let imported = 0;
  const warnings: string[] = [];
  for (const filePath of collectFiles(root, STARTUP_VERIFICATION_FILENAME)) {
    const raw = readJsonFile(filePath);
    if (!isRecord(raw)) {
      warnings.push(`Skipped invalid Matrix startup verification file: ${filePath}`);
      continue;
    }
    const accountId = readAccountIdForLegacyFile(filePath);
    const attemptedAt =
      typeof raw.attemptedAt === "string" && raw.attemptedAt.trim()
        ? raw.attemptedAt.trim()
        : new Date().toISOString();
    upsertPluginStateMigrationEntry({
      pluginId: MATRIX_PLUGIN_ID,
      namespace: "startup-verification",
      key: accountId,
      value: {
        userId: typeof raw.userId === "string" ? raw.userId : null,
        deviceId: typeof raw.deviceId === "string" ? raw.deviceId : null,
        attemptedAt,
        outcome: raw.outcome === "failed" ? "failed" : "requested",
        requestId: typeof raw.requestId === "string" ? raw.requestId : undefined,
        transactionId: typeof raw.transactionId === "string" ? raw.transactionId : undefined,
        error: typeof raw.error === "string" ? raw.error : undefined,
      },
      createdAt: Date.parse(attemptedAt) || Date.now(),
      env,
    });
    imported++;
    fs.rmSync(filePath, { force: true });
    removeEmptyDir(path.dirname(filePath));
  }
  return { imported, warnings };
}

function importStorageMetaFiles(root: string, env: NodeJS.ProcessEnv): ImportResult {
  let imported = 0;
  const warnings: string[] = [];
  for (const filePath of collectFiles(root, STORAGE_META_FILENAME)) {
    const metadata = normalizeStoredRootMetadata(readJsonFile(filePath));
    if (Object.keys(metadata).length === 0) {
      warnings.push(`Skipped invalid Matrix storage metadata file: ${filePath}`);
      continue;
    }
    const rootDir = path.dirname(filePath);
    metadata.rootDir = path.resolve(rootDir);
    upsertPluginStateMigrationEntry({
      pluginId: MATRIX_PLUGIN_ID,
      namespace: MATRIX_STORAGE_META_NAMESPACE,
      key: resolveMatrixStorageMetaKey(rootDir),
      value: metadata,
      createdAt:
        Date.parse(metadata.createdAt ?? "") || fs.statSync(filePath).mtimeMs || Date.now(),
      env,
    });
    imported++;
    fs.rmSync(filePath, { force: true });
    removeEmptyDir(rootDir);
  }
  return { imported, warnings };
}

function importLegacyCryptoMigrationFiles(root: string, env: NodeJS.ProcessEnv): ImportResult {
  let imported = 0;
  const warnings: string[] = [];
  for (const filePath of collectFiles(root, MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME)) {
    const raw = readJsonFile(filePath);
    if (!isMatrixLegacyCryptoMigrationState(raw)) {
      warnings.push(`Skipped invalid Matrix legacy crypto migration state file: ${filePath}`);
      continue;
    }
    const detectedAt =
      typeof raw.detectedAt === "string" && raw.detectedAt.trim() ? raw.detectedAt.trim() : "";
    upsertPluginStateMigrationEntry({
      pluginId: MATRIX_PLUGIN_ID,
      namespace: MATRIX_LEGACY_CRYPTO_MIGRATION_NAMESPACE,
      key: resolveMatrixLegacyCryptoMigrationStateKey(filePath),
      value: raw,
      createdAt: Date.parse(detectedAt) || fs.statSync(filePath).mtimeMs || Date.now(),
      env,
    });
    imported++;
    fs.rmSync(filePath, { force: true });
    removeEmptyDir(path.dirname(filePath));
  }
  return { imported, warnings };
}

function importIdbSnapshotFiles(root: string, env: NodeJS.ProcessEnv): ImportResult {
  let imported = 0;
  const warnings: string[] = [];
  for (const filePath of collectFiles(root, IDB_SNAPSHOT_FILENAME)) {
    const data = fs.readFileSync(filePath, "utf8");
    try {
      const parsed = parseMatrixIdbSnapshotPayload(data);
      if (!parsed) {
        warnings.push(`Skipped empty Matrix IndexedDB snapshot file: ${filePath}`);
        continue;
      }
    } catch {
      warnings.push(`Skipped invalid Matrix IndexedDB snapshot file: ${filePath}`);
      continue;
    }
    upsertPluginBlobMigrationEntry({
      pluginId: MATRIX_PLUGIN_ID,
      namespace: MATRIX_IDB_SNAPSHOT_NAMESPACE,
      key: resolveMatrixIdbSnapshotKey(filePath),
      metadata: {
        version: 1,
        snapshotPath: path.resolve(filePath),
        importedAt: new Date().toISOString(),
      },
      blob: Buffer.from(data),
      createdAt: fs.statSync(filePath).mtimeMs || Date.now(),
      env,
    });
    imported++;
    fs.rmSync(filePath, { force: true });
    removeEmptyDir(path.dirname(filePath));
  }
  return { imported, warnings };
}

function pluginStatePlan(params: {
  label: string;
  sourcePath: string;
  namespace:
    | typeof MATRIX_SYNC_STORE_NAMESPACE
    | typeof MATRIX_STORAGE_META_NAMESPACE
    | typeof MATRIX_LEGACY_CRYPTO_MIGRATION_NAMESPACE
    | "thread-bindings"
    | "inbound-dedupe"
    | "startup-verification";
  importSource: (sourcePath: string, env: NodeJS.ProcessEnv) => ImportResult;
}): ChannelLegacyStateMigrationPlan {
  return {
    kind: "custom",
    label: params.label,
    sourcePath: params.sourcePath,
    targetTable: `plugin_state_entries:${MATRIX_PLUGIN_ID}/${params.namespace}`,
    apply: ({ env }) => {
      const result = params.importSource(params.sourcePath, env);
      return {
        changes: [
          `Imported ${result.imported} ${params.label} row(s) into SQLite plugin state (${MATRIX_PLUGIN_ID}/${params.namespace})`,
        ],
        warnings: result.warnings,
      };
    },
  };
}

function pluginBlobPlan(params: {
  label: string;
  sourcePath: string;
  namespace: typeof MATRIX_IDB_SNAPSHOT_NAMESPACE;
  importSource: (sourcePath: string, env: NodeJS.ProcessEnv) => ImportResult;
}): ChannelLegacyStateMigrationPlan {
  return {
    kind: "custom",
    label: params.label,
    sourcePath: params.sourcePath,
    targetTable: `plugin_blob_entries:${MATRIX_PLUGIN_ID}/${params.namespace}`,
    apply: ({ env }) => {
      const result = params.importSource(params.sourcePath, env);
      return {
        changes: [
          `Imported ${result.imported} ${params.label} row(s) into SQLite plugin blobs (${MATRIX_PLUGIN_ID}/${params.namespace})`,
        ],
        warnings: result.warnings,
      };
    },
  };
}

export function detectMatrixLegacyStateMigrations(params: {
  stateDir: string;
}): ChannelLegacyStateMigrationPlan[] {
  const root = path.join(params.stateDir, "matrix");
  const plans: ChannelLegacyStateMigrationPlan[] = [];
  if (collectFiles(root, SYNC_STORE_FILENAME).length > 0) {
    plans.push(
      pluginStatePlan({
        label: "Matrix sync store",
        sourcePath: root,
        namespace: MATRIX_SYNC_STORE_NAMESPACE,
        importSource: importSyncStoreFiles,
      }),
    );
  }
  if (collectFiles(root, THREAD_BINDINGS_FILENAME).length > 0) {
    plans.push(
      pluginStatePlan({
        label: "Matrix thread binding",
        sourcePath: root,
        namespace: "thread-bindings",
        importSource: importThreadBindingFiles,
      }),
    );
  }
  if (collectFiles(root, INBOUND_DEDUPE_FILENAME).length > 0) {
    plans.push(
      pluginStatePlan({
        label: "Matrix inbound dedupe",
        sourcePath: root,
        namespace: "inbound-dedupe",
        importSource: importInboundDedupeFiles,
      }),
    );
  }
  if (collectFiles(root, STARTUP_VERIFICATION_FILENAME).length > 0) {
    plans.push(
      pluginStatePlan({
        label: "Matrix startup verification",
        sourcePath: root,
        namespace: "startup-verification",
        importSource: importStartupVerificationFiles,
      }),
    );
  }
  if (collectFiles(root, STORAGE_META_FILENAME).length > 0) {
    plans.push(
      pluginStatePlan({
        label: "Matrix storage metadata",
        sourcePath: root,
        namespace: MATRIX_STORAGE_META_NAMESPACE,
        importSource: importStorageMetaFiles,
      }),
    );
  }
  if (collectFiles(root, MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME).length > 0) {
    plans.push(
      pluginStatePlan({
        label: "Matrix legacy crypto migration state",
        sourcePath: root,
        namespace: MATRIX_LEGACY_CRYPTO_MIGRATION_NAMESPACE,
        importSource: importLegacyCryptoMigrationFiles,
      }),
    );
  }
  if (collectFiles(root, IDB_SNAPSHOT_FILENAME).length > 0) {
    plans.push(
      pluginBlobPlan({
        label: "Matrix IndexedDB snapshot",
        sourcePath: root,
        namespace: MATRIX_IDB_SNAPSHOT_NAMESPACE,
        importSource: importIdbSnapshotFiles,
      }),
    );
  }
  return plans;
}
