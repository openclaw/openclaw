import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import { loadTranscriptEventsSync } from "openclaw/plugin-sdk/session-store-runtime";
import {
  clearMemoryCoreWorkspaceNamespace,
  DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
  DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
} from "./dreaming-state.js";
export type DreamingArtifactsAuditIssue = {
  severity: "warn" | "error";
  code:
    | "dreaming-session-corpus-unreadable"
    | "dreaming-session-corpus-heartbeat-derived"
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
  heartbeatContaminatedSessionCorpusFileCount?: number;
  heartbeatContaminatedSessionCorpusLineCount?: number;
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
  removedHeartbeatDerivedLines?: number;
  clearedSessionCheckpointKeys?: number;
  warnings: string[];
};
const DREAMS_FILENAMES = ["DREAMS.md", "dreams.md"] as const;
export const SESSION_CORPUS_RELATIVE_DIR = path.join("memory", ".dreams", "session-corpus");
export const SESSION_INGESTION_RELATIVE_PATH = path.join(
  "memory",
  ".dreams",
  "session-ingestion.json",
);
export const REPAIR_ARCHIVE_RELATIVE_DIR = path.join(".openclaw-repair", "dreaming");
const DREAMING_NARRATIVE_RUN_PREFIX = "dreaming-narrative-";
const DREAMING_NARRATIVE_PROMPT_PREFIX = "Write a dream diary entry from these memory fragments";
const HEARTBEAT_PROMPT_TEXT = "[OpenClaw heartbeat poll]";
type CorpusSourceRef = {
  agentId: string;
  sessionPath: string;
  lineNumber: number;
};

export type HeartbeatContaminatedCorpusLine = {
  filePath: string;
  index: number;
  source: CorpusSourceRef;
};

export function requireAbsoluteWorkspaceDir(rawWorkspaceDir: string): string {
  const trimmed = rawWorkspaceDir.trim();
  if (!trimmed) {
    throw new Error("workspaceDir is required");
  }
  if (!path.isAbsolute(trimmed)) {
    throw new Error("workspaceDir must be an absolute path");
  }
  return path.resolve(trimmed);
}

export async function resolveExistingDreamsPath(workspaceDir: string): Promise<string | undefined> {
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

export async function listSessionCorpusFiles(sessionCorpusDir: string): Promise<string[]> {
  const entries = await fs.readdir(sessionCorpusDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".txt"))
    .map((entry) => path.join(sessionCorpusDir, entry.name))
    .toSorted();
}

export function isSuspiciousSessionCorpusLine(line: string): boolean {
  return (
    line.includes(DREAMING_NARRATIVE_PROMPT_PREFIX) &&
    (line.includes(DREAMING_NARRATIVE_RUN_PREFIX) || line.includes("dreaming-narrative-"))
  );
}

function parseSessionCorpusSourceRef(line: string): CorpusSourceRef | null {
  const match = line.match(/^\[([^/\]]+)\/(.+)#L(\d+)\]\s+/);
  if (!match) {
    return null;
  }
  const lineNumber = Number(match[3]);
  if (!Number.isFinite(lineNumber) || lineNumber <= 0) {
    return null;
  }
  return {
    agentId: match[1]!.trim(),
    sessionPath: match[2]!.trim(),
    lineNumber: Math.floor(lineNumber),
  };
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return "";
      }
      const text = (entry as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .join("\n");
}

function parseMessageRecord(rawLine: string): {
  role: string;
  text: string;
  provenanceKind?: string;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const asRecord = parsed as {
    message?: unknown;
    role?: unknown;
    content?: unknown;
    provenance?: unknown;
  };
  const message =
    asRecord.message && typeof asRecord.message === "object"
      ? (asRecord.message as {
          role?: unknown;
          content?: unknown;
          provenance?: unknown;
        })
      : asRecord;
  const role = typeof message.role === "string" ? message.role : "";
  if (!role) {
    return null;
  }
  const provenanceKind =
    message.provenance && typeof message.provenance === "object"
      ? (message.provenance as { kind?: unknown }).kind
      : undefined;
  return {
    role,
    text: extractMessageText(message.content),
    ...(typeof provenanceKind === "string" ? { provenanceKind } : {}),
  };
}

function isHeartbeatUserMessage(message: {
  role: string;
  text: string;
  provenanceKind?: string;
}): boolean {
  if (message.role !== "user") {
    return false;
  }
  if (message.provenanceKind === "heartbeat") {
    return true;
  }
  return message.text.trim() === HEARTBEAT_PROMPT_TEXT;
}

function isHeartbeatDerivedAssistantLine(lines: string[], source: CorpusSourceRef): boolean {
  const assistantRaw = lines[source.lineNumber - 1];
  if (!assistantRaw) {
    return false;
  }
  const assistant = parseMessageRecord(assistantRaw);
  if (!assistant || assistant.role !== "assistant") {
    return false;
  }
  for (let index = source.lineNumber - 2; index >= 0; index -= 1) {
    const prior = parseMessageRecord(lines[index] ?? "");
    if (!prior) {
      continue;
    }
    if (prior.role === "assistant") {
      return false;
    }
    if (isHeartbeatUserMessage(prior)) {
      return true;
    }
    if (prior.role === "user") {
      return false;
    }
  }
  return false;
}

async function resolveStorePathForAgent(
  workspaceRoot: string,
  agentId: string,
): Promise<string | undefined> {
  const candidates = [
    path.join(workspaceRoot, "agents", agentId, "agent", "openclaw-agent.sqlite"),
    path.join(workspaceRoot, "agents", agentId, "sessions", "sessions.json"),
    path.join(workspaceRoot, "agents", agentId, "sessions.json"),
  ];
  for (const candidate of candidates) {
    const exists = await fs
      .access(candidate)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      return candidate;
    }
  }
  return undefined;
}

async function loadTranscriptLinesFromSqlite(
  agentId: string,
  sessionPath: string,
  workspaceRoot: string,
): Promise<string[] | null> {
  const sessionId = path
    .basename(sessionPath)
    .replace(/\.jsonl$/i, "")
    .trim();
  if (!sessionId) {
    return null;
  }
  const storePath = await resolveStorePathForAgent(workspaceRoot, agentId);
  if (!storePath) {
    return null;
  }
  try {
    const events = loadTranscriptEventsSync({ agentId, sessionId, storePath });
    if (events.length === 0) {
      return null;
    }
    // Serialize all events to preserve original event positions.
    // Corpus `#L<n>` references identify positions in the original
    // transcript event stream. Non-message events (metadata, compaction,
    // model-change) are interspersed between messages in real SQLite
    // sessions. The downstream heartbeat matcher handles non-message
    // records gracefully via parseMessageRecord returning null.
    return events.map((event) => JSON.stringify(event));
  } catch {
    return null;
  }
}

export async function findHeartbeatContaminatedCorpusLines(
  workspaceDir: string,
): Promise<HeartbeatContaminatedCorpusLine[]> {
  const sessionCorpusDir = path.join(workspaceDir, SESSION_CORPUS_RELATIVE_DIR);
  const corpusFiles = await listSessionCorpusFiles(sessionCorpusDir).catch((err: unknown) => {
    if (extractErrorCode(err) === "ENOENT") {
      return [] as string[];
    }
    throw err;
  });
  const workspaceRoot = path.resolve(workspaceDir, "..");
  const transcriptCache = new Map<string, string[]>();
  const contaminated: HeartbeatContaminatedCorpusLine[] = [];

  for (const corpusFile of corpusFiles) {
    const content = await fs.readFile(corpusFile, "utf-8");
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const source = parseSessionCorpusSourceRef(line);
      if (!source) {
        continue;
      }
      // Corpus references use logical session paths. File-backed sessions
      // produce paths ending in .jsonl (e.g. "sessions/main/abc.jsonl").
      // SQLite-backed sessions produce paths without .jsonl
      // (e.g. "sessions/main/abc-123"). Try the filesystem first; if the
      // file doesn't exist or is empty, fall back to the SQLite transcript
      // store via the canonical loadTranscriptEventsSync reader.
      const sessionFileName = path.basename(source.sessionPath);
      const hasJsonlExtension = sessionFileName.toLowerCase().endsWith(".jsonl");
      const transcriptPath = path.join(
        workspaceRoot,
        "agents",
        source.agentId,
        "sessions",
        hasJsonlExtension ? sessionFileName : `${sessionFileName}.jsonl`,
      );
      let transcriptLines = transcriptCache.get(transcriptPath);
      if (!transcriptLines) {
        const transcriptContent = await fs.readFile(transcriptPath, "utf-8").catch(() => "");
        transcriptLines = transcriptContent.length > 0 ? transcriptContent.split(/\r?\n/) : [];
        // Filesystem read failed or returned empty. For non-.jsonl paths
        // (SQLite logical paths), try the canonical SQLite reader.
        if (transcriptLines.length === 0 && !hasJsonlExtension) {
          const sqliteLines = await loadTranscriptLinesFromSqlite(
            source.agentId,
            source.sessionPath,
            workspaceRoot,
          );
          if (sqliteLines) {
            transcriptLines = sqliteLines;
          }
        }
        transcriptCache.set(transcriptPath, transcriptLines);
      }
      if (transcriptLines.length === 0) {
        continue;
      }
      if (isHeartbeatDerivedAssistantLine(transcriptLines, source)) {
        contaminated.push({
          filePath: corpusFile,
          index,
          source,
        });
      }
    }
  }
  return contaminated;
}

export function buildSessionScopeCandidates(agentId: string, sessionPath: string): string[] {
  const base = path.basename(sessionPath);
  const stem = base
    .replace(/\.trajectory\.jsonl$/i, "")
    .replace(/\.jsonl$/i, "")
    .trim();
  const scopes = new Set<string>();
  if (base) {
    scopes.add(`${agentId}:${base}`);
  }
  if (stem) {
    scopes.add(`${agentId}:${stem}`);
  }
  return [...scopes];
}

export async function hasSelfIngestedSessionCorpusLines(workspaceDir: string): Promise<boolean> {
  const sessionCorpusDir = path.join(workspaceDir, SESSION_CORPUS_RELATIVE_DIR);
  const corpusFiles = await listSessionCorpusFiles(sessionCorpusDir).catch((err: unknown) => {
    if (extractErrorCode(err) === "ENOENT") {
      return [] as string[];
    }
    throw err;
  });
  for (const corpusFile of corpusFiles) {
    const content = await fs.readFile(corpusFile, "utf-8");
    const hasSuspicious = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .some((line) => line.length > 0 && isSuspiciousSessionCorpusLine(line));
    if (hasSuspicious) {
      return true;
    }
  }
  return false;
}

export async function clearScopedLegacySessionIngestionJson(params: {
  workspaceDir: string;
  stateKeys: Set<string>;
  scopeKeys: Set<string>;
  archiveDir: string;
}): Promise<{ removed: number; archivedPath?: string }> {
  const legacyPath = path.join(params.workspaceDir, SESSION_INGESTION_RELATIVE_PATH);
  const content = await fs.readFile(legacyPath, "utf-8").catch(() => null);
  if (!content) {
    return { removed: 0 };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { removed: 0 };
  }
  if (!parsed || typeof parsed !== "object") {
    return { removed: 0 };
  }

  const record = parsed as {
    files?: Record<string, unknown>;
    seenMessages?: Record<string, unknown>;
  };
  const files = record.files && typeof record.files === "object" ? record.files : {};
  const seen =
    record.seenMessages && typeof record.seenMessages === "object" ? record.seenMessages : {};

  let removed = 0;
  for (const key of params.stateKeys) {
    if (key in files) {
      delete files[key];
      removed += 1;
    }
  }
  for (const key of params.scopeKeys) {
    if (key in seen) {
      delete seen[key];
      removed += 1;
    }
  }
  if (removed === 0) {
    return { removed: 0 };
  }

  const archivedPath = await moveToArchive({
    targetPath: legacyPath,
    archiveDir: params.archiveDir,
  });
  await fs.mkdir(path.dirname(legacyPath), { recursive: true });
  await fs.writeFile(legacyPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
  return { removed, ...(archivedPath ? { archivedPath } : {}) };
}

export function buildArchiveTimestamp(now: Date): string {
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

export async function moveToArchive(params: {
  targetPath: string;
  archiveDir: string;
}): Promise<string | null> {
  const kind = await ensureArchivablePath(params.targetPath);
  if (!kind) {
    return null;
  }
  await fs.mkdir(params.archiveDir, { recursive: true });
  const baseName = path.basename(params.targetPath);
  const destination = path.join(params.archiveDir, `${baseName}.${randomUUID()}`);
  await fs.rename(params.targetPath, destination);
  return destination;
}

export async function clearSessionIngestionState(workspaceDir: string): Promise<void> {
  await Promise.all([
    clearMemoryCoreWorkspaceNamespace({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir,
    }),
    clearMemoryCoreWorkspaceNamespace({
      namespace: DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
      workspaceDir,
    }),
  ]);
}
