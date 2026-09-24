// Accessor-backed transcript corpus discovery for memory session indexing.
import fsSync, { type BigIntStats, type Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeAgentId } from "./config-utils.js";
import { isFileMissingError } from "./fs-utils.js";
import {
  isDreamingNarrativeSessionStoreKey,
  extractAgentIdFromSessionsDir,
  canonicalizeMainSessionAlias,
  cloneEnvWithPlatformSemantics,
  getRuntimeConfig,
  isCronRunSessionKey,
  isSessionArchiveArtifactName,
  isUsageCountedSessionTranscriptFileName,
  listSessionEntriesCore,
  listSessionEntriesReadOnly,
  listSessionTranscriptArchivesReadOnly,
  listSessionTranscriptInstances,
  parseUsageCountedSessionIdFromFileName,
  readTranscriptContentRevisionSync,
  resolveSessionAgentId,
  resolveSessionTranscriptsDirForAgent,
  resolveStorePath,
  type SessionEntry,
  type SessionTranscriptInstance,
} from "./openclaw-runtime-session.js";
import type { MemorySessionKind } from "./types.js";

type SessionTranscriptCorpusArtifactKind =
  | "active-session"
  | "retained-session"
  | "archive-artifact";

export type SessionTranscriptCorpusOptions = {
  /** Include rotated SQLite transcript identities retained behind current logical sessions. */
  includeRetainedSqlite?: boolean;
  /** Skip per-transcript revision reads when a caller only needs discovery metadata. */
  includeContentRevision?: boolean;
  /** Read session entries without joining the agent database writable lifecycle. */
  readOnly?: boolean;
};

export type SessionTranscriptCorpusEntry = {
  agentId: string;
  sessionFile: string;
  sessionId: string;
  /** Canonical source revision used by derived transcript consumers. */
  contentRevision?: string;
  artifactKind: SessionTranscriptCorpusArtifactKind;
  sessionKey?: string;
  storePath?: string;
  /** Present when an active transcript is addressed by SQLite identity, not a JSONL path. */
  transcriptSource?: "sqlite";
  /** Session entry activity timestamp used when the source has no filesystem stat. */
  updatedAtMs?: number;
  /** True when this transcript belongs to an internal dreaming narrative run. */
  generatedByDreamingNarrative?: boolean;
  /** True when this transcript belongs to an isolated cron run session. */
  generatedByCronRun?: boolean;
  sessionKind?: MemorySessionKind;
};

function fileContentRevision(filePath: string): string | undefined {
  try {
    return fileContentRevisionFromStat(fsSync.statSync(filePath, { bigint: true }));
  } catch {
    return undefined;
  }
}

function fileContentRevisionFromStat(stat: BigIntStats): string | undefined {
  return stat.isFile()
    ? `file:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
    : undefined;
}

function sqliteContentRevision(params: {
  agentId: string;
  env: NodeJS.ProcessEnv;
  sessionId: string;
  sessionKey?: string;
  storePath: string;
}): string | undefined {
  try {
    return readTranscriptContentRevisionSync(params);
  } catch {
    return undefined;
  }
}

type SessionEntrySummary = {
  sessionKey: string;
  entry: SessionEntry;
};

function isDreamingNarrativeSessionKeyLike(value: unknown): boolean {
  return typeof value === "string" && isDreamingNarrativeSessionStoreKey(value);
}

function normalizeComparablePath(pathname: string): string {
  const resolved = path.resolve(pathname);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function normalizeRealComparablePath(pathname: string): string {
  try {
    return normalizeComparablePath(fsSync.realpathSync(pathname));
  } catch {
    try {
      return normalizeComparablePath(
        path.join(fsSync.realpathSync(path.dirname(pathname)), path.basename(pathname)),
      );
    } catch {
      return normalizeComparablePath(pathname);
    }
  }
}

async function normalizeRealComparablePathAsync(pathname: string): Promise<string> {
  try {
    return normalizeComparablePath(await fs.realpath(pathname));
  } catch {
    try {
      return normalizeComparablePath(
        path.join(await fs.realpath(path.dirname(pathname)), path.basename(pathname)),
      );
    } catch {
      return normalizeComparablePath(pathname);
    }
  }
}

function classifySessionEntry(
  sessionKey: string,
  entry: SessionEntry,
  cronGeneratedSessionKeys: ReadonlySet<string>,
): {
  generatedByDreamingNarrative: boolean;
  generatedByCronRun: boolean;
  sessionKind: MemorySessionKind;
} {
  const generatedByDreamingNarrative =
    isDreamingNarrativeSessionStoreKey(sessionKey) ||
    isDreamingNarrativeSessionKeyLike(entry.spawnedBy);
  const generatedByCronRun = cronGeneratedSessionKeys.has(sessionKey);
  return {
    generatedByDreamingNarrative,
    generatedByCronRun,
    sessionKind: generatedByCronRun
      ? "cron"
      : typeof entry.heartbeatIsolatedBaseSessionKey === "string" &&
          entry.heartbeatIsolatedBaseSessionKey.trim()
        ? "heartbeat"
        : generatedByDreamingNarrative || Boolean(entry.spawnedBy)
          ? "subagent"
          : sessionKey.includes(":subagent:")
            ? "subagent"
            : "interactive",
  };
}

function readParentSessionKeys(entry: SessionEntry | undefined): string[] {
  const keys = new Set<string>();
  for (const value of [entry?.parentSessionKey, entry?.spawnedBy]) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      keys.add(trimmed);
    }
  }
  return [...keys];
}

function collectCronGeneratedSessionKeys(
  summaries: readonly SessionEntrySummary[],
): ReadonlySet<string> {
  // Build the cron-generated closure once so active entries and archive
  // artifacts share the same lineage classification.
  const entriesByKey = new Map(summaries.map((summary) => [summary.sessionKey, summary.entry]));
  const cronGeneratedKeys = new Set<string>();
  const cache = new Map<string, boolean>();
  const resolving = new Set<string>();

  const isCronGenerated = (sessionKey: string, entry: SessionEntry | undefined): boolean => {
    if (isCronRunSessionKey(sessionKey)) {
      cache.set(sessionKey, true);
      cronGeneratedKeys.add(sessionKey);
      return true;
    }
    const cached = cache.get(sessionKey);
    if (cached !== undefined) {
      return cached;
    }
    if (resolving.has(sessionKey)) {
      return false;
    }

    resolving.add(sessionKey);
    const generated = readParentSessionKeys(entry).some(
      (parentKey) =>
        // Parent rows can be pruned before child rows; a cron-shaped parent key
        // still carries cron lineage without requiring a store entry.
        isCronRunSessionKey(parentKey) || isCronGenerated(parentKey, entriesByKey.get(parentKey)),
    );
    resolving.delete(sessionKey);
    cache.set(sessionKey, generated);
    if (generated) {
      cronGeneratedKeys.add(sessionKey);
    }
    return generated;
  };

  for (const summary of summaries) {
    isCronGenerated(summary.sessionKey, summary.entry);
  }
  return cronGeneratedKeys;
}

function toSessionStoreCorpusEntry(
  agentId: string,
  storePath: string,
  summary: SessionEntrySummary,
  cronGeneratedSessionKeys: ReadonlySet<string>,
  includeContentRevision: boolean,
  env: NodeJS.ProcessEnv,
): SessionTranscriptCorpusEntry | null {
  const sessionId = summary.entry.sessionId?.trim();
  if (!sessionId) {
    return null;
  }
  const sessionKey = summary.sessionKey.trim();
  const classification = classifySessionEntry(
    summary.sessionKey,
    summary.entry,
    cronGeneratedSessionKeys,
  );
  const contentRevision = includeContentRevision
    ? sqliteContentRevision({
        agentId,
        env,
        sessionId,
        ...(sessionKey ? { sessionKey } : {}),
        storePath,
      })
    : undefined;
  return {
    agentId,
    artifactKind: "active-session",
    sessionFile: sessionKey,
    sessionId,
    ...(contentRevision ? { contentRevision } : {}),
    transcriptSource: "sqlite",
    storePath,
    ...(Number.isFinite(summary.entry.updatedAt) ? { updatedAtMs: summary.entry.updatedAt } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(classification.generatedByDreamingNarrative ? { generatedByDreamingNarrative: true } : {}),
    ...(classification.generatedByCronRun ? { generatedByCronRun: true } : {}),
    sessionKind: classification.sessionKind,
  };
}

function toRetainedSessionCorpusEntry(
  agentId: string,
  instance: SessionTranscriptInstance,
  sessionKey: string,
  storePath: string,
  cronGeneratedSessionKeys: ReadonlySet<string>,
  includeContentRevision: boolean,
  env: NodeJS.ProcessEnv,
): SessionTranscriptCorpusEntry | null {
  // Retained rows predate the current logical session entry. Only rows whose
  // exclusion-sensitive ownership was captured may enter historical ingestion.
  if (
    !instance.provenanceKnown ||
    instance.acpOwned ||
    instance.entry.pluginOwnerId ||
    instance.entry.hookExternalContentSource
  ) {
    return null;
  }
  const classification = classifySessionEntry(sessionKey, instance.entry, cronGeneratedSessionKeys);
  const contentRevision = includeContentRevision
    ? sqliteContentRevision({
        agentId,
        env,
        sessionId: instance.sessionId,
        ...(sessionKey ? { sessionKey } : {}),
        storePath,
      })
    : undefined;
  return {
    agentId,
    artifactKind: "retained-session",
    sessionFile: sessionKey,
    sessionId: instance.sessionId,
    ...(contentRevision ? { contentRevision } : {}),
    storePath,
    transcriptSource: "sqlite",
    updatedAtMs: instance.updatedAtMs,
    ...(sessionKey ? { sessionKey } : {}),
    ...(classification.generatedByDreamingNarrative ? { generatedByDreamingNarrative: true } : {}),
    ...(classification.generatedByCronRun ? { generatedByCronRun: true } : {}),
    sessionKind: classification.sessionKind,
  };
}

function listSessionTranscriptArtifactFiles(sessionsDir: string): string[] {
  try {
    return sessionTranscriptArtifactPaths(
      sessionsDir,
      fsSync.readdirSync(sessionsDir, { withFileTypes: true }),
    );
  } catch (err) {
    // A missing artifact directory is authoritatively empty. Other failures
    // make the corpus incomplete, so destructive consumers must not proceed.
    if (isFileMissingError(err) && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

function sessionTranscriptArtifactPaths(sessionsDir: string, entries: Dirent[]): string[] {
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => isUsageCountedSessionTranscriptFileName(name))
    .filter((name) => isSessionArchiveArtifactName(name))
    .map((name) => path.join(sessionsDir, name));
}

function toArtifactCorpusEntry(
  agentId: string,
  artifactPath: string,
  sessionId: string,
  primaryEntry?: SessionTranscriptCorpusEntry,
  contentRevision?: string,
): SessionTranscriptCorpusEntry {
  return {
    agentId,
    artifactKind: "archive-artifact",
    sessionFile: artifactPath,
    sessionId,
    ...(contentRevision ? { contentRevision } : {}),
    ...(primaryEntry?.generatedByDreamingNarrative ? { generatedByDreamingNarrative: true } : {}),
    ...(primaryEntry?.generatedByCronRun ? { generatedByCronRun: true } : {}),
    sessionKind: primaryEntry?.sessionKind ?? "unknown",
  };
}

function resolveSessionTranscriptCorpusScope(agentId: string) {
  const normalizedAgentId = normalizeAgentId(agentId);
  const cfg = getRuntimeConfig();
  const env = cloneEnvWithPlatformSemantics(process.env);
  const configuredStore = cfg.session?.store;
  const storePath = resolveStorePath(configuredStore, {
    agentId: normalizedAgentId,
    env,
  });
  const sessionsDir = path.dirname(storePath);
  const fixedStoreOwnerAgentId = extractAgentIdFromSessionsDir(sessionsDir);
  const isAgentOwnedFixedStore =
    fixedStoreOwnerAgentId !== null &&
    normalizeAgentId(fixedStoreOwnerAgentId) === normalizedAgentId;
  const isSharedFixedStore =
    typeof configuredStore === "string" &&
    configuredStore.trim().length > 0 &&
    !configuredStore.includes("{agentId}") &&
    !isAgentOwnedFixedStore;
  return {
    cfg,
    env,
    normalizedAgentId,
    storePath,
    isSharedFixedStore,
    artifactDirs: [sessionsDir, resolveSessionTranscriptsDirForAgent(normalizedAgentId, env)],
  };
}

type SessionTranscriptCorpusArtifact = {
  path: string;
  contentRevision?: string;
};

function projectSessionTranscriptCorpusEntries(
  scope: ReturnType<typeof resolveSessionTranscriptCorpusScope>,
  options: SessionTranscriptCorpusOptions,
  artifacts: readonly SessionTranscriptCorpusArtifact[],
): SessionTranscriptCorpusEntry[] {
  const { cfg, env, normalizedAgentId, storePath, isSharedFixedStore } = scope;
  const includeContentRevision = options.includeContentRevision !== false;
  const activeEntriesBySessionId = new Map<string, SessionTranscriptCorpusEntry>();
  const entryOwnersBySessionId = new Map<string, string>();
  const listEntries =
    options.readOnly === true ? listSessionEntriesReadOnly : listSessionEntriesCore;
  const sessionEntries = listEntries({
    agentId: normalizedAgentId,
    env,
    hydrateSkillPromptRefs: false,
    projection: "list",
    storePath,
  });
  const retainedInstances = options.includeRetainedSqlite
    ? listSessionTranscriptInstances({
        agentId: normalizedAgentId,
        env,
        hydrateSkillPromptRefs: false,
        projection: "list",
        readConsistency: "latest",
        storePath,
      })
    : [];
  const archivedIdentitiesByName = new Map(
    listSessionTranscriptArchivesReadOnly({
      agentId: normalizedAgentId,
      env,
      archiveNames: artifacts.map((artifact) => path.basename(artifact.path)),
      storePath,
    }).map((archive) => [archive.archiveName, archive]),
  );
  const cronGeneratedSessionKeys = collectCronGeneratedSessionKeys([
    ...retainedInstances.map(({ entry, sessionKey }) => ({ entry, sessionKey })),
    ...sessionEntries,
  ]);
  for (const summary of sessionEntries) {
    const sessionKey = isSharedFixedStore
      ? summary.sessionKey
      : canonicalizeMainSessionAlias({
          cfg,
          agentId: normalizedAgentId,
          sessionKey: summary.sessionKey,
        });
    const ownerAgentId = resolveSessionAgentId({
      config: cfg,
      sessionKey,
      ...(isSharedFixedStore ? {} : { fallbackAgentId: normalizedAgentId }),
    });
    const entry = toSessionStoreCorpusEntry(
      ownerAgentId,
      storePath,
      summary,
      cronGeneratedSessionKeys,
      includeContentRevision,
      env,
    );
    if (!entry) {
      continue;
    }
    entryOwnersBySessionId.set(entry.sessionId, ownerAgentId);
    if (ownerAgentId === normalizedAgentId) {
      activeEntriesBySessionId.set(entry.sessionId, entry);
    }
  }
  const includeUnownedArtifacts = !isSharedFixedStore;
  const corpusEntries = [...activeEntriesBySessionId.values()];
  if (options.includeRetainedSqlite) {
    for (const instance of retainedInstances) {
      if (activeEntriesBySessionId.has(instance.sessionId)) {
        continue;
      }
      const sessionKey = isSharedFixedStore
        ? instance.sessionKey
        : canonicalizeMainSessionAlias({
            cfg,
            agentId: normalizedAgentId,
            sessionKey: instance.sessionKey,
          });
      const ownerAgentId = resolveSessionAgentId({
        config: cfg,
        sessionKey,
        ...(isSharedFixedStore ? {} : { fallbackAgentId: normalizedAgentId }),
      });
      if (ownerAgentId !== normalizedAgentId) {
        continue;
      }
      const entry = toRetainedSessionCorpusEntry(
        ownerAgentId,
        instance,
        sessionKey,
        storePath,
        cronGeneratedSessionKeys,
        includeContentRevision,
        env,
      );
      if (entry?.transcriptSource === "sqlite") {
        corpusEntries.push(entry);
      }
    }
  }
  for (const { path: artifactPath, contentRevision } of artifacts) {
    const artifactName = path.basename(artifactPath);
    const archivedIdentity = archivedIdentitiesByName.get(artifactName);
    const primarySessionId =
      archivedIdentity?.sessionId ?? parseUsageCountedSessionIdFromFileName(artifactName);
    if (!primarySessionId) {
      continue;
    }
    const primaryEntry = activeEntriesBySessionId.get(primarySessionId);
    const primaryOwner = entryOwnersBySessionId.get(primarySessionId);
    if (primaryOwner && primaryOwner !== normalizedAgentId) {
      continue;
    }
    if (!primaryOwner && !archivedIdentity && !includeUnownedArtifacts) {
      continue;
    }
    corpusEntries.push({
      ...toArtifactCorpusEntry(
        normalizedAgentId,
        artifactPath,
        primarySessionId,
        primaryEntry,
        contentRevision,
      ),
      ...(archivedIdentity?.sessionKey ? { sessionKey: archivedIdentity.sessionKey } : {}),
      ...(archivedIdentity ? { storePath } : {}),
    });
  }
  return corpusEntries;
}

export function listSessionTranscriptCorpusEntriesForAgentSync(
  agentId: string,
  options: SessionTranscriptCorpusOptions = {},
): SessionTranscriptCorpusEntry[] {
  const scope = resolveSessionTranscriptCorpusScope(agentId);
  const artifactDirs = new Map<string, string>();
  for (const dir of scope.artifactDirs) {
    artifactDirs.set(normalizeRealComparablePath(dir), dir);
  }
  const artifacts: SessionTranscriptCorpusArtifact[] = [];
  const seen = new Set<string>();
  for (const dir of artifactDirs.values()) {
    for (const artifactPath of listSessionTranscriptArtifactFiles(dir)) {
      const comparablePath = normalizeRealComparablePath(artifactPath);
      if (!seen.has(comparablePath)) {
        seen.add(comparablePath);
        artifacts.push({
          path: artifactPath,
          contentRevision:
            options.includeContentRevision !== false
              ? fileContentRevision(artifactPath)
              : undefined,
        });
      }
    }
  }
  return projectSessionTranscriptCorpusEntries(scope, options, artifacts);
}

/**
 * Lists transcript corpus entries for memory indexing.
 *
 * Active sessions come from the session accessor seam; retained reset/delete
 * transcript artifacts remain explicit file artifacts until core owns archive
 * artifact enumeration.
 */
export async function listSessionTranscriptCorpusEntriesForAgent(
  agentId: string,
  options: SessionTranscriptCorpusOptions = {},
): Promise<SessionTranscriptCorpusEntry[]> {
  const scope = resolveSessionTranscriptCorpusScope(agentId);
  const capturedOptions = { ...options };
  const artifactDirs = new Map<string, string>();
  for (const dir of scope.artifactDirs) {
    artifactDirs.set(await normalizeRealComparablePathAsync(dir), dir);
  }
  const artifacts: SessionTranscriptCorpusArtifact[] = [];
  const seen = new Set<string>();
  // Keep filesystem preparation sequential; none of it may block Gateway callbacks.
  for (const dir of artifactDirs.values()) {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isFileMissingError(error) && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    for (const artifactPath of sessionTranscriptArtifactPaths(dir, entries)) {
      const comparablePath = await normalizeRealComparablePathAsync(artifactPath);
      if (seen.has(comparablePath)) {
        continue;
      }
      seen.add(comparablePath);
      let contentRevision: string | undefined;
      if (capturedOptions.includeContentRevision !== false) {
        try {
          contentRevision = fileContentRevisionFromStat(
            await fs.stat(artifactPath, { bigint: true }),
          );
        } catch {
          contentRevision = undefined;
        }
      }
      artifacts.push({ path: artifactPath, contentRevision });
    }
  }
  // Read current session ownership only after the filesystem awaits, while retaining
  // the caller's resolved store and alias configuration for this complete projection.
  return projectSessionTranscriptCorpusEntries(scope, capturedOptions, artifacts);
}
