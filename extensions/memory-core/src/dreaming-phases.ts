import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/memory-core";
import {
  buildSessionEntry,
  listSessionFilesForAgent,
  parseUsageCountedSessionIdFromFileName,
  sessionPathForFile,
} from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import {
  formatMemoryDreamingDay,
  resolveMemoryCorePluginConfig,
  resolveMemoryDreamingWorkspaces,
  resolveMemoryLightDreamingConfig,
  resolveMemoryRemDreamingConfig,
  type MemoryLightDreamingConfig,
  type MemoryRemDreamingConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import { writeDailyDreamingPhaseBlock } from "./dreaming-markdown.js";
import { generateAndAppendDreamNarrative, type NarrativePhaseData } from "./dreaming-narrative.js";
import { asRecord, formatErrorMessage, normalizeTrimmedString } from "./dreaming-shared.js";
import {
  readShortTermRecallEntries,
  recordDreamingPhaseSignals,
  recordShortTermRecalls,
  type ShortTermRecallEntry,
} from "./short-term-promotion.js";

type Logger = Pick<OpenClawPluginApi["logger"], "info" | "warn" | "error">;

type CronSchedule = { kind: "cron"; expr: string; tz?: string };
type CronPayload = { kind: "systemEvent"; text: string };
type ManagedCronJobCreate = {
  name: string;
  description: string;
  enabled: boolean;
  schedule: CronSchedule;
  sessionTarget: "main";
  wakeMode: "next-heartbeat";
  payload: CronPayload;
};

type ManagedCronJobPatch = {
  name?: string;
  description?: string;
  enabled?: boolean;
  schedule?: CronSchedule;
  sessionTarget?: "main";
  wakeMode?: "next-heartbeat";
  payload?: CronPayload;
};

type ManagedCronJobLike = {
  id: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  schedule?: {
    kind?: string;
    expr?: string;
    tz?: string;
  };
  sessionTarget?: string;
  wakeMode?: string;
  payload?: {
    kind?: string;
    text?: string;
  };
  createdAtMs?: number;
};

type CronServiceLike = {
  list: (opts?: { includeDisabled?: boolean }) => Promise<ManagedCronJobLike[]>;
  add: (input: ManagedCronJobCreate) => Promise<unknown>;
  update: (id: string, patch: ManagedCronJobPatch) => Promise<unknown>;
  remove: (id: string) => Promise<{ removed?: boolean }>;
};

const LIGHT_SLEEP_CRON_NAME = "Memory Light Dreaming";
const LIGHT_SLEEP_CRON_TAG = "[managed-by=memory-core.dreaming.light]";
const LIGHT_SLEEP_EVENT_TEXT = "__openclaw_memory_core_light_sleep__";

const REM_SLEEP_CRON_NAME = "Memory REM Dreaming";
const REM_SLEEP_CRON_TAG = "[managed-by=memory-core.dreaming.rem]";
const REM_SLEEP_EVENT_TEXT = "__openclaw_memory_core_rem_sleep__";
const DAILY_MEMORY_FILENAME_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;
const DAILY_INGESTION_STATE_RELATIVE_PATH = path.join("memory", ".dreams", "daily-ingestion.json");
const DAILY_INGESTION_SCORE = 0.62;
const DAILY_INGESTION_MAX_SNIPPET_CHARS = 280;
const DAILY_INGESTION_MIN_SNIPPET_CHARS = 8;
const DAILY_INGESTION_MAX_CHUNK_LINES = 4;
const SESSION_INGESTION_STATE_RELATIVE_PATH = path.join(
  "memory",
  ".dreams",
  "session-ingestion.json",
);
const SESSION_CORPUS_RELATIVE_DIR = path.join("memory", ".dreams", "session-corpus");
const SESSION_INGESTION_SCORE = 0.58;
const SESSION_INGESTION_MAX_SNIPPET_CHARS = 280;
const SESSION_INGESTION_MIN_SNIPPET_CHARS = 12;
const SESSION_INGESTION_MAX_MESSAGES_PER_SWEEP = 240;
const SESSION_INGESTION_MAX_MESSAGES_PER_FILE = 80;
const SESSION_INGESTION_MIN_MESSAGES_PER_FILE = 12;
const SESSION_INGESTION_MAX_TRACKED_MESSAGES_PER_SESSION = 4096;
const SESSION_INGESTION_MAX_TRACKED_SCOPES = 2048;
const GENERIC_DAY_HEADING_RE =
  /^(?:(?:mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday)(?:,\s+)?)?(?:(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{4}[/-]\d{2}[/-]\d{2})$/i;
const MANAGED_DAILY_DREAMING_BLOCKS = [
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

function buildCronDescription(params: {
  tag: string;
  phase: "light" | "rem";
  cron: string;
  limit: number;
  lookbackDays: number;
}): string {
  return `${params.tag} Run ${params.phase} dreaming (cron=${params.cron}, limit=${params.limit}, lookbackDays=${params.lookbackDays}).`;
}

function buildManagedCronJob(params: {
  name: string;
  tag: string;
  payloadText: string;
  cron: string;
  timezone?: string;
  phase: "light" | "rem";
  limit: number;
  lookbackDays: number;
}): ManagedCronJobCreate {
  return {
    name: params.name,
    description: buildCronDescription({
      tag: params.tag,
      phase: params.phase,
      cron: params.cron,
      limit: params.limit,
      lookbackDays: params.lookbackDays,
    }),
    enabled: true,
    schedule: {
      kind: "cron",
      expr: params.cron,
      ...(params.timezone ? { tz: params.timezone } : {}),
    },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "systemEvent",
      text: params.payloadText,
    },
  };
}

function isManagedPhaseJob(
  job: ManagedCronJobLike,
  params: {
    name: string;
    tag: string;
    payloadText: string;
  },
): boolean {
  const description = normalizeTrimmedString(job.description);
  if (description?.includes(params.tag)) {
    return true;
  }
  const name = normalizeTrimmedString(job.name);
  const payloadText = normalizeTrimmedString(job.payload?.text);
  return name === params.name && payloadText === params.payloadText;
}

function buildManagedPhasePatch(
  job: ManagedCronJobLike,
  desired: ManagedCronJobCreate,
): ManagedCronJobPatch | null {
  const patch: ManagedCronJobPatch = {};
  const scheduleKind = normalizeTrimmedString(job.schedule?.kind)?.toLowerCase();
  const scheduleExpr = normalizeTrimmedString(job.schedule?.expr);
  const scheduleTz = normalizeTrimmedString(job.schedule?.tz);
  if (normalizeTrimmedString(job.name) !== desired.name) {
    patch.name = desired.name;
  }
  if (normalizeTrimmedString(job.description) !== desired.description) {
    patch.description = desired.description;
  }
  if (job.enabled !== true) {
    patch.enabled = true;
  }
  if (
    scheduleKind !== "cron" ||
    scheduleExpr !== desired.schedule.expr ||
    scheduleTz !== desired.schedule.tz
  ) {
    patch.schedule = desired.schedule;
  }
  if (normalizeTrimmedString(job.sessionTarget)?.toLowerCase() !== "main") {
    patch.sessionTarget = "main";
  }
  if (normalizeTrimmedString(job.wakeMode)?.toLowerCase() !== "next-heartbeat") {
    patch.wakeMode = "next-heartbeat";
  }
  const payloadKind = normalizeTrimmedString(job.payload?.kind)?.toLowerCase();
  const payloadText = normalizeTrimmedString(job.payload?.text);
  if (payloadKind !== "systemevent" || payloadText !== desired.payload.text) {
    patch.payload = desired.payload;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

function sortManagedJobs(managed: ManagedCronJobLike[]): ManagedCronJobLike[] {
  return managed.toSorted((a, b) => {
    const aCreated =
      typeof a.createdAtMs === "number" && Number.isFinite(a.createdAtMs)
        ? a.createdAtMs
        : Number.MAX_SAFE_INTEGER;
    const bCreated =
      typeof b.createdAtMs === "number" && Number.isFinite(b.createdAtMs)
        ? b.createdAtMs
        : Number.MAX_SAFE_INTEGER;
    if (aCreated !== bCreated) {
      return aCreated - bCreated;
    }
    return a.id.localeCompare(b.id);
  });
}

function resolveCronServiceFromStartupEvent(event: unknown): CronServiceLike | null {
  const payload = asRecord(event);
  if (!payload || payload.type !== "gateway" || payload.action !== "startup") {
    return null;
  }
  const context = asRecord(payload.context);
  const deps = asRecord(context?.deps);
  const cronCandidate = context?.cron ?? deps?.cron;
  if (!cronCandidate || typeof cronCandidate !== "object") {
    return null;
  }
  const cron = cronCandidate as Partial<CronServiceLike>;
  if (
    typeof cron.list !== "function" ||
    typeof cron.add !== "function" ||
    typeof cron.update !== "function" ||
    typeof cron.remove !== "function"
  ) {
    return null;
  }
  return cron as CronServiceLike;
}

async function reconcileManagedPhaseCronJob(params: {
  cron: CronServiceLike | null;
  desired: ManagedCronJobCreate;
  match: { name: string; tag: string; payloadText: string };
  enabled: boolean;
  logger: Logger;
}): Promise<void> {
  const cron = params.cron;
  if (!cron) {
    return;
  }
  const allJobs = await cron.list({ includeDisabled: true });
  const managed = allJobs.filter((job) => isManagedPhaseJob(job, params.match));
  if (!params.enabled) {
    for (const job of managed) {
      try {
        await cron.remove(job.id);
      } catch (err) {
        params.logger.warn(
          `memory-core: failed to remove managed ${params.match.name} cron job ${job.id}: ${formatErrorMessage(err)}`,
        );
      }
    }
    return;
  }

  if (managed.length === 0) {
    await cron.add(params.desired);
    return;
  }

  const [primary, ...duplicates] = sortManagedJobs(managed);
  for (const duplicate of duplicates) {
    try {
      await cron.remove(duplicate.id);
    } catch (err) {
      params.logger.warn(
        `memory-core: failed to prune duplicate managed ${params.match.name} cron job ${duplicate.id}: ${formatErrorMessage(err)}`,
      );
    }
  }

  const patch = buildManagedPhasePatch(primary, params.desired);
  if (patch) {
    await cron.update(primary.id, patch);
  }
}

function resolveWorkspaces(params: {
  cfg?: OpenClawConfig;
  fallbackWorkspaceDir?: string;
}): string[] {
  const workspaceCandidates = params.cfg
    ? resolveMemoryDreamingWorkspaces(params.cfg).map((entry) => entry.workspaceDir)
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

function calculateLookbackCutoffMs(nowMs: number, lookbackDays: number): number {
  return nowMs - Math.max(0, lookbackDays) * 24 * 60 * 60 * 1000;
}

function isDayWithinLookback(day: string, cutoffMs: number): boolean {
  const dayMs = Date.parse(`${day}T23:59:59.999Z`);
  return Number.isFinite(dayMs) && dayMs >= cutoffMs;
}

function normalizeDailyListMarker(line: string): string {
  return line
    .replace(/^\d+\.\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .trim();
}

function normalizeDailyHeading(line: string): string | null {
  const trimmed = line.trim();
  const match = trimmed.match(/^#{1,6}\s+(.+)$/);
  if (!match) {
    return null;
  }
  const heading = match[1] ? normalizeDailyListMarker(match[1]) : "";
  if (!heading || DAILY_MEMORY_FILENAME_RE.test(heading) || isGenericDailyHeading(heading)) {
    return null;
  }
  return heading.slice(0, DAILY_INGESTION_MAX_SNIPPET_CHARS).replace(/\s+/g, " ");
}

function isGenericDailyHeading(heading: string): boolean {
  const normalized = heading.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return true;
  }
  const lower = normalized.toLowerCase();
  if (lower === "today" || lower === "yesterday" || lower === "tomorrow") {
    return true;
  }
  if (lower === "morning" || lower === "afternoon" || lower === "evening" || lower === "night") {
    return true;
  }
  return GENERIC_DAY_HEADING_RE.test(normalized);
}

function normalizeDailySnippet(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("<!--")) {
    return null;
  }
  const withoutListMarker = normalizeDailyListMarker(trimmed);
  if (withoutListMarker.length < DAILY_INGESTION_MIN_SNIPPET_CHARS) {
    return null;
  }
  return withoutListMarker.slice(0, DAILY_INGESTION_MAX_SNIPPET_CHARS).replace(/\s+/g, " ");
}

type DailySnippetChunk = {
  startLine: number;
  endLine: number;
  snippet: string;
};

function buildDailyChunkSnippet(
  heading: string | null,
  chunkLines: string[],
  chunkKind: "list" | "paragraph" | null,
): string {
  const joiner = chunkKind === "list" ? "; " : " ";
  const body = chunkLines.join(joiner).trim();
  const prefixed = heading ? `${heading}: ${body}` : body;
  return prefixed.slice(0, DAILY_INGESTION_MAX_SNIPPET_CHARS).replace(/\s+/g, " ").trim();
}

function buildDailySnippetChunks(lines: string[], limit: number): DailySnippetChunk[] {
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
    const nextChunkLines = chunkLines.length === 0 ? [snippet] : [...chunkLines, snippet];
    const candidateSnippet = buildDailyChunkSnippet(activeHeading, nextChunkLines, nextKind);
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

function findManagedDailyDreamingHeadingIndex(
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

function isManagedDailyDreamingBoundary(
  line: string,
  blockByStartMarker: ReadonlyMap<string, (typeof MANAGED_DAILY_DREAMING_BLOCKS)[number]>,
): boolean {
  const trimmed = line.trim();
  return /^#{1,6}\s+/.test(trimmed) || blockByStartMarker.has(trimmed);
}

function stripManagedDailyDreamingLines(lines: string[]): string[] {
  const blockByStartMarker: ReadonlyMap<string, (typeof MANAGED_DAILY_DREAMING_BLOCKS)[number]> =
    new Map(MANAGED_DAILY_DREAMING_BLOCKS.map((block) => [block.startMarker, block]));
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

    const headingIndex = findManagedDailyDreamingHeadingIndex(lines, index, block.heading);
    const startIndex = headingIndex ?? index;
    for (let cursor = startIndex; cursor <= stripUntilIndex; cursor += 1) {
      sanitized[cursor] = "";
    }
    index = stripUntilIndex;
  }

  return sanitized;
}

function entryWithinLookback(entry: ShortTermRecallEntry, cutoffMs: number): boolean {
  const byDay = (entry.recallDays ?? []).some((day) => isDayWithinLookback(day, cutoffMs));
  if (byDay) {
    return true;
  }
  const lastRecalledAtMs = Date.parse(entry.lastRecalledAt);
  return Number.isFinite(lastRecalledAtMs) && lastRecalledAtMs >= cutoffMs;
}

type DailyIngestionBatch = {
  day: string;
  results: MemorySearchResult[];
};

type DailyIngestionFileState = {
  mtimeMs: number;
  size: number;
};

type DailyIngestionState = {
  version: 1;
  files: Record<string, DailyIngestionFileState>;
};

function resolveDailyIngestionStatePath(workspaceDir: string): string {
  return path.join(workspaceDir, DAILY_INGESTION_STATE_RELATIVE_PATH);
}

function normalizeDailyIngestionState(raw: unknown): DailyIngestionState {
  const record = asRecord(raw);
  const filesRaw = asRecord(record?.files);
  if (!filesRaw) {
    return {
      version: 1,
      files: {},
    };
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
  return {
    version: 1,
    files,
  };
}

async function readDailyIngestionState(workspaceDir: string): Promise<DailyIngestionState> {
  const statePath = resolveDailyIngestionStatePath(workspaceDir);
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    return normalizeDailyIngestionState(JSON.parse(raw) as unknown);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || err instanceof SyntaxError) {
      return { version: 1, files: {} };
    }
    throw err;
  }
}

async function writeDailyIngestionState(
  workspaceDir: string,
  state: DailyIngestionState,
): Promise<void> {
  const statePath = resolveDailyIngestionStatePath(workspaceDir);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  await fs.rename(tmpPath, statePath);
}

type SessionIngestionFileState = {
  mtimeMs: number;
  size: number;
  contentHash: string;
};

type SessionIngestionState = {
  version: 2;
  files: Record<string, SessionIngestionFileState>;
  seenMessages: Record<string, string[]>;
};

type SessionIngestionMessage = {
  day: string;
  snippet: string;
  rendered: string;
};

type SessionIngestionCollectionResult = {
  batches: DailyIngestionBatch[];
  nextState: SessionIngestionState;
  changed: boolean;
};

function normalizeWorkspaceKey(workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir).replace(/\\/g, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

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
      files[key] = {
        mtimeMs: Math.floor(mtimeMs),
        size: Math.floor(size),
        contentHash: typeof file.contentHash === "string" ? file.contentHash.trim() : "",
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
  return { version: 2, files, seenMessages };
}

async function readSessionIngestionState(workspaceDir: string): Promise<SessionIngestionState> {
  const statePath = resolveSessionIngestionStatePath(workspaceDir);
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    return normalizeSessionIngestionState(JSON.parse(raw) as unknown);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || err instanceof SyntaxError) {
      return { version: 2, files: {}, seenMessages: {} };
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

function normalizeSessionCorpusSnippet(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, SESSION_INGESTION_MAX_SNIPPET_CHARS);
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
  return `[${source}] ${params.snippet}`.slice(0, SESSION_INGESTION_MAX_SNIPPET_CHARS + 64);
}

function resolveSessionAgentsForWorkspace(
  cfg: OpenClawConfig | undefined,
  workspaceDir: string,
): string[] {
  if (!cfg) {
    return [];
  }
  const target = normalizeWorkspaceKey(workspaceDir);
  const workspaces = resolveMemoryDreamingWorkspaces(cfg);
  const match = workspaces.find((entry) => normalizeWorkspaceKey(entry.workspaceDir) === target);
  if (!match) {
    return [];
  }
  return match.agentIds
    .filter((agentId, index, all) => agentId.trim().length > 0 && all.indexOf(agentId) === index)
    .toSorted();
}

async function appendSessionCorpusLines(params: {
  workspaceDir: string;
  day: string;
  lines: SessionIngestionMessage[];
}): Promise<MemorySearchResult[]> {
  if (params.lines.length === 0) {
    return [];
  }
  const relativePath = path.posix.join("memory", ".dreams", "session-corpus", `${params.day}.txt`);
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
      path: relativePath,
      startLine: lineNumber,
      endLine: lineNumber,
      score: SESSION_INGESTION_SCORE,
      snippet: entry.snippet,
      source: "memory",
    };
  });
}

async function collectSessionIngestionBatches(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  lookbackDays: number;
  nowMs: number;
  timezone?: string;
  state: SessionIngestionState;
}): Promise<SessionIngestionCollectionResult> {
  if (!params.cfg) {
    return {
      batches: [],
      nextState: { version: 2, files: {}, seenMessages: {} },
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

  const sessionFiles: Array<{ agentId: string; absolutePath: string; sessionPath: string }> = [];
  for (const agentId of agentIds) {
    const files = await listSessionFilesForAgent(agentId);
    for (const absolutePath of files) {
      sessionFiles.push({
        agentId,
        absolutePath,
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
    const unchanged =
      Boolean(previous) &&
      previous.mtimeMs === fingerprint.mtimeMs &&
      previous.size === fingerprint.size &&
      previous.contentHash.length > 0;
    if (unchanged) {
      nextFiles[stateKey] = previous!;
      continue;
    }

    const entry = await buildSessionEntry(file.absolutePath);
    if (!entry) {
      continue;
    }
    const contentHash = entry.hash.trim();
    if (
      previous &&
      previous.mtimeMs === fingerprint.mtimeMs &&
      previous.size === fingerprint.size &&
      previous.contentHash === contentHash
    ) {
      nextFiles[stateKey] = previous;
      continue;
    }

    const sessionScope = buildSessionScopeKey(file.agentId, file.absolutePath);
    const previousSeen = nextSeenMessages[sessionScope] ?? [];
    let seenSet = new Set(previousSeen);
    const newSeenHashes: string[] = [];

    const lines = entry.content.length > 0 ? entry.content.split("\n") : [];
    const day = formatMemoryDreamingDay(fingerprint.mtimeMs, params.timezone);
    if (!isDayWithinLookback(day, cutoffMs)) {
      nextFiles[stateKey] = {
        mtimeMs: fingerprint.mtimeMs,
        size: fingerprint.size,
        contentHash,
      };
      continue;
    }

    const fileCap = Math.max(1, Math.min(perFileCap, remaining));
    let fileCount = 0;
    for (let index = 0; index < lines.length; index += 1) {
      if (fileCount >= fileCap || remaining <= 0) {
        break;
      }
      const rawSnippet = lines[index] ?? "";
      const snippet = normalizeSessionCorpusSnippet(rawSnippet);
      if (snippet.length < SESSION_INGESTION_MIN_SNIPPET_CHARS) {
        continue;
      }
      const lineNumber = entry.lineMap[index] ?? index + 1;
      const messageHash = hashSessionMessageId(
        `${file.agentId}\n${sessionScope}\n${lineNumber}\n${snippet}`,
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

    nextFiles[stateKey] = {
      mtimeMs: fingerprint.mtimeMs,
      size: fingerprint.size,
      contentHash,
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
      previous.contentHash !== contentHash
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

  const batches: DailyIngestionBatch[] = [];
  for (const day of [...batchByDay.keys()].toSorted()) {
    const lines = batchByDay.get(day) ?? [];
    if (lines.length === 0) {
      continue;
    }
    const results = await appendSessionCorpusLines({
      workspaceDir: params.workspaceDir,
      day,
      lines,
    });
    if (results.length > 0) {
      batches.push({ day, results });
    }
  }

  return {
    batches,
    nextState: { version: 2, files: nextFiles, seenMessages: trimmedSeenMessages },
    changed,
  };
}

async function ingestSessionTranscriptSignals(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
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
  for (const batch of collected.batches) {
    await recordShortTermRecalls({
      workspaceDir: params.workspaceDir,
      query: `__dreaming_sessions__:${batch.day}`,
      results: batch.results,
      signalType: "daily",
      dedupeByQueryPerDay: true,
      dayBucket: batch.day,
      nowMs: params.nowMs,
      timezone: params.timezone,
    });
  }
  if (collected.changed) {
    await writeSessionIngestionState(params.workspaceDir, collected.nextState);
  }
}

type DailyIngestionCollectionResult = {
  batches: DailyIngestionBatch[];
  nextState: DailyIngestionState;
  changed: boolean;
};

async function collectDailyIngestionBatches(params: {
  workspaceDir: string;
  lookbackDays: number;
  limit: number;
  nowMs: number;
  state: DailyIngestionState;
}): Promise<DailyIngestionCollectionResult> {
  const memoryDir = path.join(params.workspaceDir, "memory");
  const cutoffMs = calculateLookbackCutoffMs(params.nowMs, params.lookbackDays);
  const entries = await fs.readdir(memoryDir, { withFileTypes: true }).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [] as Dirent[];
    }
    throw err;
  });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const match = entry.name.match(DAILY_MEMORY_FILENAME_RE);
      if (!match) {
        return null;
      }
      const day = match[1];
      if (!isDayWithinLookback(day, cutoffMs)) {
        return null;
      }
      return { fileName: entry.name, day };
    })
    .filter((entry): entry is { fileName: string; day: string } => entry !== null)
    .toSorted((a, b) => b.day.localeCompare(a.day));

  const batches: DailyIngestionBatch[] = [];
  const nextFiles: Record<string, DailyIngestionFileState> = {};
  let changed = false;
  const totalCap = Math.max(20, params.limit * 4);
  const perFileCap = Math.max(6, Math.ceil(totalCap / Math.max(1, Math.max(files.length, 1))));
  let total = 0;
  for (const file of files) {
    const relativePath = `memory/${file.fileName}`;
    const filePath = path.join(memoryDir, file.fileName);
    const stat = await fs.stat(filePath).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return null;
      }
      throw err;
    });
    if (!stat) {
      continue;
    }
    const fingerprint: DailyIngestionFileState = {
      mtimeMs: Math.floor(Math.max(0, stat.mtimeMs)),
      size: Math.floor(Math.max(0, stat.size)),
    };
    nextFiles[relativePath] = fingerprint;
    const previous = params.state.files[relativePath];
    const unchanged =
      previous !== undefined &&
      previous.mtimeMs === fingerprint.mtimeMs &&
      previous.size === fingerprint.size;
    if (!unchanged) {
      changed = true;
    } else {
      continue;
    }

    const raw = await fs.readFile(filePath, "utf-8").catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return "";
      }
      throw err;
    });
    if (!raw) {
      continue;
    }
    const lines = stripManagedDailyDreamingLines(raw.split(/\r?\n/));
    const chunks = buildDailySnippetChunks(lines, perFileCap);
    const results: MemorySearchResult[] = [];
    for (const chunk of chunks) {
      results.push({
        path: relativePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        score: DAILY_INGESTION_SCORE,
        snippet: chunk.snippet,
        source: "memory",
      });
      if (results.length >= perFileCap || total + results.length >= totalCap) {
        break;
      }
    }
    if (results.length === 0) {
      continue;
    }
    batches.push({ day: file.day, results });
    total += results.length;
    if (total >= totalCap) {
      break;
    }
  }

  if (!changed) {
    const previousKeys = Object.keys(params.state.files);
    const nextKeys = Object.keys(nextFiles);
    if (
      previousKeys.length !== nextKeys.length ||
      previousKeys.some((key) => !Object.hasOwn(nextFiles, key))
    ) {
      changed = true;
    }
  }

  return {
    batches,
    nextState: {
      version: 1,
      files: nextFiles,
    },
    changed,
  };
}

async function ingestDailyMemorySignals(params: {
  workspaceDir: string;
  lookbackDays: number;
  limit: number;
  nowMs: number;
  timezone?: string;
}): Promise<void> {
  const state = await readDailyIngestionState(params.workspaceDir);
  const collected = await collectDailyIngestionBatches({
    workspaceDir: params.workspaceDir,
    lookbackDays: params.lookbackDays,
    limit: params.limit,
    nowMs: params.nowMs,
    state,
  });
  for (const batch of collected.batches) {
    await recordShortTermRecalls({
      workspaceDir: params.workspaceDir,
      query: `__dreaming_daily__:${batch.day}`,
      results: batch.results,
      signalType: "daily",
      dedupeByQueryPerDay: true,
      dayBucket: batch.day,
      nowMs: params.nowMs,
      timezone: params.timezone,
    });
  }
  if (collected.changed) {
    await writeDailyIngestionState(params.workspaceDir, collected.nextState);
  }
}

function entryAverageScore(entry: ShortTermRecallEntry): number {
  return entry.recallCount > 0 ? Math.max(0, Math.min(1, entry.totalScore / entry.recallCount)) : 0;
}

function tokenizeSnippet(snippet: string): Set<string> {
  return new Set(
    snippet
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .map((token) => token.trim())
      .filter(Boolean),
  );
}

function jaccardSimilarity(left: string, right: string): number {
  const leftTokens = tokenizeSnippet(left);
  const rightTokens = tokenizeSnippet(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return left.trim().toLowerCase() === right.trim().toLowerCase() ? 1 : 0;
  }
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union > 0 ? intersection / union : 0;
}

function dedupeEntries(entries: ShortTermRecallEntry[], threshold: number): ShortTermRecallEntry[] {
  const deduped: ShortTermRecallEntry[] = [];
  for (const entry of entries) {
    const duplicate = deduped.find(
      (candidate) =>
        candidate.path === entry.path &&
        jaccardSimilarity(candidate.snippet, entry.snippet) >= threshold,
    );
    if (duplicate) {
      if (entry.recallCount > duplicate.recallCount) {
        duplicate.recallCount = entry.recallCount;
      }
      duplicate.totalScore = Math.max(duplicate.totalScore, entry.totalScore);
      duplicate.maxScore = Math.max(duplicate.maxScore, entry.maxScore);
      duplicate.queryHashes = [...new Set([...duplicate.queryHashes, ...entry.queryHashes])];
      duplicate.recallDays = [
        ...new Set([...duplicate.recallDays, ...entry.recallDays]),
      ].toSorted();
      duplicate.conceptTags = [...new Set([...duplicate.conceptTags, ...entry.conceptTags])];
      duplicate.lastRecalledAt =
        Date.parse(entry.lastRecalledAt) > Date.parse(duplicate.lastRecalledAt)
          ? entry.lastRecalledAt
          : duplicate.lastRecalledAt;
      continue;
    }
    deduped.push({ ...entry });
  }
  return deduped;
}

function buildLightDreamingBody(entries: ShortTermRecallEntry[]): string[] {
  if (entries.length === 0) {
    return ["- No notable updates."];
  }
  const lines: string[] = [];
  for (const entry of entries) {
    const snippet = entry.snippet || "(no snippet captured)";
    lines.push(`- Candidate: ${snippet}`);
    lines.push(`  - confidence: ${entryAverageScore(entry).toFixed(2)}`);
    lines.push(`  - evidence: ${entry.path}:${entry.startLine}-${entry.endLine}`);
    lines.push(`  - recalls: ${entry.recallCount}`);
    lines.push(`  - status: staged`);
  }
  return lines;
}

type RemTruthSelection = {
  key: string;
  snippet: string;
  confidence: number;
  evidence: string;
};

type RemTruthCandidate = Omit<RemTruthSelection, "key">;

export type RemDreamingPreview = {
  sourceEntryCount: number;
  reflections: string[];
  candidateTruths: RemTruthCandidate[];
  candidateKeys: string[];
  bodyLines: string[];
};

function calculateCandidateTruthConfidence(entry: ShortTermRecallEntry): number {
  const recallStrength = Math.min(1, Math.log1p(entry.recallCount) / Math.log1p(6));
  const averageScore = entryAverageScore(entry);
  const consolidation = Math.min(1, (entry.recallDays?.length ?? 0) / 3);
  const conceptual = Math.min(1, (entry.conceptTags?.length ?? 0) / 6);
  return Math.max(
    0,
    Math.min(
      1,
      averageScore * 0.45 + recallStrength * 0.25 + consolidation * 0.2 + conceptual * 0.1,
    ),
  );
}

function selectRemCandidateTruths(
  entries: ShortTermRecallEntry[],
  limit: number,
): RemTruthSelection[] {
  if (limit <= 0) {
    return [];
  }
  return dedupeEntries(
    entries.filter((entry) => !entry.promotedAt),
    0.88,
  )
    .map((entry) => ({
      key: entry.key,
      snippet: entry.snippet || "(no snippet captured)",
      confidence: calculateCandidateTruthConfidence(entry),
      evidence: `${entry.path}:${entry.startLine}-${entry.endLine}`,
    }))
    .filter((entry) => entry.confidence >= 0.45)
    .toSorted((a, b) => b.confidence - a.confidence || a.snippet.localeCompare(b.snippet))
    .slice(0, limit);
}

function buildRemReflections(
  entries: ShortTermRecallEntry[],
  limit: number,
  minPatternStrength: number,
): string[] {
  const tagStats = new Map<string, { count: number; evidence: Set<string> }>();
  for (const entry of entries) {
    for (const tag of entry.conceptTags) {
      if (!tag) {
        continue;
      }
      const stat = tagStats.get(tag) ?? { count: 0, evidence: new Set<string>() };
      stat.count += 1;
      stat.evidence.add(`${entry.path}:${entry.startLine}-${entry.endLine}`);
      tagStats.set(tag, stat);
    }
  }

  const ranked = [...tagStats.entries()]
    .map(([tag, stat]) => {
      const strength = Math.min(1, (stat.count / Math.max(1, entries.length)) * 2);
      return { tag, strength, stat };
    })
    .filter((entry) => entry.strength >= minPatternStrength)
    .toSorted(
      (a, b) =>
        b.strength - a.strength || b.stat.count - a.stat.count || a.tag.localeCompare(b.tag),
    )
    .slice(0, limit);

  if (ranked.length === 0) {
    return ["- No strong patterns surfaced."];
  }

  const lines: string[] = [];
  for (const entry of ranked) {
    lines.push(`- Theme: \`${entry.tag}\` kept surfacing across ${entry.stat.count} memories.`);
    lines.push(`  - confidence: ${entry.strength.toFixed(2)}`);
    lines.push(`  - evidence: ${[...entry.stat.evidence].slice(0, 3).join(", ")}`);
    lines.push(`  - note: reflection`);
  }
  return lines;
}

export function previewRemDreaming(params: {
  entries: ShortTermRecallEntry[];
  limit: number;
  minPatternStrength: number;
}): RemDreamingPreview {
  const reflections = buildRemReflections(params.entries, params.limit, params.minPatternStrength);
  const candidateSelections = selectRemCandidateTruths(
    params.entries,
    Math.max(1, Math.min(3, params.limit)),
  );
  const candidateTruths = candidateSelections.map((entry) => ({
    snippet: entry.snippet,
    confidence: entry.confidence,
    evidence: entry.evidence,
  }));
  const candidateKeys = [...new Set(candidateSelections.map((entry) => entry.key))];
  const bodyLines = [
    "### Reflections",
    ...reflections,
    "",
    "### Possible Lasting Truths",
    ...(candidateTruths.length > 0
      ? candidateTruths.map(
          (entry) =>
            `- ${entry.snippet} [confidence=${entry.confidence.toFixed(2)} evidence=${entry.evidence}]`,
        )
      : ["- No strong candidate truths surfaced."]),
  ];
  return {
    sourceEntryCount: params.entries.length,
    reflections,
    candidateTruths,
    candidateKeys,
    bodyLines,
  };
}

async function runLightDreaming(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  config: MemoryLightDreamingConfig & {
    timezone?: string;
    storage: { mode: "inline" | "separate" | "both"; separateReports: boolean };
  };
  logger: Logger;
  subagent?: Parameters<typeof generateAndAppendDreamNarrative>[0]["subagent"];
  nowMs?: number;
}): Promise<void> {
  const nowMs = Number.isFinite(params.nowMs) ? (params.nowMs as number) : Date.now();
  const cutoffMs = calculateLookbackCutoffMs(nowMs, params.config.lookbackDays);
  await ingestDailyMemorySignals({
    workspaceDir: params.workspaceDir,
    lookbackDays: params.config.lookbackDays,
    limit: params.config.limit,
    nowMs,
    timezone: params.config.timezone,
  });
  await ingestSessionTranscriptSignals({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    lookbackDays: params.config.lookbackDays,
    nowMs,
    timezone: params.config.timezone,
  });
  const entries = dedupeEntries(
    (await readShortTermRecallEntries({ workspaceDir: params.workspaceDir, nowMs }))
      .filter((entry) => entryWithinLookback(entry, cutoffMs))
      .toSorted((a, b) => {
        const byTime = Date.parse(b.lastRecalledAt) - Date.parse(a.lastRecalledAt);
        if (byTime !== 0) {
          return byTime;
        }
        return b.recallCount - a.recallCount;
      })
      .slice(0, params.config.limit),
    params.config.dedupeSimilarity,
  );
  const capped = entries.slice(0, params.config.limit);
  const bodyLines = buildLightDreamingBody(capped);
  await writeDailyDreamingPhaseBlock({
    workspaceDir: params.workspaceDir,
    phase: "light",
    bodyLines,
    nowMs,
    timezone: params.config.timezone,
    storage: params.config.storage,
  });
  await recordDreamingPhaseSignals({
    workspaceDir: params.workspaceDir,
    phase: "light",
    keys: capped.map((entry) => entry.key),
    nowMs,
  });
  if (params.config.enabled && entries.length > 0 && params.config.storage.mode !== "separate") {
    params.logger.info(
      `memory-core: light dreaming staged ${Math.min(entries.length, params.config.limit)} candidate(s) [workspace=${params.workspaceDir}].`,
    );
  }
  // Generate dream diary narrative from the staged entries.
  if (params.subagent && capped.length > 0) {
    const themes = [...new Set(capped.flatMap((e) => e.conceptTags).filter(Boolean))];
    const data: NarrativePhaseData = {
      phase: "light",
      snippets: capped.map((e) => e.snippet).filter(Boolean),
      ...(themes.length > 0 ? { themes } : {}),
    };
    await generateAndAppendDreamNarrative({
      subagent: params.subagent,
      workspaceDir: params.workspaceDir,
      data,
      nowMs,
      timezone: params.config.timezone,
      logger: params.logger,
    });
  }
}

async function runRemDreaming(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  config: MemoryRemDreamingConfig & {
    timezone?: string;
    storage: { mode: "inline" | "separate" | "both"; separateReports: boolean };
  };
  logger: Logger;
  subagent?: Parameters<typeof generateAndAppendDreamNarrative>[0]["subagent"];
  nowMs?: number;
}): Promise<void> {
  const nowMs = Number.isFinite(params.nowMs) ? (params.nowMs as number) : Date.now();
  const cutoffMs = calculateLookbackCutoffMs(nowMs, params.config.lookbackDays);
  await ingestDailyMemorySignals({
    workspaceDir: params.workspaceDir,
    lookbackDays: params.config.lookbackDays,
    limit: params.config.limit,
    nowMs,
    timezone: params.config.timezone,
  });
  await ingestSessionTranscriptSignals({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    lookbackDays: params.config.lookbackDays,
    nowMs,
    timezone: params.config.timezone,
  });
  const entries = (
    await readShortTermRecallEntries({ workspaceDir: params.workspaceDir, nowMs })
  ).filter((entry) => entryWithinLookback(entry, cutoffMs));
  const preview = previewRemDreaming({
    entries,
    limit: params.config.limit,
    minPatternStrength: params.config.minPatternStrength,
  });
  await writeDailyDreamingPhaseBlock({
    workspaceDir: params.workspaceDir,
    phase: "rem",
    bodyLines: preview.bodyLines,
    nowMs,
    timezone: params.config.timezone,
    storage: params.config.storage,
  });
  await recordDreamingPhaseSignals({
    workspaceDir: params.workspaceDir,
    phase: "rem",
    keys: preview.candidateKeys,
    nowMs,
  });
  if (params.config.enabled && entries.length > 0 && params.config.storage.mode !== "separate") {
    params.logger.info(
      `memory-core: REM dreaming wrote reflections from ${entries.length} recent memory trace(s) [workspace=${params.workspaceDir}].`,
    );
  }
  // Generate dream diary narrative from REM reflections.
  if (params.subagent && entries.length > 0) {
    const snippets = preview.candidateTruths.map((t) => t.snippet).filter(Boolean);
    const themes = preview.reflections.filter(
      (r) => !r.startsWith("- No strong") && !r.startsWith("  -"),
    );
    const data: NarrativePhaseData = {
      phase: "rem",
      snippets:
        snippets.length > 0
          ? snippets
          : entries
              .slice(0, 8)
              .map((e) => e.snippet)
              .filter(Boolean),
      ...(themes.length > 0 ? { themes } : {}),
    };
    await generateAndAppendDreamNarrative({
      subagent: params.subagent,
      workspaceDir: params.workspaceDir,
      data,
      nowMs,
      timezone: params.config.timezone,
      logger: params.logger,
    });
  }
}

export async function runDreamingSweepPhases(params: {
  workspaceDir: string;
  pluginConfig?: Record<string, unknown>;
  cfg?: OpenClawConfig;
  logger: Logger;
  subagent?: Parameters<typeof generateAndAppendDreamNarrative>[0]["subagent"];
  nowMs?: number;
}): Promise<void> {
  const light = resolveMemoryLightDreamingConfig({
    pluginConfig: params.pluginConfig,
    cfg: params.cfg,
  });
  if (light.enabled && light.limit > 0) {
    await runLightDreaming({
      workspaceDir: params.workspaceDir,
      cfg: params.cfg,
      config: light,
      logger: params.logger,
      subagent: params.subagent,
      nowMs: params.nowMs,
    });
  }

  const rem = resolveMemoryRemDreamingConfig({
    pluginConfig: params.pluginConfig,
    cfg: params.cfg,
  });
  if (rem.enabled && rem.limit > 0) {
    await runRemDreaming({
      workspaceDir: params.workspaceDir,
      cfg: params.cfg,
      config: rem,
      logger: params.logger,
      subagent: params.subagent,
      nowMs: params.nowMs,
    });
  }
}

async function runPhaseIfTriggered(params: {
  cleanedBody: string;
  trigger?: string;
  workspaceDir?: string;
  cfg?: OpenClawConfig;
  logger: Logger;
  subagent?: Parameters<typeof generateAndAppendDreamNarrative>[0]["subagent"];
  phase: "light" | "rem";
  eventText: string;
  config:
    | (MemoryLightDreamingConfig & {
        timezone?: string;
        storage: { mode: "inline" | "separate" | "both"; separateReports: boolean };
      })
    | (MemoryRemDreamingConfig & {
        timezone?: string;
        storage: { mode: "inline" | "separate" | "both"; separateReports: boolean };
      });
}): Promise<{ handled: true; reason: string } | undefined> {
  if (params.trigger !== "heartbeat" || params.cleanedBody.trim() !== params.eventText) {
    return undefined;
  }
  if (!params.config.enabled) {
    return { handled: true, reason: `memory-core: ${params.phase} dreaming disabled` };
  }
  const workspaces = resolveWorkspaces({
    cfg: params.cfg,
    fallbackWorkspaceDir: params.workspaceDir,
  });
  if (workspaces.length === 0) {
    params.logger.warn(
      `memory-core: ${params.phase} dreaming skipped because no memory workspace is available.`,
    );
    return { handled: true, reason: `memory-core: ${params.phase} dreaming missing workspace` };
  }
  if (params.config.limit === 0) {
    params.logger.info(`memory-core: ${params.phase} dreaming skipped because limit=0.`);
    return { handled: true, reason: `memory-core: ${params.phase} dreaming disabled by limit` };
  }
  for (const workspaceDir of workspaces) {
    try {
      if (params.phase === "light") {
        await runLightDreaming({
          workspaceDir,
          cfg: params.cfg,
          config: params.config as MemoryLightDreamingConfig & {
            timezone?: string;
            storage: { mode: "inline" | "separate" | "both"; separateReports: boolean };
          },
          logger: params.logger,
          subagent: params.subagent,
        });
      } else {
        await runRemDreaming({
          workspaceDir,
          cfg: params.cfg,
          config: params.config as MemoryRemDreamingConfig & {
            timezone?: string;
            storage: { mode: "inline" | "separate" | "both"; separateReports: boolean };
          },
          logger: params.logger,
          subagent: params.subagent,
        });
      }
    } catch (err) {
      params.logger.error(
        `memory-core: ${params.phase} dreaming failed for workspace ${workspaceDir}: ${formatErrorMessage(err)}`,
      );
    }
  }
  return { handled: true, reason: `memory-core: ${params.phase} dreaming processed` };
}

export function registerMemoryDreamingPhases(api: OpenClawPluginApi): void {
  api.registerHook(
    "gateway:startup",
    async (event: unknown) => {
      const cron = resolveCronServiceFromStartupEvent(event);
      const pluginConfig = resolveMemoryCorePluginConfig(api.config) ?? api.pluginConfig;
      const light = resolveMemoryLightDreamingConfig({ pluginConfig, cfg: api.config });
      const rem = resolveMemoryRemDreamingConfig({ pluginConfig, cfg: api.config });
      const lightDesired = buildManagedCronJob({
        name: LIGHT_SLEEP_CRON_NAME,
        tag: LIGHT_SLEEP_CRON_TAG,
        payloadText: LIGHT_SLEEP_EVENT_TEXT,
        cron: light.cron,
        timezone: light.timezone,
        phase: "light",
        limit: light.limit,
        lookbackDays: light.lookbackDays,
      });
      const remDesired = buildManagedCronJob({
        name: REM_SLEEP_CRON_NAME,
        tag: REM_SLEEP_CRON_TAG,
        payloadText: REM_SLEEP_EVENT_TEXT,
        cron: rem.cron,
        timezone: rem.timezone,
        phase: "rem",
        limit: rem.limit,
        lookbackDays: rem.lookbackDays,
      });
      try {
        await reconcileManagedPhaseCronJob({
          cron,
          desired: lightDesired,
          match: {
            name: LIGHT_SLEEP_CRON_NAME,
            tag: LIGHT_SLEEP_CRON_TAG,
            payloadText: LIGHT_SLEEP_EVENT_TEXT,
          },
          enabled: light.enabled,
          logger: api.logger,
        });
        await reconcileManagedPhaseCronJob({
          cron,
          desired: remDesired,
          match: {
            name: REM_SLEEP_CRON_NAME,
            tag: REM_SLEEP_CRON_TAG,
            payloadText: REM_SLEEP_EVENT_TEXT,
          },
          enabled: rem.enabled,
          logger: api.logger,
        });
      } catch (err) {
        api.logger.error(
          `memory-core: dreaming startup reconciliation failed: ${formatErrorMessage(err)}`,
        );
      }
    },
    { name: "memory-core-dreaming-phase-cron" },
  );

  api.on("before_agent_reply", async (event, ctx) => {
    const pluginConfig = resolveMemoryCorePluginConfig(api.config) ?? api.pluginConfig;
    const light = resolveMemoryLightDreamingConfig({ pluginConfig, cfg: api.config });
    const lightResult = await runPhaseIfTriggered({
      cleanedBody: event.cleanedBody,
      trigger: ctx.trigger,
      workspaceDir: ctx.workspaceDir,
      cfg: api.config,
      logger: api.logger,
      subagent: light.enabled ? api.runtime?.subagent : undefined,
      phase: "light",
      eventText: LIGHT_SLEEP_EVENT_TEXT,
      config: light,
    });
    if (lightResult) {
      return lightResult;
    }
    const rem = resolveMemoryRemDreamingConfig({ pluginConfig, cfg: api.config });
    return await runPhaseIfTriggered({
      cleanedBody: event.cleanedBody,
      trigger: ctx.trigger,
      workspaceDir: ctx.workspaceDir,
      cfg: api.config,
      logger: api.logger,
      subagent: rem.enabled ? api.runtime?.subagent : undefined,
      phase: "rem",
      eventText: REM_SLEEP_EVENT_TEXT,
      config: rem,
    });
  });
}
