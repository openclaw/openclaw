import path from "node:path";
import type { Insertable, Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { sqliteNullableNumber, sqliteNullableText } from "../../infra/sqlite-row-values.js";
import { asFiniteNumber } from "../../shared/number-coercion.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { SANDBOX_STATE_DIR } from "./constants.js";

export type SandboxRegistryEntry = {
  containerName: string;
  backendId?: string;
  runtimeLabel?: string;
  sessionKey: string;
  createdAtMs: number;
  lastUsedAtMs: number;
  image: string;
  configLabelKind?: string;
  configHash?: string;
};

type SandboxRegistry = {
  entries: SandboxRegistryEntry[];
};

export type SandboxBrowserRegistryEntry = {
  containerName: string;
  sessionKey: string;
  createdAtMs: number;
  lastUsedAtMs: number;
  image: string;
  configHash?: string;
  cdpPort: number;
  noVncPort?: number;
};

type SandboxBrowserRegistry = {
  entries: SandboxBrowserRegistryEntry[];
};

type RegistryEntryPayload = RegistryEntry & Record<string, unknown>;

type SandboxRegistryKind = "containers" | "browsers";

type RegistryEntry = SandboxRegistryEntry | SandboxBrowserRegistryEntry;

function normalizeSandboxRegistryEntry(entry: SandboxRegistryEntry): SandboxRegistryEntry {
  return {
    ...entry,
    backendId: entry.backendId?.trim() || "docker",
    runtimeLabel: entry.runtimeLabel?.trim() || entry.containerName,
    configLabelKind: entry.configLabelKind?.trim() || "Image",
  };
}

export async function readRegistry(): Promise<SandboxRegistry> {
  const entries = readRegistryEntries<SandboxRegistryEntry>("containers");
  return {
    entries: entries.map((entry) => normalizeSandboxRegistryEntry(entry)),
  };
}

function sandboxRegistryDbOptions(): OpenClawStateDatabaseOptions {
  return {
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: path.dirname(SANDBOX_STATE_DIR),
    },
  };
}

type SandboxRegistryEntriesTable = OpenClawStateKyselyDatabase["sandbox_registry_entries"];
type SandboxRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "sandbox_registry_entries">;
type SandboxRegistryRow = Selectable<SandboxRegistryEntriesTable>;

function requiredText(value: string | null): string | null {
  return normalizeOptionalString(value) ?? null;
}

function requiredNumber(value: number | null): number | null {
  return asFiniteNumber(value) ?? null;
}

function rowToContainerRegistryEntry(row: SandboxRegistryRow): SandboxRegistryEntry | null {
  const sessionKey = requiredText(row.session_key);
  const image = requiredText(row.image);
  const createdAtMs = requiredNumber(row.created_at_ms);
  const lastUsedAtMs = requiredNumber(row.last_used_at_ms);
  if (!sessionKey || !image || createdAtMs === null || lastUsedAtMs === null) {
    return null;
  }
  return {
    containerName: row.container_name,
    sessionKey,
    createdAtMs,
    lastUsedAtMs,
    image,
    ...(row.backend_id ? { backendId: row.backend_id } : {}),
    ...(row.runtime_label ? { runtimeLabel: row.runtime_label } : {}),
    ...(row.config_label_kind ? { configLabelKind: row.config_label_kind } : {}),
    ...(row.config_hash ? { configHash: row.config_hash } : {}),
  };
}

function rowToBrowserRegistryEntry(row: SandboxRegistryRow): SandboxBrowserRegistryEntry | null {
  const sessionKey = requiredText(row.session_key);
  const image = requiredText(row.image);
  const createdAtMs = requiredNumber(row.created_at_ms);
  const lastUsedAtMs = requiredNumber(row.last_used_at_ms);
  const cdpPort = requiredNumber(row.cdp_port);
  if (!sessionKey || !image || createdAtMs === null || lastUsedAtMs === null || cdpPort === null) {
    return null;
  }
  return {
    containerName: row.container_name,
    sessionKey,
    createdAtMs,
    lastUsedAtMs,
    image,
    cdpPort,
    ...(row.config_hash ? { configHash: row.config_hash } : {}),
    ...(row.no_vnc_port === null ? {} : { noVncPort: row.no_vnc_port }),
  };
}

function rowToRegistryEntry(
  kind: SandboxRegistryKind,
  row: SandboxRegistryRow,
): RegistryEntry | null {
  return kind === "containers" ? rowToContainerRegistryEntry(row) : rowToBrowserRegistryEntry(row);
}

function getSandboxRegistryKysely(database: OpenClawStateDatabase) {
  return getNodeSqliteKysely<SandboxRegistryDatabase>(database.db);
}

function bindRegistryEntry(
  kind: SandboxRegistryKind,
  entry: RegistryEntryPayload,
): Insertable<SandboxRegistryEntriesTable> {
  return {
    registry_kind: kind,
    container_name: entry.containerName,
    session_key: sqliteNullableText(entry.sessionKey),
    backend_id: sqliteNullableText(entry.backendId),
    runtime_label: sqliteNullableText(entry.runtimeLabel),
    image: sqliteNullableText(entry.image),
    created_at_ms: sqliteNullableNumber(entry.createdAtMs),
    last_used_at_ms: sqliteNullableNumber(entry.lastUsedAtMs),
    config_label_kind: sqliteNullableText(entry.configLabelKind),
    config_hash: sqliteNullableText(entry.configHash),
    cdp_port: sqliteNullableNumber(entry.cdpPort),
    no_vnc_port: sqliteNullableNumber(entry.noVncPort),
    entry_json: JSON.stringify(entry),
    updated_at: Date.now(),
  };
}

function getRegistryEntry(
  database: OpenClawStateDatabase,
  kind: SandboxRegistryKind,
  containerName: string,
): RegistryEntry | null {
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getSandboxRegistryKysely(database)
      .selectFrom("sandbox_registry_entries")
      .selectAll()
      .where("registry_kind", "=", kind)
      .where("container_name", "=", containerName),
  );
  return row ? rowToRegistryEntry(kind, row) : null;
}

function readRegistryEntryByKind(
  kind: SandboxRegistryKind,
  containerName: string,
): RegistryEntry | null {
  return getRegistryEntry(
    openOpenClawStateDatabase(sandboxRegistryDbOptions()),
    kind,
    containerName,
  );
}

function readRegistryEntries<T extends RegistryEntry>(kind: SandboxRegistryKind): T[] {
  const database = openOpenClawStateDatabase(sandboxRegistryDbOptions());
  const rows = executeSqliteQuerySync(
    database.db,
    getSandboxRegistryKysely(database)
      .selectFrom("sandbox_registry_entries")
      .selectAll()
      .where("registry_kind", "=", kind)
      .orderBy("container_name", "asc"),
  ).rows;
  return rows.flatMap((row) => {
    const entry = rowToRegistryEntry(kind, row);
    return entry ? [entry as T] : [];
  });
}

function upsertRegistryEntry(
  database: OpenClawStateDatabase,
  kind: SandboxRegistryKind,
  entry: RegistryEntryPayload,
): void {
  executeSqliteQuerySync(
    database.db,
    getSandboxRegistryKysely(database)
      .insertInto("sandbox_registry_entries")
      .values(bindRegistryEntry(kind, entry))
      .onConflict((conflict) =>
        conflict.columns(["registry_kind", "container_name"]).doUpdateSet({
          session_key: (eb) => eb.ref("excluded.session_key"),
          backend_id: (eb) => eb.ref("excluded.backend_id"),
          runtime_label: (eb) => eb.ref("excluded.runtime_label"),
          image: (eb) => eb.ref("excluded.image"),
          created_at_ms: (eb) => eb.ref("excluded.created_at_ms"),
          last_used_at_ms: (eb) => eb.ref("excluded.last_used_at_ms"),
          config_label_kind: (eb) => eb.ref("excluded.config_label_kind"),
          config_hash: (eb) => eb.ref("excluded.config_hash"),
          cdp_port: (eb) => eb.ref("excluded.cdp_port"),
          no_vnc_port: (eb) => eb.ref("excluded.no_vnc_port"),
          entry_json: (eb) => eb.ref("excluded.entry_json"),
          updated_at: (eb) => eb.ref("excluded.updated_at"),
        }),
      ),
  );
}

export async function readRegistryEntry(
  containerName: string,
): Promise<SandboxRegistryEntry | null> {
  const entry = readRegistryEntryByKind("containers", containerName) as SandboxRegistryEntry | null;
  return entry ? normalizeSandboxRegistryEntry(entry) : null;
}

export async function updateRegistry(entry: SandboxRegistryEntry) {
  runOpenClawStateWriteTransaction((database) => {
    const existing = getRegistryEntry(
      database,
      "containers",
      entry.containerName,
    ) as SandboxRegistryEntry | null;
    upsertRegistryEntry(database, "containers", {
      ...entry,
      backendId: entry.backendId ?? existing?.backendId,
      runtimeLabel: entry.runtimeLabel ?? existing?.runtimeLabel,
      createdAtMs: existing?.createdAtMs ?? entry.createdAtMs,
      image: existing?.image ?? entry.image,
      configLabelKind: entry.configLabelKind ?? existing?.configLabelKind,
      configHash: entry.configHash ?? existing?.configHash,
    });
  }, sandboxRegistryDbOptions());
}

export async function removeRegistryEntry(containerName: string) {
  runOpenClawStateWriteTransaction((database) => {
    executeSqliteQuerySync(
      database.db,
      getSandboxRegistryKysely(database)
        .deleteFrom("sandbox_registry_entries")
        .where("registry_kind", "=", "containers")
        .where("container_name", "=", containerName),
    );
  }, sandboxRegistryDbOptions());
}

export async function readBrowserRegistry(): Promise<SandboxBrowserRegistry> {
  return { entries: readRegistryEntries<SandboxBrowserRegistryEntry>("browsers") };
}

export async function updateBrowserRegistry(entry: SandboxBrowserRegistryEntry) {
  runOpenClawStateWriteTransaction((database) => {
    const existing = getRegistryEntry(
      database,
      "browsers",
      entry.containerName,
    ) as SandboxBrowserRegistryEntry | null;
    upsertRegistryEntry(database, "browsers", {
      ...entry,
      createdAtMs: existing?.createdAtMs ?? entry.createdAtMs,
      image: existing?.image ?? entry.image,
      configHash: entry.configHash ?? existing?.configHash,
    });
  }, sandboxRegistryDbOptions());
}

export async function removeBrowserRegistryEntry(containerName: string) {
  runOpenClawStateWriteTransaction((database) => {
    executeSqliteQuerySync(
      database.db,
      getSandboxRegistryKysely(database)
        .deleteFrom("sandbox_registry_entries")
        .where("registry_kind", "=", "browsers")
        .where("container_name", "=", containerName),
    );
  }, sandboxRegistryDbOptions());
}
