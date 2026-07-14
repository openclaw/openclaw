import fs from "node:fs/promises";
// Memory Core plugin module implements dreaming repair behavior.
import path from "node:path";
import {
  requireAbsoluteWorkspaceDir,
  resolveExistingDreamsPath,
  listSessionCorpusFiles,
  isSuspiciousSessionCorpusLine,
  findHeartbeatContaminatedCorpusLines,
  buildSessionScopeCandidates,
  hasSelfIngestedSessionCorpusLines,
  clearScopedLegacySessionIngestionJson,
  buildArchiveTimestamp,
  moveToArchive,
  clearSessionIngestionState,
  SESSION_CORPUS_RELATIVE_DIR,
  SESSION_INGESTION_RELATIVE_PATH,
  REPAIR_ARCHIVE_RELATIVE_DIR,
} from "./dreaming-repair-utils.js";
import type {
  DreamingArtifactsAuditIssue,
  DreamingArtifactsAuditSummary,
  HeartbeatContaminatedCorpusLine,
  RepairDreamingArtifactsResult,
} from "./dreaming-repair-utils.js";
import {
  DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
  DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
  readMemoryCoreWorkspaceEntries,
} from "./dreaming-state.js";

// Re-export types for CLI consumers.
export type {
  DreamingArtifactsAuditSummary,
  RepairDreamingArtifactsResult,
} from "./dreaming-repair-utils.js";

export async function auditDreamingArtifacts(params: {
  workspaceDir: string;
}): Promise<DreamingArtifactsAuditSummary> {
  const workspaceDir = requireAbsoluteWorkspaceDir(params.workspaceDir);
  const dreamsPath = await resolveExistingDreamsPath(workspaceDir);
  const sessionCorpusDir = path.join(workspaceDir, SESSION_CORPUS_RELATIVE_DIR);
  const sessionIngestionPath = path.join(workspaceDir, SESSION_INGESTION_RELATIVE_PATH);
  const issues: DreamingArtifactsAuditIssue[] = [];
  let sessionCorpusFileCount = 0;
  let heartbeatContaminatedSessionCorpusFileCount = 0;
  let heartbeatContaminatedSessionCorpusLineCount = 0;
  let suspiciousSessionCorpusFileCount = 0;
  let suspiciousSessionCorpusLineCount = 0;
  let sessionIngestionExists = false;

  if (dreamsPath) {
    try {
      await fs.access(dreamsPath);
    } catch (err) {
      issues.push({
        severity: "error",
        code: "dreaming-diary-unreadable",
        message: `Dream diary could not be inspected: ${(err as NodeJS.ErrnoException).code ?? "error"}.`,
        fixable: false,
      });
    }
  }

  try {
    const corpusFiles = await listSessionCorpusFiles(sessionCorpusDir);
    sessionCorpusFileCount = corpusFiles.length;
    for (const corpusFile of corpusFiles) {
      const content = await fs.readFile(corpusFile, "utf-8");
      const suspiciousLines = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && isSuspiciousSessionCorpusLine(line));
      if (suspiciousLines.length > 0) {
        suspiciousSessionCorpusFileCount += 1;
        suspiciousSessionCorpusLineCount += suspiciousLines.length;
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      issues.push({
        severity: "error",
        code: "dreaming-session-corpus-unreadable",
        message: `Dreaming session corpus could not be inspected: ${(err as NodeJS.ErrnoException).code ?? "error"}.`,
        fixable: false,
      });
    }
  }

  try {
    await fs.access(sessionIngestionPath);
    sessionIngestionExists = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      issues.push({
        severity: "error",
        code: "dreaming-session-ingestion-unreadable",
        message: `Dreaming session-ingestion state could not be inspected: ${(err as NodeJS.ErrnoException).code ?? "error"}.`,
        fixable: false,
      });
    }
  }

  // Fall back to SQLite plugin state when the legacy JSON file was archived by migration.
  if (!sessionIngestionExists) {
    try {
      // Daily ingestion tracks memory/*.md independently; session repair must not
      // report or clear that healthy bookkeeping when rebuilding the session corpus.
      const ingestionNamespaces = [
        DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
        DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
      ] as const;
      for (const namespace of ingestionNamespaces) {
        const entries = await readMemoryCoreWorkspaceEntries({
          namespace,
          workspaceDir,
        });
        if (entries.length > 0) {
          sessionIngestionExists = true;
          break;
        }
      }
    } catch {
      // SQLite plugin state unavailable — keep filesystem-only result.
    }
  }

  try {
    const heartbeatContaminated = await findHeartbeatContaminatedCorpusLines(workspaceDir);
    heartbeatContaminatedSessionCorpusLineCount = heartbeatContaminated.length;
    heartbeatContaminatedSessionCorpusFileCount = new Set(
      heartbeatContaminated.map((entry) => entry.filePath),
    ).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      issues.push({
        severity: "error",
        code: "dreaming-session-corpus-unreadable",
        message: `Dreaming heartbeat-derived corpus audit failed: ${(err as NodeJS.ErrnoException).code ?? "error"}.`,
        fixable: false,
      });
    }
  }

  if (heartbeatContaminatedSessionCorpusLineCount > 0) {
    issues.push({
      severity: "warn",
      code: "dreaming-session-corpus-heartbeat-derived",
      message: `Dreaming session corpus contains heartbeat-derived assistant entries (${heartbeatContaminatedSessionCorpusLineCount} line${heartbeatContaminatedSessionCorpusLineCount === 1 ? "" : "s"}).`,
      fixable: true,
    });
  }

  if (suspiciousSessionCorpusLineCount > 0) {
    issues.push({
      severity: "warn",
      code: "dreaming-session-corpus-self-ingested",
      message: `Dreaming session corpus appears to contain self-ingested narrative content (${suspiciousSessionCorpusLineCount} suspicious line${suspiciousSessionCorpusLineCount === 1 ? "" : "s"}).`,
      fixable: true,
    });
  }

  return {
    ...(dreamsPath ? { dreamsPath } : {}),
    sessionCorpusDir,
    sessionCorpusFileCount,
    ...(heartbeatContaminatedSessionCorpusFileCount > 0
      ? { heartbeatContaminatedSessionCorpusFileCount }
      : {}),
    ...(heartbeatContaminatedSessionCorpusLineCount > 0
      ? { heartbeatContaminatedSessionCorpusLineCount }
      : {}),
    suspiciousSessionCorpusFileCount,
    suspiciousSessionCorpusLineCount,
    sessionIngestionPath,
    sessionIngestionExists,
    issues,
  };
}

export async function repairDreamingArtifacts(params: {
  workspaceDir: string;
  archiveDiary?: boolean;
  now?: Date;
}): Promise<RepairDreamingArtifactsResult> {
  const workspaceDir = requireAbsoluteWorkspaceDir(params.workspaceDir);
  const warnings: string[] = [];
  const archivedPaths: string[] = [];
  let archiveDir: string | undefined;
  let archivedDreamsDiary = false;
  let archivedSessionCorpus = false;
  let archivedSessionIngestion = false;
  let removedHeartbeatDerivedLines = 0;

  const ensureArchiveDir = () => {
    archiveDir ??= path.join(
      workspaceDir,
      REPAIR_ARCHIVE_RELATIVE_DIR,
      buildArchiveTimestamp(params.now ?? new Date()),
    );
    return archiveDir;
  };

  const archivePathIfPresent = async (targetPath: string): Promise<string | null> => {
    try {
      return await moveToArchive({ targetPath, archiveDir: ensureArchiveDir() });
    } catch (err) {
      warnings.push(err instanceof Error ? err.message : String(err));
      return null;
    }
  };

  const heartbeatContaminated = await findHeartbeatContaminatedCorpusLines(workspaceDir).catch(
    (err: unknown) => {
      warnings.push(
        `Failed auditing heartbeat-derived session corpus artifacts: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [] as HeartbeatContaminatedCorpusLine[];
    },
  );
  if (heartbeatContaminated.length > 0) {
    const linesByFile = new Map<string, Set<number>>();
    const stateKeys = new Set<string>();
    const scopeKeys = new Set<string>();
    for (const entry of heartbeatContaminated) {
      if (!linesByFile.has(entry.filePath)) {
        linesByFile.set(entry.filePath, new Set());
      }
      linesByFile.get(entry.filePath)?.add(entry.index);
      stateKeys.add(`${entry.source.agentId}:${entry.source.sessionPath}`);
      for (const scope of buildSessionScopeCandidates(
        entry.source.agentId,
        entry.source.sessionPath,
      )) {
        scopeKeys.add(scope);
      }
    }

    for (const [filePath, lineIndexes] of linesByFile.entries()) {
      const original = await fs.readFile(filePath, "utf-8");
      const lines = original.split(/\r?\n/);
      const filtered = lines.filter((_, index) => !lineIndexes.has(index));
      removedHeartbeatDerivedLines += lineIndexes.size;
      const archived = await archivePathIfPresent(filePath);
      if (archived) {
        archivedSessionCorpus = true;
        archivedPaths.push(archived);
      }
      const serialized = filtered.filter(
        (line, index) => index < filtered.length - 1 || line.length > 0,
      );
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, `${serialized.join("\n")}\n`, "utf-8");
    }

    const legacy = await clearScopedLegacySessionIngestionJson({
      workspaceDir,
      stateKeys,
      scopeKeys,
      archiveDir: ensureArchiveDir(),
    }).catch((err: unknown) => {
      warnings.push(
        `Failed updating legacy dreaming session-ingestion JSON state: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { removed: 0, archivedPath: undefined };
    });
    if (legacy.archivedPath) {
      archivedSessionIngestion = true;
      archivedPaths.push(legacy.archivedPath);
    }
  }

  const shouldArchiveDerivedArtifacts = await hasSelfIngestedSessionCorpusLines(workspaceDir).catch(
    (err: unknown) => {
      warnings.push(
        `Failed auditing self-ingested session corpus artifacts: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    },
  );

  if (!shouldArchiveDerivedArtifacts) {
    if (params.archiveDiary) {
      const dreamsPath = await resolveExistingDreamsPath(workspaceDir);
      if (dreamsPath) {
        const dreamsDestination = await archivePathIfPresent(dreamsPath);
        if (dreamsDestination) {
          archivedDreamsDiary = true;
          archivedPaths.push(dreamsDestination);
        }
      }
    }

    return {
      changed: archivedDreamsDiary || removedHeartbeatDerivedLines > 0,
      ...(archiveDir ? { archiveDir } : {}),
      archivedDreamsDiary,
      archivedSessionCorpus,
      archivedSessionIngestion,
      archivedPaths,
      warnings,
      ...(removedHeartbeatDerivedLines > 0 ? { removedHeartbeatDerivedLines } : {}),
    };
  }

  const sessionCorpusDestination = await archivePathIfPresent(
    path.join(workspaceDir, SESSION_CORPUS_RELATIVE_DIR),
  );
  if (sessionCorpusDestination) {
    archivedSessionCorpus = true;
    archivedPaths.push(sessionCorpusDestination);
  }

  const sessionIngestionDestination = await archivePathIfPresent(
    path.join(workspaceDir, SESSION_INGESTION_RELATIVE_PATH),
  );
  if (sessionIngestionDestination) {
    archivedSessionIngestion = true;
    archivedPaths.push(sessionIngestionDestination);
  }

  if (sessionCorpusDestination || sessionIngestionDestination) {
    try {
      await clearSessionIngestionState(workspaceDir);
    } catch (err) {
      warnings.push(
        `Failed clearing dreaming session-ingestion SQLite state: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  if (params.archiveDiary) {
    const dreamsPath = await resolveExistingDreamsPath(workspaceDir);
    if (dreamsPath) {
      const dreamsDestination = await archivePathIfPresent(dreamsPath);
      if (dreamsDestination) {
        archivedDreamsDiary = true;
        archivedPaths.push(dreamsDestination);
      }
    }
  }

  const changed =
    archivedDreamsDiary ||
    archivedSessionCorpus ||
    archivedSessionIngestion ||
    removedHeartbeatDerivedLines > 0;
  return {
    changed,
    ...(archiveDir ? { archiveDir } : {}),
    archivedDreamsDiary,
    archivedSessionCorpus,
    archivedSessionIngestion,
    archivedPaths,
    ...(removedHeartbeatDerivedLines > 0 ? { removedHeartbeatDerivedLines } : {}),
    warnings,
  };
}
