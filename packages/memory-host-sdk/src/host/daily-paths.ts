import path from "node:path";

export const DAILY_MEMORY_FILE_NAME_RE = /^(\d{4}-\d{2}-\d{2})(?:-([a-z0-9][a-z0-9._-]*))?\.md$/i;
const DREAMING_MEMORY_PATH_RE = /(?:^|\/)memory\/dreaming\//;
const SHORT_TERM_TOP_LEVEL_MEMORY_FILE_RE = /^(?:memory\/)?\d{4}-\d{2}-\d{2}(?:-[^/]+)?\.md$/;
const SHORT_TERM_SESSION_CORPUS_RE =
  /(?:^|\/)memory\/\.dreams\/session-corpus\/(\d{4})-(\d{2})-(\d{2})\.(?:md|txt)$/;

export type ParsedDailyMemoryFileName = {
  day: string;
  slug?: string;
  fileName: string;
  canonical: boolean;
};

export type DailyMemoryPathInfo = ParsedDailyMemoryFileName & {
  normalizedPath: string;
  dir: string;
};

function normalizeDailyMemoryPath(rawPath: string): string {
  return rawPath.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function parseDailyMemoryFileName(fileName: string): ParsedDailyMemoryFileName | null {
  const normalized = path.posix.basename(normalizeDailyMemoryPath(fileName).trim());
  const match = normalized.match(DAILY_MEMORY_FILE_NAME_RE);
  if (!match || !match[1]) {
    return null;
  }
  const slug = match[2]?.trim() || undefined;
  return {
    day: match[1],
    slug,
    fileName: normalized,
    canonical: slug == null,
  };
}

export function isDailyMemoryFileName(fileName: string): boolean {
  return parseDailyMemoryFileName(fileName) !== null;
}

export function parseDailyMemoryPathInfo(filePath: string): DailyMemoryPathInfo | null {
  const normalizedPath = normalizeDailyMemoryPath(filePath);
  const parsed = parseDailyMemoryFileName(path.posix.basename(normalizedPath));
  if (!parsed) {
    return null;
  }
  return {
    ...parsed,
    normalizedPath,
    dir: path.posix.dirname(normalizedPath),
  };
}

export function extractDailyMemoryDayFromPath(filePath: string): string | null {
  return parseDailyMemoryPathInfo(filePath)?.day ?? null;
}

export function isSupportedShortTermMemoryPath(filePath: string): boolean {
  const normalizedPath = normalizeDailyMemoryPath(filePath);
  if (DREAMING_MEMORY_PATH_RE.test(normalizedPath)) {
    return false;
  }
  if (SHORT_TERM_SESSION_CORPUS_RE.test(normalizedPath)) {
    return true;
  }
  return SHORT_TERM_TOP_LEVEL_MEMORY_FILE_RE.test(normalizedPath);
}

function resolveComparableDailyVariantDir(filePath: string): string | null {
  const normalizedPath = normalizeDailyMemoryPath(filePath);
  const parsed = parseDailyMemoryFileName(path.posix.basename(normalizedPath));
  if (!parsed) {
    return null;
  }
  const relativeFromMemory = normalizedPath.match(/(?:^|.*\/)(memory\/.+)$/)?.[1];
  if (relativeFromMemory) {
    return path.posix.dirname(relativeFromMemory);
  }
  if (normalizedPath === parsed.fileName) {
    return "memory";
  }
  return path.posix.dirname(normalizedPath);
}

function resolveComparableDailyVariantPath(
  filePath: string,
): { path: string; rank: number } | null {
  const normalizedPath = normalizeDailyMemoryPath(filePath);
  const parsed = parseDailyMemoryFileName(path.posix.basename(normalizedPath));
  if (!parsed) {
    return null;
  }
  const relativeFromMemory = normalizedPath.match(/(?:^|.*\/)(memory\/.+)$/)?.[1];
  if (relativeFromMemory) {
    return { path: relativeFromMemory, rank: 0 };
  }
  if (normalizedPath === parsed.fileName) {
    return { path: `memory/${parsed.fileName}`, rank: 1 };
  }
  return { path: normalizedPath, rank: 2 };
}

export function compareDailyVariantPathPreference(leftPath: string, rightPath: string): number {
  const left = parseDailyMemoryPathInfo(leftPath);
  const right = parseDailyMemoryPathInfo(rightPath);
  const leftComparablePath = resolveComparableDailyVariantPath(leftPath);
  const rightComparablePath = resolveComparableDailyVariantPath(rightPath);
  if (
    !left ||
    !right ||
    !leftComparablePath ||
    !rightComparablePath ||
    left.day !== right.day ||
    resolveComparableDailyVariantDir(leftPath) !== resolveComparableDailyVariantDir(rightPath)
  ) {
    return 0;
  }
  if (left.canonical !== right.canonical) {
    return left.canonical ? -1 : 1;
  }
  if (leftComparablePath.rank !== rightComparablePath.rank) {
    return leftComparablePath.rank - rightComparablePath.rank;
  }
  return leftComparablePath.path.localeCompare(rightComparablePath.path);
}
