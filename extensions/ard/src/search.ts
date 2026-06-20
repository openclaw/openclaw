// Deterministic local search helpers for Agent Resource Discovery catalogs.

import type {
  ArdCatalogEntry,
  ArdSearchFilter,
  ArdSearchRequest,
  ArdSearchResponse,
  ArdSearchResult,
} from "./types.js";
import { parseArdIdentifier } from "./validation.js";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/** Normalizes free-text search input for token matching. */
export function normalizeArdSearchText(value: unknown): string {
  return typeof value === "string"
    ? value
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}._-]+/gu, " ")
        .trim()
    : "";
}

/** Returns true when an entry satisfies all ARD search filters. */
export function entryMatchesArdFilters(entry: ArdCatalogEntry, filters?: ArdSearchFilter): boolean {
  if (!filters || Object.keys(filters).length === 0) {
    return true;
  }
  return Object.entries(filters).every(([key, expected]) => {
    const actualValues = new Set(
      getFilterValues(entry, key).map(normalizeArdSearchText).filter(Boolean),
    );
    const expectedValues = (Array.isArray(expected) ? expected : [expected])
      .map(normalizeArdSearchText)
      .filter(Boolean);
    return expectedValues.length > 0
      ? expectedValues.some((value) => actualValues.has(value))
      : true;
  });
}

/** Computes an integer relevance score for one entry. Score is relevance only, not trust. */
export function scoreArdCatalogEntry(entry: ArdCatalogEntry, query?: string): number {
  const normalizedQuery = normalizeArdSearchText(query);
  if (!normalizedQuery) {
    return 1;
  }
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return 1;
  }

  let score = 0;
  for (const token of tokens) {
    score += scoreField(entry.displayName, token, 12);
    score += scoreField(entry.identifier, token, 4);
    score += scoreField(entry.description, token, 3);
    score += scoreList(entry.capabilities, token, 8);
    score += scoreList(entry.tags, token, 6);
    score += scoreList(entry.representativeQueries, token, 5);
    score += scoreField(entry.type, token, 2);
  }
  return Math.min(score, 100);
}

/** Searches a local set of ARD catalog entries with filters, scoring, stable sorting, and pagination. */
export function searchArdCatalogEntries(
  entries: readonly ArdCatalogEntry[],
  request: ArdSearchRequest = {},
  source?: string,
): ArdSearchResponse {
  const offset = parsePageToken(request.pageToken);
  const pageSize = normalizePageSize(request.pageSize);
  const results = entries
    .filter((entry) => entryMatchesArdFilters(entry, request.filters))
    .map((entry): ArdSearchResult => {
      const result: ArdSearchResult = {
        entry,
        score: scoreArdCatalogEntry(entry, request.query),
      };
      if (source) {
        result.source = source;
      }
      return result;
    })
    .filter((result) => normalizeArdSearchText(request.query) === "" || result.score > 0)
    .toSorted(compareSearchResults);

  const page = results.slice(offset, offset + pageSize);
  const nextOffset = offset + pageSize;
  return {
    results: page,
    ...(nextOffset < results.length ? { nextPageToken: String(nextOffset) } : {}),
  };
}

function scoreField(value: string | undefined, token: string, weight: number): number {
  const field = normalizeArdSearchText(value);
  if (!field) {
    return 0;
  }
  if (field === token) {
    return weight * 3;
  }
  if (field.startsWith(token)) {
    return weight * 2;
  }
  return field.includes(token) ? weight : 0;
}

function scoreList(values: readonly string[] | undefined, token: string, weight: number): number {
  return (values ?? []).reduce((total, value) => total + scoreField(value, token, weight), 0);
}

function compareSearchResults(left: ArdSearchResult, right: ArdSearchResult): number {
  if (left.score !== right.score) {
    return right.score - left.score;
  }
  const leftName = left.entry.displayName.toLowerCase();
  const rightName = right.entry.displayName.toLowerCase();
  if (leftName !== rightName) {
    return leftName < rightName ? -1 : 1;
  }
  return left.entry.identifier < right.entry.identifier
    ? -1
    : left.entry.identifier > right.entry.identifier
      ? 1
      : 0;
}

function getFilterValues(entry: ArdCatalogEntry, key: string): string[] {
  if (key === "publisher") {
    const parsed = parseArdIdentifier(entry.identifier);
    return parsed ? [parsed.publisher] : [];
  }
  const value = key.split(".").reduce<unknown>((current, segment) => {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      return (current as Record<string, unknown>)[segment];
    }
    return undefined;
  }, entry);
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => (typeof item === "string" ? [item] : []));
  }
  return [];
}

function parsePageToken(pageToken: string | undefined): number {
  if (!pageToken) {
    return 0;
  }
  const parsed = Number.parseInt(pageToken, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function normalizePageSize(pageSize: number | undefined): number {
  if (typeof pageSize !== "number" || !Number.isInteger(pageSize) || pageSize < 1) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(pageSize, MAX_PAGE_SIZE);
}
