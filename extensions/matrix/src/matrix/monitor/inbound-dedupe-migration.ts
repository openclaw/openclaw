// One-time doctor migration for pre-claimable-dedupe inbound replay markers.
// Losing them would re-dispatch already-handled events on the first stale
// /sync or decrypt replay after upgrade, so doctor imports both shipped
// sources into the core claimable-dedupe namespaces and retires them:
// - >=2026.6 tags persisted rows in each account storage root's SQLite DB
//   (namespace `inbound-dedupe`, key `<accountId>:<sha256>`, value
//   `{roomId, eventId, ts}`), plus `inbound-dedupe-migrations` import markers.
// - <=2026.5 tags wrote `inbound-dedupe.json` beside the account sync store;
//   the retired runtime importer read it lazily, so upgrades that skip the
//   SQLite era can still carry the raw file.
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createPersistentDedupeImportEntry,
  type PersistentDedupeEntry,
} from "openclaw/plugin-sdk/persistent-dedupe";
import type {
  PluginDoctorStateMigration,
  PluginDoctorStateMigrationContext,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/runtime-doctor";
import { isRecord } from "../../record-shared.js";
import { normalizeMatrixStorageMetadata } from "../client/storage.js";
import {
  buildMatrixInboundDedupeEventKey,
  MATRIX_INBOUND_DEDUPE_STATE_MAX_ENTRIES,
  MATRIX_INBOUND_DEDUPE_TTL_MS,
  resolveMatrixInboundDedupeStateNamespace,
} from "./inbound-dedupe.js";

const LEGACY_SQLITE_NAMESPACE = "inbound-dedupe";
const LEGACY_SQLITE_MAX_ENTRIES = 20_000;
const LEGACY_MARKERS_NAMESPACE = "inbound-dedupe-migrations";
const LEGACY_MARKERS_MAX_ENTRIES = 1_000;
const LEGACY_JSON_FILENAME = "inbound-dedupe.json";
const LEGACY_JSON_VERSION = 1;
const STORAGE_META_FILENAME = "storage-meta.json";

type LegacyInboundDedupeMarker = {
  accountId: string;
  roomId: string;
  eventId: string;
  ts: number;
};

type MigrationIo = {
  context: PluginDoctorStateMigrationContext;
  env: NodeJS.ProcessEnv;
};

async function collectMatrixInboundDedupeSources(stateDir: string): Promise<{
  sqliteRoots: string[];
  jsonRoots: string[];
}> {
  const matrixRoot = path.join(stateDir, "matrix");
  const sqliteRoots = new Set<string>();
  const jsonRoots = new Set<string>();
  async function visit(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isFile()) {
        // Legacy per-root dedupe rows live in `<storageRoot>/state/openclaw.sqlite`.
        if (entry.name === "openclaw.sqlite" && path.basename(dir) === "state") {
          sqliteRoots.add(path.dirname(dir));
        } else if (entry.name === LEGACY_JSON_FILENAME) {
          jsonRoots.add(dir);
        }
        continue;
      }
      if (entry.isDirectory()) {
        await visit(entryPath);
      }
    }
  }
  await visit(matrixRoot);
  const matrixRootResolved = path.resolve(matrixRoot);
  const isAccountRoot = (root: string) => path.resolve(root) !== matrixRootResolved;
  return {
    sqliteRoots: [...sqliteRoots].filter(isAccountRoot).toSorted(),
    jsonRoots: [...jsonRoots].filter(isAccountRoot).toSorted(),
  };
}

function openLegacySqliteStore(io: MigrationIo, storageRootDir: string) {
  return io.context.openPluginStateKeyedStore<unknown>({
    namespace: LEGACY_SQLITE_NAMESPACE,
    maxEntries: LEGACY_SQLITE_MAX_ENTRIES,
    env: { ...io.env, OPENCLAW_STATE_DIR: storageRootDir },
  });
}

function openLegacyMarkersStore(io: MigrationIo, storageRootDir: string) {
  return io.context.openPluginStateKeyedStore<unknown>({
    namespace: LEGACY_MARKERS_NAMESPACE,
    maxEntries: LEGACY_MARKERS_MAX_ENTRIES,
    env: { ...io.env, OPENCLAW_STATE_DIR: storageRootDir },
  });
}

function normalizeLegacyTimestamp(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return null;
  }
  return Math.max(0, Math.floor(raw));
}

function parseLegacySqliteRow(row: {
  key: string;
  value: unknown;
}): LegacyInboundDedupeMarker | null {
  const value = isRecord(row.value) ? row.value : {};
  const roomId = typeof value.roomId === "string" ? value.roomId.trim() : "";
  const eventId = typeof value.eventId === "string" ? value.eventId.trim() : "";
  const ts = normalizeLegacyTimestamp(value.ts);
  const separator = row.key.lastIndexOf(":");
  if (!roomId || !eventId || ts === null || separator <= 0) {
    return null;
  }
  const accountId = row.key.slice(0, separator);
  // Legacy keys embed sha256(accountId\0roomId\0eventId); recomputing it
  // validates the account-prefix parse and drops corrupt rows, mirroring the
  // retired runtime loader's expected-key check.
  const digest = createHash("sha256")
    .update(accountId)
    .update("\0")
    .update(roomId)
    .update("\0")
    .update(eventId)
    .digest("hex");
  if (row.key.slice(separator + 1) !== digest) {
    return null;
  }
  return { accountId, roomId, eventId, ts };
}

async function readLegacyJsonMarkers(params: {
  jsonPath: string;
  accountId: string;
}): Promise<LegacyInboundDedupeMarker[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(params.jsonPath, "utf8")) as unknown;
  } catch {
    return [];
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== LEGACY_JSON_VERSION ||
    !Array.isArray(parsed.entries)
  ) {
    return [];
  }
  const markers: LegacyInboundDedupeMarker[] = [];
  for (const entry of parsed.entries) {
    if (!isRecord(entry) || typeof entry.key !== "string") {
      continue;
    }
    // Legacy JSON keys are `roomId|eventId`; event ids never contain "|".
    const separator = entry.key.indexOf("|");
    if (separator <= 0) {
      continue;
    }
    const roomId = entry.key.slice(0, separator).trim();
    const eventId = entry.key.slice(separator + 1).trim();
    const ts = normalizeLegacyTimestamp(entry.ts);
    if (!roomId || !eventId || ts === null) {
      continue;
    }
    markers.push({ accountId: params.accountId, roomId, eventId, ts });
  }
  return markers;
}

async function resolveJsonRootAccountId(storageRootDir: string): Promise<string> {
  // The JSON era predates the per-root SQLite stores, so account identity comes
  // from storage-meta.json (or its doctor-archived copy when the metadata
  // migration already ran). Pre-metadata roots belong to the legacy single
  // account, which used the literal "default" account id.
  for (const filename of [STORAGE_META_FILENAME, `${STORAGE_META_FILENAME}.migrated`]) {
    try {
      const metadata = normalizeMatrixStorageMetadata(
        JSON.parse(await fs.readFile(path.join(storageRootDir, filename), "utf8")) as unknown,
      );
      if (metadata?.accountId) {
        return metadata.accountId;
      }
    } catch {
      // Try the next metadata source.
    }
  }
  return "default";
}

async function importInboundDedupeMarkers(params: {
  io: MigrationIo;
  markers: readonly LegacyInboundDedupeMarker[];
  now: number;
  targetStores: Map<string, PluginStateKeyedStore<PersistentDedupeEntry>>;
}): Promise<number> {
  let imported = 0;
  for (const marker of params.markers) {
    const remainingTtlMs = MATRIX_INBOUND_DEDUPE_TTL_MS - (params.now - marker.ts);
    if (remainingTtlMs <= 0) {
      continue;
    }
    const key = buildMatrixInboundDedupeEventKey(marker);
    if (!key) {
      continue;
    }
    const namespace = resolveMatrixInboundDedupeStateNamespace(marker.accountId);
    let store = params.targetStores.get(namespace);
    if (!store) {
      // Options must match the runtime claimable-dedupe open exactly, or a
      // doctor+gateway process would trip the namespace signature guard.
      store = params.io.context.openPluginStateKeyedStore<PersistentDedupeEntry>({
        namespace,
        maxEntries: MATRIX_INBOUND_DEDUPE_STATE_MAX_ENTRIES,
        defaultTtlMs: MATRIX_INBOUND_DEDUPE_TTL_MS,
        env: params.io.env,
      });
      params.targetStores.set(namespace, store);
    }
    const entry = createPersistentDedupeImportEntry({
      key,
      seenAt: marker.ts,
      ttlMs: Math.max(1, Math.floor(remainingTtlMs)),
    });
    // Rows committed after the upgrade are newer than any legacy marker, so
    // registerIfAbsent keeps them and only fills the missing keys.
    const registered = await store.registerIfAbsent(
      entry.key,
      entry.value,
      entry.ttlMs != null ? { ttlMs: entry.ttlMs } : undefined,
    );
    if (registered) {
      imported += 1;
    }
  }
  return imported;
}

async function archiveLegacyJsonSource(params: {
  jsonPath: string;
  changes: string[];
  warnings: string[];
}): Promise<void> {
  const archivedPath = `${params.jsonPath}.migrated`;
  try {
    await fs.rename(params.jsonPath, archivedPath);
    params.changes.push(`Archived Matrix inbound dedupe legacy source -> ${archivedPath}`);
  } catch (err) {
    params.warnings.push(
      `Failed archiving Matrix inbound dedupe legacy source ${params.jsonPath}: ${String(err)}`,
    );
  }
}

export const matrixInboundDedupeStateMigration: PluginDoctorStateMigration = {
  id: "matrix-inbound-dedupe-to-claimable-dedupe",
  label: "Matrix inbound dedupe markers",
  async detectLegacyState(params) {
    const io: MigrationIo = { context: params.context, env: params.env };
    const preview: string[] = [];
    const sources = await collectMatrixInboundDedupeSources(params.stateDir);
    for (const storageRootDir of sources.sqliteRoots) {
      try {
        const rows = await openLegacySqliteStore(io, storageRootDir).entries();
        const markerRows = await openLegacyMarkersStore(io, storageRootDir).entries();
        if (rows.length + markerRows.length === 0) {
          continue;
        }
      } catch {
        continue;
      }
      preview.push(
        `Matrix inbound dedupe rows can migrate to the claimable dedupe store: ${storageRootDir}`,
      );
    }
    for (const storageRootDir of sources.jsonRoots) {
      preview.push(
        `Matrix inbound dedupe JSON can migrate to the claimable dedupe store: ${path.join(storageRootDir, LEGACY_JSON_FILENAME)}`,
      );
    }
    return preview.length > 0 ? { preview } : null;
  },
  async migrateLegacyState(params) {
    const io: MigrationIo = { context: params.context, env: params.env };
    const changes: string[] = [];
    const warnings: string[] = [];
    const now = Date.now();
    const targetStores = new Map<string, PluginStateKeyedStore<PersistentDedupeEntry>>();
    const sources = await collectMatrixInboundDedupeSources(params.stateDir);
    for (const storageRootDir of sources.sqliteRoots) {
      const legacyStore = openLegacySqliteStore(io, storageRootDir);
      const markersStore = openLegacyMarkersStore(io, storageRootDir);
      try {
        const rows = await legacyStore.entries();
        const markerRows = await markersStore.entries();
        if (rows.length + markerRows.length === 0) {
          continue;
        }
        const markers = rows
          .map((row) => parseLegacySqliteRow(row))
          .filter((marker): marker is LegacyInboundDedupeMarker => marker !== null);
        const imported = await importInboundDedupeMarkers({ io, markers, now, targetStores });
        // Retire the legacy namespaces only after the import succeeded so a
        // failed run keeps the source rows for the next doctor attempt.
        await legacyStore.clear();
        await markersStore.clear();
        changes.push(
          `Migrated Matrix inbound dedupe rows to the claimable dedupe store for ${storageRootDir} (${imported} of ${rows.length} entries)`,
        );
      } catch (err) {
        warnings.push(
          `Failed migrating Matrix inbound dedupe rows for ${storageRootDir}: ${String(err)}; left legacy rows in place`,
        );
      }
    }
    for (const storageRootDir of sources.jsonRoots) {
      const jsonPath = path.join(storageRootDir, LEGACY_JSON_FILENAME);
      try {
        const accountId = await resolveJsonRootAccountId(storageRootDir);
        const markers = await readLegacyJsonMarkers({ jsonPath, accountId });
        const imported = await importInboundDedupeMarkers({ io, markers, now, targetStores });
        changes.push(
          `Migrated Matrix inbound dedupe JSON to the claimable dedupe store for ${storageRootDir} (${imported} of ${markers.length} entries)`,
        );
        await archiveLegacyJsonSource({ jsonPath, changes, warnings });
      } catch (err) {
        warnings.push(
          `Failed migrating Matrix inbound dedupe JSON ${jsonPath}: ${String(err)}; left legacy file in place`,
        );
      }
    }
    return { changes, warnings };
  },
};
