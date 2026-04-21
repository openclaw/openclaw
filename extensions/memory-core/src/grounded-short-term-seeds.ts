import {
  extractDailyMemoryDayFromPath,
  parseDailyMemoryFileName,
} from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import type { GroundedRemFilePreview } from "./rem-evidence.js";

export type GroundedShortTermSeedItem = {
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
  query: string;
  signalCount: number;
  dayBucket?: string;
};

function parseGroundedRef(
  fallbackPath: string,
  ref: string,
): { path: string; startLine: number; endLine: number } | null {
  const trimmed = ref.trim();
  if (!trimmed) {
    return null;
  }
  const match = trimmed.match(/^(.*?):(\d+)(?:-(\d+))?$/);
  if (!match) {
    return null;
  }
  return {
    path: (match[1] ?? fallbackPath).replaceAll("\\", "/").replace(/^\.\//, ""),
    startLine: Math.max(1, Number(match[2])),
    endLine: Math.max(1, Number(match[3] ?? match[2])),
  };
}

export function collectGroundedShortTermSeedItems(
  previews: GroundedRemFilePreview[],
): GroundedShortTermSeedItem[] {
  const items = new Map<string, GroundedShortTermSeedItem>();

  const normalizeGroundedSeedText = (text: string): string =>
    text.trim().replace(/\s+/g, " ").toLowerCase();

  const isCanonicalGroundedSeedPath = (filePath: string, dayBucket?: string): boolean => {
    if (!dayBucket) {
      return false;
    }
    const parsed = parseDailyMemoryFileName(filePath);
    return parsed?.day === dayBucket && parsed.canonical;
  };

  const shouldPreferGroundedSeedItem = (
    current: Pick<GroundedShortTermSeedItem, "path" | "startLine" | "endLine" | "dayBucket">,
    next: Pick<GroundedShortTermSeedItem, "path" | "startLine" | "endLine" | "dayBucket">,
  ): boolean => {
    const currentCanonical = isCanonicalGroundedSeedPath(current.path, current.dayBucket);
    const nextCanonical = isCanonicalGroundedSeedPath(next.path, next.dayBucket);
    if (currentCanonical !== nextCanonical) {
      return nextCanonical;
    }
    if (current.path !== next.path) {
      return next.path.localeCompare(current.path) < 0;
    }
    if (current.startLine !== next.startLine) {
      return next.startLine < current.startLine;
    }
    return next.endLine < current.endLine;
  };

  // Keep filename identity here so distinct same-day slugged notes survive staging.
  // Canonical-vs-variant collapsing happens later in recordGroundedShortTermCandidates().
  const buildGroundedSeedKey = (item: GroundedShortTermSeedItem): string =>
    `${item.path}:${item.startLine}:${item.endLine}:${item.query}:${normalizeGroundedSeedText(item.snippet)}`;

  for (const file of previews) {
    const dayBucket = extractDailyMemoryDayFromPath(file.path) ?? undefined;
    const signals = [
      ...file.memoryImplications.map((item) => ({
        text: item.text,
        refs: item.refs,
        score: 0.92,
        query: "__dreaming_grounded_backfill__:lasting-update",
        signalCount: 2,
      })),
      ...file.candidates
        .filter((candidate) => candidate.lean === "likely_durable")
        .map((candidate) => ({
          text: candidate.text,
          refs: candidate.refs,
          score: 0.82,
          query: "__dreaming_grounded_backfill__:candidate",
          signalCount: 1,
        })),
    ];

    for (const signal of signals) {
      if (!signal.text.trim()) {
        continue;
      }
      const firstRef = signal.refs.find((ref) => ref.trim().length > 0);
      const parsedRef = firstRef ? parseGroundedRef(file.path, firstRef) : null;
      if (!parsedRef) {
        continue;
      }
      const item: GroundedShortTermSeedItem = {
        path: parsedRef.path,
        startLine: parsedRef.startLine,
        endLine: parsedRef.endLine,
        snippet: signal.text,
        score: signal.score,
        query: signal.query,
        signalCount: signal.signalCount,
        ...(dayBucket ? { dayBucket } : {}),
      };
      const key = buildGroundedSeedKey(item);
      const existing = items.get(key);
      if (!existing || shouldPreferGroundedSeedItem(existing, item)) {
        items.set(key, item);
      }
    }
  }

  return [...items.values()];
}
