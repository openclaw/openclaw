// Accessor-backed transcript corpus discovery for memory/QMD session indexing.
import fsSync from "node:fs";
import path from "node:path";
import { normalizeAgentId } from "./config-utils.js";
import {
  canonicalizeMainSessionAlias,
  getRuntimeConfig,
  isCronRunSessionKey,
  isSessionArchiveArtifactName,
  isUsageCountedSessionTranscriptFileName,
  listSessionEntries,
  parseUsageCountedSessionIdFromFileName,
  resolveSessionAgentId,
  resolveSessionFilePath,
  resolveStorePath,
  type SessionEntry,
} from "./openclaw-runtime-session.js";

const DREAMING_NARRATIVE_RUN_PREFIX = "dreaming-narrative-";

export type SessionTranscriptCorpusArtifactKind =
  | "active-session"
  | "archive-artifact"
  | "orphan-file-artifact";

export type SessionTranscriptCorpusEntry = {
  agentId: string;
  sessionFile: string;
  sessionId: string;
  artifactKind: SessionTranscriptCorpusArtifactKind;
  sessionKey?: string;
  /** True when this transcript belongs to an internal dreaming narrative run. */
  generatedByDreamingNarrative?: boolean;
  /** True when this transcript belongs to an isolated cron run session. */
  generatedByCronRun?: boolean;
};

type SessionEntrySummary = {
  sessionKey: string;
  entry: SessionEntry;
};

function isDreamingNarrativeSessionStoreKey(sessionKey: string): boolean {
  const trimmed = sessionKey.trim();
  if (!trimmed) {
    return false;
  }
  const firstSeparator = trimmed.indexOf(":");
  if (firstSeparator < 0) {
    return trimmed.startsWith(DREAMING_NARRATIVE_RUN_PREFIX);
  }
  const secondSeparator = trimmed.indexOf(":", firstSeparator + 1);
  const sessionSegment = secondSeparator < 0 ? trimmed : trimmed.slice(secondSeparator + 1);
  return sessionSegment.startsWith(DREAMING_NARRATIVE_RUN_PREFIX);
}

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

function rememberArtifactDir(dirs: Map<string, string>, dir: string): void {
  dirs.set(normalizeRealComparablePath(dir), dir);
}

function extractAgentIdFromSessionPath(absPath: string): string | null {
  const parts = path.normalize(path.resolve(absPath)).split(path.sep).filter(Boolean);
  const sessionsIndex = parts.lastIndexOf("sessions");
  if (sessionsIndex < 2 || parts[sessionsIndex - 2] !== "agents") {
    return null;
  }
  return parts[sessionsIndex - 1] || null;
}

function extractAgentIdFromSessionsDir(sessionsDir: string): string | null {
  const parts = path.normalize(path.resolve(sessionsDir)).split(path.sep).filter(Boolean);
  const sessionsIndex = parts.length - 1;
  if (
    parts[sessionsIndex] !== "sessions" ||
    sessionsIndex < 2 ||
    parts[sessionsIndex - 2] !== "agents"
  ) {
    return null;
  }
  return parts[sessionsIndex - 1] || null;
}

function resolveSessionStoreTranscriptCorpusPath(
  agentId: string,
  sessionsDir: string,
  entry: { sessionFile?: unknown; sessionId?: unknown } | undefined,
): string | null {
  const sessionFile =
    typeof entry?.sessionFile === "string" && entry.sessionFile.trim().length > 0
      ? entry.sessionFile.trim()
      : undefined;
  const sessionId =
    typeof entry?.sessionId === "string" && entry.sessionId.trim().length > 0
      ? entry.sessionId.trim()
      : sessionFile
        ? parseUsageCountedSessionIdFromFileName(path.basename(sessionFile))
        : null;
  if (!sessionId) {
    return null;
  }
  try {
    if (!sessionFile) {
      return resolveSessionFilePath(sessionId, undefined, { agentId, sessionsDir });
    }
    const resolved = resolveSessionFilePath(
      sessionId,
      { sessionFile },
      {
        agentId,
        sessionsDir,
      },
    );
    if (!path.isAbsolute(sessionFile)) {
      const candidate = path.resolve(sessionsDir, sessionFile);
      if (
        normalizeComparablePath(path.dirname(candidate)) !== normalizeComparablePath(sessionsDir)
      ) {
        return null;
      }
      return normalizeRealComparablePath(resolved) === normalizeRealComparablePath(candidate)
        ? candidate
        : null;
    }
    const pathAgentId = extractAgentIdFromSessionPath(sessionFile);
    if (pathAgentId && normalizeAgentId(pathAgentId) !== normalizeAgentId(agentId)) {
      return null;
    }
    return normalizeRealComparablePath(resolved) === normalizeRealComparablePath(sessionFile)
      ? sessionFile
      : null;
  } catch {
    return null;
  }
}

function classifySessionEntry(
  sessionKey: string,
  entry: SessionEntry,
  cronGeneratedSessionKeys: ReadonlySet<string>,
): {
  generatedByDreamingNarrative: boolean;
  generatedByCronRun: boolean;
} {
  return {
    generatedByDreamingNarrative:
      isDreamingNarrativeSessionStoreKey(sessionKey) ||
      isDreamingNarrativeSessionKeyLike(entry.spawnedBy),
    generatedByCronRun: cronGeneratedSessionKeys.has(sessionKey),
  };
}

function collectCronGeneratedSessionKeys(
  summaries: readonly SessionEntrySummary[],
): ReadonlySet<string> {
  const entriesByKey = new Map(summaries.map((summary) => [summary.sessionKey, summary.entry]));
  const cronGeneratedKeys = new Set<string>();
  const cache = new Map<string, boolean>();

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

    // Store a temporary false before following parent links so cyclic
    // spawnedBy chains terminate without classifying the cycle as cron.
    cache.set(sessionKey, false);
    const parentKey = typeof entry?.spawnedBy === "string" ? entry.spawnedBy.trim() : "";
    const generated =
      parentKey.length > 0 &&
      (isCronRunSessionKey(parentKey) || isCronGenerated(parentKey, entriesByKey.get(parentKey)));
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

function isRegularSessionTranscriptFile(absPath: string): boolean {
  try {
    return fsSync.lstatSync(absPath).isFile();
  } catch {
    return false;
  }
}

function toSessionStoreCorpusEntry(
  agentId: string,
  sessionsDir: string,
  summary: SessionEntrySummary,
  cronGeneratedSessionKeys: ReadonlySet<string>,
): SessionTranscriptCorpusEntry | null {
  const sessionFile = resolveSessionStoreTranscriptCorpusPath(agentId, sessionsDir, summary.entry);
  if (!sessionFile || !isUsageCountedSessionTranscriptFileName(path.basename(sessionFile))) {
    return null;
  }
  const sessionId =
    typeof summary.entry.sessionId === "string" && summary.entry.sessionId.trim()
      ? summary.entry.sessionId.trim()
      : parseUsageCountedSessionIdFromFileName(path.basename(sessionFile));
  if (!sessionId) {
    return null;
  }
  const sessionKey = summary.sessionKey.trim();
  const classification = classifySessionEntry(
    summary.sessionKey,
    summary.entry,
    cronGeneratedSessionKeys,
  );
  return {
    agentId,
    artifactKind: "active-session",
    sessionFile,
    sessionId,
    ...(sessionKey ? { sessionKey } : {}),
    ...(classification.generatedByDreamingNarrative ? { generatedByDreamingNarrative: true } : {}),
    ...(classification.generatedByCronRun ? { generatedByCronRun: true } : {}),
  };
}

function listSessionTranscriptArtifactFiles(sessionsDir: string): string[] {
  try {
    return fsSync
      .readdirSync(sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => isUsageCountedSessionTranscriptFileName(name))
      .map((name) => path.join(sessionsDir, name));
  } catch {
    return [];
  }
}

function classifyTranscriptArtifact(
  artifactPath: string,
  activeEntriesByPath: ReadonlyMap<string, SessionTranscriptCorpusEntry>,
): {
  generatedByDreamingNarrative: boolean;
  generatedByCronRun: boolean;
} {
  const directEntry = activeEntriesByPath.get(normalizeRealComparablePath(artifactPath));
  if (directEntry) {
    return {
      generatedByDreamingNarrative: directEntry.generatedByDreamingNarrative === true,
      generatedByCronRun: directEntry.generatedByCronRun === true,
    };
  }
  const sessionsDir = path.dirname(artifactPath);
  const primarySessionId = parseUsageCountedSessionIdFromFileName(path.basename(artifactPath));
  const primaryEntry =
    primarySessionId && isSessionArchiveArtifactName(path.basename(artifactPath))
      ? activeEntriesByPath.get(
          normalizeRealComparablePath(path.join(sessionsDir, `${primarySessionId}.jsonl`)),
        )
      : undefined;
  return {
    generatedByDreamingNarrative: primaryEntry?.generatedByDreamingNarrative === true,
    generatedByCronRun: primaryEntry?.generatedByCronRun === true,
  };
}

function toArtifactCorpusEntry(
  agentId: string,
  artifactPath: string,
  activeEntriesByPath: ReadonlyMap<string, SessionTranscriptCorpusEntry>,
): SessionTranscriptCorpusEntry | null {
  const sessionId = parseUsageCountedSessionIdFromFileName(path.basename(artifactPath));
  if (!sessionId) {
    return null;
  }
  const artifactKind = isSessionArchiveArtifactName(path.basename(artifactPath))
    ? "archive-artifact"
    : "orphan-file-artifact";
  const classification = classifyTranscriptArtifact(artifactPath, activeEntriesByPath);
  return {
    agentId,
    artifactKind,
    sessionFile: artifactPath,
    sessionId,
    ...(classification.generatedByDreamingNarrative ? { generatedByDreamingNarrative: true } : {}),
    ...(classification.generatedByCronRun ? { generatedByCronRun: true } : {}),
  };
}

export function listSessionTranscriptCorpusEntriesForAgentSync(
  agentId: string,
): SessionTranscriptCorpusEntry[] {
  const normalizedAgentId = normalizeAgentId(agentId);
  const cfg = getRuntimeConfig();
  const configuredStore = cfg.session?.store;
  const storePath = resolveStorePath(configuredStore, {
    agentId: normalizedAgentId,
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
  const activeEntriesByPath = new Map<string, SessionTranscriptCorpusEntry>();
  const activeEntryOwnersByPath = new Map<string, string>();
  const artifactDirsByPath = new Map<string, string>();
  rememberArtifactDir(artifactDirsByPath, sessionsDir);
  const sessionEntries = listSessionEntries({
    agentId: normalizedAgentId,
    hydrateSkillPromptRefs: false,
    storePath,
  });
  const cronGeneratedSessionKeys = collectCronGeneratedSessionKeys(sessionEntries);
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
      sessionsDir,
      summary,
      cronGeneratedSessionKeys,
    );
    if (!entry) {
      continue;
    }
    const normalizedEntryPath = normalizeRealComparablePath(entry.sessionFile);
    activeEntryOwnersByPath.set(normalizedEntryPath, ownerAgentId);
    rememberArtifactDir(artifactDirsByPath, path.dirname(entry.sessionFile));
    if (ownerAgentId === normalizedAgentId) {
      activeEntriesByPath.set(normalizedEntryPath, entry);
    }
  }
  const includeUnownedArtifacts = !isSharedFixedStore;
  const corpusEntries = [...activeEntriesByPath.values()].filter((entry) =>
    isRegularSessionTranscriptFile(entry.sessionFile),
  );
  const scannedArtifactPaths = new Set<string>();
  for (const artifactDir of artifactDirsByPath.values()) {
    for (const artifactPath of listSessionTranscriptArtifactFiles(artifactDir)) {
      const normalizedArtifactPath = normalizeRealComparablePath(artifactPath);
      if (scannedArtifactPaths.has(normalizedArtifactPath)) {
        continue;
      }
      scannedArtifactPaths.add(normalizedArtifactPath);
      if (activeEntriesByPath.has(normalizedArtifactPath)) {
        continue;
      }
      const artifactOwner = activeEntryOwnersByPath.get(normalizedArtifactPath);
      if (artifactOwner) {
        continue;
      }
      const primarySessionId = parseUsageCountedSessionIdFromFileName(path.basename(artifactPath));
      const primaryOwner =
        primarySessionId && isSessionArchiveArtifactName(path.basename(artifactPath))
          ? activeEntryOwnersByPath.get(
              normalizeRealComparablePath(
                path.join(path.dirname(artifactPath), `${primarySessionId}.jsonl`),
              ),
            )
          : undefined;
      if (primaryOwner && primaryOwner !== normalizedAgentId) {
        continue;
      }
      if (!primaryOwner && !includeUnownedArtifacts) {
        continue;
      }
      const entry = toArtifactCorpusEntry(normalizedAgentId, artifactPath, activeEntriesByPath);
      if (entry) {
        corpusEntries.push(entry);
      }
    }
  }
  return corpusEntries;
}

/**
 * Lists transcript corpus entries for QMD/memory indexing.
 *
 * Active sessions come from the session accessor seam; retained reset/delete
 * transcript artifacts remain explicit file artifacts until core owns archive
 * artifact enumeration.
 */
export async function listSessionTranscriptCorpusEntriesForAgent(
  agentId: string,
): Promise<SessionTranscriptCorpusEntry[]> {
  return listSessionTranscriptCorpusEntriesForAgentSync(agentId);
}
