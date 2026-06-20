// Memory Core plugin module implements dreaming repair behavior.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { assertNoSymlinkParents } from "openclaw/plugin-sdk/security-runtime";
import {
  clearMemoryCoreWorkspaceNamespace,
  DREAMING_DAILY_INGESTION_NAMESPACE,
  DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
  DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
  memoryCoreStateReference,
  readMemoryCoreWorkspaceEntries,
} from "./dreaming-state.js";

type DreamingArtifactsAuditIssue = {
  severity: "warn" | "error";
  code:
    | "dreaming-session-corpus-unreadable"
    | "dreaming-session-corpus-self-ingested"
    | "dreaming-session-ingestion-unreadable"
    | "dreaming-diary-unreadable";
  message: string;
  fixable: boolean;
};

export type DreamingArtifactsAuditSummary = {
  dreamsPath?: string;
  sessionCorpusDir: string;
  sessionCorpusFileCount: number;
  suspiciousSessionCorpusFileCount: number;
  suspiciousSessionCorpusLineCount: number;
  sessionIngestionPath: string;
  sessionIngestionExists: boolean;
  issues: DreamingArtifactsAuditIssue[];
};

export type RepairDreamingArtifactsResult = {
  changed: boolean;
  archiveDir?: string;
  archivedDreamsDiary: boolean;
  archivedSessionCorpus: boolean;
  archivedSessionIngestion: boolean;
  archivedPaths: string[];
  warnings: string[];
};

const DREAMS_FILENAMES = ["DREAMS.md", "dreams.md"] as const;
const SESSION_CORPUS_RELATIVE_DIR = path.join("memory", ".dreams", "session-corpus");
const SESSION_INGESTION_RELATIVE_PATH = path.join("memory", ".dreams", "session-ingestion.json");
const REPAIR_ARCHIVE_RELATIVE_DIR = path.join(".openclaw-repair", "dreaming");
const DREAMING_NARRATIVE_RUN_PREFIX = "dreaming-narrative-";
const DREAMING_NARRATIVE_PROMPT_PREFIX = "Write a dream diary entry from these memory fragments";

function requireAbsoluteWorkspaceDir(rawWorkspaceDir: string): string {
  const trimmed = rawWorkspaceDir.trim();
  if (!trimmed) {
    throw new Error("workspaceDir is required");
  }
  if (!path.isAbsolute(trimmed)) {
    throw new Error("workspaceDir must be an absolute path");
  }
  return path.resolve(trimmed);
}

async function resolveExistingDreamsPath(
  workspaceDir: string,
  agentId?: string,
): Promise<string | undefined> {
  if (agentId?.trim()) {
    const scoped = path.join(
      workspaceDir,
      "memory",
      ".dreams",
      "agents",
      normalizeAgentId(agentId),
      DREAMS_FILENAMES[0],
    );
    try {
      await fs.access(scoped);
      return scoped;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw err;
    }
  }
  for (const fileName of DREAMS_FILENAMES) {
    const candidate = path.join(workspaceDir, fileName);
    try {
      await fs.access(candidate);
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }
  return undefined;
}

async function listSessionCorpusFiles(sessionCorpusDir: string): Promise<string[]> {
  const entries = await fs.readdir(sessionCorpusDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".txt"))
    .map((entry) => path.join(sessionCorpusDir, entry.name))
    .toSorted();
}

function isSuspiciousSessionCorpusLine(line: string): boolean {
  return (
    line.includes(DREAMING_NARRATIVE_PROMPT_PREFIX) &&
    (line.includes(DREAMING_NARRATIVE_RUN_PREFIX) || line.includes("dreaming-narrative-"))
  );
}

function buildArchiveTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

async function ensureArchivablePath(targetPath: string): Promise<"file" | "dir" | null> {
  const stat = await fs.lstat(targetPath).catch((err: unknown) => {
    if (extractErrorCode(err) === "ENOENT") {
      return null;
    }
    throw err;
  });
  if (!stat) {
    return null;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to archive symlinked path: ${targetPath}`);
  }
  if (stat.isDirectory()) {
    return "dir";
  }
  if (stat.isFile()) {
    return "file";
  }
  throw new Error(`Refusing to archive non-file artifact: ${targetPath}`);
}

async function assertSafeRepairArtifactParent(
  workspaceDir: string,
  targetPath: string,
): Promise<void> {
  await assertNoSymlinkParents({
    rootDir: workspaceDir,
    targetPath: path.dirname(targetPath),
    requireDirectories: true,
  });
}

async function ensureSafeArchiveDirectory(workspaceDir: string, archiveDir: string): Promise<void> {
  await assertNoSymlinkParents({
    rootDir: workspaceDir,
    targetPath: archiveDir,
    requireDirectories: true,
  });
  await fs.mkdir(archiveDir, { recursive: true });
  await assertNoSymlinkParents({
    rootDir: workspaceDir,
    targetPath: archiveDir,
    allowMissing: false,
    requireDirectories: true,
  });
}

async function moveToArchive(params: {
  workspaceDir: string;
  targetPath: string;
  archiveDir: string;
}): Promise<string | null> {
  await assertSafeRepairArtifactParent(params.workspaceDir, params.targetPath);
  const kind = await ensureArchivablePath(params.targetPath);
  if (!kind) {
    return null;
  }
  await ensureSafeArchiveDirectory(params.workspaceDir, params.archiveDir);
  const baseName = path.basename(params.targetPath);
  const destination = path.join(params.archiveDir, `${baseName}.${randomUUID()}`);
  await fs.rename(params.targetPath, destination);
  return destination;
}

async function clearSessionIngestionState(workspaceDir: string, agentId?: string): Promise<void> {
  await Promise.all([
    clearMemoryCoreWorkspaceNamespace({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir,
      agentId,
    }),
    clearMemoryCoreWorkspaceNamespace({
      namespace: DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
      workspaceDir,
      agentId,
    }),
  ]);
}

export async function auditDreamingArtifacts(params: {
  workspaceDir: string;
  agentId?: string;
}): Promise<DreamingArtifactsAuditSummary> {
  const workspaceDir = requireAbsoluteWorkspaceDir(params.workspaceDir);
  const agentId = params.agentId?.trim() ? normalizeAgentId(params.agentId) : undefined;
  const dreamsPath = await resolveExistingDreamsPath(workspaceDir, agentId);
  const sessionCorpusDir = agentId
    ? path.join(workspaceDir, "memory", ".dreams", "agents", agentId, "session-corpus")
    : path.join(workspaceDir, SESSION_CORPUS_RELATIVE_DIR);
  const sessionIngestionPath = agentId
    ? memoryCoreStateReference(DREAMING_SESSION_INGESTION_FILES_NAMESPACE, workspaceDir, agentId)
    : path.join(workspaceDir, SESSION_INGESTION_RELATIVE_PATH);
  const issues: DreamingArtifactsAuditIssue[] = [];
  let sessionCorpusFileCount = 0;
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

  if (!agentId) {
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
  }

  // Fall back to SQLite plugin state when the legacy JSON file was archived by migration.
  if (!sessionIngestionExists) {
    try {
      const ingestionNamespaces = [
        DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
        DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
        DREAMING_DAILY_INGESTION_NAMESPACE,
      ] as const;
      for (const namespace of ingestionNamespaces) {
        const entries = await readMemoryCoreWorkspaceEntries({
          namespace,
          workspaceDir,
          agentId,
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
    suspiciousSessionCorpusFileCount,
    suspiciousSessionCorpusLineCount,
    sessionIngestionPath,
    sessionIngestionExists,
    issues,
  };
}

export async function repairDreamingArtifacts(params: {
  workspaceDir: string;
  agentId?: string;
  archiveDiary?: boolean;
  now?: Date;
}): Promise<RepairDreamingArtifactsResult> {
  const workspaceDir = requireAbsoluteWorkspaceDir(params.workspaceDir);
  const agentId = params.agentId?.trim() ? normalizeAgentId(params.agentId) : undefined;
  const warnings: string[] = [];
  const archivedPaths: string[] = [];
  let archiveDir: string | undefined;
  let archivedDreamsDiary = false;
  let archivedSessionCorpus = false;
  let archivedSessionIngestion = false;

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
      return await moveToArchive({
        workspaceDir,
        targetPath,
        archiveDir: ensureArchiveDir(),
      });
    } catch (err) {
      warnings.push(err instanceof Error ? err.message : String(err));
      return null;
    }
  };

  const sessionCorpusDestination = await archivePathIfPresent(
    agentId
      ? path.join(workspaceDir, "memory", ".dreams", "agents", agentId, "session-corpus")
      : path.join(workspaceDir, SESSION_CORPUS_RELATIVE_DIR),
  );
  if (sessionCorpusDestination) {
    archivedSessionCorpus = true;
    archivedPaths.push(sessionCorpusDestination);
  }

  const sessionIngestionDestination = agentId
    ? null
    : await archivePathIfPresent(path.join(workspaceDir, SESSION_INGESTION_RELATIVE_PATH));
  if (sessionIngestionDestination) {
    archivedSessionIngestion = true;
    archivedPaths.push(sessionIngestionDestination);
  }

  if (sessionCorpusDestination || sessionIngestionDestination) {
    try {
      await clearSessionIngestionState(workspaceDir, agentId);
    } catch (err) {
      warnings.push(
        `Failed clearing dreaming session-ingestion SQLite state: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  if (params.archiveDiary) {
    const dreamsPath = await resolveExistingDreamsPath(workspaceDir, agentId);
    if (dreamsPath) {
      const dreamsDestination = await archivePathIfPresent(dreamsPath);
      if (dreamsDestination) {
        archivedDreamsDiary = true;
        archivedPaths.push(dreamsDestination);
      }
    }
  }

  const changed = archivedDreamsDiary || archivedSessionCorpus || archivedSessionIngestion;
  return {
    changed,
    ...(archiveDir ? { archiveDir } : {}),
    archivedDreamsDiary,
    archivedSessionCorpus,
    archivedSessionIngestion,
    archivedPaths,
    warnings,
  };
}
