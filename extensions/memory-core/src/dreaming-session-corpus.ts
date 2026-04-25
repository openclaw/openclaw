/**
 * dreaming-session-corpus.ts
 *
 * Session transcript scanning and ingestion for the dreaming system.
 * Responsible for reading session .jsonl files, extracting meaningful snippets,
 * and appending them to the daily session corpus.
 *
 * Exported:
 *   SessionIngestionState, SessionIngestionMessage, SessionIngestionCollectionResult
 *   collectSessionIngestionBatches(), ingestSessionTranscriptSignals()
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  buildSessionEntry,
  listSessionFilesForAgent,
  loadSessionTranscriptClassificationForAgent,
  normalizeSessionTranscriptPathForComparison,
  parseUsageCountedSessionIdFromFileName,
  sessionPathForFile,
} from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { formatMemoryDreamingDay } from "openclaw/plugin-sdk/memory-core-host-status";
import {
  recordShortTermRecalls,
  type ShortTermRecallEntry,
} from "./short-term-promotion.js";
import { asRecord, formatErrorMessage } from "./dreaming-shared.js";
import {
  type DreamingHostConfig,
  SESSION_CORPUS_RELATIVE_DIR,
  SESSION_INGESTION_SCORE,
  SESSION_INGESTION_MAX_SNIPPET_CHARS,
  SESSION_INGESTION_MIN_SNIPPET_CHARS,
  SESSION_INGESTION_MAX_MESSAGES_PER_SWEEP,
  SESSION_INGESTION_MAX_MESSAGES_PER_FILE,
  SESSION_INGESTION_MIN_MESSAGES_PER_FILE,
  SESSION_INGESTION_MAX_TRACKED_MESSAGES_PER_SESSION,
  SESSION_INGESTION_MAX_TRACKED_SCOPES,
  SESSION_INGESTION_STATE_RELATIVE_PATH,
  calculateLookbackCutoffMs,
  isDayWithinLookback,
  normalizeWorkspaceKey,
  resolveMemoryDreamingWorkspaces,
} from "./dreaming-shared-types.js";

// ─── Types ─────────────────────────────────────────────────────────────────────

export type SessionIngestionFileState = {
  mtimeMs: number;
  size: number;
  contentHash: string;
  lineCount: number;
  lastContentLine: number;
};

export type SessionIngestionState = {
  version: 3;
  files: Record<string, SessionIngestionFileState>;
  seenMessages: Record<string, string[]>;
};

export type SessionIngestionMessage = {
  day: string;
  snippet: string;
  rendered: string;
};

export type SessionIngestionCollectionResult = {
  batches: Array<{ day: string; results: MemorySearchResult[] }>;
  nextState: SessionIngestionState;
  changed: boolean;
};

// ─── Session state I/O ─────────────────────────────────────────────────────────

function resolveSessionIngestionStatePath(workspaceDir: string): string {
  return path.join(workspaceDir, SESSION_INGESTION_STATE_RELATIVE_PATH);
}

function normalizeSessionIngestionState(raw: unknown): SessionIngestionState {
  const record = asRecord(raw);
  const filesRaw = asRecord(record?.files);
  const files: Record<string, SessionIngestionFileState> = {};
  if (filesRaw) {
    for (const [key, value] of Object.entries(filesRaw)) {
      const file = asRecord(value);
      if (!file || key.trim().length === 0) {
        continue;
      }
      const mtimeMs = Number(file.mtimeMs);
      const size = Number(file.size);
      if (!Number.isFinite(mtimeMs) || mtimeMs < 0 || !Number.isFinite(size) || size < 0) {
        continue;
      }
      const lineCountRaw = Number(file.lineCount);
      const lastContentLineRaw = Number(file.lastContentLine);
      const lineCount =
        Number.isFinite(lineCountRaw) && lineCountRaw >= 0 ? Math.floor(lineCountRaw) : 0;
      const lastContentLine =
        Number.isFinite(lastContentLineRaw) && lastContentLineRaw >= 0
          ? Math.floor(lastContentLineRaw)
          : 0;
      files[key] = {
        mtimeMs: Math.floor(mtimeMs),
        size: Math.floor(size),
        contentHash: typeof file.contentHash === "string" ? file.contentHash.trim() : "",
        lineCount,
        lastContentLine: Math.min(lineCount, lastContentLine),
      };
    }
  }
  const seenMessagesRaw = asRecord(record?.seenMessages);
  const seenMessages: Record<string, string[]> = {};
  if (seenMessagesRaw) {
    for (const [scope, value] of Object.entries(seenMessagesRaw)) {
      if (scope.trim().length === 0 || !Array.isArray(value)) {
        continue;
      }
      const unique = [
        ...new Set(value.filter((entry): entry is string => typeof entry === "string")),
      ]
        .map((entry) => entry.trim())
        .filter(Boolean)
        .slice(-SESSION_INGESTION_MAX_TRACKED_MESSAGES_PER_SESSION);
      if (unique.length > 0) {
        seenMessages[scope] = unique;
      }
    }
  }
  return { version: 3, files, seenMessages };
}

async function readSessionIngestionState(workspaceDir: string): Promise<SessionIngestionState> {
  const statePath = resolveSessionIngestionStatePath(workspaceDir);
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    return normalizeSessionIngestionState(JSON.parse(raw) as unknown);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || err instanceof SyntaxError) {
      return { version: 3, files: {}, seenMessages: {} };
    }
    throw err;
  }
}

async function writeSessionIngestionState(
  workspaceDir: string,
  state: SessionIngestionState,
): Promise<void> {
  const statePath = resolveSessionIngestionStatePath(workspaceDir);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  await fs.rename(tmpPath, statePath);
}

// ─── Session corpus helpers ───────────────────────────────────────────────────

function trimTrackedSessionScopes(
  seenMessages: Record<string, string[]>,
): Record<string, string[]> {
  const keys = Object.keys(seenMessages);
  if (keys.length <= SESSION_INGESTION_MAX_TRACKED_SCOPES) {
    return seenMessages;
  }
  const keep = new Set(keys.toSorted().slice(-SESSION_INGESTION_MAX_TRACKED_SCOPES));
  const next: Record<string, string[]> = {};
  for (const [scope, hashes] of Object.entries(seenMessages)) {
    if (keep.has(scope)) {
      next[scope] = hashes;
    }
  }
  return next;
}

function hashSessionMessageId(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function buildSessionScopeKey(agentId: string, absolutePath: string): string {
  const fileName = path.basename(absolutePath);
  const logicalSessionId = parseUsageCountedSessionIdFromFileName(fileName) ?? fileName;
  return `${agentId}:${logicalSessionId}`;
}

function mergeTrackedMessageHashes(existing: string[], additions: string[]): string[] {
  if (additions.length === 0) {
    return existing;
  }
  const seen = new Set(existing);
  const next = existing.slice();
  for (const hash of additions) {
    if (!seen.has(hash)) {
      seen.add(hash);
      next.push(hash);
    }
  }
  if (next.length <= SESSION_INGESTION_MAX_TRACKED_MESSAGES_PER_SESSION) {
    return next;
  }
  return next.slice(-SESSION_INGESTION_MAX_TRACKED_MESSAGES_PER_SESSION);
}

function areStringArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }
  return true;
}

function buildSessionStateKey(agentId: string, absolutePath: string): string {
  return `${agentId}:${sessionPathForFile(absolutePath)}`;
}

function buildSessionRenderedLine(params: {
  agentId: string;
  sessionPath: string;
  lineNumber: number;
  snippet: string;
}): string {
  const source = `${params.agentId}/${params.sessionPath}#L${params.lineNumber}`;
  return `[${source}] ${params.snippet}]`.slice(
    0,
    SESSION_INGESTION_MAX_SNIPPET_CHARS + 64,
  );
}

function normalizeSessionCorpusSnippet(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, SESSION_INGESTION_MAX_SNIPPET_CHARS);
}

function resolveSessionAgentsForWorkspace(
  cfg: DreamingHostConfig,
  workspaceDir: string,
): string[] {
  if (!cfg) {
    return [];
  }
  const target = normalizeWorkspaceKey(workspaceDir);
  const workspaces = resolveMemoryDreamingWorkspaces(
    cfg as Parameters<typeof resolveMemoryDreamingWorkspaces>[0],
  );
  const match = workspaces.find(
    (entry) => normalizeWorkspaceKey(entry.workspaceDir) === target,
  );
  if (!match) {
    return [];
  }
  return match.agentIds
    .filter(
      (agentId, index, all) =>
        agentId.trim().length > 0 && all.indexOf(agentId) === index,
    )
    .toSorted();
}

// ─── Session corpus writer ─────────────────────────────────────────────────────

async function appendSessionCorpusLines(params: {
  workspaceDir: string;
  day: string;
  lines: SessionIngestionMessage[];
}): Promise<MemorySearchResult[]> {
  if (params.lines.length === 0) {
    return [];
  }
  const absolutePath = path.join(
    params.workspaceDir,
    SESSION_CORPUS_RELATIVE_DIR,
    `${params.day}.txt`,
  );
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  let existing = "";
  try {
    existing = await fs.readFile(absolutePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw err;
    }
  }
  const normalizedExisting = existing.replace(/\r\n/g, "\n");
  const existingLineCount =
    normalizedExisting.length === 0
      ? 0
      : normalizedExisting.endsWith("\n")
        ? normalizedExisting.slice(0, -1).split("\n").length
        : normalizedExisting.split("\n").length;
  const payload = `${params.lines.map((entry) => entry.rendered).join("\n")}\n`;
  await fs.appendFile(absolutePath, payload, "utf-8");
  return params.lines.map((entry, index) => {
    const lineNumber = existingLineCount + index + 1;
    return {
      path: `memory/.dreams/session-corpus/${params.day}.txt`,
      startLine: lineNumber,
      endLine: lineNumber,
      score: SESSION_INGESTION_SCORE,
      snippet: entry.snippet,
      source: "memory",
    };
  });
}

// ─── Session ingestion collector ───────────────────────────────────────────────

async function collectSessionIngestionBatches(params: {
  workspaceDir: string;
  cfg?: DreamingHostConfig;
  lookbackDays: number;
  nowMs: number;
  timezone?: string;
  state: SessionIngestionState;
}): Promise<SessionIngestionCollectionResult> {
  if (!params.cfg) {
    return {
      batches: [],
      nextState: { version: 3, files: {}, seenMessages: {} },
      changed:
        Object.keys(params.state.files).length > 0 ||
        Object.keys(params.state.seenMessages).length > 0,
    };
  }
  const agentIds = resolveSessionAgentsForWorkspace(params.cfg, params.workspaceDir);
  const cutoffMs = calculateLookbackCutoffMs(params.nowMs, params.lookbackDays);
  const batchByDay = new Map<string, SessionIngestionMessage[]>();
  const nextFiles: Record<string, SessionIngestionFileState> = {};
  const nextSeenMessages: Record<string, string[]> = { ...params.state.seenMessages };
  let changed = false;

  const sessionFiles: Array<{
    agentId: string;
    absolutePath: string;
    generatedByDreamingNarrative: boolean;
    generatedByCronRun: boolean;
    sessionPath: string;
  }> = [];
  for (const agentId of agentIds) {
    const files = await listSessionFilesForAgent(agentId);
    const transcriptClassification =
      files.length > 0
        ? loadSessionTranscriptClassificationForAgent(agentId)
        : {
            dreamingNarrativeTranscriptPaths: new Set<string>(),
            cronRunTranscriptPaths: new Set<string>(),
          };
    for (const absolutePath of files) {
      const normalizedPath = normalizeSessionTranscriptPathForComparison(absolutePath);
      sessionFiles.push({
        agentId,
        absolutePath,
        generatedByDreamingNarrative:
          transcriptClassification.dreamingNarrativeTranscriptPaths.has(normalizedPath),
        generatedByCronRun:
          transcriptClassification.cronRunTranscriptPaths.has(normalizedPath),
        sessionPath: sessionPathForFile(absolutePath),
      });
    }
  }

  const sortedFiles = sessionFiles.toSorted((a, b) => {
    if (a.agentId !== b.agentId) {
      return a.agentId.localeCompare(b.agentId);
    }
    return a.sessionPath.localeCompare(b.sessionPath);
  });

  const totalCap = SESSION_INGESTION_MAX_MESSAGES_PER_SWEEP;
  let remaining = totalCap;
  const perFileCap = Math.min(
    SESSION_INGESTION_MAX_MESSAGES_PER_FILE,
    Math.max(
      SESSION_INGESTION_MIN_MESSAGES_PER_FILE,
      Math.ceil(totalCap / Math.max(1, sortedFiles.length)),
    ),
  );

  for (const file of sortedFiles) {
    if (remaining <= 0) {
      break;
    }
    const stateKey = buildSessionStateKey(file.agentId, file.absolutePath);
    const previous = params.state.files[stateKey];
    const stat = await fs.stat(file.absolutePath).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return null;
      }
      throw err;
    });
    if (!stat) {
      if (previous) {
        changed = true;
      }
      continue;
    }
    const fingerprint = {
      mtimeMs: Math.floor(Math.max(0, stat.mtimeMs)),
      size: Math.floor(Math.max(0, stat.size)),
    };
    const cursorAtEnd =
      previous !== undefined && previous.lastContentLine >= previous.lineCount;
    const unchanged =
      Boolean(previous) &&
      previous.mtimeMs === fingerprint.mtimeMs &&
      previous.size === fingerprint.size &&
      previous.contentHash.length > 0 &&
      cursorAtEnd;
    if (unchanged) {
      nextFiles[stateKey] = previous!;
      continue;
    }

    const entry = await buildSessionEntry(file.absolutePath, {
      generatedByDreamingNarrative: file.generatedByDreamingNarrative,
      generatedByCronRun: file.generatedByCronRun,
    });
    if (!entry) {
      continue;
    }
    if (entry.generatedByDreamingNarrative || entry.generatedByCronRun) {
      nextFiles[stateKey] = {
        mtimeMs: fingerprint.mtimeMs,
        size: fingerprint.size,
        contentHash: entry.hash.trim(),
        lineCount: entry.lineMap.length,
        lastContentLine: entry.lineMap.length,
      };
      if (
        !previous ||
        previous.mtimeMs !== fingerprint.mtimeMs ||
        previous.size !== fingerprint.size ||
        previous.contentHash !== entry.hash.trim() ||
        previous.lineCount !== entry.lineMap.length ||
        previous.lastContentLine !== entry.lineMap.length
      ) {
        changed = true;
      }
      continue;
    }
    const contentHash = entry.hash.trim();
    if (
      previous &&
      previous.mtimeMs === fingerprint.mtimeMs &&
      previous.size === fingerprint.size &&
      previous.contentHash === contentHash &&
      previous.lineCount === entry.lineMap.length &&
      previous.lastContentLine >= previous.lineCount
    ) {
      nextFiles[stateKey] = previous;
      continue;
    }

    const sessionScope = buildSessionScopeKey(file.agentId, file.absolutePath);
    const previousSeen = nextSeenMessages[sessionScope] ?? [];
    let seenSet = new Set(previousSeen);
    const newSeenHashes: string[] = [];

    const lines = entry.content.length > 0 ? entry.content.split("\n") : [];
    const lineCount = lines.length;
    let cursor =
      previous &&
      previous.mtimeMs === fingerprint.mtimeMs &&
      previous.size === fingerprint.size &&
      previous.contentHash === contentHash &&
      previous.lineCount === lineCount
        ? Math.max(0, Math.min(previous.lastContentLine, lineCount))
        : 0;

    const fileCap = Math.max(1, Math.min(perFileCap, remaining));
    let fileCount = 0;
    let lastScannedContentLine = cursor;
    for (let index = cursor; index < lines.length; index += 1) {
      if (fileCount >= fileCap || remaining <= 0) {
        break;
      }
      lastScannedContentLine = index + 1;
      const rawSnippet = lines[index] ?? "";
      const snippet = normalizeSessionCorpusSnippet(rawSnippet);
      if (snippet.length < SESSION_INGESTION_MIN_SNIPPET_CHARS) {
        continue;
      }
      const lineNumber = entry.lineMap[index] ?? index + 1;
      const messageTimestampMs = entry.messageTimestampsMs[index] ?? 0;
      const day = formatMemoryDreamingDay(
        messageTimestampMs > 0 ? messageTimestampMs : fingerprint.mtimeMs,
        params.timezone,
      );
      if (!isDayWithinLookback(day, cutoffMs)) {
        continue;
      }
      const dedupeBasis =
        messageTimestampMs > 0 ? `ts:${Math.floor(messageTimestampMs)}` : `line:${lineNumber}`;
      const messageHash = hashSessionMessageId(
        `${sessionScope}\n${dedupeBasis}\n${snippet}`,
      );
      if (seenSet.has(messageHash)) {
        continue;
      }
      const rendered = buildSessionRenderedLine({
        agentId: file.agentId,
        sessionPath: file.sessionPath,
        lineNumber,
        snippet,
      });
      const bucket = batchByDay.get(day) ?? [];
      bucket.push({ day, snippet, rendered });
      batchByDay.set(day, bucket);
      seenSet.add(messageHash);
      newSeenHashes.push(messageHash);
      fileCount += 1;
      remaining -= 1;
    }

    if (lastScannedContentLine < cursor) {
      lastScannedContentLine = cursor;
    }
    cursor = Math.max(0, Math.min(lastScannedContentLine, lineCount));

    nextFiles[stateKey] = {
      mtimeMs: fingerprint.mtimeMs,
      size: fingerprint.size,
      contentHash,
      lineCount,
      lastContentLine: cursor,
    };
    const mergedSeen = mergeTrackedMessageHashes(previousSeen, newSeenHashes);
    nextSeenMessages[sessionScope] = mergedSeen;
    if (!areStringArraysEqual(mergedSeen, previousSeen)) {
      changed = true;
    }
    if (
      !previous ||
      previous.mtimeMs !== fingerprint.mtimeMs ||
      previous.size !== fingerprint.size ||
      previous.contentHash !== contentHash ||
      previous.lineCount !== lineCount ||
      previous.lastContentLine !== cursor
    ) {
      changed = true;
    }
  }

  for (const [key, state] of Object.entries(params.state.files)) {
    if (!Object.hasOwn(nextFiles, key)) {
      changed = true;
      continue;
    }
    const next = nextFiles[key];
    if (!next || next.mtimeMs !== state.mtimeMs || next.size !== state.size) {
      changed = true;
    }
    if (
      next &&
      typeof state.contentHash === "string" &&
      state.contentHash.trim().length > 0 &&
      next.contentHash !== state.contentHash
    ) {
      changed = true;
    }
    if (
      !next ||
      next.lineCount !== state.lineCount ||
      next.lastContentLine !== state.lastContentLine
    ) {
      changed = true;
    }
  }

  const trimmedSeenMessages = trimTrackedSessionScopes(nextSeenMessages);
  for (const [scope, hashes] of Object.entries(trimmedSeenMessages)) {
    const previous = params.state.seenMessages[scope] ?? [];
    if (!areStringArraysEqual(previous, hashes)) {
      changed = true;
    }
  }
  for (const scope of Object.keys(params.state.seenMessages)) {
    if (!Object.hasOwn(trimmedSeenMessages, scope)) {
      changed = true;
    }
  }

  const batches: Array<{ day: string; results: MemorySearchResult[] }> = [];
  for (const day of [...batchByDay.keys()].toSorted()) {
    const dayLines = batchByDay.get(day) ?? [];
    if (dayLines.length === 0) {
      continue;
    }
    const results = await appendSessionCorpusLines({
      workspaceDir: params.workspaceDir,
      day,
      lines: dayLines,
    });
    if (results.length > 0) {
      batches.push({ day, results });
    }
  }

  return {
    batches,
    nextState: { version: 3, files: nextFiles, seenMessages: trimmedSeenMessages },
    changed,
  };
}

// ─── Pipeline wrapper ─────────────────────────────────────────────────────────

export async function ingestSessionTranscriptSignals(params: {
  workspaceDir: string;
  cfg?: DreamingHostConfig;
  lookbackDays: number;
  nowMs: number;
  timezone?: string;
}): Promise<void> {
  const state = await readSessionIngestionState(params.workspaceDir);
  const collected = await collectSessionIngestionBatches({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    lookbackDays: params.lookbackDays,
    nowMs: params.nowMs,
    timezone: params.timezone,
    state,
  });
  const ingestionDayBucket = formatMemoryDreamingDay(params.nowMs, params.timezone);
  for (const batch of collected.batches) {
    await recordShortTermRecalls({
      workspaceDir: params.workspaceDir,
      query: `__dreaming_sessions__:${batch.day}`,
      results: batch.results,
      signalType: "daily",
      dedupeByQueryPerDay: true,
      dayBucket: ingestionDayBucket,
      nowMs: params.nowMs,
      timezone: params.timezone,
    });
  }
  if (collected.changed) {
    await writeSessionIngestionState(params.workspaceDir, collected.nextState);
  }
}
