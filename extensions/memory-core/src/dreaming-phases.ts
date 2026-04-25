/**
 * dreaming-phases.ts
 *
 * Dreaming system phase orchestration — the "runner" layer.
 *
 * Architecture (4 files):
 *   dreaming-shared-types.ts  — shared types, constants, daily-file helpers
 *   dreaming-session-corpus.ts — session transcript scanning
 *   dreaming-phases.ts        — this file: daily ingestion + phase runners + sweep
 *
 * Exported:
 *   runDreamingSweepPhases, seedHistoricalDailyMemorySignals,
 *   previewRemDreaming, registerMemoryDreamingPhases
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/memory-core";
import {
  formatMemoryDreamingDay,
  resolveMemoryLightDreamingConfig,
  resolveMemoryRemDreamingConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { writeDailyDreamingPhaseBlock } from "./dreaming-markdown.js";
import {
  buildNarrativeSessionKey,
  generateAndAppendDreamNarrative,
  type NarrativePhaseData,
} from "./dreaming-narrative.js";
import { formatErrorMessage } from "./dreaming-shared.js";
import { recordShortTermRecalls } from "./short-term-promotion.js";
import {
  type Logger,
  type DreamingHostConfig,
  type LightDreamingConfig,
  type RemDreamingConfig,
  type RunPhaseIfTriggeredParams,
  type DailyIngestionState,
  type DailyIngestionFileState,
  type DailySnippetChunk,
  calculateLookbackCutoffMs,
  isDayWithinLookback,
  resolveWorkspaces,
  normalizeDailyIngestionState,
  resolveDailyIngestionStatePath,
  buildDailyChunkSnippet,
  buildDailySnippetChunks,
  stripManagedDailyDreamingLines,
  DAILY_MEMORY_FILENAME_RE,
  DAILY_INGESTION_SCORE,
  DAILY_INGESTION_MAX_SNIPPET_CHARS,
  DAILY_INGESTION_MIN_SNIPPET_CHARS,
  MANAGED_DAILY_DREAMING_BLOCKS,
  type ShortTermRecallEntry,
} from "./dreaming-shared-types.js";
import {
  type SessionIngestionState,
  ingestSessionTranscriptSignals,
} from "./dreaming-session-corpus.js";

// Re-export types for consumers
export type {
  Logger,
  DreamingHostConfig,
  LightDreamingConfig,
  RemDreamingConfig,
  RunPhaseIfTriggeredParams,
  DailyIngestionState,
  DailyIngestionFileState,
  DailySnippetChunk,
};
export { calculateLookbackCutoffMs, isDayWithinLookback, resolveWorkspaces };

// ─── Daily ingestion state I/O ───────────────────────────────────────────────

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

// ─── Daily ingestion collector ────────────────────────────────────────────────

type DailyIngestionCollectionResult = {
  batches: Array<{ day: string; results: MemorySearchResult[] }>;
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
  const entries = await fs
    .readdir(memoryDir, { withFileTypes: true })
    .catch((err: unknown) => {
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

  const batches: Array<{ day: string; results: MemorySearchResult[] }> = [];
  const nextFiles: Record<string, DailyIngestionFileState> = {};
  let changed = false;
  const totalCap = Math.max(20, params.limit * 4);
  const perFileCap = Math.max(
    6,
    Math.ceil(totalCap / Math.max(1, Math.max(files.length, 1))),
  );
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

// ─── Daily ingestion pipeline ────────────────────────────────────────────────

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
  const ingestionDayBucket = formatMemoryDreamingDay(params.nowMs, params.timezone);
  for (const batch of collected.batches) {
    await recordShortTermRecalls({
      workspaceDir: params.workspaceDir,
      query: `__dreaming_daily__:${batch.day}`,
      results: batch.results,
      signalType: "daily",
      dedupeByQueryPerDay: true,
      dayBucket: ingestionDayBucket,
      nowMs: params.nowMs,
      timezone: params.timezone,
    });
  }
  if (collected.changed) {
    await writeDailyIngestionState(params.workspaceDir, collected.nextState);
  }
}

export async function seedHistoricalDailyMemorySignals(params: {
  workspaceDir: string;
  filePaths: string[];
  limit: number;
  nowMs: number;
  timezone?: string;
}): Promise<{
  importedFileCount: number;
  importedSignalCount: number;
  skippedPaths: string[];
}> {
  const normalizedPaths = [
    ...new Set(params.filePaths.map((entry) => entry.trim()).filter(Boolean)),
  ];
  if (normalizedPaths.length === 0) {
    return {
      importedFileCount: 0,
      importedSignalCount: 0,
      skippedPaths: [],
    };
  }

  const resolved = normalizedPaths
    .map((filePath) => {
      const fileName = path.basename(filePath);
      const match = fileName.match(DAILY_MEMORY_FILENAME_RE);
      if (!match) {
        return { filePath, day: null as string | null };
      }
      return { filePath, day: match[1] ?? null };
    })
    .toSorted((a, b) => {
      if (a.day && b.day) {
        return b.day.localeCompare(a.day);
      }
      if (a.day) {
        return -1;
      }
      if (b.day) {
        return 1;
      }
      return a.filePath.localeCompare(b.filePath);
    });

  const valid = resolved.filter(
    (entry): entry is { filePath: string; day: string } => Boolean(entry.day),
  );
  const skippedPaths = resolved
    .filter((entry) => !entry.day)
    .map((entry) => entry.filePath);
  const totalCap = Math.max(20, params.limit * 4);
  const perFileCap = Math.max(
    6,
    Math.ceil(totalCap / Math.max(1, valid.length)),
  );
  let importedSignalCount = 0;
  let importedFileCount = 0;

  for (const entry of valid) {
    if (importedSignalCount >= totalCap) {
      break;
    }
    const raw = await fs.readFile(entry.filePath, "utf-8").catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        skippedPaths.push(entry.filePath);
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
        path: `memory/${entry.day}.md`,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        score: DAILY_INGESTION_SCORE,
        snippet: chunk.snippet,
        source: "memory",
      });
      if (results.length >= perFileCap || importedSignalCount + results.length >= totalCap) {
        break;
      }
    }
    if (results.length === 0) {
      continue;
    }
    await recordShortTermRecalls({
      workspaceDir: params.workspaceDir,
      query: `__dreaming_daily__:${entry.day}`,
      results,
      signalType: "daily",
      dedupeByQueryPerDay: true,
      dayBucket: formatMemoryDreamingDay(params.nowMs, params.timezone),
      nowMs: params.nowMs,
      timezone: params.timezone,
    });
    importedSignalCount += results.length;
    importedFileCount += 1;
  }

  return {
    importedFileCount,
    importedSignalCount,
    skippedPaths,
  };
}

// ─── Scoring / dedupe utilities ───────────────────────────────────────────────

function entryAverageScore(entry: ShortTermRecallEntry): number {
  const signalCount = Math.max(
    0,
    Math.floor(entry.recallCount ?? 0) +
      Math.floor(entry.dailyCount ?? 0) +
      Math.floor(entry.groundedCount ?? 0),
  );
  return signalCount > 0 ? Math.max(0, Math.min(1, entry.totalScore / signalCount)) : 0;
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

function dedupeEntries(
  entries: ShortTermRecallEntry[],
  threshold: number,
): ShortTermRecallEntry[] {
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

// ─── Light dreaming body builder ─────────────────────────────────────────────

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

// ─── REM dreaming ─────────────────────────────────────────────────────────────

const REM_REFLECTION_TAG_BLACKLIST = new Set([
  "assistant",
  "user",
  "system",
  "subagent",
  "the",
]);

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
      averageScore * 0.45 +
        recallStrength * 0.25 +
        consolidation * 0.2 +
        conceptual * 0.1,
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
    .toSorted(
      (a, b) => b.confidence - a.confidence || a.snippet.localeCompare(b.snippet),
    )
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
      if (!tag || REM_REFLECTION_TAG_BLACKLIST.has(tag.toLowerCase())) {
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
        b.strength - a.strength ||
        b.stat.count - a.stat.count ||
        a.tag.localeCompare(b.tag),
    )
    .slice(0, limit);

  if (ranked.length === 0) {
    return ["- No strong patterns surfaced."];
  }

  const lines: string[] = [];
  for (const entry of ranked) {
    lines.push(
      `- Theme: \`${entry.tag}\` kept surfacing across ${entry.stat.count} memories.`,
    );
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
  const reflections = buildRemReflections(
    params.entries,
    params.limit,
    params.minPatternStrength,
  );
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

// ─── Lookback filter ─────────────────────────────────────────────────────────

function entryWithinLookback(entry: ShortTermRecallEntry, cutoffMs: number): boolean {
  const byDay = (entry.recallDays ?? []).some((day) => isDayWithinLookback(day, cutoffMs));
  if (byDay) {
    return true;
  }
  const lastRecalledAtMs = Date.parse(entry.lastRecalledAt);
  return Number.isFinite(lastRecalledAtMs) && lastRecalledAtMs >= cutoffMs;
}

// ─── Phase runners ────────────────────────────────────────────────────────────

async function runLightDreaming(params: {
  workspaceDir: string;
  cfg?: DreamingHostConfig;
  config: LightDreamingConfig;
  logger: Logger;
  subagent?: Parameters<typeof generateAndAppendDreamNarrative>[0]["subagent"];
  detachNarratives?: boolean;
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
    (
      await import("./short-term-promotion.js").then((m) =>
        m.readShortTermRecallEntries({ workspaceDir: params.workspaceDir, nowMs }),
      )
    )
      .filter((entry: ShortTermRecallEntry) => entryWithinLookback(entry, cutoffMs))
      .toSorted((a: ShortTermRecallEntry, b: ShortTermRecallEntry) => {
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
  await import("./short-term-promotion.js").then((m) =>
    m.recordDreamingPhaseSignals({
      workspaceDir: params.workspaceDir,
      phase: "light",
      keys: capped.map((entry) => entry.key),
      nowMs,
    }),
  );
  if (
    params.config.enabled &&
    entries.length > 0 &&
    params.config.storage.mode !== "separate"
  ) {
    params.logger.info(
      `memory-core: light dreaming staged ${Math.min(entries.length, params.config.limit)} candidate(s) [workspace=${params.workspaceDir}].`,
    );
  }
  if (params.subagent && capped.length > 0) {
    const themes = [
      ...new Set(capped.flatMap((e) => e.conceptTags).filter(Boolean)),
    ];
    const data: NarrativePhaseData = {
      phase: "light",
      snippets: capped.map((e) => e.snippet).filter(Boolean),
      ...(themes.length > 0 ? { themes } : {}),
    };
    if (params.detachNarratives) {
      queueMicrotask(() => {
        void generateAndAppendDreamNarrative({
          subagent: params.subagent!,
          workspaceDir: params.workspaceDir,
          data,
          nowMs,
          timezone: params.config.timezone,
          logger: params.logger,
        }).catch(() => undefined);
      });
    } else {
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
}

async function runRemDreaming(params: {
  workspaceDir: string;
  cfg?: DreamingHostConfig;
  config: RemDreamingConfig;
  logger: Logger;
  subagent?: Parameters<typeof generateAndAppendDreamNarrative>[0]["subagent"];
  detachNarratives?: boolean;
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
    await import("./short-term-promotion.js").then((m) =>
      m.readShortTermRecallEntries({ workspaceDir: params.workspaceDir, nowMs }),
    )
  ).filter((entry: ShortTermRecallEntry) => entryWithinLookback(entry, cutoffMs));
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
  await import("./short-term-promotion.js").then((m) =>
    m.recordDreamingPhaseSignals({
      workspaceDir: params.workspaceDir,
      phase: "rem",
      keys: preview.candidateKeys,
      nowMs,
    }),
  );
  if (
    params.config.enabled &&
    entries.length > 0 &&
    params.config.storage.mode !== "separate"
  ) {
    params.logger.info(
      `memory-core: REM dreaming wrote reflections from ${entries.length} recent memory trace(s) [workspace=${params.workspaceDir}].`,
    );
  }
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
    if (params.detachNarratives) {
      queueMicrotask(() => {
        void generateAndAppendDreamNarrative({
          subagent: params.subagent!,
          workspaceDir: params.workspaceDir,
          data,
          nowMs,
          timezone: params.config.timezone,
          logger: params.logger,
        }).catch(() => undefined);
      });
    } else {
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
}

// ─── Utility ─────────────────────────────────────────────────────────────────

async function deleteNarrativeSessionBestEffort(
  subagent: Parameters<typeof generateAndAppendDreamNarrative>[0]["subagent"],
  sessionKey: string,
): Promise<void> {
  try {
    await subagent.deleteSession({ sessionKey });
  } catch {
    // best-effort cleanup
  }
}

// ─── Sweep orchestrator (exported) ───────────────────────────────────────────

export async function runDreamingSweepPhases(params: {
  workspaceDir: string;
  pluginConfig?: Record<string, unknown>;
  cfg?: DreamingHostConfig;
  logger: Logger;
  subagent?: Parameters<typeof generateAndAppendDreamNarrative>[0]["subagent"];
  detachNarratives?: boolean;
  nowMs?: number;
}): Promise<void> {
  const sweepNowMs: number = Number.isFinite(params.nowMs)
    ? (params.nowMs as number)
    : Date.now();

  const light = resolveMemoryLightDreamingConfig({
    pluginConfig: params.pluginConfig,
    cfg: params.cfg as Parameters<typeof resolveMemoryLightDreamingConfig>[0]["cfg"],
  });
  if (light.enabled && light.limit > 0) {
    await runLightDreaming({
      workspaceDir: params.workspaceDir,
      cfg: params.cfg,
      config: light,
      logger: params.logger,
      subagent: params.subagent,
      nowMs: sweepNowMs,
      detachNarratives: params.detachNarratives,
    });
    if (params.subagent && !params.detachNarratives) {
      const lightSessionKey = buildNarrativeSessionKey({
        workspaceDir: params.workspaceDir,
        phase: "light",
        nowMs: sweepNowMs,
      });
      await deleteNarrativeSessionBestEffort(params.subagent, lightSessionKey);
    }
  }

  const rem = resolveMemoryRemDreamingConfig({
    pluginConfig: params.pluginConfig,
    cfg: params.cfg as Parameters<typeof resolveMemoryRemDreamingConfig>[0]["cfg"],
  });
  if (rem.enabled && rem.limit > 0) {
    await runRemDreaming({
      workspaceDir: params.workspaceDir,
      cfg: params.cfg,
      config: rem,
      logger: params.logger,
      subagent: params.subagent,
      nowMs: sweepNowMs,
      detachNarratives: params.detachNarratives,
    });
    if (params.subagent && !params.detachNarratives) {
      const remSessionKey = buildNarrativeSessionKey({
        workspaceDir: params.workspaceDir,
        phase: "rem",
        nowMs: sweepNowMs,
      });
      await deleteNarrativeSessionBestEffort(params.subagent, remSessionKey);
    }
  }
}

// ─── Heartbeat trigger ───────────────────────────────────────────────────────

async function runPhaseIfTriggered(
  params: RunPhaseIfTriggeredParams,
): Promise<{ handled: true; reason: string } | undefined> {
  const hasEventToken = params.cleanedBody.trim().split(/\s+/).includes(params.eventText);
  if (params.trigger !== "heartbeat" || !hasEventToken) {
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
    return { handled: true, reason: `memory-core: ${params.phase} dreaming missing workspace` };
  }
  if (params.config.limit === 0) {
    return {
      handled: true,
      reason: `memory-core: ${params.phase} dreaming disabled by limit`,
    };
  }
  for (const workspaceDir of workspaces) {
    try {
      if (params.phase === "light") {
        await runLightDreaming({
          workspaceDir,
          cfg: params.cfg,
          config: params.config,
          logger: params.logger,
          subagent: params.subagent,
          nowMs: Date.now(),
        });
      } else {
        await runRemDreaming({
          workspaceDir,
          cfg: params.cfg,
          config: params.config,
          logger: params.logger,
          subagent: params.subagent,
          nowMs: Date.now(),
        });
      }
    } catch (err) {
      params.logger.error(
        `memory-core: ${params.phase} dreaming failed for workspace ${workspaceDir}: ${formatErrorMessage(err)}`,
      );
    }
  }
  return { handled: true, reason: `memory-core: ${params.phase} dreaming completed` };
}

// ─── Plugin registration (deprecated) ────────────────────────────────────────

export async function registerMemoryDreamingPhases(
  _params: Record<string, unknown>,
): Promise<void> {
  // Deprecated: registration is now automatic via the plugin SDK manifest.
}
