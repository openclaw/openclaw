import { formatMemoryDreamingDay } from "openclaw/plugin-sdk/memory-core-host-status";
import { normalizeStringEntries, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatErrorMessage } from "./dreaming-shared.js";
import { withMemoryWorkspaceLock } from "./memory-workspace-lock.js";
import {
  emptyPhaseSignalStore,
  readPhaseSignalStore,
  readStore,
  resolvePhaseSignalPath,
  resolveStorePath,
  writePhaseSignalStore,
} from "./short-term-promotion-store.js";
import type {
  ShortTermDreamingStats,
  ShortTermDreamingStatsEntry,
  ShortTermPhaseSignalEntry,
  ShortTermPhaseSignalStore,
  ShortTermRecallEntry,
} from "./short-term-promotion-types.js";
import {
  compareStoreTimestampDesc,
  isShortTermMemoryPath,
  normalizeMemoryPathForWorkspace,
  normalizeSnippet,
  parseEntryRangeFromKey,
  parseStoreTimestampMs,
  toFiniteNonNegativeInt,
} from "./short-term-promotion-utils.js";
import { resolveMemoryCoreNowMs, resolveMemoryCoreTimestamp } from "./time.js";

const DREAMING_ENTRY_LIST_LIMIT = 8;

function compareDreamingStatsEntryByRecency(
  a: ShortTermDreamingStatsEntry,
  b: ShortTermDreamingStatsEntry,
): number {
  return (
    compareStoreTimestampDesc(a.lastRecalledAt, b.lastRecalledAt) ||
    b.totalSignalCount - a.totalSignalCount ||
    a.path.localeCompare(b.path)
  );
}

function compareDreamingStatsEntryBySignals(
  a: ShortTermDreamingStatsEntry,
  b: ShortTermDreamingStatsEntry,
): number {
  return (
    b.totalSignalCount - a.totalSignalCount ||
    b.phaseHitCount - a.phaseHitCount ||
    compareDreamingStatsEntryByRecency(a, b)
  );
}

function compareDreamingStatsEntryByPromotion(
  a: ShortTermDreamingStatsEntry,
  b: ShortTermDreamingStatsEntry,
): number {
  return (
    compareStoreTimestampDesc(a.promotedAt, b.promotedAt) ||
    compareDreamingStatsEntryBySignals(a, b)
  );
}

function trimDreamingStatsEntries(
  entries: ShortTermDreamingStatsEntry[],
  compare: (a: ShortTermDreamingStatsEntry, b: ShortTermDreamingStatsEntry) => number,
): ShortTermDreamingStatsEntry[] {
  const selected: ShortTermDreamingStatsEntry[] = [];
  for (const entry of entries) {
    const match = selected.findIndex((current) => compare(entry, current) < 0);
    const insertAt = match < 0 ? selected.length : match;
    if (insertAt < DREAMING_ENTRY_LIST_LIMIT) {
      selected.splice(insertAt, 0, entry);
      if (selected.length > DREAMING_ENTRY_LIST_LIMIT) {
        selected.pop();
      }
    }
  }
  return selected;
}

export async function loadShortTermPromotionDreamingStats(params: {
  workspaceDir: string;
  nowMs: number;
  timezone?: string;
}): Promise<ShortTermDreamingStats> {
  const workspaceDir = params.workspaceDir.trim();
  const nowIso = new Date(params.nowMs).toISOString();
  const store = await readStore(workspaceDir, nowIso);
  let phaseSignalError: string | undefined;
  let phaseStore: ShortTermPhaseSignalStore;
  try {
    phaseStore = await readPhaseSignalStore(workspaceDir, nowIso);
  } catch (err) {
    phaseSignalError = formatErrorMessage(err);
    phaseStore = emptyPhaseSignalStore(nowIso);
  }
  let shortTermCount = 0;
  let recallSignalCount = 0;
  let dailySignalCount = 0;
  let groundedSignalCount = 0;
  let totalSignalCount = 0;
  let phaseSignalCount = 0;
  let lightPhaseHitCount = 0;
  let remPhaseHitCount = 0;
  let promotedTotal = 0;
  let promotedToday = 0;
  let currentDay: string | undefined;
  let latestPromotedAtMs = Number.NEGATIVE_INFINITY;
  let latestPromotedAt: string | undefined;
  const activeEntries = new Map<string, ShortTermDreamingStatsEntry>();
  const shortTermEntries: ShortTermDreamingStatsEntry[] = [];
  const promotedEntries: ShortTermDreamingStatsEntry[] = [];

  for (const [entryKey, entry] of Object.entries(store.entries)) {
    if (entry.source !== "memory" || !entry.path || !isShortTermMemoryPath(entry.path)) {
      continue;
    }
    const range = parseEntryRangeFromKey(entryKey, entry.startLine, entry.endLine);
    const recallCount = Math.max(0, toFiniteNonNegativeInt(entry.recallCount));
    const dailyCount = Math.max(0, toFiniteNonNegativeInt(entry.dailyCount));
    const groundedCount = Math.max(0, toFiniteNonNegativeInt(entry.groundedCount));
    const totalEntrySignalCount = recallCount + dailyCount + groundedCount;
    const normalizedEntryPath = normalizeMemoryPathForWorkspace(workspaceDir, entry.path);
    const detail: ShortTermDreamingStatsEntry = {
      key: entryKey,
      path: normalizedEntryPath,
      startLine: range.startLine,
      endLine: Math.max(range.startLine, range.endLine),
      snippet: normalizeSnippet(entry.snippet) || normalizedEntryPath,
      recallCount,
      dailyCount,
      groundedCount,
      totalSignalCount: totalEntrySignalCount,
      lightHits: 0,
      remHits: 0,
      phaseHitCount: 0,
      ...(entry.lastRecalledAt ? { lastRecalledAt: entry.lastRecalledAt } : {}),
    };
    if (!entry.promotedAt) {
      shortTermCount += 1;
      recallSignalCount += recallCount;
      dailySignalCount += dailyCount;
      groundedSignalCount += groundedCount;
      totalSignalCount += totalEntrySignalCount;
      shortTermEntries.push(detail);
      activeEntries.set(entryKey, detail);
      continue;
    }
    promotedTotal += 1;
    promotedEntries.push({ ...detail, promotedAt: entry.promotedAt });
    const promotedAtMs = Date.parse(entry.promotedAt);
    if (Number.isFinite(promotedAtMs)) {
      const promotedDay = formatMemoryDreamingDay(promotedAtMs, params.timezone);
      currentDay ??= formatMemoryDreamingDay(params.nowMs, params.timezone);
      if (promotedDay === currentDay) {
        promotedToday += 1;
      }
    }
    if (Number.isFinite(promotedAtMs) && promotedAtMs > latestPromotedAtMs) {
      latestPromotedAtMs = promotedAtMs;
      latestPromotedAt = entry.promotedAt;
    }
  }

  for (const [key, phaseEntry] of Object.entries(phaseStore.entries)) {
    const detail = activeEntries.get(key);
    if (!detail) {
      continue;
    }
    const lightHits = Math.max(0, toFiniteNonNegativeInt(phaseEntry.lightHits));
    const remHits = Math.max(0, toFiniteNonNegativeInt(phaseEntry.remHits));
    lightPhaseHitCount += lightHits;
    remPhaseHitCount += remHits;
    phaseSignalCount += lightHits + remHits;
    detail.lightHits = lightHits;
    detail.remHits = remHits;
    detail.phaseHitCount = lightHits + remHits;
  }

  return {
    shortTermCount,
    recallSignalCount,
    dailySignalCount,
    groundedSignalCount,
    totalSignalCount,
    phaseSignalCount,
    lightPhaseHitCount,
    remPhaseHitCount,
    promotedTotal,
    promotedToday,
    storePath: resolveStorePath(workspaceDir),
    phaseSignalPath: resolvePhaseSignalPath(workspaceDir),
    shortTermEntries: trimDreamingStatsEntries(
      shortTermEntries,
      compareDreamingStatsEntryByRecency,
    ),
    signalEntries: trimDreamingStatsEntries(shortTermEntries, compareDreamingStatsEntryBySignals),
    promotedEntries: trimDreamingStatsEntries(
      promotedEntries,
      compareDreamingStatsEntryByPromotion,
    ),
    ...(phaseSignalError ? { phaseSignalError } : {}),
    ...(latestPromotedAt ? { lastPromotedAt: latestPromotedAt } : {}),
  };
}

async function updatePhaseSignals(
  params: { workspaceDir?: string; keys: string[]; nowMs?: number },
  mutate: (entry: ShortTermPhaseSignalEntry, nowIso: string) => void,
): Promise<void> {
  const workspaceDir = params.workspaceDir?.trim();
  if (!workspaceDir) {
    return;
  }
  const keys = uniqueStrings(normalizeStringEntries(params.keys));
  if (keys.length === 0) {
    return;
  }
  const nowIso = resolveMemoryCoreTimestamp(resolveMemoryCoreNowMs(params.nowMs));

  await withMemoryWorkspaceLock(workspaceDir, async () => {
    const [store, phaseSignals] = await Promise.all([
      readStore(workspaceDir, nowIso),
      readPhaseSignalStore(workspaceDir, nowIso),
    ]);
    const knownKeys = new Set(Object.keys(store.entries));
    for (const key of keys) {
      if (!knownKeys.has(key)) {
        continue;
      }
      const entry = phaseSignals.entries[key] ?? { key, lightHits: 0, remHits: 0 };
      mutate(entry, nowIso);
      phaseSignals.entries[key] = entry;
    }
    for (const [key, entry] of Object.entries(phaseSignals.entries)) {
      if (!knownKeys.has(key) || (entry.lightHits <= 0 && entry.remHits <= 0)) {
        delete phaseSignals.entries[key];
      }
    }
    phaseSignals.updatedAt = nowIso;
    await writePhaseSignalStore(workspaceDir, phaseSignals);
  });
}

export async function recordDreamingPhaseSignals(params: {
  workspaceDir?: string;
  phase: "light" | "rem";
  keys: string[];
  nowMs?: number;
}): Promise<void> {
  await updatePhaseSignals(params, (entry, nowIso) => {
    if (params.phase === "light") {
      entry.lightHits = Math.min(9999, entry.lightHits + 1);
      entry.lastLightAt = nowIso;
    } else {
      entry.remHits = Math.min(9999, entry.remHits + 1);
      entry.lastRemAt = nowIso;
    }
  });
}

export async function recordRemConsideredPhaseSignals(params: {
  workspaceDir?: string;
  keys: string[];
  nowMs?: number;
}): Promise<void> {
  await updatePhaseSignals(params, (entry, nowIso) => {
    entry.lastRemConsideredAt = nowIso;
  });
}

export async function readLightStagedKeys(params: {
  workspaceDir: string;
  nowMs?: number;
}): Promise<Set<string>> {
  const workspaceDir = params.workspaceDir?.trim();
  if (!workspaceDir) {
    return new Set();
  }
  const nowMs = resolveMemoryCoreNowMs(params.nowMs);
  const nowIso = resolveMemoryCoreTimestamp(nowMs);
  const store = await readPhaseSignalStore(workspaceDir, nowIso);
  const keys = new Set<string>();
  for (const [key, entry] of Object.entries(store.entries)) {
    if (entry.lightHits <= 0) {
      continue;
    }
    const lastLightMs = parseStoreTimestampMs(entry.lastLightAt);
    const lastConsumedMs = Math.max(
      parseStoreTimestampMs(entry.lastRemAt),
      parseStoreTimestampMs(entry.lastRemConsideredAt),
    );
    const hasPendingLightSignal = Number.isFinite(lastLightMs)
      ? lastLightMs > lastConsumedMs
      : !entry.lastRemAt;
    if (hasPendingLightSignal) {
      keys.add(key);
    }
  }
  return keys;
}

export async function filterFreshLightDreamingEntries(params: {
  workspaceDir: string;
  entries: readonly ShortTermRecallEntry[];
  nowMs?: number;
}): Promise<ShortTermRecallEntry[]> {
  const workspaceDir = params.workspaceDir.trim();
  if (!workspaceDir || params.entries.length === 0) {
    return [];
  }
  const nowMs = resolveMemoryCoreNowMs(params.nowMs);
  const nowIso = resolveMemoryCoreTimestamp(nowMs);
  const phaseSignals = await readPhaseSignalStore(workspaceDir, nowIso);
  return params.entries.filter((entry) => {
    const phaseSignal = phaseSignals.entries[entry.key];
    if (!phaseSignal || phaseSignal.lightHits <= 0) {
      return true;
    }
    const lastLightMs = parseStoreTimestampMs(phaseSignal.lastLightAt);
    if (!Number.isFinite(lastLightMs)) {
      return true;
    }
    const lastRecalledAtMs = parseStoreTimestampMs(entry.lastRecalledAt);
    return Number.isFinite(lastRecalledAtMs) && lastRecalledAtMs > lastLightMs;
  });
}
