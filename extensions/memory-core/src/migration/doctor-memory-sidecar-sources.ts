import fs from "node:fs/promises";
import path from "node:path";
import { resolveUserPath } from "openclaw/plugin-sdk/memory-core-host-engine-fs";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import {
  legacyStateFileExists,
  type PluginDoctorMigrationBackupResource,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
// Doctor discovery accepts retired array-backed config without loading a writable store.
import { asOptionalObjectRecord as readLegacyObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  LEGACY_MEMORY_SIDECAR_SUFFIXES,
  type LegacyMemorySidecarSource,
} from "./doctor-memory-sidecar-import.js";

type MemoryFtsTokenizer = "unicode61" | "trigram";

function resolveConfiguredAgentIds(config: unknown): string[] {
  const agents = readLegacyObjectRecord(readLegacyObjectRecord(config)?.agents);
  const entries = readLegacyObjectRecord(agents?.entries);
  const listedIds = Array.isArray(agents?.list)
    ? agents.list.flatMap((entry) => {
        const id = readLegacyObjectRecord(entry)?.id;
        return typeof id === "string" ? [id] : [];
      })
    : [];
  const ids = new Set([...Object.keys(entries ?? {}), ...listedIds].map(normalizeAgentId));
  return ids.size > 0 ? [...ids] : [normalizeAgentId(undefined)];
}

function readAgentMemorySearch(
  config: unknown,
  agentId: string,
): Record<string, unknown> | undefined {
  const agents = readLegacyObjectRecord(readLegacyObjectRecord(config)?.agents);
  const keyedEntries = readLegacyObjectRecord(agents?.entries);
  const keyedEntry = keyedEntries
    ? Object.entries(keyedEntries).find(([id]) => normalizeAgentId(id) === agentId)?.[1]
    : undefined;
  const keyedSearch = readLegacyObjectRecord(
    readLegacyObjectRecord(readLegacyObjectRecord(keyedEntry)?.memory)?.search,
  );
  if (keyedSearch) {
    return keyedSearch;
  }
  const entries = Array.isArray(agents?.list) ? agents.list : [];
  const entry = entries
    .map(readLegacyObjectRecord)
    .find(
      (candidate) =>
        normalizeAgentId(typeof candidate?.id === "string" ? candidate.id : undefined) === agentId,
    );
  return readLegacyObjectRecord(readLegacyObjectRecord(entry?.memory)?.search);
}

function readMemorySearchLayers(config: unknown, agentId: string): Record<string, unknown>[] {
  const cfg = readLegacyObjectRecord(config);
  return [
    readAgentMemorySearch(config, agentId),
    readLegacyObjectRecord(readLegacyObjectRecord(cfg?.memory)?.search),
    // Doctor still inspects the retired root shape to migrate its persisted sidecar path.
    readLegacyObjectRecord(cfg?.memorySearch),
  ].filter((value): value is Record<string, unknown> => value !== undefined);
}

function readStoreLayers(config: unknown, agentId: string): Record<string, unknown>[] {
  return readMemorySearchLayers(config, agentId).flatMap((search) => {
    const store = readLegacyObjectRecord(search.store);
    return store ? [store] : [];
  });
}

function firstDefined(layers: Record<string, unknown>[], key: string): unknown {
  return layers.find((layer) => layer[key] !== undefined)?.[key];
}

function readNestedStoreLayers(
  config: unknown,
  agentId: string,
  key: string,
): Record<string, unknown>[] {
  return readStoreLayers(config, agentId).flatMap((store) => {
    const nested = readLegacyObjectRecord(store[key]);
    return nested ? [nested] : [];
  });
}

export function readMemorySearchVectorExtensionPath(
  config: unknown,
  agentId: string,
): string | undefined {
  const raw = firstDefined(readNestedStoreLayers(config, agentId, "vector"), "extensionPath");
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

export function readMemorySearchVectorEnabled(config: unknown, agentId: string): boolean {
  if (readMemorySearchProvider(config, agentId) === "none") {
    return false;
  }
  const raw = firstDefined(readNestedStoreLayers(config, agentId, "vector"), "enabled");
  return typeof raw === "boolean" ? raw : true;
}

function readMemorySearchProvider(config: unknown, agentId: string): string | undefined {
  const raw = firstDefined(readMemorySearchLayers(config, agentId), "provider");
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function readLegacyMemorySearchStorePaths(config: unknown, agentId: string): string[] {
  return [
    ...new Set(
      readStoreLayers(config, agentId).flatMap((store) =>
        typeof store.path === "string" && store.path.trim() ? [store.path.trim()] : [],
      ),
    ),
  ];
}

export function readMemorySearchFtsTokenizer(
  config: unknown,
  agentId: string,
): MemoryFtsTokenizer | undefined {
  const raw = firstDefined(readNestedStoreLayers(config, agentId, "fts"), "tokenizer");
  return raw === "unicode61" || raw === "trigram" ? raw : undefined;
}

async function isCanonicalAgentDatabaseSymlink(params: {
  legacyPath: string;
  agentDatabasePath: string;
}): Promise<boolean> {
  try {
    if (!(await fs.lstat(params.legacyPath)).isSymbolicLink()) {
      return false;
    }
    for (const suffix of LEGACY_MEMORY_SIDECAR_SUFFIXES.slice(1)) {
      try {
        await fs.lstat(`${params.legacyPath}${suffix}`);
        return false;
      } catch (err: unknown) {
        if (!err || typeof err !== "object" || !("code" in err) || err.code !== "ENOENT") {
          return false;
        }
      }
    }
    const [legacyTarget, canonicalTarget] = await Promise.all([
      fs.realpath(params.legacyPath),
      fs.realpath(params.agentDatabasePath),
    ]);
    return legacyTarget === canonicalTarget;
  } catch {
    // Only the exact compatibility alias is known non-legacy state. Any unresolved
    // target remains visible so Doctor cannot hide data it failed to classify.
    return false;
  }
}

export async function collectLegacyMemorySidecarSources(params: {
  config: unknown;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  requireReadable?: boolean;
}): Promise<LegacyMemorySidecarSource[]> {
  const agentIds = new Set(resolveConfiguredAgentIds(params.config));
  const legacyDir = path.join(params.stateDir, "memory");
  const retrySidecars: Array<{ agentId: string; legacyPath: string }> = [];
  try {
    const entries = await fs.readdir(legacyDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".sqlite")) {
        const stem = entry.name.slice(0, -".sqlite".length);
        const retryMarker = ".retry-";
        const retryIndex = stem.indexOf(retryMarker);
        const rawAgentId = retryIndex === -1 ? stem : stem.slice(0, retryIndex);
        const agentId = normalizeAgentId(rawAgentId);
        if (retryIndex !== -1 && rawAgentId === agentId && agentIds.has(agentId)) {
          retrySidecars.push({ agentId, legacyPath: path.join(legacyDir, entry.name) });
        }
      }
    }
  } catch (error) {
    if (
      params.requireReadable &&
      !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }

  const migrationEnv = { ...params.env, OPENCLAW_STATE_DIR: params.stateDir };
  const sources: LegacyMemorySidecarSource[] = [];
  const seen = new Set<string>();
  async function addSource(agentId: string, legacyPath: string): Promise<void> {
    const normalizedPath = path.resolve(legacyPath);
    const key = `${agentId}\0${normalizedPath}`;
    if (seen.has(key)) {
      return;
    }
    if (params.requireReadable) {
      try {
        if (!(await fs.stat(normalizedPath)).isFile()) {
          return;
        }
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return;
        }
        throw error;
      }
    } else if (!(await legacyStateFileExists(normalizedPath))) {
      return;
    }
    seen.add(key);
    // Most startups have no legacy sidecars. Load the SQLite graph only after
    // finding a source that needs its canonical database path checked.
    const { resolveOpenClawAgentSqlitePath } = await import("openclaw/plugin-sdk/sqlite-runtime");
    const agentDatabasePath = resolveOpenClawAgentSqlitePath({
      agentId,
      env: migrationEnv,
    });
    if (
      await isCanonicalAgentDatabaseSymlink({
        legacyPath: normalizedPath,
        agentDatabasePath,
      })
    ) {
      return;
    }
    sources.push({
      agentId,
      legacyPath: normalizedPath,
      stateDir: params.stateDir,
      agentDatabasePath,
    });
  }
  for (const agentId of agentIds) {
    for (const configuredPath of readLegacyMemorySearchStorePaths(params.config, agentId)) {
      await addSource(
        agentId,
        resolveUserPath(configuredPath.replaceAll("{agentId}", agentId), migrationEnv),
      );
    }
    await addSource(agentId, path.join(legacyDir, `${agentId}.sqlite`));
  }
  for (const retrySidecar of retrySidecars) {
    await addSource(retrySidecar.agentId, retrySidecar.legacyPath);
  }
  return sources;
}

export async function collectLegacyMemorySidecarBackupResources(params: {
  config: unknown;
  env: NodeJS.ProcessEnv;
  stateDir: string;
}): Promise<PluginDoctorMigrationBackupResource[]> {
  const resources: PluginDoctorMigrationBackupResource[] = [];
  for (const source of await collectLegacyMemorySidecarSources({
    ...params,
    requireReadable: true,
  })) {
    resources.push(
      { path: source.legacyPath, kind: "sqlite" },
      { path: source.agentDatabasePath, kind: "sqlite" },
    );
    // Archived companions keep their renamed bytes; only the live source is an online snapshot.
    for (const suffix of LEGACY_MEMORY_SIDECAR_SUFFIXES) {
      resources.push({ path: `${source.legacyPath}${suffix}.migrated`, kind: "file" });
    }
  }
  return resources;
}
