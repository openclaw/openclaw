import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MemoryEmbeddingProbeResult } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveMemoryRemDreamingConfig } from "openclaw/plugin-sdk/memory-core-host-status";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import {
  colorize,
  defaultRuntime,
  formatErrorMessage,
  getRuntimeConfig,
  getMemorySearchManager,
  isRich,
  listMemoryFiles,
  normalizeExtraMemoryPaths,
  resolveCommandSecretRefsViaGateway,
  resolveDefaultAgentId,
  resolveSessionTranscriptsDirForAgent,
  resolveStateDir,
  setVerbose,
  shortenHomeInString,
  shortenHomePath,
  theme,
  type OpenClawConfig,
  withManager,
  withProgress,
  withProgressTotals,
} from "./cli.host.runtime.js";
import type {
  MemoryCommandOptions,
  MemoryPromoteCommandOptions,
  MemoryPromoteExplainOptions,
  MemoryRemBackfillOptions,
  MemoryRemHarnessOptions,
  MemorySearchCommandOptions,
  MemoryRollupOptions,
} from "./cli.types.js";
import { removeBackfillDiaryEntries, writeBackfillDiaryEntries } from "./dreaming-narrative.js";
import { seedHistoricalDailyMemorySignals } from "./dreaming-phases.js";
import {
  auditDreamingArtifacts,
  repairDreamingArtifacts,
  type DreamingArtifactsAuditSummary,
  type RepairDreamingArtifactsResult,
} from "./dreaming-repair.js";
import { asRecord } from "./dreaming-shared.js";
import { resolveShortTermPromotionDreamingConfig } from "./dreaming.js";
import { previewGroundedRemMarkdown } from "./rem-evidence.js";
import { previewRemHarness } from "./rem-harness.js";
import {
  resolveMemoryRollupConfig,
  sessionRollupsDefaults,
  type SessionRollupAction,
  type SessionRollupGenerationResult,
  type SessionRollupPlan,
  writeSessionRollups,
} from "./session-rollups.js";
import {
  applyShortTermPromotions,
  auditShortTermPromotionArtifacts,
  removeGroundedShortTermCandidates,
  repairShortTermPromotionArtifacts,
  recordGroundedShortTermCandidates,
  recordShortTermRecalls,
  rankShortTermPromotionCandidates,
  resolveShortTermRecallLockPath,
  resolveShortTermRecallStorePath,
  type RepairShortTermPromotionArtifactsResult,
  type ShortTermAuditSummary,
} from "./short-term-promotion.js";

type MemoryManager = NonNullable<Awaited<ReturnType<typeof getMemorySearchManager>>["manager"]>;
type MemoryManagerPurpose = Parameters<typeof getMemorySearchManager>[0]["purpose"];

type MemorySourceName = "memory" | "sessions";

type MemorySourceNameWithRollups = "memory" | "sessions" | "session-rollups";

type SourceScan = {
  source: MemorySourceName;
  totalFiles: number | null;
  issues: string[];
};

type MemorySourceScan = {
  sources: SourceScan[];
  totalFiles: number | null;
  issues: string[];
};

type MemoryRollupState = {
  config: ReturnType<typeof resolveMemoryRollupConfig>;
  plan: SessionRollupPlan;
  error?: string;
};

function isMemorySourceName(value: unknown): value is MemorySourceName {
  return value === "memory" || value === "sessions";
}

type MemoryIndexCoverage = {
  memoryFilesDiscovered: number | null;
  memoryFilesIndexed: number | null;
  sessionTranscriptsDiscovered: number | null;
  sessionTranscriptsIndexed: number | null;
};

type LoadedMemoryCommandConfig = {
  config: OpenClawConfig;
  diagnostics: string[];
};

function getMemoryCommandSecretTargetIds(): Set<string> {
  return new Set([
    "agents.defaults.memorySearch.remote.apiKey",
    "agents.list[].memorySearch.remote.apiKey",
  ]);
}

async function loadMemoryCommandConfig(commandName: string): Promise<LoadedMemoryCommandConfig> {
  const { resolvedConfig, diagnostics } = await resolveCommandSecretRefsViaGateway({
    config: getRuntimeConfig(),
    commandName,
    targetIds: getMemoryCommandSecretTargetIds(),
  });
  return {
    config: resolvedConfig,
    diagnostics,
  };
}

function emitMemorySecretResolveDiagnostics(
  diagnostics: string[],
  params?: { json?: boolean },
): void {
  if (diagnostics.length === 0) {
    return;
  }
  const toStderr = params?.json === true;
  for (const entry of diagnostics) {
    const message = theme.warn(`[secrets] ${entry}`);
    if (toStderr) {
      defaultRuntime.error(message);
    } else {
      defaultRuntime.log(message);
    }
  }
}

function resolveMemoryPluginConfig(cfg: OpenClawConfig): Record<string, unknown> {
  const entry = asRecord(cfg.plugins?.entries?.["memory-core"]);
  return asRecord(entry?.config) ?? {};
}

const DAILY_MEMORY_FILE_NAME_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;

async function listHistoricalDailyFiles(inputPath: string): Promise<string[]> {
  const resolvedPath = path.resolve(inputPath);
  let stat;
  try {
    stat = await fs.stat(resolvedPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return [];
    }
    throw err;
  }
  if (stat.isFile()) {
    return DAILY_MEMORY_FILE_NAME_RE.test(path.basename(resolvedPath)) ? [resolvedPath] : [];
  }
  if (!stat.isDirectory()) {
    return [];
  }
  const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && DAILY_MEMORY_FILE_NAME_RE.test(entry.name))
    .map((entry) => path.join(resolvedPath, entry.name))
    .toSorted((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

async function createHistoricalRemHarnessWorkspace(params: {
  inputPath: string;
  remLimit: number;
  nowMs: number;
  timezone?: string;
}): Promise<{
  workspaceDir: string;
  sourceFiles: string[];
  workspaceSourceFiles: string[];
  importedFileCount: number;
  importedSignalCount: number;
  skippedPaths: string[];
}> {
  const sourceFiles = await listHistoricalDailyFiles(params.inputPath);
  const workspaceDir = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-rem-harness-"),
  );
  const memoryDir = path.join(workspaceDir, "memory");
  await fs.mkdir(memoryDir, { recursive: true });
  for (const filePath of sourceFiles) {
    await fs.copyFile(filePath, path.join(memoryDir, path.basename(filePath)));
  }
  const workspaceSourceFiles = sourceFiles.map((entry) =>
    path.join(memoryDir, path.basename(entry)),
  );
  const seeded = await seedHistoricalDailyMemorySignals({
    workspaceDir,
    filePaths: workspaceSourceFiles,
    limit: params.remLimit,
    nowMs: params.nowMs,
    timezone: params.timezone,
  });
  return {
    workspaceDir,
    sourceFiles,
    workspaceSourceFiles,
    importedFileCount: seeded.importedFileCount,
    importedSignalCount: seeded.importedSignalCount,
    skippedPaths: seeded.skippedPaths,
  };
}

function formatDreamingSummary(cfg: OpenClawConfig): string {
  const pluginConfig = resolveMemoryPluginConfig(cfg);
  const dreaming = resolveShortTermPromotionDreamingConfig({ pluginConfig, cfg });
  if (!dreaming.enabled) {
    return "off";
  }
  const timezone = dreaming.timezone ? ` (${dreaming.timezone})` : "";
  return `${dreaming.cron}${timezone} · limit=${dreaming.limit} · minScore=${dreaming.minScore} · minRecallCount=${dreaming.minRecallCount} · minUniqueQueries=${dreaming.minUniqueQueries} · recencyHalfLifeDays=${dreaming.recencyHalfLifeDays} · maxAgeDays=${dreaming.maxAgeDays ?? "none"}`;
}

function formatAuditCounts(audit: ShortTermAuditSummary): string {
  const scriptCoverage = audit.conceptTagScripts
    ? [
        audit.conceptTagScripts.latinEntryCount > 0
          ? `${audit.conceptTagScripts.latinEntryCount} latin`
          : null,
        audit.conceptTagScripts.cjkEntryCount > 0
          ? `${audit.conceptTagScripts.cjkEntryCount} cjk`
          : null,
        audit.conceptTagScripts.mixedEntryCount > 0
          ? `${audit.conceptTagScripts.mixedEntryCount} mixed`
          : null,
        audit.conceptTagScripts.otherEntryCount > 0
          ? `${audit.conceptTagScripts.otherEntryCount} other`
          : null,
      ]
        .filter(Boolean)
        .join(", ")
    : "";
  const suffix = scriptCoverage ? ` · scripts=${scriptCoverage}` : "";
  return `${audit.entryCount} entries · ${audit.promotedCount} promoted · ${audit.conceptTaggedEntryCount} concept-tagged · ${audit.spacedEntryCount} spaced${suffix}`;
}

function formatRepairSummary(repair: RepairShortTermPromotionArtifactsResult): string {
  const actions: string[] = [];
  if (repair.rewroteStore) {
    actions.push(
      `rewrote store${repair.removedInvalidEntries > 0 ? ` (-${repair.removedInvalidEntries} invalid)` : ""}`,
    );
  }
  if (repair.removedStaleLock) {
    actions.push("removed stale lock");
  }
  return actions.length > 0 ? actions.join(" · ") : "no changes";
}

function formatDreamingAuditSummary(audit: DreamingArtifactsAuditSummary): string {
  const bits = [
    audit.dreamsPath ? "diary present" : "diary absent",
    `${audit.sessionCorpusFileCount} corpus files`,
    audit.sessionIngestionExists ? "ingestion state present" : "ingestion state absent",
    audit.suspiciousSessionCorpusLineCount > 0
      ? `${audit.suspiciousSessionCorpusLineCount} suspicious lines`
      : null,
  ].filter(Boolean);
  return bits.join(" · ");
}

function formatDreamingRepairSummary(repair: RepairDreamingArtifactsResult): string {
  const actions: string[] = [];
  if (repair.archivedSessionCorpus) {
    actions.push("archived session corpus");
  }
  if (repair.archivedSessionIngestion) {
    actions.push("archived ingestion state");
  }
  if (repair.archivedDreamsDiary) {
    actions.push("archived diary");
  }
  if (repair.warnings.length > 0) {
    actions.push(`${repair.warnings.length} warning${repair.warnings.length === 1 ? "" : "s"}`);
  }
  return actions.length > 0 ? actions.join(" · ") : "no changes";
}

function formatSourceLabel(source: string, workspaceDir: string, agentId: string): string {
  if (source === "memory") {
    return shortenHomeInString(
      `memory (MEMORY.md + ${path.join(workspaceDir, "memory")}${path.sep}*.md)`,
    );
  }
  if (source === "sessions") {
    const stateDir = resolveStateDir(process.env, os.homedir);
    return shortenHomeInString(
      `sessions (${path.join(stateDir, "agents", agentId, "sessions")}${path.sep}*.jsonl)`,
    );
  }
  return source;
}

function formatRollupStatusLine(result: SessionRollupPlan): string {
  return `discovered=${result.discovered}, upToDate=${result.generated}, pending=${result.pending}, stale=${result.stale}, orphaned=${result.orphaned}, coverage=${result.evidenceCoveragePercent}%`;
}

function formatRollupEnabled(enabled: boolean): string {
  return enabled ? "enabled" : "disabled";
}

function formatCoverageLabel(coverage: {
  indexed: number | null;
  discovered: number | null;
}): string {
  return `${coverage.indexed ?? "?"}/${coverage.discovered ?? "?"}`;
}

function formatIndexCoverageLine(coverage: MemoryIndexCoverage): string {
  return [
    `memory=${formatCoverageLabel({ indexed: coverage.memoryFilesIndexed, discovered: coverage.memoryFilesDiscovered })}`,
    `sessions=${formatCoverageLabel({ indexed: coverage.sessionTranscriptsIndexed, discovered: coverage.sessionTranscriptsDiscovered })}`,
  ].join(", ");
}

function resolveMemoryIndexCoverage(params: {
  status: ReturnType<MemoryManager["status"]>;
  scan?: MemorySourceScan;
}): MemoryIndexCoverage {
  const sourceCounts = params.status.sourceCounts ?? [];
  const discover = (source: MemorySourceName) =>
    params.scan?.sources?.find((entry) => entry.source === source)?.totalFiles ?? null;
  const indexed = (source: MemorySourceName) =>
    sourceCounts.find((entry) => entry.source === source)?.files ?? null;
  return {
    memoryFilesDiscovered: discover("memory"),
    memoryFilesIndexed: indexed("memory"),
    sessionTranscriptsDiscovered: discover("sessions"),
    sessionTranscriptsIndexed: indexed("sessions"),
  };
}

function resolveAgent(cfg: OpenClawConfig, agent?: string) {
  const trimmed = agent?.trim();
  if (trimmed) {
    return trimmed;
  }
  return resolveDefaultAgentId(cfg);
}

function buildCliMemorySearchSessionKey(agentId: string): string {
  return buildAgentSessionKey({
    agentId,
    channel: "cli",
    peer: { kind: "direct", id: "memory-search" },
    dmScope: "per-channel-peer",
  });
}

function resolveAgentIds(cfg: OpenClawConfig, agent?: string): string[] {
  const trimmed = agent?.trim();
  if (trimmed) {
    return [trimmed];
  }
  const list = cfg.agents?.list ?? [];
  if (list.length > 0) {
    return list.map((entry) => entry.id).filter(Boolean);
  }
  return [resolveDefaultAgentId(cfg)];
}

function formatExtraPaths(workspaceDir: string, extraPaths: string[]): string[] {
  return normalizeExtraMemoryPaths(workspaceDir, extraPaths).map((entry) => shortenHomePath(entry));
}

function extractIsoDayFromPath(filePath: string): string | null {
  const match = path.basename(filePath).match(DAILY_MEMORY_FILE_NAME_RE);
  return match?.[1] ?? null;
}

function groundedMarkdownToDiaryLines(markdown: string): string[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.replace(/^##\s+/, "").trimEnd())
    .filter((line, index, lines) => !(line.length === 0 && lines[index - 1]?.length === 0));
}

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

function collectGroundedShortTermSeedItems(
  previews: Awaited<ReturnType<typeof previewGroundedRemMarkdown>>["files"],
): Array<{
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
  query: string;
  signalCount: number;
  dayBucket?: string;
}> {
  const items: Array<{
    path: string;
    startLine: number;
    endLine: number;
    snippet: string;
    score: number;
    query: string;
    signalCount: number;
    dayBucket?: string;
  }> = [];
  const seen = new Set<string>();

  for (const file of previews) {
    const dayBucket = extractIsoDayFromPath(file.path) ?? undefined;
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
      const key = `${parsedRef.path}:${parsedRef.startLine}:${parsedRef.endLine}:${signal.query}:${signal.text.toLowerCase()}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      items.push({
        path: parsedRef.path,
        startLine: parsedRef.startLine,
        endLine: parsedRef.endLine,
        snippet: signal.text,
        score: signal.score,
        query: signal.query,
        signalCount: signal.signalCount,
        ...(dayBucket ? { dayBucket } : {}),
      });
    }
  }

  return items;
}

function matchesPromotionSelector(
  candidate: {
    key: string;
    path: string;
    snippet: string;
  },
  selector: string,
): boolean {
  const trimmed = selector.trim().toLowerCase();
  if (!trimmed) {
    return false;
  }
  return (
    candidate.key.toLowerCase() === trimmed ||
    candidate.key.toLowerCase().includes(trimmed) ||
    candidate.path.toLowerCase().includes(trimmed) ||
    candidate.snippet.toLowerCase().includes(trimmed)
  );
}

async function withMemoryManagerForAgent(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: MemoryManagerPurpose;
  run: (manager: MemoryManager) => Promise<void>;
}): Promise<void> {
  const runtimeCfg = ensureRollupExtraPathEnabled(params.cfg);
  const managerParams: Parameters<typeof getMemorySearchManager>[0] = {
    cfg: runtimeCfg,
    agentId: params.agentId,
  };
  if (params.purpose) {
    managerParams.purpose = params.purpose;
  }
  await withManager<MemoryManager>({
    getManager: () => getMemorySearchManager(managerParams),
    onMissing: (error) => defaultRuntime.log(error ?? "Memory search disabled."),
    onCloseError: (err) =>
      defaultRuntime.error(`Memory manager close failed: ${formatErrorMessage(err)}`),
    close: async (manager) => {
      await manager.close?.();
    },
    run: params.run,
  });
}

function ensureRollupExtraPathEnabled(cfg: OpenClawConfig): OpenClawConfig {
  const pluginConfig = resolveMemoryPluginConfig(cfg);
  const rollupConfig = resolveMemoryRollupConfig(pluginConfig);
  if (!rollupConfig.enabled) {
    return cfg;
  }

  const rawOutputDir = rollupConfig.outputDir.trim();
  if (!rawOutputDir) {
    return cfg;
  }

  const existingPaths = asRecord(asRecord(cfg.agents?.defaults)?.memorySearch)?.extraPaths;
  const configuredPaths = normalizeStringArray(existingPaths);
  const normalized = configuredPaths.map((entry) => path.normalize(entry).replace(/\\/g, "/"));
  const targetPath = path.normalize(rawOutputDir).replace(/\\/g, "/");

  if (normalized.includes(targetPath)) {
    return cfg;
  }

  const next: OpenClawConfig = structuredClone(cfg);
  const previousDefaults = asRecord(next.agents?.defaults) ?? {};
  const previousSearch = asRecord(previousDefaults.memorySearch) ?? {};
  next.agents = {
    ...next.agents,
    defaults: {
      ...previousDefaults,
      memorySearch: {
        ...previousSearch,
        extraPaths: [...configuredPaths, rawOutputDir],
      },
    },
  };

  return next;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry): entry is string => entry.length > 0);
}

async function checkReadableFile(pathname: string): Promise<{ exists: boolean; issue?: string }> {
  try {
    await fs.access(pathname, fsSync.constants.R_OK);
    return { exists: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { exists: false };
    }
    return {
      exists: true,
      issue: `${shortenHomePath(pathname)} not readable (${code ?? "error"})`,
    };
  }
}

async function scanSessionFiles(agentId: string): Promise<SourceScan> {
  const issues: string[] = [];
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
  try {
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
    const totalFiles = entries.filter(
      (entry) => entry.isFile() && entry.name.endsWith(".jsonl"),
    ).length;
    return { source: "sessions", totalFiles, issues };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      issues.push(`sessions directory missing (${shortenHomePath(sessionsDir)})`);
      return { source: "sessions", totalFiles: 0, issues };
    }
    issues.push(
      `sessions directory not accessible (${shortenHomePath(sessionsDir)}): ${code ?? "error"}`,
    );
    return { source: "sessions", totalFiles: null, issues };
  }
}

async function safeRollupPlan(params: {
  workspaceDir: string;
  agentId: string;
  config: ReturnType<typeof resolveMemoryRollupConfig>;
}): Promise<MemoryRollupState> {
  try {
    const plan = await writeSessionRollups({
      workspaceDir: params.workspaceDir,
      agentId: params.agentId,
      config: params.config,
      dryRun: true,
    });
    return {
      config: params.config,
      plan,
    };
  } catch (error) {
    return {
      config: params.config,
      plan: {
        config: params.config,
        discovered: 0,
        generated: 0,
        pending: 0,
        stale: 0,
        orphaned: 0,
        actions: [],
        orphans: [],
        evidenceCoveragePercent: 100,
      },
      error: formatErrorMessage(error),
    };
  }
}

async function scanMemoryFiles(
  workspaceDir: string,
  extraPaths: string[] = [],
): Promise<SourceScan> {
  const issues: string[] = [];
  const memoryFile = path.join(workspaceDir, "MEMORY.md");
  const memoryDir = path.join(workspaceDir, "memory");

  const primary = await checkReadableFile(memoryFile);
  if (primary.issue) {
    issues.push(primary.issue);
  }

  const resolvedExtraPaths = normalizeExtraMemoryPaths(workspaceDir, extraPaths);
  for (const extraPath of resolvedExtraPaths) {
    try {
      const stat = await fs.lstat(extraPath);
      if (stat.isSymbolicLink()) {
        continue;
      }
      const extraCheck = await checkReadableFile(extraPath);
      if (extraCheck.issue) {
        issues.push(extraCheck.issue);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        issues.push(`additional memory path missing (${shortenHomePath(extraPath)})`);
      } else {
        issues.push(
          `additional memory path not accessible (${shortenHomePath(extraPath)}): ${code ?? "error"}`,
        );
      }
    }
  }

  let dirReadable: boolean | null = null;
  try {
    await fs.access(memoryDir, fsSync.constants.R_OK);
    dirReadable = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      issues.push(`memory directory missing (${shortenHomePath(memoryDir)})`);
      dirReadable = false;
    } else {
      issues.push(
        `memory directory not accessible (${shortenHomePath(memoryDir)}): ${code ?? "error"}`,
      );
      dirReadable = null;
    }
  }

  let listed: string[] = [];
  let listedOk = false;
  try {
    listed = await listMemoryFiles(workspaceDir, resolvedExtraPaths);
    listedOk = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (dirReadable !== null) {
      issues.push(
        `memory directory scan failed (${shortenHomePath(memoryDir)}): ${code ?? "error"}`,
      );
      dirReadable = null;
    }
  }

  let totalFiles: number | null = 0;
  if (dirReadable === null) {
    totalFiles = null;
  } else {
    const files = new Set<string>(listedOk ? listed : []);
    if (!listedOk) {
      if (primary.exists) {
        files.add(memoryFile);
      }
    }
    totalFiles = files.size;
  }

  if ((totalFiles ?? 0) === 0 && issues.length === 0) {
    issues.push(`no memory files found in ${shortenHomePath(workspaceDir)}`);
  }

  return { source: "memory", totalFiles, issues };
}

async function summarizeQmdIndexArtifact(manager: MemoryManager): Promise<string | null> {
  const status = manager.status?.();
  if (!status || status.backend !== "qmd") {
    return null;
  }
  const dbPath = status.dbPath?.trim();
  if (!dbPath) {
    return null;
  }
  let stat: fsSync.Stats;
  try {
    stat = await fs.stat(dbPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`QMD index file not found: ${shortenHomePath(dbPath)}`, { cause: err });
    }
    throw new Error(
      `QMD index file check failed: ${shortenHomePath(dbPath)} (${code ?? "error"})`,
      { cause: err },
    );
  }
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`QMD index file is empty: ${shortenHomePath(dbPath)}`);
  }
  return `QMD index: ${shortenHomePath(dbPath)} (${stat.size} bytes)`;
}

async function scanMemorySources(params: {
  workspaceDir: string;
  agentId: string;
  sources: MemorySourceNameWithRollups[];
  extraPaths?: string[];
}): Promise<MemorySourceScan> {
  const scans: SourceScan[] = [];
  const extraPaths = params.extraPaths ?? [];
  for (const source of params.sources) {
    if (source === "memory") {
      scans.push(await scanMemoryFiles(params.workspaceDir, extraPaths));
    }
    if (source === "sessions") {
      scans.push(await scanSessionFiles(params.agentId));
    }
    if (source === "session-rollups") {
      // Session rollup coverage is surfaced from rollup plan metrics rather than file-level scans.
      continue;
    }
  }
  const issues = scans.flatMap((scan) => scan.issues);
  const totals = scans.map((scan) => scan.totalFiles);
  const numericTotals = totals.filter((total): total is number => total !== null);
  const totalFiles = totals.some((total) => total === null)
    ? null
    : numericTotals.reduce((sum, total) => sum + total, 0);
  return { sources: scans, totalFiles, issues };
}

export async function runMemoryStatus(opts: MemoryCommandOptions) {
  setVerbose(Boolean(opts.verbose));
  const { config: cfg, diagnostics } = await loadMemoryCommandConfig("memory status");
  emitMemorySecretResolveDiagnostics(diagnostics, { json: Boolean(opts.json) });
  const agentIds = resolveAgentIds(cfg, opts.agent);
  const allResults: Array<{
    agentId: string;
    status: ReturnType<MemoryManager["status"]>;
    embeddingProbe?: MemoryEmbeddingProbeResult;
    indexError?: string;
    scan?: MemorySourceScan;
    indexCoverage?: MemoryIndexCoverage;
    rollup?: MemoryRollupState;
    audit?: ShortTermAuditSummary;
    repair?: RepairShortTermPromotionArtifactsResult;
    dreamingAudit?: DreamingArtifactsAuditSummary;
    dreamingRepair?: RepairDreamingArtifactsResult;
  }> = [];

  for (const agentId of agentIds) {
    const managerPurpose = opts.index ? "cli" : "status";
    await withMemoryManagerForAgent({
      cfg,
      agentId,
      purpose: managerPurpose,
      run: async (manager) => {
        const deep = Boolean(opts.deep || opts.index);
        let embeddingProbe: MemoryEmbeddingProbeResult | undefined;
        let indexError: string | undefined;
        const syncFn = manager.sync ? manager.sync.bind(manager) : undefined;
        if (deep) {
          const initialStatus = manager.status();
          const hasVectorStoreProbe =
            initialStatus.backend === "builtin" &&
            typeof manager.probeVectorStoreAvailability === "function";
          await withProgress(
            { label: "Checking memory…", total: hasVectorStoreProbe ? 3 : 2 },
            async (progress) => {
              progress.setLabel(hasVectorStoreProbe ? "Probing vector store…" : "Probing vectors…");
              if (hasVectorStoreProbe) {
                await manager.probeVectorStoreAvailability?.();
              } else {
                await manager.probeVectorAvailability();
              }
              progress.tick();
              progress.setLabel("Probing embeddings…");
              embeddingProbe = await manager.probeEmbeddingAvailability();
              progress.tick();
              if (hasVectorStoreProbe) {
                progress.setLabel("Checking semantic vectors…");
                await manager.probeVectorAvailability();
                progress.tick();
              }
            },
          );
          if (opts.index && syncFn) {
            await withProgressTotals(
              {
                label: "Indexing memory…",
                total: 0,
                fallback: opts.verbose ? "line" : undefined,
              },
              async (update, progress) => {
                try {
                  await syncFn({
                    reason: "cli",
                    force: Boolean(opts.force),
                    progress: (syncUpdate) => {
                      update({
                        completed: syncUpdate.completed,
                        total: syncUpdate.total,
                        label: syncUpdate.label,
                      });
                      if (syncUpdate.label) {
                        progress.setLabel(syncUpdate.label);
                      }
                    },
                  });
                } catch (err) {
                  indexError = formatErrorMessage(err);
                  defaultRuntime.error(`Memory index failed: ${indexError}`);
                  process.exitCode = 1;
                }
              },
            );
          } else if (opts.index && !syncFn) {
            defaultRuntime.log("Memory backend does not support manual reindex.");
          }
        }
        const status = manager.status();
        const configuredSources = (status.sources ?? []).filter(isMemorySourceName);
        const sources = new Set<MemorySourceNameWithRollups>([
          "memory",
          "sessions",
          "session-rollups",
          ...configuredSources,
        ]);
        const workspaceDir = status.workspaceDir;
        const scan = workspaceDir
          ? await scanMemorySources({
              workspaceDir,
              agentId,
              sources: [...sources],
              extraPaths: status.extraPaths,
            })
          : undefined;
        const rollupConfig = resolveMemoryRollupConfig(resolveMemoryPluginConfig(cfg));
        const rollup = workspaceDir
          ? await safeRollupPlan({
              workspaceDir,
              agentId,
              config: rollupConfig,
            })
          : {
              config: rollupConfig,
              plan: {
                config: rollupConfig,
                discovered: 0,
                generated: 0,
                pending: 0,
                stale: 0,
                orphaned: 0,
                actions: [],
                orphans: [],
                evidenceCoveragePercent: 100,
              },
            };
        let audit: ShortTermAuditSummary | undefined;
        let repair: RepairShortTermPromotionArtifactsResult | undefined;
        let dreamingAudit: DreamingArtifactsAuditSummary | undefined;
        let dreamingRepair: RepairDreamingArtifactsResult | undefined;
        if (workspaceDir) {
          dreamingAudit = await auditDreamingArtifacts({ workspaceDir });
          if (opts.fix && dreamingAudit.issues.some((issue) => issue.fixable)) {
            dreamingRepair = await repairDreamingArtifacts({ workspaceDir });
            dreamingAudit = await auditDreamingArtifacts({ workspaceDir });
          }
          if (opts.fix) {
            repair = await repairShortTermPromotionArtifacts({ workspaceDir });
          }
          const customQmd = asRecord(asRecord(status.custom)?.qmd);
          audit = await auditShortTermPromotionArtifacts({
            workspaceDir,
            qmd:
              status.backend === "qmd"
                ? {
                    dbPath: status.dbPath,
                    collections:
                      typeof customQmd?.collections === "number"
                        ? customQmd.collections
                        : undefined,
                  }
                : undefined,
          });
        }
        allResults.push({
          agentId,
          status,
          embeddingProbe,
          indexError,
          scan,
          indexCoverage: resolveMemoryIndexCoverage({
            status,
            scan,
          }),
          rollup,
          audit,
          repair,
          dreamingAudit,
          dreamingRepair,
        });
      },
    });
  }

  if (opts.json) {
    defaultRuntime.writeJson(allResults);
    return;
  }

  const rich = isRich();
  const heading = (text: string) => colorize(rich, theme.heading, text);
  const muted = (text: string) => colorize(rich, theme.muted, text);
  const info = (text: string) => colorize(rich, theme.info, text);
  const success = (text: string) => colorize(rich, theme.success, text);
  const warn = (text: string) => colorize(rich, theme.warn, text);
  const accent = (text: string) => colorize(rich, theme.accent, text);
  const label = (text: string) => muted(`${text}:`);

  for (const result of allResults) {
    const {
      agentId,
      status,
      embeddingProbe,
      indexError,
      scan,
      indexCoverage,
      audit,
      repair,
      dreamingAudit,
      dreamingRepair,
      rollup,
    } = result;
    const filesIndexed = status.files ?? 0;
    const chunksIndexed = status.chunks ?? 0;
    const totalFiles = scan?.totalFiles ?? null;
    const workspaceDir = status.workspaceDir;
    const effectiveIndexCoverage = indexCoverage ?? resolveMemoryIndexCoverage({ status, scan });
    const indexedLabel =
      totalFiles === null
        ? `${filesIndexed}/? files · ${chunksIndexed} chunks`
        : `${filesIndexed}/${totalFiles} files · ${chunksIndexed} chunks`;
    if (opts.index) {
      const line = indexError ? `Memory index failed: ${indexError}` : "Memory index complete.";
      defaultRuntime.log(line);
    }
    const requestedProvider = status.requestedProvider ?? status.provider;
    const modelLabel = status.model ?? status.provider;
    const storePath = status.dbPath ? shortenHomePath(status.dbPath) : "<unknown>";
    const workspacePath = status.workspaceDir ? shortenHomePath(status.workspaceDir) : "<unknown>";
    const sourceList = status.sources?.length ? status.sources.join(", ") : null;
    const extraPaths = status.workspaceDir
      ? formatExtraPaths(status.workspaceDir, status.extraPaths ?? [])
      : [];
    const lines = [
      `${heading("Memory Search")} ${muted(`(${agentId})`)}`,
      `${label("Provider")} ${info(status.provider)} ${muted(`(requested: ${requestedProvider})`)}`,
      `${label("Model")} ${info(modelLabel)}`,
      sourceList ? `${label("Sources")} ${info(sourceList)}` : null,
      extraPaths.length ? `${label("Extra paths")} ${info(extraPaths.join(", "))}` : null,
      `${label("Indexed")} ${success(indexedLabel)}`,
      `${label("Dirty")} ${status.dirty ? warn("yes") : muted("no")}`,
      `${label("Store")} ${info(storePath)}`,
      `${label("Workspace")} ${info(workspacePath)}`,
      `${label("Index coverage")} ${
        workspaceDir
          ? success(formatIndexCoverageLine(effectiveIndexCoverage))
          : muted("no workspace")
      }`,
      `${label("Dreaming")} ${info(formatDreamingSummary(cfg))}`,
      `${label("Session rollups")} ${info(formatRollupEnabled(Boolean(rollup?.config.enabled)))}`,
      `${label("Rollup coverage")} ${
        !workspaceDir
          ? muted("no workspace")
          : rollup?.error
            ? muted(rollup.error)
            : success(formatRollupStatusLine(rollup.plan))
      }`,
    ].filter(Boolean) as string[];
    if (rollup?.error) {
      lines.push(`${label("Rollup status")} ${warn(`status generation failed: ${rollup.error}`)}`);
    }
    if (workspaceDir) {
      const uncoveredMemory =
        effectiveIndexCoverage.memoryFilesDiscovered !== null &&
        effectiveIndexCoverage.memoryFilesIndexed !== null &&
        effectiveIndexCoverage.memoryFilesIndexed < effectiveIndexCoverage.memoryFilesDiscovered;
      const uncoveredSessions =
        effectiveIndexCoverage.sessionTranscriptsDiscovered !== null &&
        effectiveIndexCoverage.sessionTranscriptsIndexed !== null &&
        effectiveIndexCoverage.sessionTranscriptsIndexed <
          effectiveIndexCoverage.sessionTranscriptsDiscovered;
      if (uncoveredMemory || uncoveredSessions) {
        lines.push(
          `${label("Coverage health")} ${warn("index coverage below discovered file count")}`,
        );
      }
      if (uncoveredMemory) {
        lines.push(`${muted("Fix:")} ${muted(`openclaw memory index --agent ${agentId} --force`)}`);
      }
      if (uncoveredSessions) {
        lines.push(
          `${muted("Fix sessions:")} ${muted(
            `openclaw memory status --deep --agent ${agentId} (verify session source config)`,
          )}`,
        );
      }
    }
    if (embeddingProbe) {
      const state = embeddingProbe.ok ? "ready" : "unavailable";
      const stateColor = embeddingProbe.ok ? theme.success : theme.warn;
      lines.push(`${label("Embeddings")} ${colorize(rich, stateColor, state)}`);
      if (embeddingProbe.error) {
        lines.push(`${label("Embeddings error")} ${warn(embeddingProbe.error)}`);
      }
    }
    if (status.sourceCounts?.length) {
      lines.push(label("By source"));
      for (const entry of status.sourceCounts) {
        const total = scan?.sources?.find(
          (scanEntry) => scanEntry.source === entry.source,
        )?.totalFiles;
        const counts =
          total === null
            ? `${entry.files}/? files · ${entry.chunks} chunks`
            : `${entry.files}/${total} files · ${entry.chunks} chunks`;
        lines.push(`  ${accent(entry.source)} ${muted("·")} ${muted(counts)}`);
      }
    }
    if (rollup?.plan) {
      if (!rollup.error && rollup.config.enabled && rollup.plan.discovered > 0) {
        const staleRatio = rollup.plan.stale / rollup.plan.discovered;
        const pendingRatio = rollup.plan.pending / rollup.plan.discovered;
        const staleOrPendingRatio =
          (rollup.plan.stale + rollup.plan.pending) / rollup.plan.discovered;
        if (
          staleRatio >= sessionRollupsDefaults.sourceStaleWarningRatio ||
          pendingRatio >= sessionRollupsDefaults.sourceStaleWarningRatio ||
          staleOrPendingRatio >= sessionRollupsDefaults.sourceStaleWarningRatio
        ) {
          lines.push(
            `${label("Rollup health")} ${warn(
              `stale=${(staleRatio * 100).toFixed(1)}%, pending=${(pendingRatio * 100).toFixed(1)}%, stale+pending=${(staleOrPendingRatio * 100).toFixed(1)}% > ${(sessionRollupsDefaults.sourceStaleWarningRatio * 100).toFixed(0)}%`,
            )}`,
          );
          lines.push(
            `${muted("Fix:")} ${muted(`openclaw memory rollup --stale --agent ${agentId}`)}`,
          );
          lines.push(
            `${muted("Apply:")} ${muted(`openclaw memory rollup --apply --agent ${agentId}`)}`,
          );
        }
      }
      if (!rollup.config.enabled) {
        lines.push(
          `${label("Rollup health")} ${muted("not running — enable plugins.entries.memory-core.config.memoryRollups.enabled")}`,
        );
      }
    }
    if (status.fallback) {
      lines.push(`${label("Fallback")} ${warn(status.fallback.from)}`);
    }
    if (status.vector) {
      const formatVectorState = (available: boolean | undefined) =>
        status.vector?.enabled
          ? available === undefined
            ? "unknown"
            : available
              ? "ready"
              : "unavailable"
          : "disabled";
      const formatVectorLine = (lineLabel: string, state: string) => {
        const vectorColor =
          state === "ready" ? theme.success : state === "unavailable" ? theme.warn : theme.muted;
        lines.push(`${label(lineLabel)} ${colorize(rich, vectorColor, state)}`);
      };
      if (status.backend === "builtin") {
        const storeState = formatVectorState(status.vector.storeAvailable);
        formatVectorLine("Vector store", storeState);
        if (status.vector.semanticAvailable !== undefined) {
          formatVectorLine("Semantic vectors", formatVectorState(status.vector.semanticAvailable));
        }
      } else {
        const vectorState = formatVectorState(
          status.vector.semanticAvailable ?? status.vector.available,
        );
        formatVectorLine("Vector", vectorState);
      }
      if (status.vector.dims) {
        lines.push(`${label("Vector dims")} ${info(String(status.vector.dims))}`);
      }
      if (status.vector.extensionPath) {
        lines.push(`${label("Vector path")} ${info(shortenHomePath(status.vector.extensionPath))}`);
      }
      if (status.vector.loadError) {
        lines.push(`${label("Vector error")} ${warn(status.vector.loadError)}`);
      }
    }
    if (status.fts) {
      const ftsState = status.fts.enabled
        ? status.fts.available
          ? "ready"
          : "unavailable"
        : "disabled";
      const ftsColor =
        ftsState === "ready"
          ? theme.success
          : ftsState === "unavailable"
            ? theme.warn
            : theme.muted;
      lines.push(`${label("FTS")} ${colorize(rich, ftsColor, ftsState)}`);
      if (status.fts.error) {
        lines.push(`${label("FTS error")} ${warn(status.fts.error)}`);
      }
    }
    if (status.cache) {
      const cacheState = status.cache.enabled ? "enabled" : "disabled";
      const cacheColor = status.cache.enabled ? theme.success : theme.muted;
      const suffix =
        status.cache.enabled && typeof status.cache.entries === "number"
          ? ` (${status.cache.entries} entries)`
          : "";
      lines.push(`${label("Embedding cache")} ${colorize(rich, cacheColor, cacheState)}${suffix}`);
      if (status.cache.enabled && typeof status.cache.maxEntries === "number") {
        lines.push(`${label("Cache cap")} ${info(String(status.cache.maxEntries))}`);
      }
    }
    if (status.batch) {
      const batchState = status.batch.enabled ? "enabled" : "disabled";
      const batchColor = status.batch.enabled ? theme.success : theme.warn;
      const batchSuffix = ` (failures ${status.batch.failures}/${status.batch.limit})`;
      lines.push(
        `${label("Batch")} ${colorize(rich, batchColor, batchState)}${muted(batchSuffix)}`,
      );
      if (status.batch.lastError) {
        lines.push(`${label("Batch error")} ${warn(status.batch.lastError)}`);
      }
    }
    if (audit) {
      lines.push(`${label("Recall store")} ${info(formatAuditCounts(audit))}`);
      lines.push(`${label("Recall path")} ${info(shortenHomePath(audit.storePath))}`);
      if (audit.updatedAt) {
        lines.push(`${label("Recall updated")} ${info(audit.updatedAt)}`);
      }
      if (status.backend === "qmd" && audit.qmd) {
        const qmdBits = [
          audit.qmd.dbPath ? shortenHomePath(audit.qmd.dbPath) : "<unknown>",
          typeof audit.qmd.dbBytes === "number" ? `${audit.qmd.dbBytes} bytes` : null,
          typeof audit.qmd.collections === "number" ? `${audit.qmd.collections} collections` : null,
        ].filter(Boolean);
        lines.push(`${label("QMD audit")} ${info(qmdBits.join(" · "))}`);
      }
    }
    if (dreamingAudit) {
      lines.push(
        `${label("Dreaming artifacts")} ${info(formatDreamingAuditSummary(dreamingAudit))}`,
      );
      lines.push(
        `${label("Dream corpus")} ${info(shortenHomePath(dreamingAudit.sessionCorpusDir))}`,
      );
      lines.push(
        `${label("Dream ingestion")} ${info(shortenHomePath(dreamingAudit.sessionIngestionPath))}`,
      );
      if (dreamingAudit.dreamsPath) {
        lines.push(`${label("Dream diary")} ${info(shortenHomePath(dreamingAudit.dreamsPath))}`);
      }
    }
    if (repair) {
      lines.push(`${label("Repair")} ${info(formatRepairSummary(repair))}`);
    }
    if (dreamingRepair) {
      lines.push(`${label("Dream repair")} ${info(formatDreamingRepairSummary(dreamingRepair))}`);
      if (dreamingRepair.archiveDir) {
        lines.push(`${label("Dream archive")} ${info(shortenHomePath(dreamingRepair.archiveDir))}`);
      }
    }
    if (status.fallback?.reason) {
      lines.push(muted(status.fallback.reason));
    }
    if (indexError) {
      lines.push(`${label("Index error")} ${warn(indexError)}`);
    }
    if (scan?.issues.length) {
      lines.push(label("Issues"));
      for (const issue of scan.issues) {
        lines.push(`  ${warn(issue)}`);
      }
    }
    if (audit?.issues.length) {
      if (!scan?.issues.length) {
        lines.push(label("Issues"));
      }
      for (const issue of audit.issues) {
        lines.push(`  ${issue.severity === "error" ? warn(issue.message) : muted(issue.message)}`);
      }
      if (!opts.fix) {
        lines.push(`  ${muted(`Fix: openclaw memory status --fix --agent ${agentId}`)}`);
      }
    }
    if (dreamingAudit?.issues.length) {
      if (!scan?.issues.length && !audit?.issues.length) {
        lines.push(label("Issues"));
      }
      for (const issue of dreamingAudit.issues) {
        lines.push(`  ${issue.severity === "error" ? warn(issue.message) : muted(issue.message)}`);
      }
      if (!opts.fix) {
        lines.push(`  ${muted(`Fix: openclaw memory status --fix --agent ${agentId}`)}`);
      }
    }
    defaultRuntime.log(lines.join("\n"));
    defaultRuntime.log("");
  }
}

function formatRollupAction(action: SessionRollupAction, rich: boolean): string {
  const statusColor = action.status === "upToDate" ? theme.success : theme.warn;
  const status = colorize(rich, statusColor, action.status);
  const source = colorize(rich, theme.accent, action.sourceTranscript);
  const hash = colorize(rich, theme.muted, action.inputHash.slice(0, 8));
  return `${status} ${source} ${hash} (${shortenHomePath(action.outputPath)})`;
}

function formatRollupOrphan(
  pathValue: string,
  sourceTranscript: string | undefined,
  rich: boolean,
): string {
  const source = sourceTranscript
    ? shortenHomePath(sourceTranscript)
    : "<unknown source transcript>";
  return `${colorize(rich, theme.warn, "orphan")} ${colorize(rich, theme.accent, source)} ${shortenHomePath(pathValue)}`;
}

export async function runMemoryRollup(opts: MemoryRollupOptions) {
  setVerbose(Boolean(opts.verbose));
  const { config: cfg, diagnostics } = await loadMemoryCommandConfig("memory rollup");
  emitMemorySecretResolveDiagnostics(diagnostics, { json: Boolean(opts.json) });
  const agentIds = resolveAgentIds(cfg, opts.agent);
  const allResults: Array<{
    agentId: string;
    workspaceDir: string | null;
    config: ReturnType<typeof resolveMemoryRollupConfig>;
    plan: SessionRollupGenerationResult;
    indexError?: string;
  }> = [];

  for (const agentId of agentIds) {
    await withMemoryManagerForAgent({
      cfg,
      agentId,
      purpose: "cli",
      run: async (manager) => {
        const status = manager.status();
        const workspaceDir = status.workspaceDir?.trim() ?? null;
        const config = resolveMemoryRollupConfig(resolveMemoryPluginConfig(cfg));

        if (!workspaceDir) {
          allResults.push({
            agentId,
            workspaceDir: null,
            config,
            plan: {
              config,
              discovered: 0,
              generated: 0,
              pending: 0,
              stale: 0,
              orphaned: 0,
              actions: [],
              orphans: [],
              evidenceCoveragePercent: 100,
              wrote: 0,
              unchanged: 0,
              skipped: config.enabled ? 0 : 0,
            },
          });
          return;
        }

        const shouldApply = Boolean(opts.apply) && !Boolean(opts.stale);
        const runDry = !shouldApply || Boolean(opts.dryRun);
        const syncFn = manager.sync ? manager.sync.bind(manager) : undefined;

        const plan = await writeSessionRollups({
          workspaceDir,
          agentId,
          config,
          dryRun: runDry,
          apply: shouldApply,
        });
        let indexError: string | undefined;
        if (shouldApply && plan.wrote > 0) {
          if (!syncFn) {
            indexError = "memory backend does not support manual reindex";
          } else {
            try {
              await syncFn({
                reason: "rollup-apply",
                force: true,
              });
            } catch (err) {
              indexError = formatErrorMessage(err);
              defaultRuntime.error(`Memory rollup index failed (${agentId}): ${indexError}`);
              process.exitCode = 1;
            }
          }
        }

        allResults.push({
          agentId,
          workspaceDir,
          config,
          plan,
          indexError,
        });
      },
    });
  }

  if (opts.json) {
    defaultRuntime.writeJson(
      allResults.map((result) => {
        const staleActions = result.plan.actions.filter((action) => action.status !== "upToDate");
        const resultActions = Boolean(opts.stale) ? staleActions : result.plan.actions;
        const staleOrphans = result.plan.orphans;
        return {
          agentId: result.agentId,
          workspaceDir: result.workspaceDir,
          config: {
            ...result.config,
            enabled: result.config.enabled,
          },
          discovered: result.plan.discovered,
          generated: result.plan.generated,
          pending: result.plan.pending,
          stale: result.plan.stale,
          orphaned: result.plan.orphaned,
          evidenceCoveragePercent: result.plan.evidenceCoveragePercent,
          wrote: result.plan.wrote,
          unchanged: result.plan.unchanged,
          skipped: result.plan.skipped,
          actions: resultActions,
          orphans: staleOrphans,
          indexError: result.indexError,
        };
      }),
    );
    return;
  }

  const rich = isRich();
  const heading = (text: string) => colorize(rich, theme.heading, text);
  const muted = (text: string) => colorize(rich, theme.muted, text);
  const label = (text: string) => muted(`${text}:`);
  const success = (text: string) => colorize(rich, theme.success, text);
  const warn = (text: string) => colorize(rich, theme.warn, text);

  for (const result of allResults) {
    const { agentId, workspaceDir, config, plan } = result;
    const lines: string[] = [];
    lines.push(`${heading("Session Rollup")} ${muted(`(${agentId})`)}`);
    if (!workspaceDir) {
      lines.push(`${label("Workspace")} ${muted("missing")}`);
      defaultRuntime.log(lines.join("\n"));
      defaultRuntime.log("");
      continue;
    }

    lines.push(`${label("Workspace")} ${muted(shortenHomePath(workspaceDir))}`);
    lines.push(`${label("Enabled")} ${muted(config.enabled ? "yes" : "no")}`);
    lines.push(
      `${label("Output")} ${muted(`${config.outputDir} (maxMessages=${config.maxMessages}, maxSummaryChars=${config.maxSummaryChars})`)}`,
    );
    lines.push(`${label("Plan")} ${muted(formatRollupStatusLine(plan))}`);
    lines.push(
      `${label("Applied")}: wrote=${plan.wrote} unchanged=${plan.unchanged} skipped=${plan.skipped}`,
    );

    if (opts.stale) {
      const staleActions = plan.actions.filter((action) => action.status !== "upToDate");
      if (staleActions.length === 0 && plan.orphans.length === 0) {
        lines.push(`${label("Rollups")} ${muted("No stale or orphaned rollups detected.")}`);
      } else {
        if (staleActions.length > 0) {
          lines.push(label("Stale / missing"));
          for (const action of staleActions) {
            lines.push(`  ${formatRollupAction(action, rich)}`);
          }
        }
        if (plan.orphans.length > 0) {
          lines.push(label("Orphans"));
          for (const orphan of plan.orphans) {
            lines.push(`  ${formatRollupOrphan(orphan.outputPath, orphan.sourceTranscript, rich)}`);
          }
        }
      }
      lines.push(
        `${label("Repair")} ${muted(`openclaw memory rollup --apply --agent ${agentId}`)} ${muted("to regenerate")}`,
      );
    } else if (!config.enabled) {
      lines.push(
        `${label("Hint")} ${muted("Enable with plugins.entries.memory-core.config.memoryRollups.enabled")}`,
      );
    } else {
      if (plan.wrote === 0 && plan.pending > 0) {
        lines.push(
          `${label("Hint")} ${muted("Run with --apply to write rollups")} ${muted(`(dry-run shows ${plan.pending} pending)`)}`,
        );
      }
      if (plan.generated > 0) {
        lines.push(
          `${label("Next")} ${muted(`Recent rollup file: ${shortenHomePath(plan.actions[0]?.outputPath ?? "")}`)}`,
        );
      }
      if (plan.wrote > 0) {
        lines.push(
          `${label("Rollup index")} ${result.indexError ? warn("index failed") : success("updated")}`,
        );
      }
    }

    defaultRuntime.log(lines.join("\n"));
    defaultRuntime.log("");
  }
}

export async function runMemoryIndex(opts: MemoryCommandOptions) {
  setVerbose(Boolean(opts.verbose));
  const { config: cfg, diagnostics } = await loadMemoryCommandConfig("memory index");
  emitMemorySecretResolveDiagnostics(diagnostics);
  const agentIds = resolveAgentIds(cfg, opts.agent);
  for (const agentId of agentIds) {
    await withMemoryManagerForAgent({
      cfg,
      agentId,
      purpose: "cli",
      run: async (manager) => {
        try {
          const syncFn = manager.sync ? manager.sync.bind(manager) : undefined;
          if (opts.verbose) {
            const status = manager.status();
            const rich = isRich();
            const heading = (text: string) => colorize(rich, theme.heading, text);
            const muted = (text: string) => colorize(rich, theme.muted, text);
            const info = (text: string) => colorize(rich, theme.info, text);
            const warn = (text: string) => colorize(rich, theme.warn, text);
            const label = (text: string) => muted(`${text}:`);
            const sourceLabels = (status.sources ?? []).map((source) =>
              formatSourceLabel(source, status.workspaceDir ?? "", agentId),
            );
            const extraPaths = status.workspaceDir
              ? formatExtraPaths(status.workspaceDir, status.extraPaths ?? [])
              : [];
            const requestedProvider = status.requestedProvider ?? status.provider;
            const modelLabel = status.model ?? status.provider;
            const lines = [
              `${heading("Memory Index")} ${muted(`(${agentId})`)}`,
              `${label("Provider")} ${info(status.provider)} ${muted(
                `(requested: ${requestedProvider})`,
              )}`,
              `${label("Model")} ${info(modelLabel)}`,
              sourceLabels.length ? `${label("Sources")} ${info(sourceLabels.join(", "))}` : null,
              extraPaths.length ? `${label("Extra paths")} ${info(extraPaths.join(", "))}` : null,
            ].filter(Boolean) as string[];
            if (status.fallback) {
              lines.push(`${label("Fallback")} ${warn(status.fallback.from)}`);
            }
            defaultRuntime.log(lines.join("\n"));
            defaultRuntime.log("");
          }
          const startedAt = Date.now();
          let lastLabel = "Indexing memory…";
          let lastCompleted = 0;
          let lastTotal = 0;
          const formatElapsed = () => {
            const elapsedMs = Math.max(0, Date.now() - startedAt);
            const seconds = Math.floor(elapsedMs / 1000);
            const minutes = Math.floor(seconds / 60);
            const remainingSeconds = seconds % 60;
            return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
          };
          const formatEta = () => {
            if (lastTotal <= 0 || lastCompleted <= 0) {
              return null;
            }
            const elapsedMs = Math.max(1, Date.now() - startedAt);
            const rate = lastCompleted / elapsedMs;
            if (!Number.isFinite(rate) || rate <= 0) {
              return null;
            }
            const remainingMs = Math.max(0, (lastTotal - lastCompleted) / rate);
            const seconds = Math.floor(remainingMs / 1000);
            const minutes = Math.floor(seconds / 60);
            const remainingSeconds = seconds % 60;
            return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
          };
          const buildLabel = () => {
            const elapsed = formatElapsed();
            const eta = formatEta();
            return eta
              ? `${lastLabel} · elapsed ${elapsed} · eta ${eta}`
              : `${lastLabel} · elapsed ${elapsed}`;
          };
          if (!syncFn) {
            defaultRuntime.log("Memory backend does not support manual reindex.");
            return;
          }
          await withProgressTotals(
            {
              label: "Indexing memory…",
              total: 0,
              fallback: opts.verbose ? "line" : undefined,
            },
            async (update, progress) => {
              const interval = setInterval(() => {
                progress.setLabel(buildLabel());
              }, 1000);
              try {
                await syncFn({
                  reason: "cli",
                  force: Boolean(opts.force),
                  progress: (syncUpdate) => {
                    if (syncUpdate.label) {
                      lastLabel = syncUpdate.label;
                    }
                    lastCompleted = syncUpdate.completed;
                    lastTotal = syncUpdate.total;
                    update({
                      completed: syncUpdate.completed,
                      total: syncUpdate.total,
                      label: buildLabel(),
                    });
                    progress.setLabel(buildLabel());
                  },
                });
              } finally {
                clearInterval(interval);
              }
            },
          );
          const qmdIndexSummary = await summarizeQmdIndexArtifact(manager);
          if (qmdIndexSummary) {
            defaultRuntime.log(qmdIndexSummary);
          }
          const postIndexStatus = manager.status();
          const vectorEnabled = postIndexStatus.vector?.enabled ?? false;
          const vectorAvailable =
            postIndexStatus.vector?.storeAvailable ?? postIndexStatus.vector?.available;
          const vectorLoadErr = postIndexStatus.vector?.loadError;
          if (vectorEnabled && vectorAvailable === false) {
            const errDetail = vectorLoadErr ? `: ${vectorLoadErr}` : "";
            // Indexing still persisted chunks/FTS state; keep the command successful but
            // emit a stderr warning so operators and scripts can detect degraded recall.
            defaultRuntime.error(
              `Memory index WARNING (${agentId}): chunks_vec not updated — sqlite-vec unavailable${errDetail}. Vector recall degraded.`,
            );
          } else {
            defaultRuntime.log(`Memory index updated (${agentId}).`);
          }
        } catch (err) {
          const message = formatErrorMessage(err);
          defaultRuntime.error(`Memory index failed (${agentId}): ${message}`);
          process.exitCode = 1;
        }
      },
    });
  }
}

export async function runMemorySearch(
  queryArg: string | undefined,
  opts: MemorySearchCommandOptions,
) {
  const query = opts.query ?? queryArg;
  if (!query) {
    defaultRuntime.error("Missing search query. Provide a positional query or use --query <text>.");
    process.exitCode = 1;
    return;
  }
  const { config: cfg, diagnostics } = await loadMemoryCommandConfig("memory search");
  emitMemorySecretResolveDiagnostics(diagnostics, { json: Boolean(opts.json) });
  const agentId = resolveAgent(cfg, opts.agent);
  const dreaming = resolveShortTermPromotionDreamingConfig({
    pluginConfig: resolveMemoryPluginConfig(cfg),
    cfg,
  });
  await withMemoryManagerForAgent({
    cfg,
    agentId,
    purpose: "cli",
    run: async (manager) => {
      const sessionKey = buildCliMemorySearchSessionKey(agentId);
      let results: Awaited<ReturnType<typeof manager.search>>;
      try {
        results = await manager.search(query, {
          maxResults: opts.maxResults,
          minScore: opts.minScore,
          sessionKey,
        });
      } catch (err) {
        const message = formatErrorMessage(err);
        defaultRuntime.error(`Memory search failed: ${message}`);
        process.exitCode = 1;
        return;
      }
      const workspaceDir =
        typeof (manager as { status?: () => { workspaceDir?: string } }).status === "function"
          ? manager.status().workspaceDir
          : undefined;
      void recordShortTermRecalls({
        workspaceDir,
        query,
        results,
        timezone: dreaming.timezone,
      }).catch(() => {
        // Recall tracking is best-effort and must not block normal search results.
      });
      if (opts.json) {
        defaultRuntime.writeJson({ results });
        return;
      }
      if (results.length === 0) {
        defaultRuntime.log("No matches.");
        return;
      }
      const rich = isRich();
      const lines: string[] = [];
      for (const result of results) {
        lines.push(
          `${colorize(rich, theme.success, result.score.toFixed(3))} ${colorize(
            rich,
            theme.accent,
            `${shortenHomePath(result.path)}:${result.startLine}-${result.endLine}`,
          )}`,
        );
        lines.push(colorize(rich, theme.muted, result.snippet));
        lines.push("");
      }
      defaultRuntime.log(lines.join("\n").trim());
    },
  });
}

export async function runMemoryPromote(opts: MemoryPromoteCommandOptions) {
  const { config: cfg, diagnostics } = await loadMemoryCommandConfig("memory promote");
  emitMemorySecretResolveDiagnostics(diagnostics, { json: Boolean(opts.json) });
  const agentId = resolveAgent(cfg, opts.agent);

  await withMemoryManagerForAgent({
    cfg,
    agentId,
    purpose: "status",
    run: async (manager) => {
      const status = manager.status();
      const workspaceDir = status.workspaceDir?.trim();
      const dreaming = resolveShortTermPromotionDreamingConfig({
        pluginConfig: resolveMemoryPluginConfig(cfg),
        cfg,
      });
      if (!workspaceDir) {
        defaultRuntime.error("Memory promote requires a resolvable workspace directory.");
        process.exitCode = 1;
        return;
      }

      let candidates: Awaited<ReturnType<typeof rankShortTermPromotionCandidates>>;
      try {
        candidates = await rankShortTermPromotionCandidates({
          workspaceDir,
          limit: opts.limit,
          minScore: opts.minScore ?? dreaming.minScore,
          minRecallCount: opts.minRecallCount ?? dreaming.minRecallCount,
          minUniqueQueries: opts.minUniqueQueries ?? dreaming.minUniqueQueries,
          recencyHalfLifeDays: dreaming.recencyHalfLifeDays,
          maxAgeDays: dreaming.maxAgeDays,
          includePromoted: Boolean(opts.includePromoted),
        });
      } catch (err) {
        defaultRuntime.error(`Memory promote ranking failed: ${formatErrorMessage(err)}`);
        process.exitCode = 1;
        return;
      }

      let applyResult: Awaited<ReturnType<typeof applyShortTermPromotions>> | undefined;
      if (opts.apply) {
        try {
          applyResult = await applyShortTermPromotions({
            workspaceDir,
            candidates,
            limit: opts.limit,
            minScore: opts.minScore ?? dreaming.minScore,
            minRecallCount: opts.minRecallCount ?? dreaming.minRecallCount,
            minUniqueQueries: opts.minUniqueQueries ?? dreaming.minUniqueQueries,
            maxAgeDays: dreaming.maxAgeDays,
            timezone: dreaming.timezone,
          });
        } catch (err) {
          defaultRuntime.error(`Memory promote apply failed: ${formatErrorMessage(err)}`);
          process.exitCode = 1;
          return;
        }
      }

      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      const lockPath = resolveShortTermRecallLockPath(workspaceDir);
      const customQmd = asRecord(asRecord(status.custom)?.qmd);
      const audit = await auditShortTermPromotionArtifacts({
        workspaceDir,
        qmd:
          status.backend === "qmd"
            ? {
                dbPath: status.dbPath,
                collections:
                  typeof customQmd?.collections === "number" ? customQmd.collections : undefined,
              }
            : undefined,
      });

      if (opts.json) {
        defaultRuntime.writeJson({
          workspaceDir,
          storePath,
          lockPath,
          audit,
          candidates,
          apply: applyResult
            ? {
                applied: applyResult.applied,
                appended: applyResult.appended,
                reconciledExisting: applyResult.reconciledExisting,
                memoryPath: applyResult.memoryPath,
                appliedCandidates: applyResult.appliedCandidates,
              }
            : undefined,
        });
        return;
      }

      if (candidates.length === 0) {
        defaultRuntime.log("No short-term recall candidates.");
        defaultRuntime.log(`Recall store: ${shortenHomePath(storePath)}`);
        if (audit.issues.length > 0) {
          for (const issue of audit.issues) {
            defaultRuntime.log(issue.message);
          }
        }
        return;
      }

      const rich = isRich();
      const lines: string[] = [];
      lines.push(
        `${colorize(rich, theme.heading, "Short-Term Promotion Candidates")} ${colorize(
          rich,
          theme.muted,
          `(${agentId})`,
        )}`,
      );
      lines.push(`${colorize(rich, theme.muted, "Recall store:")} ${shortenHomePath(storePath)}`);
      lines.push(colorize(rich, theme.muted, `Store health: ${formatAuditCounts(audit)}`));
      for (const candidate of candidates) {
        lines.push(
          `${colorize(rich, theme.success, candidate.score.toFixed(3))} ${colorize(
            rich,
            theme.accent,
            `${shortenHomePath(candidate.path)}:${candidate.startLine}-${candidate.endLine}`,
          )}`,
        );
        lines.push(
          colorize(
            rich,
            theme.muted,
            `recalls=${candidate.recallCount} avg=${candidate.avgScore.toFixed(3)} queries=${candidate.uniqueQueries} age=${candidate.ageDays.toFixed(1)}d consolidate=${candidate.components.consolidation.toFixed(2)} conceptual=${candidate.components.conceptual.toFixed(2)}`,
          ),
        );
        if (candidate.conceptTags.length > 0) {
          lines.push(colorize(rich, theme.muted, `concepts=${candidate.conceptTags.join(", ")}`));
        }
        if (candidate.snippet) {
          lines.push(colorize(rich, theme.muted, candidate.snippet));
        }
        lines.push("");
      }
      if (audit.issues.length > 0) {
        lines.push(colorize(rich, theme.warn, "Audit issues:"));
        for (const issue of audit.issues) {
          lines.push(
            colorize(rich, issue.severity === "error" ? theme.warn : theme.muted, issue.message),
          );
        }
        lines.push("");
      }
      if (applyResult) {
        if (applyResult.applied > 0) {
          lines.push(
            colorize(
              rich,
              theme.success,
              `Processed ${applyResult.applied} candidate(s) for ${shortenHomePath(applyResult.memoryPath)}.`,
            ),
          );
          lines.push(
            colorize(
              rich,
              theme.muted,
              `appended=${applyResult.appended} reconciledExisting=${applyResult.reconciledExisting}`,
            ),
          );
        } else {
          lines.push(colorize(rich, theme.warn, "No candidates met apply criteria."));
        }
      }
      defaultRuntime.log(lines.join("\n").trim());
    },
  });
}

export async function runMemoryPromoteExplain(
  selectorArg: string | undefined,
  opts: MemoryPromoteExplainOptions,
) {
  const selector = selectorArg?.trim();
  if (!selector) {
    defaultRuntime.error("Memory promote-explain requires a non-empty selector.");
    process.exitCode = 1;
    return;
  }

  const { config: cfg, diagnostics } = await loadMemoryCommandConfig("memory promote-explain");
  emitMemorySecretResolveDiagnostics(diagnostics, { json: Boolean(opts.json) });
  const agentId = resolveAgent(cfg, opts.agent);

  await withMemoryManagerForAgent({
    cfg,
    agentId,
    purpose: "status",
    run: async (manager) => {
      const status = manager.status();
      const workspaceDir = status.workspaceDir?.trim();
      const dreaming = resolveShortTermPromotionDreamingConfig({
        pluginConfig: resolveMemoryPluginConfig(cfg),
        cfg,
      });
      if (!workspaceDir) {
        defaultRuntime.error("Memory promote-explain requires a resolvable workspace directory.");
        process.exitCode = 1;
        return;
      }

      let candidates: Awaited<ReturnType<typeof rankShortTermPromotionCandidates>>;
      try {
        candidates = await rankShortTermPromotionCandidates({
          workspaceDir,
          minScore: 0,
          minRecallCount: 0,
          minUniqueQueries: 0,
          includePromoted: Boolean(opts.includePromoted),
          recencyHalfLifeDays: dreaming.recencyHalfLifeDays,
          maxAgeDays: dreaming.maxAgeDays,
        });
      } catch (err) {
        defaultRuntime.error(`Memory promote-explain failed: ${formatErrorMessage(err)}`);
        process.exitCode = 1;
        return;
      }

      const candidate = candidates.find((entry) => matchesPromotionSelector(entry, selector));
      if (!candidate) {
        defaultRuntime.error(`No promotion candidate matched "${selector}".`);
        process.exitCode = 1;
        return;
      }

      const thresholds = {
        minScore: dreaming.minScore,
        minRecallCount: dreaming.minRecallCount,
        minUniqueQueries: dreaming.minUniqueQueries,
        maxAgeDays: dreaming.maxAgeDays ?? null,
      };

      if (opts.json) {
        defaultRuntime.writeJson({
          workspaceDir,
          thresholds,
          candidate,
          passes: {
            score: candidate.score >= thresholds.minScore,
            recallCount: candidate.recallCount >= thresholds.minRecallCount,
            uniqueQueries: candidate.uniqueQueries >= thresholds.minUniqueQueries,
            maxAge:
              thresholds.maxAgeDays === null ? true : candidate.ageDays <= thresholds.maxAgeDays,
          },
        });
        return;
      }

      const rich = isRich();
      const lines = [
        `${colorize(rich, theme.heading, "Promotion Explain")} ${colorize(
          rich,
          theme.muted,
          "(" + agentId + ")",
        )}`,
        colorize(rich, theme.accent, candidate.key),
        colorize(
          rich,
          theme.muted,
          `${shortenHomePath(candidate.path)}:${String(candidate.startLine)}-${String(candidate.endLine)}`,
        ),
        candidate.snippet,
        colorize(
          rich,
          theme.muted,
          `score=${candidate.score.toFixed(3)} recallCount=${candidate.recallCount} uniqueQueries=${candidate.uniqueQueries} ageDays=${candidate.ageDays.toFixed(1)}`,
        ),
        colorize(
          rich,
          theme.muted,
          `components: frequency=${candidate.components.frequency.toFixed(2)} relevance=${candidate.components.relevance.toFixed(2)} diversity=${candidate.components.diversity.toFixed(2)} recency=${candidate.components.recency.toFixed(2)} consolidation=${candidate.components.consolidation.toFixed(2)} conceptual=${candidate.components.conceptual.toFixed(2)}`,
        ),
        colorize(
          rich,
          theme.muted,
          `thresholds: minScore=${thresholds.minScore} minRecallCount=${thresholds.minRecallCount} minUniqueQueries=${thresholds.minUniqueQueries} maxAgeDays=${thresholds.maxAgeDays ?? "none"}`,
        ),
      ];
      if (candidate.conceptTags.length > 0) {
        lines.push(colorize(rich, theme.muted, `concepts=${candidate.conceptTags.join(", ")}`));
      }
      defaultRuntime.log(lines.join("\n"));
    },
  });
}

export async function runMemoryRemHarness(opts: MemoryRemHarnessOptions) {
  const { config: cfg, diagnostics } = await loadMemoryCommandConfig("memory rem-harness");
  emitMemorySecretResolveDiagnostics(diagnostics, { json: Boolean(opts.json) });
  const agentId = resolveAgent(cfg, opts.agent);

  await withMemoryManagerForAgent({
    cfg,
    agentId,
    purpose: "status",
    run: async (manager) => {
      const status = manager.status();
      const managerWorkspaceDir = status.workspaceDir?.trim();
      const pluginConfig = resolveMemoryPluginConfig(cfg);
      if (!managerWorkspaceDir && !opts.path) {
        defaultRuntime.error("Memory rem-harness requires a resolvable workspace directory.");
        process.exitCode = 1;
        return;
      }
      const remConfig = resolveMemoryRemDreamingConfig({
        pluginConfig,
        cfg,
      });
      const nowMs = Date.now();
      let workspaceDir = managerWorkspaceDir ?? "";
      let sourceFiles: string[] = [];
      let groundedInputPaths: string[] = [];
      let importedFileCount = 0;
      let importedSignalCount = 0;
      let skippedPaths: string[] = [];
      let cleanupWorkspaceDir: string | null = null;
      if (opts.path) {
        const historical = await createHistoricalRemHarnessWorkspace({
          inputPath: opts.path,
          remLimit: remConfig.limit,
          nowMs,
          timezone: remConfig.timezone,
        });
        workspaceDir = historical.workspaceDir;
        cleanupWorkspaceDir = historical.workspaceDir;
        sourceFiles = historical.sourceFiles;
        groundedInputPaths = historical.workspaceSourceFiles;
        importedFileCount = historical.importedFileCount;
        importedSignalCount = historical.importedSignalCount;
        skippedPaths = historical.skippedPaths;
        if (sourceFiles.length === 0) {
          await fs.rm(historical.workspaceDir, { recursive: true, force: true });
          defaultRuntime.error(
            `Memory rem-harness found no YYYY-MM-DD.md files at ${shortenHomePath(path.resolve(opts.path))}.`,
          );
          process.exitCode = 1;
          return;
        }
      }
      if (!workspaceDir) {
        defaultRuntime.error("Memory rem-harness requires a resolvable workspace directory.");
        process.exitCode = 1;
        return;
      }
      try {
        const preview = await previewRemHarness({
          workspaceDir,
          cfg,
          pluginConfig,
          grounded: Boolean(opts.grounded),
          groundedInputPaths,
          includePromoted: Boolean(opts.includePromoted),
          nowMs,
        });
        groundedInputPaths = preview.groundedInputPaths;
        const remPreview = preview.rem;
        const groundedPreview = preview.grounded;
        const deepCandidates = preview.deep.candidates;

        if (opts.json) {
          defaultRuntime.writeJson({
            workspaceDir,
            sourcePath: opts.path ? path.resolve(opts.path) : null,
            sourceFiles,
            historicalImport: opts.path
              ? {
                  importedFileCount,
                  importedSignalCount,
                  skippedPaths,
                }
              : null,
            remConfig: preview.remConfig,
            deepConfig: {
              minScore: preview.deepConfig.minScore,
              minRecallCount: preview.deepConfig.minRecallCount,
              minUniqueQueries: preview.deepConfig.minUniqueQueries,
              recencyHalfLifeDays: preview.deepConfig.recencyHalfLifeDays,
              maxAgeDays: preview.deepConfig.maxAgeDays ?? null,
            },
            rem: { skipped: preview.remSkipped, ...remPreview },
            grounded: groundedPreview,
            deep: {
              candidateCount: preview.deep.candidateCount,
              candidates: deepCandidates,
            },
          });
          return;
        }

        const rich = isRich();
        const lines = [
          `${colorize(rich, theme.heading, "REM Harness")} ${colorize(rich, theme.muted, `(${agentId})`)}`,
          colorize(rich, theme.muted, `workspace=${shortenHomePath(workspaceDir)}`),
          ...(opts.path
            ? [
                colorize(
                  rich,
                  theme.muted,
                  `sourcePath=${shortenHomePath(path.resolve(opts.path))}`,
                ),
                colorize(
                  rich,
                  theme.muted,
                  `historicalFiles=${sourceFiles.length} importedFiles=${importedFileCount} importedSignals=${importedSignalCount}`,
                ),
                ...(skippedPaths.length > 0
                  ? [
                      colorize(
                        rich,
                        theme.warn,
                        `skipped=${skippedPaths.map((entry) => shortenHomePath(entry)).join(", ")}`,
                      ),
                    ]
                  : []),
              ]
            : []),
          ...(opts.grounded
            ? [
                colorize(
                  rich,
                  theme.muted,
                  `groundedInputs=${groundedInputPaths.length > 0 ? groundedInputPaths.map((entry) => shortenHomePath(entry)).join(", ") : "none"}`,
                ),
              ]
            : []),
          colorize(
            rich,
            theme.muted,
            `recentRecallEntries=${preview.recallEntryCount} deepCandidates=${deepCandidates.length}`,
          ),
          "",
          colorize(rich, theme.heading, "REM Preview"),
          ...remPreview.bodyLines,
          ...(groundedPreview
            ? [
                "",
                colorize(rich, theme.heading, "Grounded REM"),
                ...groundedPreview.files.flatMap((file) => [
                  colorize(rich, theme.muted, file.path),
                  file.renderedMarkdown,
                  "",
                ]),
              ]
            : []),
          "",
          colorize(rich, theme.heading, "Deep Candidates"),
          ...(deepCandidates.length > 0
            ? deepCandidates
                .slice(0, 10)
                .map(
                  (candidate) =>
                    `${candidate.score.toFixed(3)} ${candidate.snippet} [${shortenHomePath(candidate.path)}:${candidate.startLine}-${candidate.endLine}]`,
                )
            : ["- No deep candidates."]),
        ];
        defaultRuntime.log(lines.join("\n"));
      } finally {
        if (cleanupWorkspaceDir) {
          await fs.rm(cleanupWorkspaceDir, { recursive: true, force: true });
        }
      }
    },
  });
}

export async function runMemoryRemBackfill(opts: MemoryRemBackfillOptions) {
  const { config: cfg, diagnostics } = await loadMemoryCommandConfig("memory rem-backfill");
  emitMemorySecretResolveDiagnostics(diagnostics, { json: Boolean(opts.json) });
  const agentId = resolveAgent(cfg, opts.agent);

  await withMemoryManagerForAgent({
    cfg,
    agentId,
    purpose: "status",
    run: async (manager) => {
      const status = manager.status();
      const workspaceDir = status.workspaceDir?.trim();
      const pluginConfig = resolveMemoryPluginConfig(cfg);
      const remConfig = resolveMemoryRemDreamingConfig({
        pluginConfig,
        cfg,
      });
      if (!workspaceDir) {
        defaultRuntime.error("Memory rem-backfill requires a resolvable workspace directory.");
        process.exitCode = 1;
        return;
      }

      if (opts.rollback || opts.rollbackShortTerm) {
        const diaryRollback = opts.rollback
          ? await removeBackfillDiaryEntries({ workspaceDir })
          : null;
        const shortTermRollback = opts.rollbackShortTerm
          ? await removeGroundedShortTermCandidates({ workspaceDir })
          : null;
        if (opts.json) {
          defaultRuntime.writeJson({
            workspaceDir,
            rollback: Boolean(opts.rollback),
            rollbackShortTerm: Boolean(opts.rollbackShortTerm),
            ...(diaryRollback
              ? {
                  dreamsPath: diaryRollback.dreamsPath,
                  removedEntries: diaryRollback.removed,
                }
              : {}),
            ...(shortTermRollback
              ? {
                  shortTermStorePath: shortTermRollback.storePath,
                  removedShortTermEntries: shortTermRollback.removed,
                }
              : {}),
          });
          return;
        }
        defaultRuntime.log(
          [
            `${colorize(isRich(), theme.heading, "REM Backfill")} ${colorize(isRich(), theme.muted, "(rollback)")}`,
            colorize(isRich(), theme.muted, `workspace=${shortenHomePath(workspaceDir)}`),
            ...(diaryRollback
              ? [
                  colorize(
                    isRich(),
                    theme.muted,
                    `dreamsPath=${shortenHomePath(diaryRollback.dreamsPath)}`,
                  ),
                  colorize(isRich(), theme.muted, `removedEntries=${diaryRollback.removed}`),
                ]
              : []),
            ...(shortTermRollback
              ? [
                  colorize(
                    isRich(),
                    theme.muted,
                    `shortTermStorePath=${shortenHomePath(shortTermRollback.storePath)}`,
                  ),
                  colorize(
                    isRich(),
                    theme.muted,
                    `removedShortTermEntries=${shortTermRollback.removed}`,
                  ),
                ]
              : []),
          ].join("\n"),
        );
        return;
      }

      if (!opts.path) {
        defaultRuntime.error(
          "Memory rem-backfill requires --path <file-or-dir> unless using --rollback.",
        );
        process.exitCode = 1;
        return;
      }

      const scratchDir = await fs.mkdtemp(
        path.join(resolvePreferredOpenClawTmpDir(), "openclaw-rem-backfill-"),
      );
      try {
        const sourceFiles = await listHistoricalDailyFiles(opts.path);
        if (sourceFiles.length === 0) {
          defaultRuntime.error(
            `Memory rem-backfill found no YYYY-MM-DD.md files at ${shortenHomePath(path.resolve(opts.path))}.`,
          );
          process.exitCode = 1;
          return;
        }
        const scratchMemoryDir = path.join(scratchDir, "memory");
        await fs.mkdir(scratchMemoryDir, { recursive: true });
        const workspaceSourceFiles: string[] = [];
        for (const filePath of sourceFiles) {
          const dst = path.join(scratchMemoryDir, path.basename(filePath));
          await fs.copyFile(filePath, dst);
          workspaceSourceFiles.push(dst);
        }
        const grounded = await previewGroundedRemMarkdown({
          workspaceDir: scratchDir,
          inputPaths: workspaceSourceFiles,
        });
        const sourcePathByDay = new Map(
          sourceFiles
            .map((sourcePath) => [extractIsoDayFromPath(sourcePath), sourcePath] as const)
            .filter((entry): entry is [string, string] => Boolean(entry[0])),
        );
        const entries = grounded.files
          .map((file) => {
            const isoDay = extractIsoDayFromPath(file.path);
            if (!isoDay) {
              return null;
            }
            return {
              isoDay,
              sourcePath: sourcePathByDay.get(isoDay) ?? file.path,
              bodyLines: groundedMarkdownToDiaryLines(file.renderedMarkdown),
            };
          })
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

        const written = await writeBackfillDiaryEntries({
          workspaceDir,
          entries,
          timezone: remConfig.timezone,
        });
        let stagedShortTermEntries = 0;
        let replacedShortTermEntries = 0;
        if (opts.stageShortTerm) {
          const cleared = await removeGroundedShortTermCandidates({ workspaceDir });
          replacedShortTermEntries = cleared.removed;
          const shortTermSeedItems = collectGroundedShortTermSeedItems(grounded.files);
          if (shortTermSeedItems.length > 0) {
            await recordGroundedShortTermCandidates({
              workspaceDir,
              query: "__dreaming_grounded_backfill__",
              items: shortTermSeedItems,
              dedupeByQueryPerDay: true,
              nowMs: Date.now(),
              timezone: remConfig.timezone,
            });
          }
          stagedShortTermEntries = shortTermSeedItems.length;
        }

        if (opts.json) {
          defaultRuntime.writeJson({
            workspaceDir,
            sourcePath: path.resolve(opts.path),
            sourceFiles,
            groundedFiles: grounded.scannedFiles,
            writtenEntries: written.written,
            replacedEntries: written.replaced,
            dreamsPath: written.dreamsPath,
            ...(opts.stageShortTerm
              ? {
                  stagedShortTermEntries,
                  replacedShortTermEntries,
                }
              : {}),
          });
          return;
        }

        const rich = isRich();
        defaultRuntime.log(
          [
            `${colorize(rich, theme.heading, "REM Backfill")} ${colorize(rich, theme.muted, `(${agentId})`)}`,
            colorize(rich, theme.muted, `workspace=${shortenHomePath(workspaceDir)}`),
            colorize(rich, theme.muted, `sourcePath=${shortenHomePath(path.resolve(opts.path))}`),
            colorize(
              rich,
              theme.muted,
              `historicalFiles=${sourceFiles.length} writtenEntries=${written.written} replacedEntries=${written.replaced}`,
            ),
            ...(opts.stageShortTerm
              ? [
                  colorize(
                    rich,
                    theme.muted,
                    `stagedShortTermEntries=${stagedShortTermEntries} replacedShortTermEntries=${replacedShortTermEntries}`,
                  ),
                ]
              : []),
            colorize(rich, theme.muted, `dreamsPath=${shortenHomePath(written.dreamsPath)}`),
          ].join("\n"),
        );
      } finally {
        await fs.rm(scratchDir, { recursive: true, force: true });
      }
    },
  });
}
