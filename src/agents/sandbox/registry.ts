import path from "node:path";
import type { Insertable } from "kysely";
import { z } from "zod";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
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

type RegistryEntry = {
  containerName: string;
};

type RegistryEntryPayload = RegistryEntry & Record<string, unknown>;

type LegacyRegistryKind = "containers" | "browsers";

const RegistryEntrySchema = z
  .object({
    containerName: z.string(),
  })
  .passthrough();

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

type SandboxRegistryRow = {
  container_name: string;
  entry_json: string;
};

type SandboxRegistryEntriesTable = OpenClawStateKyselyDatabase["sandbox_registry_entries"];
type SandboxRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "sandbox_registry_entries">;

function parseRegistryEntry(row: SandboxRegistryRow): RegistryEntry | null {
  try {
    const parsed = JSON.parse(row.entry_json) as unknown;
    const entry = RegistryEntrySchema.safeParse(parsed);
    return entry.success && entry.data.containerName === row.container_name ? entry.data : null;
  } catch {
    return null;
  }
}

function getSandboxRegistryKysely(database: OpenClawStateDatabase) {
  return getNodeSqliteKysely<SandboxRegistryDatabase>(database.db);
}

function bindRegistryEntry(
  kind: LegacyRegistryKind,
  entry: RegistryEntryPayload,
): Insertable<SandboxRegistryEntriesTable> {
  return {
    registry_kind: kind,
    container_name: entry.containerName,
    entry_json: JSON.stringify(entry),
    updated_at: Date.now(),
  };
}

function getRegistryEntry(
  database: OpenClawStateDatabase,
  kind: LegacyRegistryKind,
  containerName: string,
): RegistryEntry | null {
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getSandboxRegistryKysely(database)
      .selectFrom("sandbox_registry_entries")
      .select(["container_name", "entry_json"])
      .where("registry_kind", "=", kind)
      .where("container_name", "=", containerName),
  );
  return row ? parseRegistryEntry(row) : null;
}

function readRegistryEntryByKind(
  kind: LegacyRegistryKind,
  containerName: string,
): RegistryEntry | null {
  return getRegistryEntry(
    openOpenClawStateDatabase(sandboxRegistryDbOptions()),
    kind,
    containerName,
  );
}

function readRegistryEntries<T extends RegistryEntry>(kind: LegacyRegistryKind): T[] {
  const database = openOpenClawStateDatabase(sandboxRegistryDbOptions());
  const rows = executeSqliteQuerySync(
    database.db,
    getSandboxRegistryKysely(database)
      .selectFrom("sandbox_registry_entries")
      .select(["container_name", "entry_json"])
      .where("registry_kind", "=", kind)
      .orderBy("container_name", "asc"),
  ).rows;
  return rows.flatMap((row) => {
    const entry = parseRegistryEntry(row);
    return entry ? [entry as T] : [];
  });
}

function upsertRegistryEntry(
  database: OpenClawStateDatabase,
  kind: LegacyRegistryKind,
  entry: RegistryEntryPayload,
): void {
  executeSqliteQuerySync(
    database.db,
    getSandboxRegistryKysely(database)
      .insertInto("sandbox_registry_entries")
      .values(bindRegistryEntry(kind, entry))
      .onConflict((conflict) =>
        conflict.columns(["registry_kind", "container_name"]).doUpdateSet({
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
