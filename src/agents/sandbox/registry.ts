import fs from "node:fs/promises";
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
import { safeParseJsonWithSchema } from "../../utils/zod-parse.js";
import {
  SANDBOX_BROWSER_REGISTRY_PATH,
  SANDBOX_BROWSERS_DIR,
  SANDBOX_CONTAINERS_DIR,
  SANDBOX_REGISTRY_PATH,
  SANDBOX_STATE_DIR,
} from "./constants.js";

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

type RegistryFile = {
  entries: RegistryEntryPayload[];
};

type LegacyRegistryKind = "containers" | "browsers";

type LegacyRegistryTarget = {
  kind: LegacyRegistryKind;
  registryPath: string;
  shardedDir: string;
};

export type LegacySandboxRegistryInspection = LegacyRegistryTarget & {
  exists: boolean;
  valid: boolean;
  entries: number;
};

export type LegacySandboxRegistryMigrationResult = LegacyRegistryTarget & {
  status: "missing" | "migrated" | "removed-empty" | "quarantined-invalid";
  entries: number;
  quarantinePath?: string;
};

const RegistryEntrySchema = z
  .object({
    containerName: z.string(),
  })
  .passthrough();

const RegistryFileSchema = z.object({
  entries: z.array(RegistryEntrySchema),
});

function normalizeSandboxRegistryEntry(entry: SandboxRegistryEntry): SandboxRegistryEntry {
  return {
    ...entry,
    backendId: entry.backendId?.trim() || "docker",
    runtimeLabel: entry.runtimeLabel?.trim() || entry.containerName,
    configLabelKind: entry.configLabelKind?.trim() || "Image",
  };
}

async function readLegacyRegistryFile(registryPath: string): Promise<RegistryFile | null> {
  try {
    const raw = await fs.readFile(registryPath, "utf-8");
    const parsed = safeParseJsonWithSchema(RegistryFileSchema, raw) as RegistryFile | null;
    return parsed;
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ENOENT") {
      return { entries: [] };
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to read sandbox registry file: ${registryPath}`, { cause: error });
  }
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
  const row = executeSqliteQueryTakeFirstSync<SandboxRegistryRow>(
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
  const rows = executeSqliteQuerySync<SandboxRegistryRow>(
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

async function quarantineLegacyRegistry(registryPath: string): Promise<string> {
  const quarantinePath = `${registryPath}.invalid-${Date.now()}`;
  await fs.rename(registryPath, quarantinePath).catch(async (error) => {
    const code = (error as { code?: string } | null)?.code;
    if (code !== "ENOENT") {
      await fs.rm(registryPath, { force: true });
    }
  });
  return quarantinePath;
}

async function legacyShardPaths(dir: string): Promise<string[]> {
  try {
    const names = await fs.readdir(dir);
    return names
      .filter((name) => name.endsWith(".json"))
      .toSorted()
      .map((name) => path.join(dir, name));
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readLegacyShardFile(shardPath: string): Promise<RegistryEntryPayload | null> {
  try {
    const raw = await fs.readFile(shardPath, "utf-8");
    return safeParseJsonWithSchema(RegistryEntrySchema, raw) as RegistryEntryPayload | null;
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function inspectMonolithicLegacyRegistry(target: LegacyRegistryTarget): Promise<{
  exists: boolean;
  valid: boolean;
  entries: RegistryEntryPayload[];
}> {
  try {
    await fs.access(target.registryPath);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ENOENT") {
      return { exists: false, valid: true, entries: [] };
    }
    throw error;
  }

  const registry = await readLegacyRegistryFile(target.registryPath);
  return {
    exists: true,
    valid: Boolean(registry),
    entries: registry?.entries ?? [],
  };
}

async function inspectShardedLegacyRegistry(target: LegacyRegistryTarget): Promise<{
  exists: boolean;
  valid: boolean;
  entries: RegistryEntryPayload[];
  invalidPath?: string;
}> {
  const shardPaths = await legacyShardPaths(target.shardedDir);
  const entries: RegistryEntryPayload[] = [];
  for (const shardPath of shardPaths) {
    const entry = await readLegacyShardFile(shardPath);
    if (!entry) {
      return { exists: true, valid: false, entries, invalidPath: shardPath };
    }
    entries.push(entry);
  }
  return { exists: shardPaths.length > 0, valid: true, entries };
}

async function migrateTargetIfNeeded(
  target: LegacyRegistryTarget,
): Promise<LegacySandboxRegistryMigrationResult> {
  const monolithic = await inspectMonolithicLegacyRegistry(target);
  if (!monolithic.valid) {
    const quarantinePath = await quarantineLegacyRegistry(target.registryPath);
    return { ...target, status: "quarantined-invalid", entries: 0, quarantinePath };
  }
  const sharded = await inspectShardedLegacyRegistry(target);
  if (!sharded.valid) {
    const quarantinePath = sharded.invalidPath
      ? await quarantineLegacyRegistry(sharded.invalidPath)
      : undefined;
    return { ...target, status: "quarantined-invalid", entries: 0, quarantinePath };
  }

  if (!monolithic.exists && !sharded.exists) {
    return { ...target, status: "missing", entries: 0 };
  }

  const entries = [...monolithic.entries, ...sharded.entries];
  if (entries.length === 0) {
    await fs.rm(target.registryPath, { force: true });
    await fs.rm(`${target.registryPath}.lock`, { force: true });
    await fs.rm(target.shardedDir, { recursive: true, force: true });
    return { ...target, status: "removed-empty", entries: 0 };
  }

  runOpenClawStateWriteTransaction((database) => {
    for (const entry of entries) {
      if (!getRegistryEntry(database, target.kind, entry.containerName)) {
        upsertRegistryEntry(database, target.kind, entry);
      }
    }
  }, sandboxRegistryDbOptions());

  await fs.rm(target.registryPath, { force: true });
  await fs.rm(`${target.registryPath}.lock`, { force: true });
  await fs.rm(target.shardedDir, { recursive: true, force: true });
  return { ...target, status: "migrated", entries: entries.length };
}

function legacyRegistryTargets(): LegacyRegistryTarget[] {
  return [
    {
      kind: "containers",
      registryPath: SANDBOX_REGISTRY_PATH,
      shardedDir: SANDBOX_CONTAINERS_DIR,
    },
    {
      kind: "browsers",
      registryPath: SANDBOX_BROWSER_REGISTRY_PATH,
      shardedDir: SANDBOX_BROWSERS_DIR,
    },
  ];
}

export async function inspectLegacySandboxRegistryFiles(): Promise<
  LegacySandboxRegistryInspection[]
> {
  const inspections: LegacySandboxRegistryInspection[] = [];
  for (const target of legacyRegistryTargets()) {
    const monolithic = await inspectMonolithicLegacyRegistry(target);
    const sharded = monolithic.valid
      ? await inspectShardedLegacyRegistry(target)
      : { exists: false, valid: true, entries: [] };
    inspections.push({
      ...target,
      exists: monolithic.exists || sharded.exists,
      valid: monolithic.valid && sharded.valid,
      entries: monolithic.entries.length + sharded.entries.length,
    });
  }
  return inspections;
}

export async function migrateLegacySandboxRegistryFiles(): Promise<
  LegacySandboxRegistryMigrationResult[]
> {
  const results: LegacySandboxRegistryMigrationResult[] = [];
  for (const target of legacyRegistryTargets()) {
    results.push(await migrateTargetIfNeeded(target));
  }
  return results;
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
