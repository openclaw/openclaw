import path from "node:path";

export const DAILY_MEMORY_FILE_NAME_RE = /^(\d{4}-\d{2}-\d{2})(?:-([a-z0-9][a-z0-9._-]*))?\.md$/i;

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

export function compareDailyVariantPathPreference(leftPath: string, rightPath: string): number {
  const left = parseDailyMemoryPathInfo(leftPath);
  const right = parseDailyMemoryPathInfo(rightPath);
  if (!left || !right || left.day !== right.day || left.dir !== right.dir) {
    return 0;
  }
  if (left.canonical !== right.canonical) {
    return left.canonical ? -1 : 1;
  }
  return left.normalizedPath.localeCompare(right.normalizedPath);
}
