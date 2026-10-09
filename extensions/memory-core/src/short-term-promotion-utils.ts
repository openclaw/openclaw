import { createHash } from "node:crypto";
import path from "node:path";
import type { MemoryEntryProvenance } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { DEFAULT_MEMORY_DEEP_DREAMING_MAX_PROMOTED_SNIPPET_TOKENS } from "openclaw/plugin-sdk/memory-core-host-status";
import {
  asFiniteNumberInRange,
  asNonNegativeFiniteNumber,
  parseDateStringTimestampMs,
} from "openclaw/plugin-sdk/number-runtime";
import {
  asOptionalObjectRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeUniqueTrimmedStringList,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { deriveConceptTags, MAX_CONCEPT_TAGS } from "./concept-vocabulary.js";
import {
  DEFAULT_PROMOTION_MIN_RECALL_COUNT,
  DEFAULT_PROMOTION_MIN_SCORE,
  DEFAULT_PROMOTION_MIN_UNIQUE_QUERIES,
  type PromotionThresholdOptions,
  type ShortTermRecallEntry,
  type ShortTermRecallStore,
} from "./short-term-promotion-types.js";

const GENERIC_DAY_HEADING_RE =
  /^(?:(?:mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday)(?:,\s+)?)?(?:(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{4}[/-]\d{2}[/-]\d{2})$/i;
const SHORT_TERM_PATH_RE = /(?:^|\/)memory\/(?:[^/]+\/)*(\d{4})-(\d{2})-(\d{2})(?:-[^/]+)?\.md$/;
const DREAMING_MEMORY_PATH_RE = /(?:^|\/)memory\/dreaming\//;
const SHORT_TERM_SESSION_CORPUS_RE =
  /(?:^|\/)memory\/\.dreams\/session-corpus\/(\d{4})-(\d{2})-(\d{2})\.(?:md|txt)$/;
export const SHORT_TERM_BASENAME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:-[^/]+)?\.md$/;
export const MAX_QUERY_HASHES = 32;
export const MAX_RECALL_DAYS = 16;
export const SHORT_TERM_RECALL_MAX_ENTRIES = 512;
const SHORT_TERM_RECALL_MAX_SNIPPET_CHARS = 800;
const DREAMING_TRANSCRIPT_PROMPT_LINE_RE =
  /\[[^\]]*dreaming-narrative[^\]]*]\s*(?:User|Assistant):\s*Write a dream diary entry from these memory fragments:?/i;
const RAW_SESSION_METADATA_RE =
  /\bSession Key\b.{0,260}\bSession ID\b|\bSession ID\b.{0,260}\bSession Key\b/i;
const RAW_CONVERSATION_SUMMARY_RE =
  /^(?:[-*+]\s*)?Conversation Summary:\s*(?:$|(?:[-*+]\s*)?(?:user|assistant|(?:\*\*)?Session (?:Key|ID)(?:\*\*)?):\s)/i;
const RAW_TRANSCRIPT_TURN_RE = /^(?:[-*+]\s*)?(?:user|assistant):\s/i;
const MEMORY_FLUSH_PROMPT_RE =
  /Save important context from this session to the daily memory file\.\s*STRICT RULES:/i;
const PROMOTION_SCORE_METADATA_RE =
  /\[\s*score=\d+(?:\.\d+)?\s+(?:signals=\d+\s+)?recalls=\d+\s+avg=\d+(?:\.\d+)?\s+source=memory\//i;
const DREAMING_DIFF_PREFIX_RE = /@@\s*-\d+(?:,\d+)?\s+[-*+]\s+/iy;

export function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

export function resolvePromotionThresholds(options: PromotionThresholdOptions) {
  return {
    minScore:
      asFiniteNumberInRange(Number(options.minScore), { min: 0, max: 1 }) ??
      DEFAULT_PROMOTION_MIN_SCORE,
    minRecallCount: toFiniteNonNegativeInt(
      options.minRecallCount,
      DEFAULT_PROMOTION_MIN_RECALL_COUNT,
    ),
    minUniqueQueries: toFiniteNonNegativeInt(
      options.minUniqueQueries,
      DEFAULT_PROMOTION_MIN_UNIQUE_QUERIES,
    ),
    maxAgeDays: toFiniteNonNegativeInt(options.maxAgeDays, -1),
  };
}

export function isGenericDailyHeading(heading: string): boolean {
  const normalized = heading.trim().replace(/\s+/g, " ");
  return (
    !normalized ||
    /^(today|yesterday|tomorrow|morning|afternoon|evening|night)$/i.test(normalized) ||
    GENERIC_DAY_HEADING_RE.test(normalized)
  );
}

export function normalizeSnippet(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

const PROMOTED_SNIPPET_CHARS_PER_TOKEN_ESTIMATE = 4;

function truncatePromotedSnippet(snippet: string, maxTokens: number): string {
  // This is an inexpensive display-size guard, not a tokenizer contract.
  const limit =
    toFiniteNonNegativeInt(maxTokens, DEFAULT_MEMORY_DEEP_DREAMING_MAX_PROMOTED_SNIPPET_TOKENS) *
    PROMOTED_SNIPPET_CHARS_PER_TOKEN_ESTIMATE;
  if (limit === 0 || snippet.length <= limit) {
    return snippet;
  }
  const hardLimit = truncateUtf16Safe(snippet, limit);
  const sentenceBoundary = Math.max(
    hardLimit.lastIndexOf(". "),
    hardLimit.lastIndexOf("! "),
    hardLimit.lastIndexOf("? "),
  );
  const wordBoundary = hardLimit.lastIndexOf(" ");
  const cutAt =
    sentenceBoundary >= Math.floor(limit * 0.55)
      ? sentenceBoundary + 1
      : wordBoundary >= Math.floor(limit * 0.65)
        ? wordBoundary
        : limit;
  return `${hardLimit.slice(0, cutAt).trimEnd()}...`;
}

export function formatPromotedSnippetForMemory(rawSnippet: string, maxTokens: number): string {
  const normalized = normalizeSnippet(rawSnippet || "(no snippet captured)")
    .replace(/^[-*+] +/, "")
    .trim();
  return truncatePromotedSnippet(normalized || "(no snippet captured)", maxTokens);
}

function normalizeProjectKeyList(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const keys = new Set<string>();
  for (const rawKey of value.split(";")) {
    const trimmed = rawKey.trim();
    if (!trimmed || /[\r\n<>]/u.test(trimmed)) {
      continue;
    }
    if (trimmed.startsWith("path:")) {
      keys.add(trimmed);
      continue;
    }
    const separator = trimmed.indexOf("/");
    if (separator < 1) {
      keys.add(trimmed);
      continue;
    }
    // Preserve remote path case so case-sensitive hosts fail closed. Providers
    // with case-insensitive slugs may miss boosts/digests across casing variants,
    // but folding paths could cross-inject memory between distinct repositories.
    keys.add(`${trimmed.slice(0, separator).toLowerCase()}${trimmed.slice(separator)}`);
  }
  return keys.size > 0 ? [...keys].join("; ") : undefined;
}

export function mergeProjectKeyLists(...values: unknown[]): string | undefined {
  return normalizeProjectKeyList(values.filter((value) => typeof value === "string").join(";"));
}

export function truncateShortTermSnippet(snippet: string): string {
  if (snippet.length <= SHORT_TERM_RECALL_MAX_SNIPPET_CHARS) {
    return snippet;
  }
  return truncateUtf16Safe(snippet, SHORT_TERM_RECALL_MAX_SNIPPET_CHARS).trimEnd();
}

export function enforceShortTermRecallSnippetCap(store: ShortTermRecallStore): void {
  for (const entry of Object.values(store.entries)) {
    entry.snippet = truncateShortTermSnippet(entry.snippet);
  }
}

function consumeDreamingLeadPrefix(snippet: string): string {
  let index = 0;
  while (index < snippet.length) {
    DREAMING_DIFF_PREFIX_RE.lastIndex = index;
    const diffMatch = DREAMING_DIFF_PREFIX_RE.exec(snippet);
    if (diffMatch) {
      index = DREAMING_DIFF_PREFIX_RE.lastIndex;
      continue;
    }
    const char = snippet[index];
    if (char === "[" || char === "(") {
      index += 1;
      while (snippet[index] === " ") {
        index += 1;
      }
      continue;
    }
    if (
      (char === "-" || char === "*" || char === "+" || char === ">") &&
      snippet[index + 1] === " "
    ) {
      index += 2;
      continue;
    }
    break;
  }
  return snippet.slice(index);
}

function hasDreamingNarrativeLead(snippet: string): boolean {
  const withoutPrefix = consumeDreamingLeadPrefix(snippet);
  // Serialized metadata can precede narrative markers; bound the scan to the lead.
  // REM uses a Markdown heading instead of the staged block's colon marker.
  const head = truncateUtf16Safe(withoutPrefix, 200);
  return /\b(?:Candidate|Reflections?):/i.test(head) || /#{1,6}\s+Reflections?\b/i.test(head);
}

export function isContaminatedDreamingSnippet(
  raw: string,
  opts: { allowTranscriptTurnSnippet?: boolean } = {},
): boolean {
  const snippet = normalizeSnippet(raw);
  if (!snippet) {
    return false;
  }
  if (
    /<!--\s*openclaw-memory-promotion:/i.test(snippet) ||
    DREAMING_TRANSCRIPT_PROMPT_LINE_RE.test(snippet) ||
    RAW_SESSION_METADATA_RE.test(snippet) ||
    RAW_CONVERSATION_SUMMARY_RE.test(snippet) ||
    (!opts.allowTranscriptTurnSnippet && RAW_TRANSCRIPT_TURN_RE.test(snippet)) ||
    MEMORY_FLUSH_PROMPT_RE.test(snippet) ||
    PROMOTION_SCORE_METADATA_RE.test(snippet)
  ) {
    return true;
  }

  const hasNarrativeLead = hasDreamingNarrativeLead(snippet);
  const hasConfidence = /\bconfidence:\s*\d/i.test(snippet);
  const hasEvidence = /\bevidence:\s*(?:memory\/\.dreams\/session-corpus\/|memory\/)/i.test(
    snippet,
  );
  const hasStatus = /\bstatus:\s*staged\b/i.test(snippet);
  const hasRecalls = /\brecalls:\s*\d+\b/i.test(snippet);
  const hasReflectionNote = /\bnote:\s*reflection\b/i.test(snippet);
  return (
    hasNarrativeLead &&
    hasConfidence &&
    hasEvidence &&
    ((hasStatus && hasRecalls) || hasReflectionNote)
  );
}

export function normalizeMemoryPath(rawPath: string): string {
  return rawPath.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function buildClaimHash(snippet: string): string {
  return createHash("sha1").update(normalizeSnippet(snippet)).digest("hex").slice(0, 12);
}

export function buildDailyClaimEntryKey(claimHash: string): string {
  return `memory:claim:${claimHash}`;
}

export function buildEntryKey(result: {
  path: string;
  startLine: number;
  endLine: number;
  source: string;
  claimHash?: string;
}): string {
  const base = `${result.source}:${normalizeMemoryPath(result.path)}:${result.startLine}:${result.endLine}`;
  return result.claimHash ? `${base}:${result.claimHash}` : base;
}

export function hashQuery(query: string): string {
  return createHash("sha1")
    .update(normalizeLowercaseStringOrEmpty(query))
    .digest("hex")
    .slice(0, 12);
}

export function mergeRecentDistinct(
  existing: string[],
  nextValue: string,
  limit: number,
): string[] {
  const next = [
    ...new Set(existing.filter((value) => typeof value === "string" && value.length > 0)),
  ];
  if (nextValue && !next.includes(nextValue)) {
    next.push(nextValue);
  }
  return next.length <= limit ? next : next.slice(next.length - limit);
}

export function normalizeIsoDay(isoLike: unknown): string | null {
  if (typeof isoLike !== "string") {
    return null;
  }
  const match = isoLike.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}

export function totalSignalCountForEntry(entry: ShortTermRecallEntry): number {
  return entry.recallCount + entry.dailyCount + entry.groundedCount;
}

export function normalizeShortTermRecallStore(raw: unknown, nowIso: string): ShortTermRecallStore {
  const record = asOptionalObjectRecord(raw);
  if (!record) {
    return { version: 1, updatedAt: nowIso, entries: {} };
  }
  const entriesRaw = asOptionalObjectRecord(record.entries);
  const entries: Record<string, ShortTermRecallEntry> = {};

  if (entriesRaw) {
    for (const [key, value] of Object.entries(entriesRaw)) {
      const entry = asOptionalObjectRecord(value);
      if (!entry) {
        continue;
      }
      const entryPath = typeof entry.path === "string" ? normalizeMemoryPath(entry.path) : "";
      const startLine = Number(entry.startLine);
      const endLine = Number(entry.endLine);
      const source = entry.source === "memory" ? "memory" : null;
      if (!entryPath || !Number.isInteger(startLine) || !Number.isInteger(endLine) || !source) {
        continue;
      }

      const recallCount = Math.max(0, Math.floor(Number(entry.recallCount) || 0));
      const dailyCount = Math.max(0, Math.floor(Number(entry.dailyCount) || 0));
      const groundedCount = Math.max(0, Math.floor(Number(entry.groundedCount) || 0));
      const totalScore = Math.max(0, Number(entry.totalScore) || 0);
      const maxScore = clampScore(Number(entry.maxScore) || 0);
      const firstRecalledAt =
        typeof entry.firstRecalledAt === "string" ? entry.firstRecalledAt : nowIso;
      const lastRecalledAt =
        typeof entry.lastRecalledAt === "string" ? entry.lastRecalledAt : nowIso;
      const promotedAt = typeof entry.promotedAt === "string" ? entry.promotedAt : undefined;
      const claimHash = normalizeOptionalString(entry.claimHash);
      const projectKey = normalizeProjectKeyList(entry.projectKey);
      const fullSnippet = typeof entry.snippet === "string" ? normalizeSnippet(entry.snippet) : "";
      if (
        fullSnippet &&
        isContaminatedDreamingSnippet(fullSnippet, {
          allowTranscriptTurnSnippet: isShortTermSessionCorpusPath(entryPath),
        })
      ) {
        continue;
      }
      const snippet = truncateShortTermSnippet(fullSnippet);
      const queryHashes = normalizeUniqueTrimmedStringList(entry.queryHashes).slice(
        0,
        MAX_QUERY_HASHES,
      );
      const storedUserQueryHashes = Array.isArray(entry.userQueryHashes)
        ? normalizeUniqueTrimmedStringList(entry.userQueryHashes).slice(0, MAX_QUERY_HASHES)
        : undefined;
      // Legacy rows did not retain query provenance. Rows containing only recall
      // signals are unambiguous, so preserve their earned diversity; mixed rows
      // stay unqualified until fresh interactive recalls arrive.
      const userQueryHashes =
        storedUserQueryHashes ??
        (dailyCount === 0 && groundedCount === 0 ? queryHashes : undefined);
      const recallDays = Array.isArray(entry.recallDays)
        ? entry.recallDays
            .map(normalizeIsoDay)
            .filter((valueLocal): valueLocal is string => valueLocal !== null)
        : [];
      const conceptTags = Array.isArray(entry.conceptTags)
        ? normalizeUniqueTrimmedStringList(
            entry.conceptTags.map(normalizeLowercaseStringOrEmpty),
          ).slice(0, MAX_CONCEPT_TAGS)
        : deriveConceptTags({ path: entryPath, snippet: fullSnippet });
      const provenanceRaw = asOptionalObjectRecord(entry.provenance);
      const supersedesKey = normalizeOptionalString(provenanceRaw?.supersedesKey);
      const lastObservedAt = Date.parse(lastRecalledAt);
      const fallbackObservedAt = Number.isFinite(lastObservedAt)
        ? lastObservedAt
        : Date.parse(nowIso);
      const provenance: MemoryEntryProvenance | undefined = provenanceRaw
        ? {
            originClass:
              provenanceRaw.originClass === "owner" ||
              provenanceRaw.originClass === "agent" ||
              provenanceRaw.originClass === "system" ||
              provenanceRaw.originClass === "untrusted"
                ? provenanceRaw.originClass
                : "untrusted",
            sessionKind:
              provenanceRaw.sessionKind === "interactive" ||
              provenanceRaw.sessionKind === "cron" ||
              provenanceRaw.sessionKind === "heartbeat" ||
              provenanceRaw.sessionKind === "subagent" ||
              provenanceRaw.sessionKind === "unknown"
                ? provenanceRaw.sessionKind
                : "unknown",
            observedAt:
              typeof provenanceRaw.observedAt === "number" &&
              Number.isFinite(provenanceRaw.observedAt)
                ? provenanceRaw.observedAt
                : fallbackObservedAt,
            ...(supersedesKey ? { supersedesKey } : {}),
          }
        : undefined;

      const normalizedKey =
        key || buildEntryKey({ path: entryPath, startLine, endLine, source, claimHash });
      entries[normalizedKey] = {
        key: normalizedKey,
        path: entryPath,
        startLine,
        endLine,
        source,
        snippet,
        recallCount,
        dailyCount,
        groundedCount,
        totalScore,
        maxScore,
        firstRecalledAt,
        lastRecalledAt,
        queryHashes,
        ...(userQueryHashes ? { userQueryHashes } : {}),
        recallDays: recallDays.slice(-MAX_RECALL_DAYS),
        conceptTags,
        ...(provenance ? { provenance } : {}),
        ...(claimHash ? { claimHash } : {}),
        ...(projectKey ? { projectKey } : {}),
        ...(promotedAt ? { promotedAt } : {}),
      };
    }
  }

  return {
    version: 1,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : nowIso,
    entries,
  };
}

export function parseStoreTimestampMs(value: string | undefined): number {
  return parseDateStringTimestampMs(value) ?? Number.NEGATIVE_INFINITY;
}

export function compareStoreTimestampDesc(
  left: string | undefined,
  right: string | undefined,
): number {
  const leftMs = parseStoreTimestampMs(left);
  const rightMs = parseStoreTimestampMs(right);
  if (leftMs === rightMs) {
    return 0;
  }
  return rightMs > leftMs ? 1 : -1;
}

function compareShortTermRecallRetention(a: ShortTermRecallEntry, b: ShortTermRecallEntry): number {
  const lastDiff = compareStoreTimestampDesc(a.lastRecalledAt, b.lastRecalledAt);
  if (lastDiff !== 0) {
    return lastDiff;
  }
  const signalDiff = totalSignalCountForEntry(b) - totalSignalCountForEntry(a);
  if (signalDiff !== 0) {
    return signalDiff;
  }
  const totalScoreDiff = b.totalScore - a.totalScore;
  if (totalScoreDiff !== 0) {
    return totalScoreDiff;
  }
  const maxScoreDiff = b.maxScore - a.maxScore;
  if (maxScoreDiff !== 0) {
    return maxScoreDiff;
  }
  const promotedDiff = compareStoreTimestampDesc(a.promotedAt, b.promotedAt);
  if (promotedDiff !== 0) {
    return promotedDiff;
  }
  return a.key.localeCompare(b.key);
}

export function enforceShortTermRecallStoreRetention(store: ShortTermRecallStore): number {
  const entries = Object.entries(store.entries);
  if (entries.length <= SHORT_TERM_RECALL_MAX_ENTRIES) {
    return 0;
  }
  const retained = entries
    .toSorted(([, a], [, b]) => compareShortTermRecallRetention(a, b))
    .slice(0, SHORT_TERM_RECALL_MAX_ENTRIES);
  store.entries = Object.fromEntries(retained.toSorted(([a], [b]) => a.localeCompare(b)));
  return entries.length - retained.length;
}

export function toFiniteNonNegativeInt(value: unknown, fallback = 0): number {
  return asNonNegativeFiniteNumber(Math.floor(Number(value))) ?? fallback;
}

export function calculateRecencyComponent(ageDays: number, halfLifeDays: number): number {
  if (!Number.isFinite(ageDays) || ageDays < 0) {
    return 1;
  }
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
    return 1;
  }
  const lambda = Math.LN2 / halfLifeDays;
  return Math.exp(-lambda * ageDays);
}

export function isShortTermMemoryPath(filePath: string): boolean {
  const normalized = normalizeMemoryPath(filePath);
  return (
    !DREAMING_MEMORY_PATH_RE.test(normalized) &&
    (SHORT_TERM_PATH_RE.test(normalized) ||
      SHORT_TERM_SESSION_CORPUS_RE.test(normalized) ||
      SHORT_TERM_BASENAME_RE.test(normalized))
  );
}

export function isShortTermSessionCorpusPath(filePath: string): boolean {
  return SHORT_TERM_SESSION_CORPUS_RE.test(normalizeMemoryPath(filePath));
}

export function normalizeMemoryPathForWorkspace(workspaceDir: string, rawPath: string): string {
  const normalized = normalizeMemoryPath(rawPath);
  const workspaceNormalized = normalizeMemoryPath(workspaceDir);
  if (path.isAbsolute(rawPath) && normalized.startsWith(`${workspaceNormalized}/`)) {
    return normalized.slice(workspaceNormalized.length + 1);
  }
  return normalized;
}

export function parseEntryRangeFromKey(
  key: string,
  fallbackStartLine: unknown,
  fallbackEndLine: unknown,
): { startLine: number; endLine: number } {
  const startLine = toFiniteNonNegativeInt(fallbackStartLine);
  const endLine = toFiniteNonNegativeInt(fallbackEndLine);
  if (startLine > 0 && endLine > 0) {
    return { startLine, endLine };
  }
  const match = key.match(/:(\d+):(\d+)$/);
  if (match) {
    return {
      startLine: Math.max(1, toFiniteNonNegativeInt(match[1])),
      endLine: Math.max(1, toFiniteNonNegativeInt(match[2])),
    };
  }
  return { startLine: 1, endLine: 1 };
}
