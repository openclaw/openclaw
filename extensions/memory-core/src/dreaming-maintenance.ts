import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryDreamingMaintenanceConfig } from "openclaw/plugin-sdk/memory-core-host-status";
import {
  withTrailingNewline,
  replaceManagedMarkdownBlock,
} from "openclaw/plugin-sdk/memory-host-markdown";
import type { PromotionCandidate, ShortTermRecallEntry } from "./short-term-promotion.js";
import { runWithShortTermPromotionLock } from "./short-term-promotion.js";

const MAINTENANCE_RELATIVE_DIR = path.join("memory", ".dreams", "maintenance");
const REPORTS_RELATIVE_DIR = path.join(MAINTENANCE_RELATIVE_DIR, "reports");
const CURRENT_STATE_RELATIVE_PATH = path.join(MAINTENANCE_RELATIVE_DIR, "current.json");
const STAGED_PLAN_RELATIVE_PATH = path.join(MAINTENANCE_RELATIVE_DIR, "staged-plan.json");
const STAGED_SUMMARY_RELATIVE_PATH = path.join(MAINTENANCE_RELATIVE_DIR, "staged-summary.md");
const LAST_APPLY_RELATIVE_PATH = path.join(MAINTENANCE_RELATIVE_DIR, "last-apply.json");
const MEMORY_RELATIVE_PATH = "MEMORY.md";
const MANAGED_HEADING = "## Dreaming Maintained Memory";
const MANAGED_START_MARKER = "<!-- openclaw:dreaming:managed:start -->";
const MANAGED_END_MARKER = "<!-- openclaw:dreaming:managed:end -->";
const INDEX_HEADING = "## Dreaming Memory Index";
const INDEX_START_MARKER = "<!-- openclaw:dreaming:index:start -->";
const INDEX_END_MARKER = "<!-- openclaw:dreaming:index:end -->";
const LEGACY_PROMOTION_RE =
  /<!--\s*openclaw-memory-promotion:([^\s]+)\s*-->\s*\n-\s+(.+?)\s+\[score=([0-9.]+)\s+recalls=(\d+)\s+avg=([0-9.]+)\s+source=([^\]]+)\]/g;

type EvidenceKind = "daily-log" | "daily-note" | "transcript" | "recall";
type OperationKind = "add" | "merge" | "fix" | "prune" | "index";
type RiskLevel = "low" | "medium" | "high";
type FileChangeMode = "planned" | "written";

type ManagedEvidence = {
  kind: EvidenceKind;
  path: string;
  startLine: number;
  endLine: number;
  queryTerms: string[];
  firstSupportedAt: string;
  lastSupportedAt: string;
  signalCount: number;
};

type ManagedEntry = {
  id: string;
  claimHash: string;
  snippet: string;
  sourcePath: string;
  startLine: number;
  endLine: number;
  score: number;
  recallCount: number;
  uniqueQueries: number;
  queryTerms: string[];
  conceptTags: string[];
  firstSupportedAt: string;
  lastSupportedAt: string;
  evidence: ManagedEvidence[];
};

type ManagedState = {
  version: 1;
  updatedAt: string;
  entries: ManagedEntry[];
};

type ReportEvidence = {
  kind: EvidenceKind;
  path: string;
  startLine: number;
  endLine: number;
  queryTerms: string[];
};

type ReportChange = {
  type: OperationKind;
  id: string;
  claimHash: string;
  risk: RiskLevel;
  reason: string;
  summary: string;
  evidence: {
    sourceKinds: EvidenceKind[];
    queryTerms: string[];
    sources: string[];
  };
  before?: {
    snippet: string;
    sourcePath: string;
    lastSupportedAt: string;
  };
  after?: {
    snippet: string;
    sourcePath: string;
    lastSupportedAt: string;
  };
};

type FileChange = {
  path: string;
  mode: FileChangeMode;
  beforeExists: boolean;
  beforeSha1: string;
  afterSha1: string;
  beforeContent: string;
  afterContent: string;
  summary: string;
};

export type DreamingMaintenanceReport = {
  version: 1;
  reportId: string;
  workspaceDir: string;
  generatedAt: string;
  staged: boolean;
  applied: boolean;
  autoApply: boolean;
  touchedFiles: Array<{ path: string; mode: FileChangeMode }>;
  fileChanges: FileChange[];
  operationCounts: Record<OperationKind, number>;
  noChangeReasons: string[];
  evidenceSources: ReportEvidence[];
  queryTerms: string[];
  changes: ReportChange[];
  diffSummary: string[];
};

type StagedPlan = {
  version: 1;
  report: DreamingMaintenanceReport;
  beforeState: ManagedState;
  afterState: ManagedState;
};

type LastApplyRecord = {
  version: 1;
  reportId: string;
  appliedAt: string;
  workspaceDir: string;
  appliedPlan: StagedPlan;
  restoreFiles: FileChange[];
};

type CandidateBundle = {
  claimHash: string;
  snippet: string;
  sourcePath: string;
  startLine: number;
  endLine: number;
  score: number;
  recallCount: number;
  uniqueQueries: number;
  queryTerms: string[];
  conceptTags: string[];
  firstSupportedAt: string;
  lastSupportedAt: string;
  evidence: ManagedEvidence[];
};

function normalizeSnippet(value: string, maxChars?: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (!Number.isFinite(maxChars) || (maxChars as number) <= 0 || normalized.length <= maxChars!) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxChars! - 1)).trimEnd()}…`;
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function resolveMaintenancePaths(workspaceDir: string) {
  return {
    maintenanceDir: path.join(workspaceDir, MAINTENANCE_RELATIVE_DIR),
    reportsDir: path.join(workspaceDir, REPORTS_RELATIVE_DIR),
    currentStatePath: path.join(workspaceDir, CURRENT_STATE_RELATIVE_PATH),
    stagedPlanPath: path.join(workspaceDir, STAGED_PLAN_RELATIVE_PATH),
    stagedSummaryPath: path.join(workspaceDir, STAGED_SUMMARY_RELATIVE_PATH),
    lastApplyPath: path.join(workspaceDir, LAST_APPLY_RELATIVE_PATH),
    memoryPath: path.join(workspaceDir, MEMORY_RELATIVE_PATH),
  };
}

function emptyManagedState(nowIso: string): ManagedState {
  return {
    version: 1,
    updatedAt: nowIso,
    entries: [],
  };
}

function normalizeDistinctStrings(values: readonly string[], limit: number): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const trimmed = normalizeSnippet(value, 120);
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
    if (normalized.length >= limit) {
      break;
    }
  }
  return normalized;
}

function normalizeEvidenceKind(
  relativePath: string,
  dailySignalFiles: readonly string[],
  queryTerms: readonly string[],
): EvidenceKind {
  const normalizedPath = normalizeRelativePath(relativePath);
  if (dailySignalFiles.map(normalizeRelativePath).includes(normalizedPath)) {
    return "daily-log";
  }
  if (normalizedPath.startsWith("memory/.dreams/session-corpus/")) {
    return "transcript";
  }
  const hasOrganicQuery = queryTerms.some((entry) => !entry.startsWith("__dreaming_"));
  if (hasOrganicQuery) {
    return "recall";
  }
  return "daily-note";
}

function buildBundleKey(candidate: PromotionCandidate): string {
  return candidate.claimHash?.trim() || sha1(normalizeSnippet(candidate.snippet));
}

function parseIsoTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function minIso(a: string, b: string): string {
  return parseIsoTimestamp(a) <= parseIsoTimestamp(b) ? a : b;
}

function maxIso(a: string, b: string): string {
  return parseIsoTimestamp(a) >= parseIsoTimestamp(b) ? a : b;
}

function evidenceDescriptor(evidence: ManagedEvidence): string {
  return `${evidence.path}:${evidence.startLine}-${evidence.endLine}`;
}

function compareEntryPriority(left: ManagedEntry, right: ManagedEntry): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  const leftLast = parseIsoTimestamp(left.lastSupportedAt);
  const rightLast = parseIsoTimestamp(right.lastSupportedAt);
  if (rightLast !== leftLast) {
    return rightLast - leftLast;
  }
  return left.snippet.localeCompare(right.snippet);
}

function renderManagedEntry(entry: ManagedEntry, config: MemoryDreamingMaintenanceConfig): string {
  const snippet = normalizeSnippet(entry.snippet, config.maxEntryChars);
  const evidenceKinds = normalizeDistinctStrings(
    entry.evidence.map((item) => item.kind),
    4,
  );
  const sources = normalizeDistinctStrings(
    entry.evidence.slice(0, config.maxEvidencePerEntry).map((item) => evidenceDescriptor(item)),
    config.maxEvidencePerEntry,
  );
  const queryTerms = normalizeDistinctStrings(entry.queryTerms, config.maxQueryTermsPerEntry);
  const lines = [
    `- ${snippet} [id=${entry.id} score=${entry.score.toFixed(3)} support=${entry.recallCount} queries=${entry.uniqueQueries} last=${entry.lastSupportedAt.slice(0, 10)}]`,
    `  - evidence: ${evidenceKinds.join(", ") || "none"}; sources: ${sources.join("; ") || "none"}`,
  ];
  if (queryTerms.length > 0) {
    lines.push(`  - query terms: ${queryTerms.join("; ")}`);
  }
  return lines.join("\n");
}

function renderIndexBlock(
  entries: ManagedEntry[],
  config: MemoryDreamingMaintenanceConfig,
): string {
  const topConcepts = new Map<string, number>();
  for (const entry of entries) {
    for (const tag of entry.conceptTags) {
      topConcepts.set(tag, (topConcepts.get(tag) ?? 0) + 1);
    }
  }
  const conceptLine = [...topConcepts.entries()]
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([tag]) => tag)
    .join(", ");
  const lines = [`- entries: ${entries.length}`, `- top concepts: ${conceptLine || "none"}`];
  if (entries.length > 0) {
    const strongest = entries[0];
    lines.push(`- strongest: ${strongest.id} (${strongest.score.toFixed(3)})`);
    lines.push(`- newest support: ${strongest.lastSupportedAt}`);
    const ids = entries
      .slice(0, Math.max(0, config.maxIndexLines - lines.length - 1))
      .map((entry) => entry.id);
    if (ids.length > 0) {
      lines.push(`- ids: ${ids.join(", ")}`);
    }
  }
  return lines.slice(0, Math.max(1, config.maxIndexLines)).join("\n");
}

async function readFileOrEmpty(filePath: string): Promise<string> {
  return await fs.readFile(filePath, "utf-8").catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return "";
    }
    throw err;
  });
}

async function ensureParent(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await ensureParent(filePath);
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function normalizeManagedEntry(raw: unknown): ManagedEntry | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const claimHash = typeof record.claimHash === "string" ? record.claimHash.trim() : "";
  const snippet = typeof record.snippet === "string" ? normalizeSnippet(record.snippet) : "";
  const sourcePath =
    typeof record.sourcePath === "string" ? normalizeRelativePath(record.sourcePath) : "";
  const startLine = Math.max(1, Math.floor(Number(record.startLine) || 1));
  const endLine = Math.max(startLine, Math.floor(Number(record.endLine) || startLine));
  if (!id || !claimHash || !snippet || !sourcePath) {
    return null;
  }
  const evidenceRaw = Array.isArray(record.evidence) ? record.evidence : [];
  const evidence: ManagedEvidence[] = evidenceRaw
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const evidenceRecord = item as Record<string, unknown>;
      const kind = evidenceRecord.kind;
      if (
        kind !== "daily-log" &&
        kind !== "daily-note" &&
        kind !== "transcript" &&
        kind !== "recall"
      ) {
        return null;
      }
      const evidencePath =
        typeof evidenceRecord.path === "string" ? normalizeRelativePath(evidenceRecord.path) : "";
      if (!evidencePath) {
        return null;
      }
      return {
        kind,
        path: evidencePath,
        startLine: Math.max(1, Math.floor(Number(evidenceRecord.startLine) || 1)),
        endLine: Math.max(
          1,
          Math.floor(Number(evidenceRecord.endLine) || Number(evidenceRecord.startLine) || 1),
        ),
        queryTerms: normalizeDistinctStrings(
          Array.isArray(evidenceRecord.queryTerms)
            ? evidenceRecord.queryTerms.filter(
                (entry): entry is string => typeof entry === "string",
              )
            : [],
          12,
        ),
        firstSupportedAt:
          typeof evidenceRecord.firstSupportedAt === "string"
            ? evidenceRecord.firstSupportedAt
            : new Date(0).toISOString(),
        lastSupportedAt:
          typeof evidenceRecord.lastSupportedAt === "string"
            ? evidenceRecord.lastSupportedAt
            : new Date(0).toISOString(),
        signalCount: Math.max(1, Math.floor(Number(evidenceRecord.signalCount) || 1)),
      } satisfies ManagedEvidence;
    })
    .filter((item): item is ManagedEvidence => item !== null);
  return {
    id,
    claimHash,
    snippet,
    sourcePath,
    startLine,
    endLine,
    score: Math.max(0, Math.min(1, Number(record.score) || 0)),
    recallCount: Math.max(0, Math.floor(Number(record.recallCount) || 0)),
    uniqueQueries: Math.max(0, Math.floor(Number(record.uniqueQueries) || 0)),
    queryTerms: normalizeDistinctStrings(
      Array.isArray(record.queryTerms)
        ? record.queryTerms.filter((entry): entry is string => typeof entry === "string")
        : [],
      12,
    ),
    conceptTags: normalizeDistinctStrings(
      Array.isArray(record.conceptTags)
        ? record.conceptTags.filter((entry): entry is string => typeof entry === "string")
        : [],
      12,
    ),
    firstSupportedAt:
      typeof record.firstSupportedAt === "string"
        ? record.firstSupportedAt
        : new Date(0).toISOString(),
    lastSupportedAt:
      typeof record.lastSupportedAt === "string"
        ? record.lastSupportedAt
        : new Date(0).toISOString(),
    evidence,
  };
}

function normalizeManagedState(raw: unknown, nowIso: string): ManagedState {
  if (!raw || typeof raw !== "object") {
    return emptyManagedState(nowIso);
  }
  const record = raw as Record<string, unknown>;
  const entries = Array.isArray(record.entries)
    ? record.entries
        .map(normalizeManagedEntry)
        .filter((item): item is ManagedEntry => item !== null)
    : [];
  return {
    version: 1,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : nowIso,
    entries: entries.toSorted(compareEntryPriority),
  };
}

function importLegacyPromotions(memoryText: string, nowIso: string): ManagedState {
  const entries: ManagedEntry[] = [];
  const matches = memoryText.matchAll(LEGACY_PROMOTION_RE);
  for (const match of matches) {
    const rawKey = match[1]?.trim() ?? "";
    const snippet = normalizeSnippet(match[2] ?? "");
    const score = Math.max(0, Math.min(1, Number(match[3]) || 0));
    const recalls = Math.max(0, Math.floor(Number(match[4]) || 0));
    const source = match[6]?.trim() ?? "";
    const sourceMatch = source.match(/^(.+):(\d+)-(\d+)$/);
    const sourcePath = normalizeRelativePath(sourceMatch?.[1] ?? "memory/legacy-promotions.md");
    const startLine = Math.max(1, Number(sourceMatch?.[2]) || 1);
    const endLine = Math.max(startLine, Number(sourceMatch?.[3]) || startLine);
    if (!rawKey || !snippet) {
      continue;
    }
    entries.push({
      id: rawKey.slice(-8),
      claimHash: rawKey.split(":").at(-1)?.trim() || rawKey.slice(-12),
      snippet,
      sourcePath,
      startLine,
      endLine,
      score,
      recallCount: recalls,
      uniqueQueries: 0,
      queryTerms: [],
      conceptTags: [],
      firstSupportedAt: nowIso,
      lastSupportedAt: nowIso,
      evidence: [
        {
          kind: "daily-note",
          path: sourcePath,
          startLine,
          endLine,
          queryTerms: [],
          firstSupportedAt: nowIso,
          lastSupportedAt: nowIso,
          signalCount: Math.max(1, recalls),
        },
      ],
    });
  }
  return {
    version: 1,
    updatedAt: nowIso,
    entries: entries.toSorted(compareEntryPriority),
  };
}

async function loadCurrentState(workspaceDir: string, nowIso: string): Promise<ManagedState> {
  const paths = resolveMaintenancePaths(workspaceDir);
  const rawState = await readFileOrEmpty(paths.currentStatePath);
  if (rawState.trim()) {
    return normalizeManagedState(JSON.parse(rawState) as unknown, nowIso);
  }
  const memoryText = await readFileOrEmpty(paths.memoryPath);
  return importLegacyPromotions(memoryText, nowIso);
}

function buildEvidenceFromRecall(
  entry: ShortTermRecallEntry,
  dailySignalFiles: readonly string[],
): ManagedEvidence {
  return {
    kind: normalizeEvidenceKind(entry.path, dailySignalFiles, entry.queryTerms ?? []),
    path: normalizeRelativePath(entry.path),
    startLine: entry.startLine,
    endLine: entry.endLine,
    queryTerms: normalizeDistinctStrings(entry.queryTerms ?? [], 12),
    firstSupportedAt: entry.firstRecalledAt,
    lastSupportedAt: entry.lastRecalledAt,
    signalCount: Math.max(1, entry.recallCount + entry.dailyCount + entry.groundedCount),
  };
}

function buildCandidateBundles(params: {
  candidates: PromotionCandidate[];
  recalls: ShortTermRecallEntry[];
  dailySignalFiles: readonly string[];
}): CandidateBundle[] {
  const recallsByClaim = new Map<string, ShortTermRecallEntry[]>();
  for (const recall of params.recalls) {
    const claimHash =
      recall.claimHash?.trim() ||
      sha1(
        normalizeSnippet(recall.snippet || `${recall.path}:${recall.startLine}-${recall.endLine}`),
      );
    const bucket = recallsByClaim.get(claimHash) ?? [];
    bucket.push(recall);
    recallsByClaim.set(claimHash, bucket);
  }

  const bundles = new Map<string, CandidateBundle>();
  for (const candidate of params.candidates) {
    const claimHash = buildBundleKey(candidate);
    const supportingRecalls = recallsByClaim.get(claimHash) ?? [];
    const evidence = supportingRecalls.map((entry) =>
      buildEvidenceFromRecall(entry, params.dailySignalFiles),
    );
    const queryTerms = normalizeDistinctStrings(
      [...candidate.queryTerms, ...supportingRecalls.flatMap((entry) => entry.queryTerms ?? [])],
      12,
    );
    const conceptTags = normalizeDistinctStrings(
      [...candidate.conceptTags, ...supportingRecalls.flatMap((entry) => entry.conceptTags ?? [])],
      12,
    );
    const recallCount =
      supportingRecalls.reduce(
        (sum, entry) => sum + entry.recallCount + entry.dailyCount + entry.groundedCount,
        0,
      ) ||
      Math.max(
        1,
        candidate.recallCount + (candidate.dailyCount ?? 0) + (candidate.groundedCount ?? 0),
      );
    const uniqueQueries =
      new Set(
        supportingRecalls.flatMap((entry) => entry.queryTerms ?? []).concat(candidate.queryTerms),
      ).size || candidate.uniqueQueries;
    const firstSupportedAt =
      supportingRecalls.reduce(
        (min, entry) => (min ? minIso(min, entry.firstRecalledAt) : entry.firstRecalledAt),
        "",
      ) || candidate.firstRecalledAt;
    const lastSupportedAt =
      supportingRecalls.reduce(
        (max, entry) => (max ? maxIso(max, entry.lastRecalledAt) : entry.lastRecalledAt),
        "",
      ) || candidate.lastRecalledAt;
    const existing = bundles.get(claimHash);
    if (!existing || candidate.score > existing.score) {
      bundles.set(claimHash, {
        claimHash,
        snippet: candidate.snippet,
        sourcePath: normalizeRelativePath(candidate.path),
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        score: candidate.score,
        recallCount,
        uniqueQueries,
        queryTerms,
        conceptTags,
        firstSupportedAt,
        lastSupportedAt,
        evidence:
          evidence.length > 0
            ? evidence
            : [
                {
                  kind: normalizeEvidenceKind(
                    candidate.path,
                    params.dailySignalFiles,
                    candidate.queryTerms,
                  ),
                  path: normalizeRelativePath(candidate.path),
                  startLine: candidate.startLine,
                  endLine: candidate.endLine,
                  queryTerms,
                  firstSupportedAt,
                  lastSupportedAt,
                  signalCount: Math.max(1, candidate.recallCount),
                },
              ],
      });
      continue;
    }
    existing.score = Math.max(existing.score, candidate.score);
    existing.recallCount = Math.max(existing.recallCount, recallCount);
    existing.uniqueQueries = Math.max(existing.uniqueQueries, uniqueQueries);
    existing.queryTerms = normalizeDistinctStrings([...existing.queryTerms, ...queryTerms], 12);
    existing.conceptTags = normalizeDistinctStrings([...existing.conceptTags, ...conceptTags], 12);
    existing.firstSupportedAt = minIso(existing.firstSupportedAt, firstSupportedAt);
    existing.lastSupportedAt = maxIso(existing.lastSupportedAt, lastSupportedAt);
    existing.evidence = dedupeEvidence([...existing.evidence, ...evidence]);
  }
  return [...bundles.values()].toSorted(
    (a, b) => b.score - a.score || a.snippet.localeCompare(b.snippet),
  );
}

function dedupeEvidence(items: ManagedEvidence[]): ManagedEvidence[] {
  const map = new Map<string, ManagedEvidence>();
  for (const item of items) {
    const key = `${item.kind}:${item.path}:${item.startLine}:${item.endLine}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...item, queryTerms: normalizeDistinctStrings(item.queryTerms, 12) });
      continue;
    }
    existing.queryTerms = normalizeDistinctStrings(
      [...existing.queryTerms, ...item.queryTerms],
      12,
    );
    existing.firstSupportedAt = minIso(existing.firstSupportedAt, item.firstSupportedAt);
    existing.lastSupportedAt = maxIso(existing.lastSupportedAt, item.lastSupportedAt);
    existing.signalCount = Math.max(existing.signalCount, item.signalCount);
  }
  return [...map.values()];
}

function buildManagedEntryFromBundle(bundle: CandidateBundle, priorId?: string): ManagedEntry {
  return {
    id: priorId ?? bundle.claimHash.slice(0, 8),
    claimHash: bundle.claimHash,
    snippet: bundle.snippet,
    sourcePath: bundle.sourcePath,
    startLine: bundle.startLine,
    endLine: bundle.endLine,
    score: bundle.score,
    recallCount: bundle.recallCount,
    uniqueQueries: bundle.uniqueQueries,
    queryTerms: normalizeDistinctStrings(bundle.queryTerms, 12),
    conceptTags: normalizeDistinctStrings(bundle.conceptTags, 12),
    firstSupportedAt: bundle.firstSupportedAt,
    lastSupportedAt: bundle.lastSupportedAt,
    evidence: dedupeEvidence(bundle.evidence),
  };
}

function summarizeChangeEvidence(
  entry: ManagedEntry | CandidateBundle | null,
): ReportChange["evidence"] {
  const evidence = Array.isArray(entry?.evidence) ? entry.evidence : [];
  return {
    sourceKinds: normalizeDistinctStrings(
      evidence.map((item) => item.kind),
      8,
    ) as EvidenceKind[],
    queryTerms: normalizeDistinctStrings(
      evidence.flatMap((item) => item.queryTerms).concat(entry?.queryTerms ?? []),
      8,
    ),
    sources: normalizeDistinctStrings(
      evidence.map((item) => evidenceDescriptor(item)),
      8,
    ),
  };
}

function findFixTarget(
  bundle: CandidateBundle,
  currentEntries: ManagedEntry[],
  usedIds: Set<string>,
): ManagedEntry | null {
  const exactSource = currentEntries.find(
    (entry) => !usedIds.has(entry.id) && entry.sourcePath === bundle.sourcePath,
  );
  if (exactSource) {
    return exactSource;
  }
  const bundleEvidencePaths = new Set(bundle.evidence.map((item) => item.path));
  return (
    currentEntries.find(
      (entry) =>
        !usedIds.has(entry.id) && entry.evidence.some((item) => bundleEvidencePaths.has(item.path)),
    ) ?? null
  );
}

function serializeState(state: ManagedState): string {
  return JSON.stringify(
    {
      version: 1,
      updatedAt: state.updatedAt,
      entries: state.entries,
    },
    null,
    2,
  );
}

function buildMemoryText(params: {
  original: string;
  afterState: ManagedState;
  config: MemoryDreamingMaintenanceConfig;
}): string {
  const managedBody =
    params.afterState.entries.length > 0
      ? params.afterState.entries
          .map((entry) => renderManagedEntry(entry, params.config))
          .join("\n")
      : "- No active Dreaming-managed entries.";
  const indexBody = renderIndexBlock(params.afterState.entries, params.config);
  const base = params.original.trim().length > 0 ? params.original : "# Long-Term Memory\n";
  const withManaged = replaceManagedMarkdownBlock({
    original: base,
    heading: MANAGED_HEADING,
    startMarker: MANAGED_START_MARKER,
    endMarker: MANAGED_END_MARKER,
    body: managedBody,
  });
  const withIndex = replaceManagedMarkdownBlock({
    original: withManaged,
    heading: INDEX_HEADING,
    startMarker: INDEX_START_MARKER,
    endMarker: INDEX_END_MARKER,
    body: indexBody,
  });
  return withTrailingNewline(withIndex);
}

function createFileChange(params: {
  relativePath: string;
  mode: FileChangeMode;
  beforeContent: string;
  afterContent: string;
  summary: string;
}): FileChange | null {
  if (params.beforeContent === params.afterContent) {
    return null;
  }
  return {
    path: params.relativePath,
    mode: params.mode,
    beforeExists: params.beforeContent.length > 0,
    beforeSha1: sha1(params.beforeContent),
    afterSha1: sha1(params.afterContent),
    beforeContent: params.beforeContent,
    afterContent: params.afterContent,
    summary: params.summary,
  };
}

function buildHumanSummary(report: DreamingMaintenanceReport): string {
  const lines = [
    "# Dreaming Maintenance",
    "",
    `- report: ${report.reportId}`,
    `- staged: ${report.staged ? "yes" : "no"}`,
    `- applied: ${report.applied ? "yes" : "no"}`,
    `- touched: ${report.touchedFiles.map((item) => `${item.path} (${item.mode})`).join(", ") || "none"}`,
    `- ops: add=${report.operationCounts.add}, merge=${report.operationCounts.merge}, fix=${report.operationCounts.fix}, prune=${report.operationCounts.prune}, index=${report.operationCounts.index}`,
  ];
  if (report.noChangeReasons.length > 0) {
    lines.push(`- no-change: ${report.noChangeReasons.join("; ")}`);
  }
  if (report.queryTerms.length > 0) {
    lines.push(`- query terms: ${report.queryTerms.join("; ")}`);
  }
  lines.push("", "## Summary", "");
  if (report.diffSummary.length > 0) {
    lines.push(...report.diffSummary.map((line) => `- ${line}`));
  } else {
    lines.push("- No durable changes staged.");
  }
  if (report.changes.length > 0) {
    lines.push("", "## Reasons", "");
    for (const change of report.changes) {
      lines.push(
        `- ${change.type.toUpperCase()} ${change.id}: ${change.summary} (${change.reason}; risk=${change.risk})`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

async function writeReportArtifacts(workspaceDir: string, plan: StagedPlan): Promise<void> {
  const paths = resolveMaintenancePaths(workspaceDir);
  const reportJsonRelativePath = path.posix.join(
    "memory",
    ".dreams",
    "maintenance",
    "reports",
    `${plan.report.reportId}.json`,
  );
  const reportSummaryRelativePath = path.posix.join(
    "memory",
    ".dreams",
    "maintenance",
    "reports",
    `${plan.report.reportId}.md`,
  );
  const reportJsonPath = path.join(workspaceDir, reportJsonRelativePath);
  const reportSummaryPath = path.join(workspaceDir, reportSummaryRelativePath);
  const stagedSummary = buildHumanSummary(plan.report);
  await Promise.all([
    writeJson(paths.stagedPlanPath, plan),
    ensureParent(paths.stagedSummaryPath).then(() =>
      fs.writeFile(paths.stagedSummaryPath, stagedSummary, "utf-8"),
    ),
    writeJson(reportJsonPath, plan.report),
    ensureParent(reportSummaryPath).then(() =>
      fs.writeFile(reportSummaryPath, stagedSummary, "utf-8"),
    ),
  ]);
}

function planTouchedFiles(
  fileChanges: FileChange[],
): Array<{ path: string; mode: FileChangeMode }> {
  return fileChanges.map((change) => ({ path: change.path, mode: change.mode }));
}

function buildDiffSummary(changes: ReportChange[], noChangeReasons: string[]): string[] {
  if (changes.length === 0) {
    return noChangeReasons.length > 0
      ? noChangeReasons
      : ["managed memory already matches current evidence"];
  }
  return changes.map((change) => `${change.type.toUpperCase()} ${change.id}: ${change.summary}`);
}

function buildPlan(params: {
  workspaceDir: string;
  nowMs: number;
  config: MemoryDreamingMaintenanceConfig;
  dailySignalFiles: readonly string[];
  candidates: PromotionCandidate[];
  recalls: ShortTermRecallEntry[];
  originalMemory: string;
  originalStateFile: string;
  currentState: ManagedState;
  autoApply: boolean;
}): StagedPlan {
  const nowIso = new Date(params.nowMs).toISOString();
  const bundles = buildCandidateBundles({
    candidates: params.candidates,
    recalls: params.recalls,
    dailySignalFiles: params.dailySignalFiles,
  });
  const currentEntries = params.currentState.entries;
  const currentByClaim = new Map(currentEntries.map((entry) => [entry.claimHash, entry]));
  const usedIds = new Set<string>();
  const nextEntries: ManagedEntry[] = [];
  const changes: ReportChange[] = [];
  const operationCounts: Record<OperationKind, number> = {
    add: 0,
    merge: 0,
    fix: 0,
    prune: 0,
    index: 0,
  };
  const noChangeReasons: string[] = [];

  for (const bundle of bundles) {
    const claimMatch = currentByClaim.get(bundle.claimHash);
    if (claimMatch) {
      usedIds.add(claimMatch.id);
      const nextEntry = buildManagedEntryFromBundle(bundle, claimMatch.id);
      nextEntries.push(nextEntry);
      const mergedChanged = JSON.stringify(claimMatch) !== JSON.stringify(nextEntry);
      if (mergedChanged) {
        operationCounts.merge += 1;
        changes.push({
          type: "merge",
          id: claimMatch.id,
          claimHash: nextEntry.claimHash,
          risk: "low",
          reason: "fresh evidence reinforced an existing managed memory",
          summary: `updated support for "${normalizeSnippet(nextEntry.snippet, 80)}"`,
          evidence: summarizeChangeEvidence(nextEntry),
          before: {
            snippet: claimMatch.snippet,
            sourcePath: claimMatch.sourcePath,
            lastSupportedAt: claimMatch.lastSupportedAt,
          },
          after: {
            snippet: nextEntry.snippet,
            sourcePath: nextEntry.sourcePath,
            lastSupportedAt: nextEntry.lastSupportedAt,
          },
        });
      }
      continue;
    }

    const fixTarget = findFixTarget(bundle, currentEntries, usedIds);
    if (fixTarget) {
      usedIds.add(fixTarget.id);
      const nextEntry = buildManagedEntryFromBundle(bundle, fixTarget.id);
      nextEntries.push(nextEntry);
      operationCounts.fix += 1;
      changes.push({
        type: "fix",
        id: fixTarget.id,
        claimHash: nextEntry.claimHash,
        risk: "medium",
        reason: "new evidence replaced an older managed fact for the same source lane",
        summary: `replaced "${normalizeSnippet(fixTarget.snippet, 60)}" with "${normalizeSnippet(nextEntry.snippet, 60)}"`,
        evidence: summarizeChangeEvidence(nextEntry),
        before: {
          snippet: fixTarget.snippet,
          sourcePath: fixTarget.sourcePath,
          lastSupportedAt: fixTarget.lastSupportedAt,
        },
        after: {
          snippet: nextEntry.snippet,
          sourcePath: nextEntry.sourcePath,
          lastSupportedAt: nextEntry.lastSupportedAt,
        },
      });
      continue;
    }

    const nextEntry = buildManagedEntryFromBundle(bundle);
    nextEntries.push(nextEntry);
    operationCounts.add += 1;
    changes.push({
      type: "add",
      id: nextEntry.id,
      claimHash: nextEntry.claimHash,
      risk: "low",
      reason: "durable thresholds were met with new supporting evidence",
      summary: `stage "${normalizeSnippet(nextEntry.snippet, 80)}"`,
      evidence: summarizeChangeEvidence(nextEntry),
      after: {
        snippet: nextEntry.snippet,
        sourcePath: nextEntry.sourcePath,
        lastSupportedAt: nextEntry.lastSupportedAt,
      },
    });
  }

  for (const entry of currentEntries) {
    if (usedIds.has(entry.id)) {
      continue;
    }
    const ageDays = Math.max(
      0,
      (params.nowMs - parseIsoTimestamp(entry.lastSupportedAt)) / (24 * 60 * 60 * 1000),
    );
    if (ageDays > params.config.staleAfterDays) {
      operationCounts.prune += 1;
      changes.push({
        type: "prune",
        id: entry.id,
        claimHash: entry.claimHash,
        risk: "medium",
        reason: `no fresh corroboration for ${ageDays.toFixed(1)} day(s)`,
        summary: `drop stale managed memory "${normalizeSnippet(entry.snippet, 80)}"`,
        evidence: summarizeChangeEvidence(entry),
        before: {
          snippet: entry.snippet,
          sourcePath: entry.sourcePath,
          lastSupportedAt: entry.lastSupportedAt,
        },
      });
      continue;
    }
    nextEntries.push(entry);
  }

  const prunedForIndex = nextEntries
    .toSorted(compareEntryPriority)
    .slice(params.config.maxManagedEntries);
  if (prunedForIndex.length > 0) {
    operationCounts.prune += prunedForIndex.length;
    for (const entry of prunedForIndex) {
      changes.push({
        type: "prune",
        id: entry.id,
        claimHash: entry.claimHash,
        risk: "medium",
        reason: `index cap maxManagedEntries=${params.config.maxManagedEntries}`,
        summary: `drop overflow managed memory "${normalizeSnippet(entry.snippet, 80)}"`,
        evidence: summarizeChangeEvidence(entry),
        before: {
          snippet: entry.snippet,
          sourcePath: entry.sourcePath,
          lastSupportedAt: entry.lastSupportedAt,
        },
      });
    }
  }

  const finalEntries = nextEntries
    .toSorted(compareEntryPriority)
    .slice(0, Math.max(0, params.config.maxManagedEntries));
  const afterState: ManagedState = {
    version: 1,
    updatedAt: nowIso,
    entries: finalEntries,
  };

  if (bundles.length === 0) {
    noChangeReasons.push("no ranked candidates passed the current deep thresholds");
  }
  if (changes.length === 0) {
    noChangeReasons.push("managed memory already matches current evidence");
  }

  const beforeStateText = params.originalStateFile;
  const afterStateText = `${serializeState(afterState)}\n`;
  const nextMemoryText = buildMemoryText({
    original: params.originalMemory,
    afterState,
    config: params.config,
  });
  const memoryChange = createFileChange({
    relativePath: MEMORY_RELATIVE_PATH,
    mode: "planned",
    beforeContent: params.originalMemory,
    afterContent: nextMemoryText,
    summary: "replace Dreaming managed/index blocks in MEMORY.md",
  });
  const stateChange = createFileChange({
    relativePath: CURRENT_STATE_RELATIVE_PATH.replaceAll("\\", "/"),
    mode: "planned",
    beforeContent: beforeStateText,
    afterContent: afterStateText,
    summary: "update Dreaming maintenance state snapshot",
  });
  if (memoryChange) {
    operationCounts.index += 1;
  }
  const fileChanges = [memoryChange, stateChange].filter(
    (item): item is FileChange => item !== null,
  );
  const evidenceSources = normalizeDistinctEvidence(
    changes.flatMap((change) =>
      change.evidence.sources.map((source, index) => ({
        kind: change.evidence.sourceKinds[index] ?? change.evidence.sourceKinds[0] ?? "recall",
        path: source.split(":")[0] ?? source,
        startLine: 1,
        endLine: 1,
        queryTerms: change.evidence.queryTerms,
      })),
    ),
  );
  const queryTerms = normalizeDistinctStrings(
    changes.flatMap((change) => change.evidence.queryTerms),
    12,
  );
  const report: DreamingMaintenanceReport = {
    version: 1,
    reportId: nowIso.replace(/[:.]/g, "-"),
    workspaceDir: params.workspaceDir,
    generatedAt: nowIso,
    staged: true,
    applied: false,
    autoApply: params.autoApply,
    touchedFiles: planTouchedFiles(fileChanges),
    fileChanges,
    operationCounts,
    noChangeReasons,
    evidenceSources,
    queryTerms,
    changes,
    diffSummary: buildDiffSummary(changes, noChangeReasons),
  };

  return {
    version: 1,
    report,
    beforeState: params.currentState,
    afterState,
  };
}

function normalizeDistinctEvidence(evidence: ReportEvidence[]): ReportEvidence[] {
  const map = new Map<string, ReportEvidence>();
  for (const item of evidence) {
    const key = `${item.kind}:${item.path}:${item.startLine}:${item.endLine}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        ...item,
        queryTerms: normalizeDistinctStrings(item.queryTerms, 8),
      });
      continue;
    }
    existing.queryTerms = normalizeDistinctStrings([...existing.queryTerms, ...item.queryTerms], 8);
  }
  return [...map.values()];
}

async function writeFileChange(workspaceDir: string, change: FileChange): Promise<void> {
  const absolutePath = path.join(workspaceDir, change.path);
  if (!change.beforeExists && change.afterContent.length === 0) {
    await fs.unlink(absolutePath).catch(() => undefined);
    return;
  }
  await ensureParent(absolutePath);
  await fs.writeFile(absolutePath, change.afterContent, "utf-8");
}

export async function stageDreamingMaintenance(params: {
  workspaceDir: string;
  nowMs?: number;
  config: MemoryDreamingMaintenanceConfig;
  dailySignalFiles: readonly string[];
  candidates: PromotionCandidate[];
  recalls: ShortTermRecallEntry[];
  autoApply?: boolean;
}): Promise<DreamingMaintenanceReport> {
  const workspaceDir = params.workspaceDir.trim();
  const nowMs = Number.isFinite(params.nowMs) ? (params.nowMs as number) : Date.now();
  const nowIso = new Date(nowMs).toISOString();
  return await runWithShortTermPromotionLock(workspaceDir, async () => {
    const paths = resolveMaintenancePaths(workspaceDir);
    const [originalMemory, currentState] = await Promise.all([
      readFileOrEmpty(paths.memoryPath),
      loadCurrentState(workspaceDir, nowIso),
    ]);
    const currentStateRaw = await readFileOrEmpty(paths.currentStatePath);
    const plan = buildPlan({
      workspaceDir,
      nowMs,
      config: params.config,
      dailySignalFiles: params.dailySignalFiles,
      candidates: params.candidates,
      recalls: params.recalls,
      originalMemory,
      originalStateFile: currentStateRaw,
      currentState,
      autoApply: Boolean(params.autoApply),
    });
    await writeReportArtifacts(workspaceDir, plan);
    return plan.report;
  });
}

async function readStagedPlan(workspaceDir: string): Promise<StagedPlan | null> {
  const paths = resolveMaintenancePaths(workspaceDir);
  const raw = await readFileOrEmpty(paths.stagedPlanPath);
  if (!raw.trim()) {
    return null;
  }
  const parsed = JSON.parse(raw) as unknown;
  const record = parsed as Record<string, unknown>;
  const report = record.report as DreamingMaintenanceReport | undefined;
  if (!report || !Array.isArray(report.fileChanges)) {
    return null;
  }
  return parsed as StagedPlan;
}

export async function applyDreamingMaintenance(params: {
  workspaceDir: string;
}): Promise<
  | { status: "applied"; reportId: string; touchedFiles: string[] }
  | { status: "noop"; reason: string }
  | { status: "conflict"; path: string }
> {
  const workspaceDir = params.workspaceDir.trim();
  return await runWithShortTermPromotionLock(workspaceDir, async () => {
    const paths = resolveMaintenancePaths(workspaceDir);
    const plan = await readStagedPlan(workspaceDir);
    if (!plan) {
      return { status: "noop", reason: "no staged dreaming maintenance plan is available" };
    }
    for (const change of plan.report.fileChanges) {
      const currentContent = await readFileOrEmpty(path.join(workspaceDir, change.path));
      if (sha1(currentContent) !== change.beforeSha1) {
        return { status: "conflict", path: change.path };
      }
    }
    const restoreFiles: FileChange[] = [];
    for (const change of plan.report.fileChanges) {
      const currentContent = await readFileOrEmpty(path.join(workspaceDir, change.path));
      restoreFiles.push({
        ...change,
        mode: "written",
        beforeExists: currentContent.length > 0,
        beforeSha1: sha1(currentContent),
        afterSha1: change.beforeSha1,
        beforeContent: currentContent,
        afterContent: change.beforeContent,
      });
      await writeFileChange(workspaceDir, {
        ...change,
        mode: "written",
      });
    }
    const lastApply: LastApplyRecord = {
      version: 1,
      reportId: plan.report.reportId,
      appliedAt: new Date().toISOString(),
      workspaceDir,
      appliedPlan: {
        ...plan,
        report: {
          ...plan.report,
          applied: true,
          staged: false,
          touchedFiles: plan.report.touchedFiles.map((item) => ({
            ...item,
            mode: "written",
          })),
          fileChanges: plan.report.fileChanges.map((change) => ({
            ...change,
            mode: "written",
          })),
        },
      },
      restoreFiles,
    };
    await writeJson(paths.lastApplyPath, lastApply);
    await fs.unlink(paths.stagedPlanPath).catch(() => undefined);
    await fs.unlink(paths.stagedSummaryPath).catch(() => undefined);
    return {
      status: "applied",
      reportId: plan.report.reportId,
      touchedFiles: plan.report.fileChanges.map((change) => change.path),
    };
  });
}

export async function rollbackDreamingMaintenance(params: {
  workspaceDir: string;
}): Promise<
  | { status: "rolled_back"; reportId: string; touchedFiles: string[] }
  | { status: "noop"; reason: string }
  | { status: "conflict"; path: string }
> {
  const workspaceDir = params.workspaceDir.trim();
  return await runWithShortTermPromotionLock(workspaceDir, async () => {
    const paths = resolveMaintenancePaths(workspaceDir);
    const raw = await readFileOrEmpty(paths.lastApplyPath);
    if (!raw.trim()) {
      return { status: "noop", reason: "no previous dreaming apply record is available" };
    }
    const record = JSON.parse(raw) as LastApplyRecord;
    for (const change of record.appliedPlan.report.fileChanges) {
      const currentContent = await readFileOrEmpty(path.join(workspaceDir, change.path));
      if (sha1(currentContent) !== change.afterSha1) {
        return { status: "conflict", path: change.path };
      }
    }
    for (const restore of record.restoreFiles) {
      await writeFileChange(workspaceDir, {
        ...restore,
        mode: "written",
      });
    }
    await fs.unlink(paths.lastApplyPath).catch(() => undefined);
    return {
      status: "rolled_back",
      reportId: record.reportId,
      touchedFiles: record.restoreFiles.map((change) => change.path),
    };
  });
}

export const __testing = {
  buildCandidateBundles,
  buildMemoryText,
  importLegacyPromotions,
  resolveMaintenancePaths,
};
