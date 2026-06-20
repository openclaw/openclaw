// Memory Core doctor contract migrates shipped workspace dreaming state.
import fs from "node:fs/promises";
import path from "node:path";
import {
  listAgentIds,
  resolveDefaultAgentId,
  resolveAgentWorkspaceDir,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor";
import { root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import { updateDreamsFile } from "./src/dreaming-dreams-file.js";
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
  migrateMemoryCoreWorkspaceNamespaceToAgent,
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
  stateWorkspaceDir: string;
  agentId: string;
  label: string;
  relativePath: string;
  filePath: string;
};

type WorkspaceTarget = {
  workspaceDir: string;
  stateWorkspaceDir: string;
  stateWorkspaceDirs: string[];
  agentIds: string[];
  agentWorkspaceDirs: Record<string, string>;
  agentId?: string;
};

const LEGACY_JSON_CANDIDATES = [
  { label: "daily ingestion", relativePath: DAILY_INGESTION_STATE_RELATIVE_PATH },
  { label: "session ingestion", relativePath: SESSION_INGESTION_STATE_RELATIVE_PATH },
  { label: "short-term recall", relativePath: SHORT_TERM_STORE_RELATIVE_PATH },
  { label: "phase signals", relativePath: SHORT_TERM_PHASE_SIGNAL_RELATIVE_PATH },
] as const;

const SCOPED_STATE_NAMESPACES = [
  { namespace: DREAMING_DAILY_INGESTION_NAMESPACE, label: "daily ingestion" },
  { namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE, label: "session ingestion files" },
  { namespace: DREAMING_SESSION_INGESTION_SEEN_NAMESPACE, label: "session ingestion seen state" },
  { namespace: SHORT_TERM_RECALL_NAMESPACE, label: "short-term recall" },
  { namespace: SHORT_TERM_PHASE_SIGNAL_NAMESPACE, label: "phase signals" },
  { namespace: SHORT_TERM_META_NAMESPACE, label: "short-term metadata" },
] as const;

async function resolveConfiguredWorkspaces(
  config: unknown,
  env: NodeJS.ProcessEnv,
): Promise<WorkspaceTarget[]> {
  const cfg = config as Parameters<typeof listAgentIds>[0];
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const targets = new Map<string, WorkspaceTarget>();
  for (const configuredAgentId of listAgentIds(cfg)) {
    const workspaceDir = resolveAgentWorkspaceDir(cfg, configuredAgentId, env);
    const workspaceRoot = await fs.realpath(workspaceDir).catch(() => path.resolve(workspaceDir));
    const existing = targets.get(workspaceRoot);
    if (existing) {
      existing.agentIds.push(configuredAgentId);
      existing.agentWorkspaceDirs[configuredAgentId] = workspaceDir;
      if (!existing.stateWorkspaceDirs.includes(workspaceDir)) {
        existing.stateWorkspaceDirs.push(workspaceDir);
      }
    } else {
      targets.set(workspaceRoot, {
        workspaceDir: workspaceRoot,
        stateWorkspaceDir: workspaceDir,
        stateWorkspaceDirs: [...new Set([workspaceDir, workspaceRoot])],
        agentIds: [configuredAgentId],
        agentWorkspaceDirs: { [configuredAgentId]: workspaceDir },
      });
    }
  }
  return [...targets.values()].map((target) => {
    const agentId =
      target.agentIds.length === 1
        ? target.agentIds[0]
        : target.agentIds.includes(defaultAgentId)
          ? defaultAgentId
          : undefined;
    const resolved: WorkspaceTarget = {
      workspaceDir: target.workspaceDir,
      stateWorkspaceDir: agentId
        ? (target.agentWorkspaceDirs[agentId] ?? target.stateWorkspaceDir)
        : target.stateWorkspaceDir,
      stateWorkspaceDirs: target.stateWorkspaceDirs,
      agentIds: target.agentIds,
      agentWorkspaceDirs: target.agentWorkspaceDirs,
    };
    if (agentId) {
      // Legacy workspace-scoped dreaming state was shared. Preserve it under
      // the resolved default agent rather than copying private state to peers.
      resolved.agentId = agentId;
    }
    return resolved;
  });
}

function isAgentScopedWorkspaceTarget(
  target: WorkspaceTarget,
): target is WorkspaceTarget & { agentId: string } {
  return typeof target.agentId === "string";
}

async function resolveAgentScopedWorkspaces(
  config: unknown,
  env: NodeJS.ProcessEnv,
): Promise<Array<WorkspaceTarget & { agentId: string }>> {
  return (await resolveConfiguredWorkspaces(config, env)).filter(isAgentScopedWorkspaceTarget);
}

function formatSharedWorkspaceMigrationWarning(target: WorkspaceTarget): string {
  return `Skipped automatic Memory Core dreaming migration for shared workspace ${target.workspaceDir}; its resolved default agent does not share the workspace with ${target.agentIds.join(", ")}`;
}

async function collectSharedJsonMigrationWarnings(
  config: unknown,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const warnings: string[] = [];
  for (const target of await resolveConfiguredWorkspaces(config, env)) {
    if (isAgentScopedWorkspaceTarget(target)) {
      continue;
    }
    for (const candidate of LEGACY_JSON_CANDIDATES) {
      if (await workspaceFileExists(target.workspaceDir, candidate.relativePath)) {
        warnings.push(formatSharedWorkspaceMigrationWarning(target));
        break;
      }
    }
  }
  return warnings;
}

async function collectSharedAgentScopeMigrationWarnings(
  config: unknown,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const warnings: string[] = [];
  for (const target of await resolveConfiguredWorkspaces(config, env)) {
    if (isAgentScopedWorkspaceTarget(target)) {
      continue;
    }
    const hasUnscopedState = (
      await Promise.all(
        SCOPED_STATE_NAMESPACES.map(async (candidate) => {
          return (
            await Promise.all(
              target.stateWorkspaceDirs.map(async (workspaceDir) => {
                const entries = await readMemoryCoreWorkspaceEntries({
                  namespace: candidate.namespace,
                  workspaceDir,
                });
                return entries.length > 0;
              }),
            )
          ).some(Boolean);
        }),
      )
    ).some(Boolean);
    const hasLegacyDiary = (
      await Promise.all(
        ["DREAMS.md", "dreams.md"].map((relativePath) =>
          workspaceFileExists(target.workspaceDir, relativePath),
        ),
      )
    ).some(Boolean);
    if (hasUnscopedState || hasLegacyDiary) {
      warnings.push(formatSharedWorkspaceMigrationWarning(target));
    }
  }
  return warnings;
}

async function workspaceFileExists(workspaceDir: string, relativePath: string): Promise<boolean> {
  try {
    const workspace = await fsRoot(workspaceDir);
    const opened = await workspace.open(relativePath);
    try {
      return opened.stat.isFile();
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
  } catch {
    return false;
  }
}

async function readWorkspaceRegularFile(
  workspaceDir: string,
  relativePath: string,
): Promise<Buffer> {
  const workspace = await fsRoot(workspaceDir);
  const opened = await workspace.open(relativePath);
  try {
    if (!opened.stat.isFile()) {
      throw new Error("source is not a regular file");
    }
    return await opened.handle.readFile();
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

async function readJsonFile(workspaceDir: string, relativePath: string): Promise<unknown> {
  return JSON.parse((await readWorkspaceRegularFile(workspaceDir, relativePath)).toString("utf8"));
}

async function archiveLegacySource(params: {
  workspaceDir: string;
  relativePath: string;
  label: string;
  changes: string[];
  warnings: string[];
}): Promise<void> {
  const workspace = await fsRoot(params.workspaceDir);
  const archivedRelativePath = `${params.relativePath}.migrated`;
  const filePath = path.join(params.workspaceDir, params.relativePath);
  const archivedPath = path.join(params.workspaceDir, archivedRelativePath);
  if (await workspaceFileExists(params.workspaceDir, archivedRelativePath)) {
    params.warnings.push(
      `Left migrated Memory Core ${params.label} source in place because ${archivedPath} already exists`,
    );
    return;
  }
  try {
    await workspace.move(params.relativePath, archivedRelativePath);
    params.changes.push(`Archived Memory Core ${params.label} legacy source -> ${archivedPath}`);
  } catch (err) {
    params.warnings.push(
      `Failed archiving Memory Core ${params.label} source ${filePath}: ${String(err)}`,
    );
  }
}

async function collectLegacySources(
  config: unknown,
  env: NodeJS.ProcessEnv,
): Promise<LegacySource[]> {
  const sources: LegacySource[] = [];
  for (const target of await resolveAgentScopedWorkspaces(config, env)) {
    const { workspaceDir, stateWorkspaceDir, agentId } = target;
    for (const candidate of LEGACY_JSON_CANDIDATES) {
      const filePath = path.join(workspaceDir, candidate.relativePath);
      if (await workspaceFileExists(workspaceDir, candidate.relativePath)) {
        sources.push({
          workspaceDir,
          stateWorkspaceDir,
          agentId,
          label: candidate.label,
          relativePath: candidate.relativePath,
          filePath,
        });
      }
    }
  }
  return sources;
}

async function workspaceHasRows(
  namespace: string,
  stateWorkspaceDir: string,
  agentId: string,
): Promise<boolean> {
  return (
    (await readMemoryCoreWorkspaceEntries({ namespace, workspaceDir: stateWorkspaceDir, agentId }))
      .length > 0
  );
}

async function migrateDailyIngestion(source: LegacySource): Promise<number> {
  const state = normalizeDailyIngestionState(
    await readJsonFile(source.workspaceDir, source.relativePath),
  );
  await writeMemoryCoreWorkspaceEntries({
    namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
    workspaceDir: source.stateWorkspaceDir,
    agentId: source.agentId,
    entries: Object.entries(state.files).map(([key, value]) => ({ key, value })),
  });
  return Object.keys(state.files).length;
}

async function migrateSessionIngestion(source: LegacySource): Promise<number> {
  const state = normalizeSessionIngestionState(
    await readJsonFile(source.workspaceDir, source.relativePath),
  );
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
      workspaceDir: source.stateWorkspaceDir,
      agentId: source.agentId,
      entries: Object.entries(state.files).map(([key, value]) => ({ key, value })),
    }),
    writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
      workspaceDir: source.stateWorkspaceDir,
      agentId: source.agentId,
      entries: seenEntries,
    }),
  ]);
  return Object.keys(state.files).length + Object.keys(state.seenMessages).length;
}

async function migrateShortTermRecall(source: LegacySource): Promise<number> {
  const nowIso = new Date().toISOString();
  const state = normalizeShortTermRecallStore(
    await readJsonFile(source.workspaceDir, source.relativePath),
    nowIso,
  );
  await Promise.all([
    writeMemoryCoreWorkspaceEntries({
      namespace: SHORT_TERM_RECALL_NAMESPACE,
      workspaceDir: source.stateWorkspaceDir,
      agentId: source.agentId,
      entries: Object.entries(state.entries).map(([key, value]) => ({ key, value })),
    }),
    writeMemoryCoreWorkspaceEntry({
      namespace: SHORT_TERM_META_NAMESPACE,
      workspaceDir: source.stateWorkspaceDir,
      agentId: source.agentId,
      key: "recall",
      value: { updatedAt: state.updatedAt },
    }),
  ]);
  return Object.keys(state.entries).length;
}

async function migratePhaseSignals(source: LegacySource): Promise<number> {
  const nowIso = new Date().toISOString();
  const state = normalizeShortTermPhaseSignalStore(
    await readJsonFile(source.workspaceDir, source.relativePath),
    nowIso,
  );
  await Promise.all([
    writeMemoryCoreWorkspaceEntries({
      namespace: SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
      workspaceDir: source.stateWorkspaceDir,
      agentId: source.agentId,
      entries: Object.entries(state.entries).map(([key, value]) => ({ key, value })),
    }),
    writeMemoryCoreWorkspaceEntry({
      namespace: SHORT_TERM_META_NAMESPACE,
      workspaceDir: source.stateWorkspaceDir,
      agentId: source.agentId,
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

async function collectUnscopedStateTargets(
  config: unknown,
  env: NodeJS.ProcessEnv,
): Promise<
  Array<
    WorkspaceTarget & {
      agentId: string;
      sourceStateWorkspaceDir: string;
      namespace: string;
      label: string;
      entryCount: number;
    }
  >
> {
  const sources: Array<
    WorkspaceTarget & {
      agentId: string;
      sourceStateWorkspaceDir: string;
      namespace: string;
      label: string;
      entryCount: number;
    }
  > = [];
  for (const target of await resolveAgentScopedWorkspaces(config, env)) {
    for (const sourceStateWorkspaceDir of target.stateWorkspaceDirs) {
      for (const candidate of SCOPED_STATE_NAMESPACES) {
        const entryCount = (
          await readMemoryCoreWorkspaceEntries({
            namespace: candidate.namespace,
            workspaceDir: sourceStateWorkspaceDir,
          })
        ).length;
        if (entryCount > 0) {
          sources.push({ ...target, sourceStateWorkspaceDir, ...candidate, entryCount });
        }
      }
    }
  }
  return sources;
}

async function collectLegacyDreamDiarySources(
  config: unknown,
  env: NodeJS.ProcessEnv,
): Promise<Array<WorkspaceTarget & { agentId: string; relativePath: string; filePath: string }>> {
  const sources: Array<
    WorkspaceTarget & { agentId: string; relativePath: string; filePath: string }
  > = [];
  for (const target of await resolveAgentScopedWorkspaces(config, env)) {
    const seenPaths = new Set<string>();
    for (const filename of ["DREAMS.md", "dreams.md"]) {
      const filePath = path.join(target.workspaceDir, filename);
      if (await workspaceFileExists(target.workspaceDir, filename)) {
        const realPath = await fs.realpath(filePath).catch(() => filePath);
        if (!seenPaths.has(realPath)) {
          seenPaths.add(realPath);
          sources.push({ ...target, relativePath: filename, filePath });
        }
      }
    }
  }
  return sources;
}

async function migrateLegacyDreamDiary(params: {
  workspaceDir: string;
  agentId: string;
  relativePath: string;
  filePath: string;
  changes: string[];
  warnings: string[];
}): Promise<void> {
  let legacyContent: string;
  try {
    legacyContent = (
      await readWorkspaceRegularFile(params.workspaceDir, params.relativePath)
    ).toString("utf8");
  } catch {
    params.warnings.push(
      `Skipped Memory Core dream diary migration for ${params.filePath} because it is not a regular file`,
    );
    return;
  }
  try {
    await updateDreamsFile({
      workspaceDir: params.workspaceDir,
      agentId: params.agentId,
      updater: (existing) => {
        const normalizedLegacy = legacyContent.trim();
        const migratedPrefix = `${legacyContent.trimEnd()}\n\n<!-- openclaw:dreaming:legacy-diary-migrated -->`;
        if (
          !normalizedLegacy ||
          existing.trim() === normalizedLegacy ||
          existing.includes(migratedPrefix)
        ) {
          return { content: existing, result: undefined, shouldWrite: false };
        }
        if (!existing.trim()) {
          return { content: legacyContent, result: undefined };
        }
        return {
          content: `${legacyContent.trimEnd()}\n\n<!-- openclaw:dreaming:legacy-diary-migrated -->\n\n${existing.trimStart()}`,
          result: undefined,
        };
      },
    });
  } catch (err) {
    params.warnings.push(
      `Skipped Memory Core dream diary migration for ${params.filePath}: ${String(err)}`,
    );
    return;
  }
  await archiveLegacySource({
    workspaceDir: params.workspaceDir,
    relativePath: params.relativePath,
    label: "dream diary",
    changes: params.changes,
    warnings: params.warnings,
  });
  params.changes.push(`Migrated Memory Core dream diary -> agent-scoped path (${params.agentId})`);
}

export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "memory-core-dreams-json-to-sqlite",
    label: "Memory Core dreaming state",
    async detectLegacyState(params) {
      configureMemoryCoreDreamingState(params.context.openPluginStateKeyedStore);
      const [sources, sharedWarnings] = await Promise.all([
        collectLegacySources(params.config, params.env),
        collectSharedJsonMigrationWarnings(params.config, params.env),
      ]);
      if (sources.length === 0 && sharedWarnings.length === 0) {
        return null;
      }
      return {
        preview: [
          ...sources.map(
            (source) => `- Memory Core ${source.label}: ${source.filePath} -> SQLite plugin state`,
          ),
          ...sharedWarnings.map((warning) => `- ${warning}`),
        ],
      };
    },
    async migrateLegacyState(params) {
      configureMemoryCoreDreamingState(params.context.openPluginStateKeyedStore);
      const changes: string[] = [];
      const warnings = await collectSharedJsonMigrationWarnings(params.config, params.env);
      for (const source of await collectLegacySources(params.config, params.env)) {
        const targetHasRows = (
          await Promise.all(
            targetNamespacesForSource(source.label).map((namespace) =>
              workspaceHasRows(namespace, source.stateWorkspaceDir, source.agentId),
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
          workspaceDir: source.workspaceDir,
          relativePath: source.relativePath,
          label: source.label,
          changes,
          warnings,
        });
      }
      return { changes, warnings };
    },
  },
  {
    id: "memory-core-workspace-state-to-agent-scope",
    label: "Memory Core agent-scoped dreaming state",
    async detectLegacyState(params) {
      configureMemoryCoreDreamingState(params.context.openPluginStateKeyedStore);
      const [stateSources, diarySources, sharedWarnings] = await Promise.all([
        collectUnscopedStateTargets(params.config, params.env),
        collectLegacyDreamDiarySources(params.config, params.env),
        collectSharedAgentScopeMigrationWarnings(params.config, params.env),
      ]);
      if (stateSources.length === 0 && diarySources.length === 0 && sharedWarnings.length === 0) {
        return null;
      }
      return {
        preview: [
          ...stateSources.map(
            (source) =>
              `- Memory Core ${source.label}: ${source.entryCount} workspace-scoped row(s) -> agent ${source.agentId}`,
          ),
          ...diarySources.map(
            (source) => `- Memory Core dream diary: ${source.filePath} -> agent ${source.agentId}`,
          ),
          ...sharedWarnings.map((warning) => `- ${warning}`),
        ],
      };
    },
    async migrateLegacyState(params) {
      configureMemoryCoreDreamingState(params.context.openPluginStateKeyedStore);
      const changes: string[] = [];
      const warnings = await collectSharedAgentScopeMigrationWarnings(params.config, params.env);
      for (const source of await collectUnscopedStateTargets(params.config, params.env)) {
        const result = await migrateMemoryCoreWorkspaceNamespaceToAgent({
          namespace: source.namespace,
          agentId: source.agentId,
          sourceWorkspaceDir: source.sourceStateWorkspaceDir,
          workspaceDir: source.stateWorkspaceDir,
        });
        if (result.sourceEntries > 0) {
          changes.push(
            `Migrated Memory Core ${source.label} -> agent-scoped SQLite state (${result.migratedEntries} row(s), ${result.retainedAgentEntries} existing agent row(s) retained)`,
          );
        }
      }
      for (const source of await collectLegacyDreamDiarySources(params.config, params.env)) {
        await migrateLegacyDreamDiary({ ...source, changes, warnings });
      }
      return { changes, warnings };
    },
  },
];
