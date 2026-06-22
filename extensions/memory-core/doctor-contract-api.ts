// Memory Core doctor contract migrates shipped workspace dreaming state.
import fs from "node:fs/promises";
import path from "node:path";
import {
  ensureMemoryIndexSchema,
  importLegacyMemorySidecarIndex,
  loadSqliteVecExtension,
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveMemoryDreamingWorkspaces } from "openclaw/plugin-sdk/memory-core-host-status";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor";
import {
  ensureOpenClawAgentDatabaseSchema,
  resolveOpenClawAgentSqlitePath,
} from "openclaw/plugin-sdk/sqlite-runtime";
import {
  DAILY_INGESTION_STATE_RELATIVE_PATH,
  SESSION_INGESTION_STATE_RELATIVE_PATH,
  normalizeDailyIngestionState,
  normalizeSessionIngestionState,
} from "./src/dreaming-phases.js";
import {
  DREAMING_DAILY_INGESTION_NAMESPACE,
  DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
  DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
  SESSION_SEEN_HASHES_PER_CHUNK,
  SHORT_TERM_META_NAMESPACE,
  SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
  SHORT_TERM_RECALL_NAMESPACE,
  configureMemoryCoreDreamingState,
  readMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntry,
} from "./src/dreaming-state.js";
import {
  SHORT_TERM_PHASE_SIGNAL_RELATIVE_PATH,
  SHORT_TERM_STORE_RELATIVE_PATH,
  normalizeShortTermPhaseSignalStore,
  normalizeShortTermRecallStore,
} from "./src/short-term-promotion.js";

type LegacySource = {
  workspaceDir: string;
  label: string;
  filePath: string;
};

type LegacyMemorySidecarSource = {
  agentId: string;
  legacyPath: string;
  agentDatabasePath: string;
};

const LEGACY_MEMORY_SIDECAR_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;

function resolveConfiguredAgentIds(config: unknown): string[] {
  const cfg = config as { agents?: { list?: unknown } };
  const ids = new Set<string>();
  if (Array.isArray(cfg.agents?.list)) {
    for (const entry of cfg.agents.list) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const id = (entry as { id?: unknown }).id;
      ids.add(normalizeAgentId(typeof id === "string" ? id : undefined));
    }
  }
  if (ids.size === 0) {
    ids.add(normalizeAgentId(undefined));
  }
  return [...ids];
}

async function collectLegacyMemorySidecarSources(params: {
  config: unknown;
  env: NodeJS.ProcessEnv;
  stateDir: string;
}): Promise<LegacyMemorySidecarSource[]> {
  const agentIds = new Set(resolveConfiguredAgentIds(params.config));
  const legacyDir = path.join(params.stateDir, "memory");
  try {
    const entries = await fs.readdir(legacyDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".sqlite")) {
        agentIds.add(normalizeAgentId(entry.name.slice(0, -".sqlite".length)));
      }
    }
  } catch {}

  const migrationEnv = { ...params.env, OPENCLAW_STATE_DIR: params.stateDir };
  const sources: LegacyMemorySidecarSource[] = [];
  for (const agentId of agentIds) {
    const legacyPath = path.join(legacyDir, `${agentId}.sqlite`);
    if (!(await fileExists(legacyPath))) {
      continue;
    }
    sources.push({
      agentId,
      legacyPath,
      agentDatabasePath: resolveOpenClawAgentSqlitePath({ agentId, env: migrationEnv }),
    });
  }
  return sources;
}

async function archiveLegacyMemorySidecar(params: {
  source: LegacyMemorySidecarSource;
  changes: string[];
  warnings: string[];
}): Promise<void> {
  const existingSources = (
    await Promise.all(
      LEGACY_MEMORY_SIDECAR_SUFFIXES.map(async (suffix) => {
        const filePath = `${params.source.legacyPath}${suffix}`;
        return (await fileExists(filePath)) ? filePath : null;
      }),
    )
  ).filter((filePath): filePath is string => filePath !== null);
  if (existingSources.length === 0) {
    return;
  }
  const existingArchives = (
    await Promise.all(
      existingSources.map(async (sourcePath) => {
        const archivedPath = `${sourcePath}.migrated`;
        return (await fileExists(archivedPath)) ? archivedPath : null;
      }),
    )
  ).filter((filePath): filePath is string => filePath !== null);
  if (existingArchives.length > 0) {
    params.warnings.push(
      `Left migrated Memory Core legacy memory index sidecar in place because ${existingArchives[0]} already exists`,
    );
    return;
  }
  for (const sourcePath of existingSources) {
    try {
      await fs.rename(sourcePath, `${sourcePath}.migrated`);
    } catch (err) {
      params.warnings.push(
        `Failed archiving Memory Core legacy memory index sidecar ${sourcePath}: ${String(err)}`,
      );
      return;
    }
  }
  params.changes.push(
    `Archived Memory Core legacy memory index sidecar -> ${params.source.legacyPath}.migrated`,
  );
}

async function migrateLegacyMemorySidecarSource(params: {
  source: LegacyMemorySidecarSource;
  env: NodeJS.ProcessEnv;
  changes: string[];
  warnings: string[];
}): Promise<void> {
  await fs.mkdir(path.dirname(params.source.agentDatabasePath), { recursive: true });
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(params.source.agentDatabasePath, { allowExtension: true });
  try {
    const migrationEnv = {
      ...params.env,
      OPENCLAW_STATE_DIR: path.dirname(path.dirname(params.source.legacyPath)),
    };
    ensureOpenClawAgentDatabaseSchema(db, {
      agentId: params.source.agentId,
      env: migrationEnv,
      path: params.source.agentDatabasePath,
      register: true,
    });
    ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled: true });
    await loadSqliteVecExtension({ db });
    const result = importLegacyMemorySidecarIndex({
      db,
      legacySidecarDatabasePath: params.source.legacyPath,
    });
    if (result.reason === "legacy-schema-missing") {
      params.warnings.push(
        `Skipped Memory Core legacy memory index import for agent ${params.source.agentId} because the sidecar schema is not a legacy memory index`,
      );
      return;
    }
    if (result.reason === "canonical-not-empty") {
      params.warnings.push(
        `Skipped Memory Core legacy memory index import for agent ${params.source.agentId} because per-agent SQLite already has memory index rows`,
      );
      await archiveLegacyMemorySidecar(params);
      return;
    }
    if (!result.imported) {
      return;
    }
    ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled: true });
    params.changes.push(
      `Migrated Memory Core legacy memory index for agent ${params.source.agentId} -> per-agent SQLite (${result.sources} source(s), ${result.chunks} chunk(s), ${result.cacheEntries} cache row(s))`,
    );
    await archiveLegacyMemorySidecar(params);
  } finally {
    db.close();
  }
}

function resolveConfiguredWorkspaces(config: unknown, env: NodeJS.ProcessEnv): string[] {
  return resolveMemoryDreamingWorkspaces(
    config as Parameters<typeof resolveMemoryDreamingWorkspaces>[0],
    { env },
  ).map((entry) => entry.workspaceDir);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function archiveLegacySource(params: {
  filePath: string;
  label: string;
  changes: string[];
  warnings: string[];
}): Promise<void> {
  const archivedPath = `${params.filePath}.migrated`;
  if (await fileExists(archivedPath)) {
    params.warnings.push(
      `Left migrated Memory Core ${params.label} source in place because ${archivedPath} already exists`,
    );
    return;
  }
  try {
    await fs.rename(params.filePath, archivedPath);
    params.changes.push(`Archived Memory Core ${params.label} legacy source -> ${archivedPath}`);
  } catch (err) {
    params.warnings.push(
      `Failed archiving Memory Core ${params.label} legacy source: ${String(err)}`,
    );
  }
}

async function collectLegacySources(
  config: unknown,
  env: NodeJS.ProcessEnv,
): Promise<LegacySource[]> {
  const sources: LegacySource[] = [];
  for (const workspaceDir of resolveConfiguredWorkspaces(config, env)) {
    const candidates = [
      { label: "daily ingestion", relativePath: DAILY_INGESTION_STATE_RELATIVE_PATH },
      { label: "session ingestion", relativePath: SESSION_INGESTION_STATE_RELATIVE_PATH },
      { label: "short-term recall", relativePath: SHORT_TERM_STORE_RELATIVE_PATH },
      { label: "phase signals", relativePath: SHORT_TERM_PHASE_SIGNAL_RELATIVE_PATH },
    ];
    for (const candidate of candidates) {
      const filePath = path.join(workspaceDir, candidate.relativePath);
      if (await fileExists(filePath)) {
        sources.push({ workspaceDir, label: candidate.label, filePath });
      }
    }
  }
  return sources;
}

async function workspaceHasRows(namespace: string, workspaceDir: string): Promise<boolean> {
  return (await readMemoryCoreWorkspaceEntries({ namespace, workspaceDir })).length > 0;
}

async function migrateDailyIngestion(source: LegacySource): Promise<number> {
  const state = normalizeDailyIngestionState(await readJsonFile(source.filePath));
  await writeMemoryCoreWorkspaceEntries({
    namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
    workspaceDir: source.workspaceDir,
    entries: Object.entries(state.files).map(([key, value]) => ({ key, value })),
  });
  return Object.keys(state.files).length;
}

async function migrateSessionIngestion(source: LegacySource): Promise<number> {
  const state = normalizeSessionIngestionState(await readJsonFile(source.filePath));
  const seenEntries = Object.entries(state.seenMessages).flatMap(([scope, hashes]) =>
    Array.from(
      { length: Math.ceil(hashes.length / SESSION_SEEN_HASHES_PER_CHUNK) },
      (_, index) => ({
        key: `${scope}:${index}`,
        value: {
          scope,
          index,
          hashes: hashes.slice(
            index * SESSION_SEEN_HASHES_PER_CHUNK,
            (index + 1) * SESSION_SEEN_HASHES_PER_CHUNK,
          ),
        },
      }),
    ),
  );
  await Promise.all([
    writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir: source.workspaceDir,
      entries: Object.entries(state.files).map(([key, value]) => ({ key, value })),
    }),
    writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
      workspaceDir: source.workspaceDir,
      entries: seenEntries,
    }),
  ]);
  return Object.keys(state.files).length + Object.keys(state.seenMessages).length;
}

async function migrateShortTermRecall(source: LegacySource): Promise<number> {
  const nowIso = new Date().toISOString();
  const state = normalizeShortTermRecallStore(await readJsonFile(source.filePath), nowIso);
  await Promise.all([
    writeMemoryCoreWorkspaceEntries({
      namespace: SHORT_TERM_RECALL_NAMESPACE,
      workspaceDir: source.workspaceDir,
      entries: Object.entries(state.entries).map(([key, value]) => ({ key, value })),
    }),
    writeMemoryCoreWorkspaceEntry({
      namespace: SHORT_TERM_META_NAMESPACE,
      workspaceDir: source.workspaceDir,
      key: "recall",
      value: { updatedAt: state.updatedAt },
    }),
  ]);
  return Object.keys(state.entries).length;
}

async function migratePhaseSignals(source: LegacySource): Promise<number> {
  const nowIso = new Date().toISOString();
  const state = normalizeShortTermPhaseSignalStore(await readJsonFile(source.filePath), nowIso);
  await Promise.all([
    writeMemoryCoreWorkspaceEntries({
      namespace: SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
      workspaceDir: source.workspaceDir,
      entries: Object.entries(state.entries).map(([key, value]) => ({ key, value })),
    }),
    writeMemoryCoreWorkspaceEntry({
      namespace: SHORT_TERM_META_NAMESPACE,
      workspaceDir: source.workspaceDir,
      key: "phase",
      value: { updatedAt: state.updatedAt },
    }),
  ]);
  return Object.keys(state.entries).length;
}

function targetNamespacesForSource(label: string): string[] {
  if (label === "daily ingestion") {
    return [DREAMING_DAILY_INGESTION_NAMESPACE];
  }
  if (label === "session ingestion") {
    return [DREAMING_SESSION_INGESTION_FILES_NAMESPACE, DREAMING_SESSION_INGESTION_SEEN_NAMESPACE];
  }
  if (label === "short-term recall") {
    return [SHORT_TERM_RECALL_NAMESPACE];
  }
  return [SHORT_TERM_PHASE_SIGNAL_NAMESPACE];
}

async function migrateSource(source: LegacySource): Promise<number> {
  if (source.label === "daily ingestion") {
    return await migrateDailyIngestion(source);
  }
  if (source.label === "session ingestion") {
    return await migrateSessionIngestion(source);
  }
  if (source.label === "short-term recall") {
    return await migrateShortTermRecall(source);
  }
  return await migratePhaseSignals(source);
}

export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "memory-core-dreams-json-to-sqlite",
    label: "Memory Core dreaming state",
    async detectLegacyState(params) {
      configureMemoryCoreDreamingState(params.context.openPluginStateKeyedStore);
      const sources = await collectLegacySources(params.config, params.env);
      if (sources.length === 0) {
        return null;
      }
      return {
        preview: sources.map(
          (source) => `- Memory Core ${source.label}: ${source.filePath} -> SQLite plugin state`,
        ),
      };
    },
    async migrateLegacyState(params) {
      configureMemoryCoreDreamingState(params.context.openPluginStateKeyedStore);
      const changes: string[] = [];
      const warnings: string[] = [];
      for (const source of await collectLegacySources(params.config, params.env)) {
        const targetHasRows = (
          await Promise.all(
            targetNamespacesForSource(source.label).map((namespace) =>
              workspaceHasRows(namespace, source.workspaceDir),
            ),
          )
        ).some(Boolean);
        if (targetHasRows) {
          warnings.push(
            `Skipped Memory Core ${source.label} import for ${source.workspaceDir} because SQLite rows already exist; left legacy source in place`,
          );
          continue;
        }
        let imported: number;
        try {
          imported = await migrateSource(source);
        } catch (err) {
          warnings.push(
            `Skipped Memory Core ${source.label} import for ${source.workspaceDir} because the legacy source could not be imported: ${String(err)}`,
          );
          continue;
        }
        changes.push(
          `Migrated Memory Core ${source.label} -> SQLite plugin state (${imported} row(s))`,
        );
        await archiveLegacySource({
          filePath: source.filePath,
          label: source.label,
          changes,
          warnings,
        });
      }
      return { changes, warnings };
    },
  },
  {
    id: "memory-core-legacy-sidecar-index-to-agent-sqlite",
    label: "Memory Core legacy memory index sidecar",
    async detectLegacyState(params) {
      const sources = await collectLegacyMemorySidecarSources({
        config: params.config,
        env: params.env,
        stateDir: params.stateDir,
      });
      if (sources.length === 0) {
        return null;
      }
      return {
        preview: sources.map(
          (source) =>
            `- Memory Core legacy memory index: ${source.legacyPath} -> ${source.agentDatabasePath}`,
        ),
      };
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      for (const source of await collectLegacyMemorySidecarSources({
        config: params.config,
        env: params.env,
        stateDir: params.stateDir,
      })) {
        try {
          await migrateLegacyMemorySidecarSource({
            source,
            env: params.env,
            changes,
            warnings,
          });
        } catch (err) {
          warnings.push(
            `Skipped Memory Core legacy memory index import for agent ${source.agentId} because the sidecar could not be imported: ${String(err)}`,
          );
        }
      }
      return { changes, warnings };
    },
  },
];
