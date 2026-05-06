import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeJson } from "../../infra/json-files.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import {
  deleteOpenClawStateKvJson,
  listOpenClawStateKvJson,
  readOpenClawStateKvJson,
  writeOpenClawStateKvJson,
} from "../../state/openclaw-state-kv.js";
import { safeParseJsonWithSchema } from "../../utils/zod-parse.js";
import { acquireSessionWriteLock } from "../session-write-lock.js";
import {
  SANDBOX_BROWSER_REGISTRY_PATH,
  SANDBOX_BROWSERS_DIR,
  SANDBOX_CONTAINERS_DIR,
  SANDBOX_REGISTRY_PATH,
  SANDBOX_STATE_DIR,
} from "./constants.js";
import { hashTextSha256 } from "./hash.js";

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

const SANDBOX_CONTAINER_REGISTRY_KV_SCOPE = "sandbox_registry_containers";
const SANDBOX_BROWSER_REGISTRY_KV_SCOPE = "sandbox_registry_browsers";

function normalizeSandboxRegistryEntry(entry: SandboxRegistryEntry): SandboxRegistryEntry {
  return {
    ...entry,
    backendId: entry.backendId?.trim() || "docker",
    runtimeLabel: entry.runtimeLabel?.trim() || entry.containerName,
    configLabelKind: entry.configLabelKind?.trim() || "Image",
  };
}

async function withRegistryLock<T>(registryPath: string, fn: () => Promise<T>): Promise<T> {
  const lock = await acquireSessionWriteLock({
    sessionFile: registryPath,
    allowReentrant: false,
    timeoutMs: 60_000,
  });
  try {
    return await fn();
  } finally {
    await lock.release();
  }
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
  const entries = await readShardedEntries<SandboxRegistryEntry>(SANDBOX_CONTAINERS_DIR);
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

function registryKvScopeForDir(dir: string): string {
  return dir === SANDBOX_BROWSERS_DIR
    ? SANDBOX_BROWSER_REGISTRY_KV_SCOPE
    : SANDBOX_CONTAINER_REGISTRY_KV_SCOPE;
}

function shardedEntryFilePath(dir: string, containerName: string): string {
  return path.join(dir, `${hashTextSha256(containerName)}.json`);
}

async function withEntryLock<T>(
  dir: string,
  containerName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const entryPath = shardedEntryFilePath(dir, containerName);
  const lock = await acquireSessionWriteLock({
    sessionFile: entryPath,
    allowReentrant: false,
    timeoutMs: 60_000,
  });
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

async function readShardedEntry<T extends RegistryEntry>(
  dir: string,
  containerName: string,
): Promise<T | null> {
  const sqliteEntry = readOpenClawStateKvJson(
    registryKvScopeForDir(dir),
    containerName,
    sandboxRegistryDbOptions(),
  ) as T | undefined;
  if (sqliteEntry?.containerName === containerName) {
    return sqliteEntry;
  }

  let raw: string;
  try {
    raw = await fs.readFile(shardedEntryFilePath(dir, containerName), "utf-8");
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const parsed = safeParseJsonWithSchema(RegistryEntrySchema, raw) as T | null;
  if (parsed?.containerName === containerName) {
    writeOpenClawStateKvJson(
      registryKvScopeForDir(dir),
      parsed.containerName,
      parsed,
      sandboxRegistryDbOptions(),
    );
  }
  return parsed?.containerName === containerName ? parsed : null;
}

async function writeShardedEntry(dir: string, entry: RegistryEntryPayload): Promise<void> {
  writeOpenClawStateKvJson(
    registryKvScopeForDir(dir),
    entry.containerName,
    entry,
    sandboxRegistryDbOptions(),
  );
  await fs.mkdir(dir, { recursive: true });
  await writeJson(shardedEntryFilePath(dir, entry.containerName), entry, {
    trailingNewline: true,
  });
}

async function removeShardedEntry(dir: string, containerName: string): Promise<void> {
  deleteOpenClawStateKvJson(registryKvScopeForDir(dir), containerName, sandboxRegistryDbOptions());
  await fs.rm(shardedEntryFilePath(dir, containerName), { force: true });
}

async function readShardedEntries<T extends RegistryEntry>(dir: string): Promise<T[]> {
  const byName = new Map<string, T>();
  for (const entry of listOpenClawStateKvJson<T>(
    registryKvScopeForDir(dir),
    sandboxRegistryDbOptions(),
  )) {
    if (entry.value?.containerName) {
      byName.set(entry.value.containerName, entry.value);
    }
  }

  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ENOENT") {
      return [...byName.values()].toSorted((left, right) =>
        left.containerName.localeCompare(right.containerName),
      );
    }
    throw error;
  }

  const entries = await Promise.all(
    files
      .filter((name) => name.endsWith(".json"))
      .toSorted()
      .map(async (name) => {
        try {
          const raw = await fs.readFile(path.join(dir, name), "utf-8");
          return safeParseJsonWithSchema(RegistryEntrySchema, raw) as T | null;
        } catch {
          return null;
        }
      }),
  );
  for (const entry of entries) {
    if (entry) {
      if (!byName.has(entry.containerName)) {
        writeOpenClawStateKvJson(
          registryKvScopeForDir(dir),
          entry.containerName,
          entry,
          sandboxRegistryDbOptions(),
        );
        byName.set(entry.containerName, entry);
      }
    }
  }
  return [...byName.values()].toSorted((left, right) =>
    left.containerName.localeCompare(right.containerName),
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

async function migrateMonolithicIfNeeded(
  target: LegacyRegistryTarget,
): Promise<LegacySandboxRegistryMigrationResult> {
  const { registryPath, shardedDir } = target;
  try {
    await fs.access(registryPath);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ENOENT") {
      return { ...target, status: "missing", entries: 0 };
    }
    throw error;
  }

  return await withRegistryLock(registryPath, async () => {
    const registry = await readLegacyRegistryFile(registryPath);
    if (!registry) {
      const quarantinePath = await quarantineLegacyRegistry(registryPath);
      return { ...target, status: "quarantined-invalid", entries: 0, quarantinePath };
    }
    if (registry.entries.length === 0) {
      await fs.rm(registryPath, { force: true });
      return { ...target, status: "removed-empty", entries: 0 };
    }
    await fs.mkdir(shardedDir, { recursive: true });
    for (const entry of registry.entries) {
      await withEntryLock(shardedDir, entry.containerName, async () => {
        const existing = await readShardedEntry(shardedDir, entry.containerName);
        if (!existing) {
          await writeShardedEntry(shardedDir, entry);
        }
      });
    }
    await fs.rm(registryPath, { force: true });
    return { ...target, status: "migrated", entries: registry.entries.length };
  });
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
    try {
      await fs.access(target.registryPath);
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === "ENOENT") {
        inspections.push({ ...target, exists: false, valid: true, entries: 0 });
        continue;
      }
      throw error;
    }

    const registry = await readLegacyRegistryFile(target.registryPath);
    inspections.push({
      ...target,
      exists: true,
      valid: Boolean(registry),
      entries: registry?.entries.length ?? 0,
    });
  }
  return inspections;
}

export async function migrateLegacySandboxRegistryFiles(): Promise<
  LegacySandboxRegistryMigrationResult[]
> {
  const results: LegacySandboxRegistryMigrationResult[] = [];
  for (const target of legacyRegistryTargets()) {
    results.push(await migrateMonolithicIfNeeded(target));
  }
  return results;
}

export async function readRegistryEntry(
  containerName: string,
): Promise<SandboxRegistryEntry | null> {
  const entry = await readShardedEntry<SandboxRegistryEntry>(SANDBOX_CONTAINERS_DIR, containerName);
  return entry ? normalizeSandboxRegistryEntry(entry) : null;
}

export async function updateRegistry(entry: SandboxRegistryEntry) {
  await withEntryLock(SANDBOX_CONTAINERS_DIR, entry.containerName, async () => {
    const existing = await readShardedEntry<SandboxRegistryEntry>(
      SANDBOX_CONTAINERS_DIR,
      entry.containerName,
    );
    await writeShardedEntry(SANDBOX_CONTAINERS_DIR, {
      ...entry,
      backendId: entry.backendId ?? existing?.backendId,
      runtimeLabel: entry.runtimeLabel ?? existing?.runtimeLabel,
      createdAtMs: existing?.createdAtMs ?? entry.createdAtMs,
      image: existing?.image ?? entry.image,
      configLabelKind: entry.configLabelKind ?? existing?.configLabelKind,
      configHash: entry.configHash ?? existing?.configHash,
    });
  });
}

export async function removeRegistryEntry(containerName: string) {
  await withEntryLock(SANDBOX_CONTAINERS_DIR, containerName, async () => {
    await removeShardedEntry(SANDBOX_CONTAINERS_DIR, containerName);
  });
}

export async function readBrowserRegistry(): Promise<SandboxBrowserRegistry> {
  return { entries: await readShardedEntries<SandboxBrowserRegistryEntry>(SANDBOX_BROWSERS_DIR) };
}

export async function updateBrowserRegistry(entry: SandboxBrowserRegistryEntry) {
  await withEntryLock(SANDBOX_BROWSERS_DIR, entry.containerName, async () => {
    const existing = await readShardedEntry<SandboxBrowserRegistryEntry>(
      SANDBOX_BROWSERS_DIR,
      entry.containerName,
    );
    await writeShardedEntry(SANDBOX_BROWSERS_DIR, {
      ...entry,
      createdAtMs: existing?.createdAtMs ?? entry.createdAtMs,
      image: existing?.image ?? entry.image,
      configHash: entry.configHash ?? existing?.configHash,
    });
  });
}

export async function removeBrowserRegistryEntry(containerName: string) {
  await withEntryLock(SANDBOX_BROWSERS_DIR, containerName, async () => {
    await removeShardedEntry(SANDBOX_BROWSERS_DIR, containerName);
  });
}
