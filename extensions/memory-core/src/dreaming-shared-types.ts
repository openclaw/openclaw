import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/memory-core";
import { resolveMemoryDreamingWorkspaces } from "openclaw/plugin-sdk/memory-core-host-status";
import { asRecord, normalizeTrimmedString } from "./dreaming-shared.js";

type Logger = Pick<OpenClawPluginApi["logger"], "info" | "warn" | "error">;
type DreamingHostConfig = unknown;

export { type Logger, type DreamingHostConfig };

// ─── Config types ────────────────────────────────────────────────────────────

export type DreamingPhaseStorageConfig = {
  timezone?: string;
  storage: { mode: "inline" | "separate" | "both"; separateReports: boolean };
};
export type LightDreamingConfig = DreamingPhaseStorageConfig & {
  enabled: boolean;
  lookbackDays: number;
  limit: number;
  dedupeSimilarity: number;
};
export type RemDreamingConfig = DreamingPhaseStorageConfig & {
  enabled: boolean;
  lookbackDays: number;
  limit: number;
  minPatternStrength: number;
};
export type RunPhaseIfTriggeredParams = {
  cleanedBody: string;
  trigger?: string;
  workspaceDir?: string;
  cfg?: DreamingHostConfig;
  logger: Logger;
  subagent?: import("./dreaming-narrative.js").Parameters<
    typeof import("./dreaming-narrative.js").generateAndAppendDreamNarrative
  >[0]["subagent"];
  eventText: string;
} & (
  | {
      phase: "light";
      config: LightDreamingConfig;
    }
  | {
      phase: "rem";
      config: RemDreamingConfig;
    }
);

// ─── Constants ────────────────────────────────────────────────────────────────

export const LIGHT_SLEEP_EVENT_TEXT = "__openclaw_memory_core_light_sleep__";
export const REM_SLEEP_EVENT_TEXT = "__openclaw_memory_core_rem_sleep__";
export const DAILY_MEMORY_FILENAME_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;
export const DAILY_INGESTION_STATE_RELATIVE_PATH = path.join(
  "memory",
  ".dreams",
  "daily-ingestion.json",
);
export const DAILY_INGESTION_SCORE = 0.62;
export const DAILY_INGESTION_MAX_SNIPPET_CHARS = 280;
export const DAILY_INGESTION_MIN_SNIPPET_CHARS = 8;
export const DAILY_INGESTION_MAX_CHUNK_LINES = 4;
export const SESSION_INGESTION_STATE_RELATIVE_PATH = path.join(
  "memory",
  ".dreams",
  "session-ingestion.json",
);
export const SESSION_CORPUS_RELATIVE_DIR = path.join(
  "memory",
  ".dreams",
  "session-corpus",
);
export const SESSION_INGESTION_SCORE = 0.58;
export const SESSION_INGESTION_MAX_SNIPPET_CHARS = 280;
export const SESSION_INGESTION_MIN_SNIPPET_CHARS = 12;
export const SESSION_INGESTION_MAX_MESSAGES_PER_SWEEP = 240;
export const SESSION_INGESTION_MAX_MESSAGES_PER_FILE = 80;
export const SESSION_INGESTION_MIN_MESSAGES_PER_FILE = 12;
export const SESSION_INGESTION_MAX_TRACKED_MESSAGES_PER_SESSION = 4096;
export const SESSION_INGESTION_MAX_TRACKED_SCOPES = 2048;
export const GENERIC_DAY_HEADING_RE =
  /^(?:(?:mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday)(?:,\s+)?)?(?:(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{4}[/-]\d{2}[/-]\d{2})$/i;

export const MANAGED_DAILY_DREAMING_BLOCKS = [
  {
    heading: "## Light Sleep",
    startMarker: "<!-- openclaw:dreaming:light:start -->",
    endMarker: "<!-- openclaw:dreaming:light:end -->",
  },
  {
    heading: "## REM Sleep",
    startMarker: "<!-- openclaw:dreaming:rem:start -->",
    endMarker: "<!-- openclaw:dreaming:rem:end -->",
  },
] as const;

// ─── Workspace resolution ───────────────────────────────────────────────────

export function resolveWorkspaces(params: {
  cfg?: DreamingHostConfig;
  fallbackWorkspaceDir?: string;
}): string[] {
  const workspaceCandidates = params.cfg
    ? resolveMemoryDreamingWorkspaces(
        params.cfg as Parameters<typeof resolveMemoryDreamingWorkspaces>[0],
      ).map((entry) => entry.workspaceDir)
    : [];
  const seen = new Set<string>();
  const workspaces = workspaceCandidates.filter((workspaceDir) => {
    if (seen.has(workspaceDir)) {
      return false;
    }
    seen.add(workspaceDir);
    return true;
  });
  const fallbackWorkspaceDir = normalizeTrimmedString(params.fallbackWorkspaceDir);
  if (workspaces.length === 0 && fallbackWorkspaceDir) {
    workspaces.push(fallbackWorkspaceDir);
  }
  return workspaces;
}

// ─── Lookback helpers ────────────────────────────────────────────────────────

export function calculateLookbackCutoffMs(nowMs: number, lookbackDays: number): number {
  return nowMs - Math.max(0, lookbackDays) * 24 * 60 * 60 * 1000;
}

export function isDayWithinLookback(day: string, cutoffMs: number): boolean {
  const dayMs = Date.parse(`${day}T23:59:59.999Z`);
  return Number.isFinite(dayMs) && dayMs >= cutoffMs;
}

// ─── Daily file normalization helpers ────────────────────────────────────────

export function normalizeDailyListMarker(line: string): string {
  return line.replace(/^\d+\.\s+/, "").replace(/^[-*+]\s+/, "").trim();
}

export function normalizeDailyHeading(line: string): string | null {
  const trimmed = line.trim();
  const match = trimmed.match(/^#{1,6}\s+(.+)$/);
  if (!match) {
    return null;
  }
  const heading = match[1] ? normalizeDailyListMarker(match[1]) : "";
  if (
    !heading ||
    DAILY_MEMORY_FILENAME_RE.test(heading) ||
    isGenericDailyHeading(heading)
  ) {
    return null;
  }
  return heading.slice(0, DAILY_INGESTION_MAX_SNIPPET_CHARS).replace(/\s+/g, " ");
}

export function isGenericDailyHeading(heading: string): boolean {
  const normalized = heading.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return true;
  }
  const lower = normalized.toLowerCase();
  if (lower === "today" || lower === "yesterday" || lower === "tomorrow") {
    return true;
  }
  if (
    lower === "morning" ||
    lower === "afternoon" ||
    lower === "evening" ||
    lower === "night"
  ) {
    return true;
  }
  return GENERIC_DAY_HEADING_RE.test(normalized);
}

export function normalizeDailySnippet(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("<!--")) {
    return null;
  }
  const withoutListMarker = normalizeDailyListMarker(trimmed);
  if (withoutListMarker.length < DAILY_INGESTION_MIN_SNIPPET_CHARS) {
    return null;
  }
  return withoutListMarker
    .slice(0, DAILY_INGESTION_MAX_SNIPPET_CHARS)
    .replace(/\s+/g, " ");
}

// ─── Daily snippet chunk builder ─────────────────────────────────────────────

export type DailySnippetChunk = {
  startLine: number;
  endLine: number;
  snippet: string;
};

export function buildDailyChunkSnippet(
  heading: string | null,
  chunkLines: string[],
  chunkKind: "list" | "paragraph" | null,
): string {
  const joiner = chunkKind === "list" ? "; " : " ";
  const body = chunkLines.join(joiner).trim();
  const prefixed = heading ? `${heading}: ${body}` : body;
  return prefixed.slice(0, DAILY_INGESTION_MAX_SNIPPET_CHARS).replace(/\s+/g, " ").trim();
}

export function buildDailySnippetChunks(lines: string[], limit: number): DailySnippetChunk[] {
  const chunks: DailySnippetChunk[] = [];
  let activeHeading: string | null = null;
  let chunkLines: string[] = [];
  let chunkKind: "list" | "paragraph" | null = null;
  let chunkStartLine = 0;
  let chunkEndLine = 0;

  const flushChunk = () => {
    if (chunkLines.length === 0) {
      chunkKind = null;
      chunkStartLine = 0;
      chunkEndLine = 0;
      return;
    }

    const snippet = buildDailyChunkSnippet(activeHeading, chunkLines, chunkKind);
    if (snippet.length >= DAILY_INGESTION_MIN_SNIPPET_CHARS) {
      chunks.push({
        startLine: chunkStartLine,
        endLine: chunkEndLine,
        snippet,
      });
    }

    chunkLines = [];
    chunkKind = null;
    chunkStartLine = 0;
    chunkEndLine = 0;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (typeof line !== "string") {
      continue;
    }

    const heading = normalizeDailyHeading(line);
    if (heading) {
      flushChunk();
      activeHeading = heading;
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("<!--")) {
      flushChunk();
      continue;
    }

    const snippet = normalizeDailySnippet(line);
    if (!snippet) {
      flushChunk();
      continue;
    }

    const nextKind = /^([-*+]\s+|\d+\.\s+)/.test(trimmed) ? "list" : "paragraph";
    const nextChunkLines =
      chunkLines.length === 0 ? [snippet] : [...chunkLines, snippet];
    const candidateSnippet = buildDailyChunkSnippet(
      activeHeading,
      nextChunkLines,
      nextKind,
    );
    const shouldSplit =
      chunkLines.length > 0 &&
      (chunkKind !== nextKind ||
        chunkLines.length >= DAILY_INGESTION_MAX_CHUNK_LINES ||
        candidateSnippet.length > DAILY_INGESTION_MAX_SNIPPET_CHARS);

    if (shouldSplit) {
      flushChunk();
    }

    if (chunkLines.length === 0) {
      chunkStartLine = index + 1;
      chunkKind = nextKind;
    }
    chunkLines.push(snippet);
    chunkEndLine = index + 1;

    if (chunks.length >= limit) {
      break;
    }
  }

  flushChunk();
  return chunks.slice(0, limit);
}

// ─── Managed block helpers (shared between daily file scanner & markdown writer) ──

export function findManagedDailyDreamingHeadingIndex(
  lines: string[],
  startIndex: number,
  heading: string,
): number | null {
  for (let index = startIndex - 1; index >= 0; index -= 1) {
    const trimmed = lines[index]?.trim() ?? "";
    if (!trimmed) {
      continue;
    }
    return trimmed === heading ? index : null;
  }
  return null;
}

export function isManagedDailyDreamingBoundary(
  line: string,
  blockByStartMarker: ReadonlyMap<
    string,
    (typeof MANAGED_DAILY_DREAMING_BLOCKS)[number]
  >,
): boolean {
  const trimmed = line.trim();
  return /^#{1,6}\s+/.test(trimmed) || blockByStartMarker.has(trimmed);
}

export function stripManagedDailyDreamingLines(lines: string[]): string[] {
  const blockByStartMarker: ReadonlyMap<
    string,
    (typeof MANAGED_DAILY_DREAMING_BLOCKS)[number]
  > = new Map(MANAGED_DAILY_DREAMING_BLOCKS.map((block) => [block.startMarker, block]));
  const sanitized = [...lines];
  for (let index = 0; index < sanitized.length; index += 1) {
    const block = blockByStartMarker.get(sanitized[index]?.trim() ?? "");
    if (!block) {
      continue;
    }

    let stripUntilIndex = -1;
    for (let cursor = index + 1; cursor < sanitized.length; cursor += 1) {
      const line = sanitized[cursor];
      const trimmed = line?.trim() ?? "";
      if (trimmed === block.endMarker) {
        stripUntilIndex = cursor;
        break;
      }
      if (line && isManagedDailyDreamingBoundary(line, blockByStartMarker)) {
        stripUntilIndex = cursor - 1;
        break;
      }
    }
    if (stripUntilIndex < index) {
      continue;
    }

    const headingIndex = findManagedDailyDreamingHeadingIndex(
      lines,
      index,
      block.heading,
    );
    const startIndex = headingIndex ?? index;
    for (let cursor = startIndex; cursor <= stripUntilIndex; cursor += 1) {
      sanitized[cursor] = "";
    }
    index = stripUntilIndex;
  }

  return sanitized;
}

// ─── Daily ingestion state (normalized) ─────────────────────────────────────

export type DailyIngestionFileState = {
  mtimeMs: number;
  size: number;
};
export type DailyIngestionState = {
  version: 1;
  files: Record<string, DailyIngestionFileState>;
};

export function resolveDailyIngestionStatePath(workspaceDir: string): string {
  return path.join(workspaceDir, DAILY_INGESTION_STATE_RELATIVE_PATH);
}

/** Normalize a raw unknown value to a typed DailyIngestionState. */
export function normalizeDailyIngestionState(raw: unknown): DailyIngestionState {
  const record = asRecord(raw);
  const filesRaw = asRecord(record?.files);
  if (!filesRaw) {
    return { version: 1, files: {} };
  }
  const files: Record<string, DailyIngestionFileState> = {};
  for (const [key, value] of Object.entries(filesRaw)) {
    const file = asRecord(value);
    if (!file || typeof key !== "string" || key.trim().length === 0) {
      continue;
    }
    const mtimeMs = Number(file.mtimeMs);
    const size = Number(file.size);
    if (!Number.isFinite(mtimeMs) || mtimeMs < 0 || !Number.isFinite(size) || size < 0) {
      continue;
    }
    files[key] = {
      mtimeMs: Math.floor(mtimeMs),
      size: Math.floor(size),
    };
  }
  return { version: 1, files };
}

// ─── Session corpus normalization helpers ───────────────────────────────────

export function normalizeWorkspaceKey(workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir).replace(/\\/g, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function normalizeSessionCorpusSnippet(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, SESSION_INGESTION_MAX_SNIPPET_CHARS);
}

export { createHash } from "node:crypto";

// Re-exported from dreaming-shared for convenience
export { asRecord } from "./dreaming-shared.js";
