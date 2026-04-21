import path from "node:path";

export const DAILY_MEMORY_FILE_NAME_RE = /^(\d{4}-\d{2}-\d{2})(?:-([a-z0-9][a-z0-9._-]*))?\.md$/i;
const DREAMING_MEMORY_PATH_RE = /(?:^|\/)memory\/dreaming\//;
const SHORT_TERM_TOP_LEVEL_MEMORY_FILE_RE = /^(?:memory\/)?\d{4}-\d{2}-\d{2}(?:-[^/]+)?\.md$/i;
const SHORT_TERM_LEGACY_ABSOLUTE_MEMORY_FILE_RE =
  /(?:^|\/)memory\/\d{4}-\d{2}-\d{2}(?:-[^/]+)?\.md$/i;
const SHORT_TERM_SESSION_CORPUS_RE =
  /(?:^|\/)memory\/\.dreams\/session-corpus\/(\d{4})-(\d{2})-(\d{2})\.(?:md|txt)$/i;
const WINDOWS_ABSOLUTE_PATH_RE = /^[a-z]:\//i;
const SESSION_SUMMARY_VARIANT_SLUG_TOKENS = new Set(["reset", "session", "summary"]);

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

export function isCrossPlatformAbsolutePath(normalizedPath: string): boolean {
  return (
    path.isAbsolute(normalizedPath) ||
    WINDOWS_ABSOLUTE_PATH_RE.test(normalizedPath) ||
    normalizedPath.startsWith("//")
  );
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
  if (SHORT_TERM_TOP_LEVEL_MEMORY_FILE_RE.test(normalizedPath)) {
    return true;
  }
  // Older short-term stores could persist absolute workspace paths for direct
  // `memory/YYYY-MM-DD*.md` files. Keep those entries visible until a later
  // rewrite normalizes them back to relative paths.
  return (
    isCrossPlatformAbsolutePath(normalizedPath) &&
    SHORT_TERM_LEGACY_ABSOLUTE_MEMORY_FILE_RE.test(normalizedPath)
  );
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

function isSummaryStyleDailyMemoryVariantSlug(slug: string | undefined): boolean {
  if (!slug) {
    return false;
  }
  const tokens = slug
    .toLowerCase()
    .split(/[-_.]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return false;
  }
  if (!tokens.every((token) => SESSION_SUMMARY_VARIANT_SLUG_TOKENS.has(token))) {
    return false;
  }
  return tokens.includes("summary") && (tokens.includes("reset") || tokens.includes("session"));
}

export function resolveDailyMemoryVariantMergeKey(filePath: string): string | null {
  const parsed = parseDailyMemoryPathInfo(filePath);
  if (!parsed) {
    return null;
  }
  const comparableDir = resolveComparableDailyVariantDir(filePath);
  if (!comparableDir) {
    return null;
  }
  if (parsed.canonical || isSummaryStyleDailyMemoryVariantSlug(parsed.slug)) {
    return `${comparableDir}/${parsed.day}`;
  }
  return `${comparableDir}/${parsed.fileName}`;
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
