import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  prepareSimilarityText,
  preparedTextSimilarity,
  type PreparedSimilarityText,
} from "./memory/tokenize.js";
import { compareStoreTimestampDesc } from "./short-term-promotion-utils.js";
import type { ShortTermRecallEntry } from "./short-term-promotion.js";

const LIGHT_DIARY_SNIPPET_SIMILARITY_THRESHOLD = 0.35;

type DedupedEntry = ShortTermRecallEntry & { sourceEntryKeys: string[] };

export function dedupeEntries(entries: ShortTermRecallEntry[], threshold: number): DedupedEntry[] {
  const deduped: DedupedEntry[] = [];
  // Duplicates only match within one path, and each kept snippet is tokenized once.
  const candidatesByPath = new Map<
    string,
    Array<{ candidate: DedupedEntry; prepared: PreparedSimilarityText }>
  >();
  for (const entry of entries) {
    const bucket = candidatesByPath.get(entry.path);
    const prepared = prepareSimilarityText(entry.snippet);
    const duplicate = bucket?.find(
      (item) => preparedTextSimilarity(item.prepared, prepared) >= threshold,
    )?.candidate;
    if (duplicate) {
      // Merged tags also become narrative input, so retain their source keys.
      duplicate.sourceEntryKeys.push(entry.key);
      if (entry.recallCount > duplicate.recallCount) {
        duplicate.recallCount = entry.recallCount;
      }
      duplicate.totalScore = Math.max(duplicate.totalScore, entry.totalScore);
      duplicate.maxScore = Math.max(duplicate.maxScore, entry.maxScore);
      duplicate.queryHashes = uniqueStrings([...duplicate.queryHashes, ...entry.queryHashes]);
      duplicate.userQueryHashes = uniqueStrings([
        ...(duplicate.userQueryHashes ?? []),
        ...(entry.userQueryHashes ?? []),
      ]);
      duplicate.recallDays = [
        ...new Set([...duplicate.recallDays, ...entry.recallDays]),
      ].toSorted();
      duplicate.conceptTags = uniqueStrings([...duplicate.conceptTags, ...entry.conceptTags]);
      duplicate.lastRecalledAt =
        compareStoreTimestampDesc(entry.lastRecalledAt, duplicate.lastRecalledAt) < 0
          ? entry.lastRecalledAt
          : duplicate.lastRecalledAt;
      continue;
    }
    const kept: DedupedEntry = { ...entry, sourceEntryKeys: [entry.key] };
    deduped.push(kept);
    if (bucket) {
      bucket.push({ candidate: kept, prepared });
    } else {
      candidatesByPath.set(entry.path, [{ candidate: kept, prepared }]);
    }
  }
  return deduped;
}

function normalizeDiaryCoverageText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

type PreparedDiaryEntry = {
  normalized: string;
  prepared: PreparedSimilarityText;
};

function isEntryCoveredByRecentDiary(
  entry: ShortTermRecallEntry,
  recentDiaryEntries: readonly PreparedDiaryEntry[],
): boolean {
  const snippet = normalizeDiaryCoverageText(entry.snippet);
  if (!snippet) {
    return false;
  }
  const prepared = prepareSimilarityText(entry.snippet);
  return recentDiaryEntries.some(
    (diary) =>
      diary.normalized.includes(snippet) ||
      preparedTextSimilarity(prepared, diary.prepared) >= LIGHT_DIARY_SNIPPET_SIMILARITY_THRESHOLD,
  );
}

export function prioritizeLightEntriesByDiaryCoverage<T extends ShortTermRecallEntry>(
  entries: T[],
  recentDiaryEntries: readonly string[],
): T[] {
  if (recentDiaryEntries.length === 0) {
    return entries;
  }
  const preparedDiaryEntries = recentDiaryEntries.map((diaryEntry) => ({
    normalized: normalizeDiaryCoverageText(diaryEntry),
    prepared: prepareSimilarityText(diaryEntry),
  }));
  const fresh: T[] = [];
  const covered: T[] = [];
  for (const entry of entries) {
    if (isEntryCoveredByRecentDiary(entry, preparedDiaryEntries)) {
      covered.push(entry);
    } else {
      fresh.push(entry);
    }
  }
  return [...fresh, ...covered];
}
