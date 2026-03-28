import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { z } from "zod";
import type { McpToolResult } from "./proxy.js";

const DB_PATH = join(homedir(), ".airya", "data", "airya.db");
const AIRYA_DEFAULT_REPO_ROOT = join(homedir(), "Projects", "airya");
const AIRYA_WORKTREES_ROOT = join(AIRYA_DEFAULT_REPO_ROOT, ".worktrees");
const DEFAULT_MAX_TOKENS = 4000;
const DEFAULT_SEARCH_LIMIT = 10;
const DEFAULT_LIST_LIMIT = 20;
const TELEMETRY_ID_SAMPLE_LIMIT = 50;
const MEMORY_DEFAULT_WORKSPACE = "00000000-0000-0000-0000-000000000000";

const MEMORY_CLASS_MAP: Record<string, string> = {
  decision_log: "decision",
  project_context: "context",
  lineage_context: "context",
  founder_profile: "rule",
  execution_outcome: "insight",
  conversation_summary: "context",
};

interface MemoryRow {
  id: string;
  workspace_id: string;
  memory_class: string;
  memory_key: string;
  value_json: string;
  summary_text: string;
  confidence: number;
  priority: number;
  provenance: string;
  review_state: string;
  status: string;
  memory_tier: string | null;
  scope_kind: string | null;
  scope_id: string | null;
  project_id: string | null;
  work_item_id: string | null;
  conversation_id: string | null;
  valid_from: string;
  valid_to: string | null;
  created_at: string;
  updated_at: string;
}

interface FormatOptions {
  role?: string | null;
  citationGuard?: "off" | "penalize" | "strict";
  scoreOverride?: number;
}

type RankedMemoryItem = {
  row: MemoryRow;
  score: number;
};

type TokenBudgetSelection = {
  results: Array<Record<string, unknown>>;
  selectedItems: RankedMemoryItem[];
  truncated: boolean;
  tokensUsedEstimate: number;
};

type MemoryContextRetrieval = {
  rows: MemoryRow[];
  items: RankedMemoryItem[];
  tokenBudget: number;
  totalAvailable: number;
  totalBeforeDedupe: number;
};

type MemorySearchRetrieval = {
  rows: MemoryRow[];
  items: RankedMemoryItem[];
  query: string;
  searchMethod: string;
  limitApplied: number;
};

type MemoryListRetrieval = {
  rows: MemoryRow[];
  items: RankedMemoryItem[];
};

type ActiveReadWhereClause = {
  clause: string;
  params: unknown[];
};

type MemoryRetrievalModule = {
  DEFAULT_LIST_LIMIT: number;
  DEFAULT_SEARCH_LIMIT: number;
  MAX_LIST_LIMIT: number;
  MAX_SEARCH_LIMIT: number;
  computeMemoryScore: (row: MemoryRow, options: FormatOptions) => number;
  resolveMemoryRolloutState: (
    workspaceId: string,
    env: Record<string, string | undefined>,
  ) => Record<string, unknown>;
  normalizeRole: (value: string | undefined) => string | undefined;
  normalizeMaxAgeDays: (value: number | undefined) => number | undefined;
  retrieveMemoryContext: (
    db: Database.Database,
    options: Record<string, unknown>,
  ) => MemoryContextRetrieval;
  selectRankedItemsWithinTokenBudget: (
    items: RankedMemoryItem[],
    options: {
      maxTokens: number;
      formatItem: (item: RankedMemoryItem) => Record<string, unknown>;
    },
  ) => TokenBudgetSelection;
  formatMemoryForMcp: (row: MemoryRow, options: FormatOptions) => Record<string, unknown>;
  buildActiveReadWhereClause: (
    prefix: string,
    maxAgeDays: number | undefined,
  ) => ActiveReadWhereClause;
  summarizeCitationCoverage: (rows: MemoryRow[]) => Record<string, unknown>;
  buildRetrievalTelemetrySummary: (
    candidates: MemoryRow[],
    selected: RankedMemoryItem[],
  ) => Record<string, unknown>;
  clampInteger: (
    value: number | undefined,
    defaultValue: number,
    min: number,
    max: number,
  ) => number;
  normalizeSearchQuery: (value: string) => string;
  buildMemorySearchHybridOptions: (options: Record<string, unknown>) => Record<string, unknown>;
  retrieveMemorySearch: (
    db: Database.Database,
    options: Record<string, unknown>,
  ) => MemorySearchRetrieval;
  retrieveMemoryList: (
    db: Database.Database,
    options: Record<string, unknown>,
  ) => MemoryListRetrieval;
};

const memoryRetrieval = (await import(resolveMemoryRetrievalModuleUrl())) as MemoryRetrievalModule;

interface MemoryRuntime {
  db?: Database.Database;
  dbPath: string;
  defaultWorkspaceId: string;
  now: () => string;
  generateId: () => string;
  env: Record<string, string | undefined>;
  allowTelemetryPersistence: boolean;
}

export interface MemoryReadToolDefinition {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (input: Record<string, unknown>) => Promise<McpToolResult>;
}

export interface MemoryReadToolOptions {
  db?: Database.Database;
  dbPath?: string;
  defaultWorkspaceId?: string;
  now?: () => string;
  generateId?: () => string;
  env?: Record<string, string | undefined>;
  allowTelemetryPersistence?: boolean;
}

export interface MemoryReadToolRegistrar {
  tool(
    name: string,
    description: string,
    schema: Record<string, z.ZodTypeAny>,
    handler: (input: Record<string, unknown>) => Promise<McpToolResult>,
  ): void;
}

export function createMemoryReadToolDefinitions(
  options: MemoryReadToolOptions = {},
): MemoryReadToolDefinition[] {
  const runtime = createRuntime(options);

  return [
    {
      name: "memory_context",
      description:
        "Bootstrap context: returns all active memories ranked by composite score. Call this first to load shared knowledge.",
      schema: {
        project: z.string().optional().describe("Filter by project scope"),
        role: z
          .string()
          .optional()
          .describe('Agent role for relevance hints (e.g. "architect", "reviewer")'),
        max_tokens: z
          .number()
          .optional()
          .default(DEFAULT_MAX_TOKENS)
          .describe("Token budget cap (default 4000)"),
        max_age_days: z
          .number()
          .optional()
          .describe("Optional recency ceiling in days (0-3650). Older memories are excluded"),
        citation_guard: z
          .enum(["off", "penalize", "strict"])
          .optional()
          .default("penalize")
          .describe("Citation guard mode for ranking: off | penalize | strict"),
        include_citation_coverage: z
          .boolean()
          .optional()
          .describe("Include citation coverage stats in response"),
        workspace_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            "Workspace scope for context bootstrap (default: AIRYA_WORKSPACE_ID or shared workspace)",
          ),
        include_telemetry: z
          .boolean()
          .optional()
          .describe("Include retrieval telemetry (query/ids) for tuning"),
        persist_telemetry: z
          .boolean()
          .optional()
          .describe("Persist compact retrieval telemetry memory in workspace"),
      },
      handler: async (input) => handleMemoryContext(input, runtime),
    },
    {
      name: "memory_search",
      description:
        "Full-text search across memories. Returns matching memories ranked by relevance.",
      schema: {
        query: z.string().describe("Search string"),
        limit: z
          .number()
          .optional()
          .default(DEFAULT_SEARCH_LIMIT)
          .describe("Max results (default 10)"),
        role: z
          .string()
          .optional()
          .describe('Optional role hint for ranking (e.g. "commander", "reviewer")'),
        text_weight: z
          .number()
          .optional()
          .describe("Optional lexical score weight for hybrid ranking (0-1)"),
        vector_weight: z
          .number()
          .optional()
          .describe("Optional vector score weight for hybrid ranking (0-1)"),
        metadata_weight: z
          .number()
          .optional()
          .describe("Optional metadata score weight for hybrid ranking (0-1)"),
        mmr_enabled: z.boolean().optional().describe("Enable diversity-aware MMR reranking"),
        mmr_lambda: z.number().optional().describe("MMR relevance/diversity balance (0-1)"),
        temporal_decay_enabled: z
          .boolean()
          .optional()
          .describe("Enable recency decay in hybrid ranking"),
        temporal_decay_half_life_days: z
          .number()
          .optional()
          .describe("Half-life in days for temporal decay"),
        max_age_days: z
          .number()
          .optional()
          .describe("Optional recency ceiling in days (0-3650). Older memories are excluded"),
        citation_guard: z
          .enum(["off", "penalize", "strict"])
          .optional()
          .default("penalize")
          .describe("Citation guard mode for ranking: off | penalize | strict"),
        include_citation_coverage: z
          .boolean()
          .optional()
          .describe("Include citation coverage stats in response"),
        workspace_id: z
          .string()
          .uuid()
          .optional()
          .describe("Workspace scope for search (default: AIRYA_WORKSPACE_ID or shared workspace)"),
        include_telemetry: z
          .boolean()
          .optional()
          .describe("Include retrieval telemetry (query/ids) for tuning"),
        persist_telemetry: z
          .boolean()
          .optional()
          .describe("Persist compact retrieval telemetry memory in workspace"),
      },
      handler: async (input) => handleMemorySearch(input, runtime),
    },
    {
      name: "memory_read",
      description: "Read a specific memory by ID. Returns full memory with all metadata.",
      schema: {
        id: z.string().describe("Memory UUID"),
        max_age_days: z
          .number()
          .optional()
          .describe("Optional recency ceiling in days (0-3650). Older memories are excluded"),
        include_citation_coverage: z
          .boolean()
          .optional()
          .describe("Include citation coverage stats in response"),
        workspace_id: z
          .string()
          .uuid()
          .optional()
          .describe("Workspace scope for read (default: AIRYA_WORKSPACE_ID or shared workspace)"),
      },
      handler: async (input) => handleMemoryRead(input, runtime),
    },
    {
      name: "memory_list",
      description:
        "List memories with filters. Supports filtering by type, project, and minimum importance.",
      schema: {
        memory_type: z
          .string()
          .optional()
          .describe("Filter by type: decision, context, rule, insight"),
        project: z.string().optional().describe("Filter by project scope"),
        importance: z
          .enum(["critical", "high", "medium", "low"])
          .optional()
          .describe("Minimum importance level"),
        limit: z
          .number()
          .optional()
          .default(DEFAULT_LIST_LIMIT)
          .describe("Max results (default 20)"),
        role: z.string().optional().describe("Optional role hint for ranking"),
        max_age_days: z
          .number()
          .optional()
          .describe("Optional recency ceiling in days (0-3650). Older memories are excluded"),
        citation_guard: z
          .enum(["off", "penalize", "strict"])
          .optional()
          .default("penalize")
          .describe("Citation guard mode for ranking: off | penalize | strict"),
        include_citation_coverage: z
          .boolean()
          .optional()
          .describe("Include citation coverage stats in response"),
        workspace_id: z
          .string()
          .uuid()
          .optional()
          .describe("Workspace scope for list (default: AIRYA_WORKSPACE_ID or shared workspace)"),
        include_telemetry: z
          .boolean()
          .optional()
          .describe("Include retrieval telemetry (query/ids) for tuning"),
        persist_telemetry: z
          .boolean()
          .optional()
          .describe("Persist compact retrieval telemetry memory in workspace"),
      },
      handler: async (input) => handleMemoryList(input, runtime),
    },
  ];
}

export function registerMemoryReadTools(
  server: MemoryReadToolRegistrar,
  options: MemoryReadToolOptions = {},
): string[] {
  const definitions = createMemoryReadToolDefinitions(options);
  for (const definition of definitions) {
    server.tool(definition.name, definition.description, definition.schema, definition.handler);
  }
  return definitions.map((definition) => definition.name);
}

function createRuntime(options: MemoryReadToolOptions): MemoryRuntime {
  return {
    db: options.db,
    dbPath: options.dbPath ?? process.env.AIRYA_DB_PATH ?? DB_PATH,
    defaultWorkspaceId:
      options.defaultWorkspaceId ?? process.env["AIRYA_WORKSPACE_ID"] ?? MEMORY_DEFAULT_WORKSPACE,
    now: options.now ?? (() => new Date().toISOString()),
    generateId: options.generateId ?? randomUUID,
    env: options.env ?? (process.env as Record<string, string | undefined>),
    allowTelemetryPersistence: options.allowTelemetryPersistence ?? true,
  };
}

function resolveMemoryRetrievalModuleUrl(): string {
  const explicitRepoRoot = process.env["AIRYA_REPO_ROOT"];
  const candidateRepoRoots = new Set<string>();
  const preferDist = import.meta.url.includes("/dist/");

  if (explicitRepoRoot) {
    candidateRepoRoots.add(explicitRepoRoot);
  }
  candidateRepoRoots.add(AIRYA_DEFAULT_REPO_ROOT);

  if (!explicitRepoRoot && existsSync(AIRYA_WORKTREES_ROOT)) {
    const matchingWorktrees = readdirSync(AIRYA_WORKTREES_ROOT)
      .map((name) => join(AIRYA_WORKTREES_ROOT, name))
      .filter((path) => {
        try {
          return statSync(path).isDirectory();
        } catch {
          return false;
        }
      })
      .filter((path) =>
        existsSync(join(path, "packages", "engine", "src", "airya", "memory-retrieval.ts")),
      );

    if (matchingWorktrees.length === 1) {
      candidateRepoRoots.add(matchingWorktrees[0]);
    }
  }

  for (const repoRoot of candidateRepoRoots) {
    const sourcePath = join(repoRoot, "packages", "engine", "src", "airya", "memory-retrieval.ts");
    const distPath = join(repoRoot, "packages", "engine", "dist", "airya", "memory-retrieval.js");
    const preferredCandidates = preferDist ? [distPath, sourcePath] : [sourcePath, distPath];

    for (const candidatePath of preferredCandidates) {
      if (existsSync(candidatePath)) {
        return pathToFileURL(candidatePath).href;
      }
    }
  }

  throw new Error(
    "Unable to locate shared memory retrieval module. Set AIRYA_REPO_ROOT to a checkout containing packages/engine/src/airya/memory-retrieval.ts.",
  );
}

function openReadDb(runtime: MemoryRuntime): { db: Database.Database; close: () => void } {
  if (runtime.db) {
    return { db: runtime.db, close: () => {} };
  }

  if (!existsSync(runtime.dbPath)) {
    throw new Error(
      `AiRYA database not found at ${runtime.dbPath}. Run 'airya setup' or 'pnpm dev' first.`,
    );
  }

  const db = new Database(runtime.dbPath, { readonly: true });
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  return { db, close: () => db.close() };
}

function openWriteDb(runtime: MemoryRuntime): { db: Database.Database; close: () => void } {
  if (runtime.db) {
    return { db: runtime.db, close: () => {} };
  }

  if (!existsSync(runtime.dbPath)) {
    throw new Error(
      `AiRYA database not found at ${runtime.dbPath}. Run 'airya setup' or 'pnpm dev' first.`,
    );
  }

  const db = new Database(runtime.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  return { db, close: () => db.close() };
}

function parseValueJson(valueJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(valueJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // leave empty
  }
  return {};
}

function extractSourceChannel(valueObj: Record<string, unknown>): string | null {
  const provenance = valueObj["_provenance"];
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) {
    return null;
  }
  const sourceChannel = (provenance as Record<string, unknown>)["source_channel"];
  return typeof sourceChannel === "string" ? sourceChannel : null;
}

function hasRequiredCitationRow(row: MemoryRow): boolean {
  return Boolean(
    row.id &&
    row.memory_key &&
    row.workspace_id &&
    row.provenance &&
    row.updated_at &&
    row.created_at,
  );
}

function summarizeCitationCoverage(rows: MemoryRow[]): {
  total: number;
  required_present: number;
  coverage_ratio: number;
} {
  const total = rows.length;
  const requiredPresent = rows.reduce(
    (count, row) => count + (hasRequiredCitationRow(row) ? 1 : 0),
    0,
  );
  const coverageRatio = total === 0 ? 1 : requiredPresent / total;
  return { total, required_present: requiredPresent, coverage_ratio: coverageRatio };
}

function mapImportance(priority: number): string {
  if (priority >= 90) {
    return "critical";
  }
  if (priority >= 70) {
    return "high";
  }
  if (priority >= 40) {
    return "medium";
  }
  return "low";
}

function mapMemoryType(memoryClass: string): string {
  return MEMORY_CLASS_MAP[memoryClass] ?? memoryClass;
}

function formatMemory(row: MemoryRow, options: FormatOptions = {}): Record<string, unknown> {
  const score =
    typeof options.scoreOverride === "number"
      ? options.scoreOverride
      : memoryRetrieval.computeMemoryScore(row, options);
  const ageMs = Date.now() - new Date(row.updated_at).getTime();
  const ageDays = Math.floor(ageMs / 86_400_000);
  const valueObj = parseValueJson(row.value_json);
  const sourceChannel = extractSourceChannel(valueObj);

  return {
    id: row.id,
    memory_type: mapMemoryType(row.memory_class),
    memory_class: row.memory_class,
    memory_key: row.memory_key,
    title: row.summary_text.slice(0, 120),
    content: row.summary_text,
    importance: mapImportance(row.priority),
    confidence: row.confidence,
    priority: row.priority,
    provenance: row.provenance,
    score: Math.round(score * 1000) / 1000,
    staleness_warning: ageDays > 30 ? `Last updated ${ageDays} days ago` : null,
    updated_at: row.updated_at,
    created_at: row.created_at,
    citation: {
      memory_id: row.id,
      memory_key: row.memory_key,
      workspace_id: row.workspace_id,
      provenance: row.provenance,
      source_channel: sourceChannel,
      updated_at: row.updated_at,
      created_at: row.created_at,
    },
  };
}

function resolveWorkspaceId(workspaceId: unknown, runtime: MemoryRuntime): string {
  return typeof workspaceId === "string" && workspaceId ? workspaceId : runtime.defaultWorkspaceId;
}

function enforceRolloutAccess(
  workspaceId: string,
  runtime: MemoryRuntime,
): {
  rollout: Record<string, unknown>;
  deniedResponse?: McpToolResult;
} {
  const rollout = memoryRetrieval.resolveMemoryRolloutState(workspaceId, runtime.env);

  if (rollout["internal_only"] === true && rollout["workspace_allowed"] !== true) {
    return {
      rollout,
      deniedResponse: {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "Memory retrieval rollout restricted to internal workspaces",
                workspace_id: workspaceId,
                rollout,
              },
              null,
              2,
            ),
          },
        ],
      },
    };
  }

  return { rollout };
}

function writeOptionDeniedResult(workspaceId: string): McpToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            ok: false,
            error: "persist_telemetry is not allowed in read-only continuity mode",
            code: "WRITE_OPTION_NOT_ALLOWED",
            field: "persist_telemetry",
            workspace_id: workspaceId,
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

function buildReadToolErrorResult(tool: string, workspaceId: string, err: unknown): McpToolResult {
  const detail = err instanceof Error ? err.message : String(err);
  const schemaDrift = detail.includes("no such column: event_at");

  const payload = schemaDrift
    ? {
        ok: false,
        error: "TEMPORAL_QUERY_SCHEMA_REQUIRED",
        code: "TEMPORAL_QUERY_SCHEMA_REQUIRED",
        message: "Temporal query requires the migrated memory schema with event_at.",
        detail,
        tool,
        workspace_id: workspaceId,
      }
    : {
        ok: false,
        error: "MEMORY_TOOL_EXECUTION_FAILED",
        code: "MEMORY_TOOL_EXECUTION_FAILED",
        message: "Memory tool execution failed.",
        detail,
        tool,
        workspace_id: workspaceId,
      };

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    isError: true,
  };
}

function persistRetrievalTelemetry(
  runtime: MemoryRuntime,
  tool: string,
  workspaceId: string,
  telemetryPayload: Record<string, unknown>,
): { persisted: boolean; memory_id?: string; memory_key?: string; error?: string } {
  let writeHandle: { db: Database.Database; close: () => void } | undefined;
  try {
    writeHandle = openWriteDb(runtime);
    const now = runtime.now();
    const id = runtime.generateId();
    const key = `telemetry/retrieval/${tool}/${now}/${id.slice(0, 8)}`;
    const candidateCountTotal = asOptionalNumber(telemetryPayload["candidate_count_total"]) ?? 0;
    const selectedCountTotal = asOptionalNumber(telemetryPayload["selected_count_total"]) ?? 0;
    const summaryText = `Retrieval telemetry ${tool}: candidates=${candidateCountTotal}, selected=${selectedCountTotal}`;
    const valueJson = JSON.stringify({
      kind: "retrieval_telemetry",
      ...telemetryPayload,
      _provenance: {
        source_channel: "cli",
        saved_at: now,
      },
    });

    writeHandle.db
      .prepare(`
      INSERT INTO airya_memory_items (
        id, workspace_id, memory_class, memory_key,
        value_json, summary_text, confidence, priority,
        provenance, review_state, status,
        valid_from, created_at, updated_at
      ) VALUES (?, ?, 'lineage_context', ?, ?, ?, 0.85, 35, 'system_derived', 'not_required', 'superseded', ?, ?, ?)
    `)
      .run(id, workspaceId, key, valueJson, summaryText, now, now, now);

    return { persisted: true, memory_id: id, memory_key: key };
  } catch (err) {
    return { persisted: false, error: (err as Error).message };
  } finally {
    writeHandle?.close();
  }
}

async function handleMemoryContext(
  input: Record<string, unknown>,
  runtime: MemoryRuntime,
): Promise<McpToolResult> {
  const workspaceId = resolveWorkspaceId(input.workspace_id, runtime);
  let readHandle: { db: Database.Database; close: () => void } | undefined;
  try {
    readHandle = openReadDb(runtime);
    const roleHint = memoryRetrieval.normalizeRole(asOptionalString(input.role));
    const rolloutGate = enforceRolloutAccess(workspaceId, runtime);
    if (rolloutGate.deniedResponse) {
      return rolloutGate.deniedResponse;
    }

    if (input.persist_telemetry === true && !runtime.allowTelemetryPersistence) {
      return writeOptionDeniedResult(workspaceId);
    }

    const citationGuard =
      (input.citation_guard as "off" | "penalize" | "strict" | undefined) ?? "penalize";
    const normalizedMaxAgeDays = memoryRetrieval.normalizeMaxAgeDays(
      asOptionalNumber(input.max_age_days),
    );
    const retrieval = memoryRetrieval.retrieveMemoryContext(readHandle.db, {
      workspaceId,
      project: asOptionalString(input.project),
      role: roleHint,
      maxTokens: asOptionalNumber(input.max_tokens),
      maxAgeDays: normalizedMaxAgeDays,
      citationGuard,
    });
    const rows = retrieval.rows;
    const ranked = retrieval.items as Array<{ row: MemoryRow; score: number }>;
    const selection = memoryRetrieval.selectRankedItemsWithinTokenBudget(ranked, {
      maxTokens: retrieval.tokenBudget,
      formatItem: (item: { row: MemoryRow; score: number }) =>
        memoryRetrieval.formatMemoryForMcp(item.row, {
          role: roleHint,
          citationGuard,
          scoreOverride: item.score,
        }),
    });
    const results = selection.results;
    const selectedRows = selection.selectedItems.map((item: { row: MemoryRow }) => item.row);
    const activeWhere = memoryRetrieval.buildActiveReadWhereClause("", normalizedMaxAgeDays);
    const lastUpdate = readHandle.db
      .prepare(
        `SELECT MAX(updated_at) as last_update
       FROM airya_memory_items
       WHERE workspace_id = ? AND ${activeWhere.clause}`,
      )
      .get(workspaceId, ...activeWhere.params) as { last_update: string | null } | undefined;

    const response: Record<string, unknown> = {
      memories: results,
      total_available: retrieval.totalAvailable,
      total_before_dedupe: retrieval.totalBeforeDedupe,
      returned: results.length,
      truncated: selection.truncated,
      workspace_id: workspaceId,
      role_hint_applied: roleHint,
      citation_guard_applied: citationGuard,
      max_age_days_applied: normalizedMaxAgeDays,
      tokens_used_estimate: selection.tokensUsedEstimate,
      last_write_at: lastUpdate?.last_update ?? null,
    };

    if (input.include_citation_coverage === true) {
      response["citation_coverage"] = {
        candidates: memoryRetrieval.summarizeCitationCoverage(rows),
        ranked: memoryRetrieval.summarizeCitationCoverage(
          ranked.map((item: { row: MemoryRow }) => item.row),
        ),
        selected: memoryRetrieval.summarizeCitationCoverage(selectedRows),
      };
    }

    const retrievalTelemetry = memoryRetrieval.buildRetrievalTelemetrySummary(
      ranked.map((item: { row: MemoryRow }) => item.row),
      selection.selectedItems as Array<{ row: MemoryRow; score: number }>,
    );
    const telemetryPayload: Record<string, unknown> = {
      tool: "memory_context",
      workspace_id: workspaceId,
      query: asOptionalString(input.project) ?? null,
      filters: {
        project: asOptionalString(input.project) ?? null,
        max_tokens: retrieval.tokenBudget,
        max_age_days: normalizedMaxAgeDays,
        citation_guard: citationGuard,
      },
      candidate_ids: ranked.slice(0, TELEMETRY_ID_SAMPLE_LIMIT).map(({ row }) => row.id),
      candidate_count_total: ranked.length,
      selected_ids: selectedRows
        .slice(0, TELEMETRY_ID_SAMPLE_LIMIT)
        .map((row: MemoryRow) => row.id),
      selected_keys: selectedRows
        .slice(0, TELEMETRY_ID_SAMPLE_LIMIT)
        .map((row: MemoryRow) => row.memory_key),
      selected_count_total: selectedRows.length,
      total_before_dedupe: rows.length,
      total_after_dedupe: ranked.length,
      ...retrievalTelemetry,
      rollout: rolloutGate.rollout,
    };

    if (input.include_telemetry === true) {
      response["telemetry"] = telemetryPayload;
    }

    if (input.persist_telemetry === true) {
      response["telemetry_persist"] = persistRetrievalTelemetry(
        runtime,
        "memory_context",
        workspaceId,
        telemetryPayload,
      );
    }

    return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
  } catch (err) {
    return buildReadToolErrorResult("memory_context", workspaceId, err);
  } finally {
    readHandle?.close();
  }
}

async function handleMemorySearch(
  input: Record<string, unknown>,
  runtime: MemoryRuntime,
): Promise<McpToolResult> {
  const workspaceId = resolveWorkspaceId(input.workspace_id, runtime);
  let readHandle: { db: Database.Database; close: () => void } | undefined;
  try {
    readHandle = openReadDb(runtime);
    const rolloutGate = enforceRolloutAccess(workspaceId, runtime);
    if (rolloutGate.deniedResponse) {
      return rolloutGate.deniedResponse;
    }

    if (input.persist_telemetry === true && !runtime.allowTelemetryPersistence) {
      return writeOptionDeniedResult(workspaceId);
    }

    const maxResults = memoryRetrieval.clampInteger(
      asOptionalNumber(input.limit),
      memoryRetrieval.DEFAULT_SEARCH_LIMIT,
      1,
      memoryRetrieval.MAX_SEARCH_LIMIT,
    );
    const roleHint = memoryRetrieval.normalizeRole(asOptionalString(input.role));
    const citationGuard =
      (input.citation_guard as "off" | "penalize" | "strict" | undefined) ?? "penalize";
    const normalizedMaxAgeDays = memoryRetrieval.normalizeMaxAgeDays(
      asOptionalNumber(input.max_age_days),
    );
    const normalizedQuery = memoryRetrieval.normalizeSearchQuery(
      asOptionalString(input.query) ?? "",
    );
    const hybrid = memoryRetrieval.buildMemorySearchHybridOptions({
      text_weight: input.text_weight,
      vector_weight: input.vector_weight,
      metadata_weight: input.metadata_weight,
      mmr_enabled: input.mmr_enabled,
      mmr_lambda: input.mmr_lambda,
      temporal_decay_enabled: input.temporal_decay_enabled,
      temporal_decay_half_life_days: input.temporal_decay_half_life_days,
    });

    if (!normalizedQuery) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: "Query must contain non-whitespace characters", workspace_id: workspaceId },
              null,
              2,
            ),
          },
        ],
      };
    }

    const retrieval = memoryRetrieval.retrieveMemorySearch(readHandle.db, {
      workspaceId,
      query: normalizedQuery,
      limit: maxResults,
      role: roleHint,
      maxAgeDays: normalizedMaxAgeDays,
      citationGuard,
      hybrid,
    });
    const rows = retrieval.rows;
    const ranked = retrieval.items as Array<{ row: MemoryRow; score: number }>;
    const results = ranked.map((item) =>
      memoryRetrieval.formatMemoryForMcp(item.row, {
        role: roleHint,
        citationGuard,
        scoreOverride: item.score,
      }),
    );
    const response: Record<string, unknown> = {
      query: retrieval.query,
      results,
      count: results.length,
      total_before_dedupe: rows.length,
      workspace_id: workspaceId,
      role_hint_applied: roleHint,
      citation_guard_applied: citationGuard,
      max_age_days_applied: normalizedMaxAgeDays,
      search_method: retrieval.searchMethod,
    };

    if (input.include_citation_coverage === true) {
      response["citation_coverage"] = {
        candidates: memoryRetrieval.summarizeCitationCoverage(rows),
        selected: memoryRetrieval.summarizeCitationCoverage(ranked.map((item) => item.row)),
      };
    }

    const retrievalTelemetry = memoryRetrieval.buildRetrievalTelemetrySummary(
      rows,
      ranked as Array<{ row: MemoryRow; score: number }>,
    );
    const telemetryPayload: Record<string, unknown> = {
      tool: "memory_search",
      workspace_id: workspaceId,
      query: retrieval.query,
      search_method: retrieval.searchMethod,
      filters: {
        limit: retrieval.limitApplied,
        max_age_days: normalizedMaxAgeDays,
        citation_guard: citationGuard,
      },
      candidate_ids: rows.slice(0, TELEMETRY_ID_SAMPLE_LIMIT).map((row) => row.id),
      candidate_count_total: rows.length,
      selected_ids: ranked.slice(0, TELEMETRY_ID_SAMPLE_LIMIT).map(({ row }) => row.id),
      selected_keys: ranked.slice(0, TELEMETRY_ID_SAMPLE_LIMIT).map(({ row }) => row.memory_key),
      selected_count_total: ranked.length,
      total_before_dedupe: rows.length,
      total_after_dedupe: ranked.length,
      ...retrievalTelemetry,
      rollout: rolloutGate.rollout,
    };

    if (input.include_telemetry === true) {
      response["telemetry"] = telemetryPayload;
    }

    if (input.persist_telemetry === true) {
      response["telemetry_persist"] = persistRetrievalTelemetry(
        runtime,
        "memory_search",
        workspaceId,
        telemetryPayload,
      );
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  } catch (err) {
    return buildReadToolErrorResult("memory_search", workspaceId, err);
  } finally {
    readHandle?.close();
  }
}

async function handleMemoryRead(
  input: Record<string, unknown>,
  runtime: MemoryRuntime,
): Promise<McpToolResult> {
  const workspaceId = resolveWorkspaceId(input.workspace_id, runtime);
  let readHandle: { db: Database.Database; close: () => void } | undefined;
  try {
    readHandle = openReadDb(runtime);
    const rolloutGate = enforceRolloutAccess(workspaceId, runtime);
    if (rolloutGate.deniedResponse) {
      return rolloutGate.deniedResponse;
    }

    const normalizedMaxAgeDays = memoryRetrieval.normalizeMaxAgeDays(
      asOptionalNumber(input.max_age_days),
    );
    const activeWhere = memoryRetrieval.buildActiveReadWhereClause("", normalizedMaxAgeDays);
    const row = readHandle.db
      .prepare(
        `SELECT * FROM airya_memory_items
       WHERE id = ? AND workspace_id = ? AND ${activeWhere.clause}`,
      )
      .get(String(input.id), workspaceId, ...activeWhere.params) as MemoryRow | undefined;

    if (!row) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "Memory not found",
              id: input.id,
              workspace_id: workspaceId,
            }),
          },
        ],
      };
    }

    let valueJson: unknown = {};
    try {
      valueJson = JSON.parse(row.value_json);
    } catch {
      // leave empty
    }

    const response: Record<string, unknown> = {
      ...formatMemory(row),
      workspace_id: workspaceId,
      max_age_days_applied: normalizedMaxAgeDays,
      value_json: valueJson,
    };

    if (input.include_citation_coverage === true) {
      response["citation_coverage"] = summarizeCitationCoverage([row]);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  } catch (err) {
    return buildReadToolErrorResult("memory_read", workspaceId, err);
  } finally {
    readHandle?.close();
  }
}

async function handleMemoryList(
  input: Record<string, unknown>,
  runtime: MemoryRuntime,
): Promise<McpToolResult> {
  const workspaceId = resolveWorkspaceId(input.workspace_id, runtime);
  let readHandle: { db: Database.Database; close: () => void } | undefined;
  try {
    readHandle = openReadDb(runtime);
    const roleHint = memoryRetrieval.normalizeRole(asOptionalString(input.role));
    const rolloutGate = enforceRolloutAccess(workspaceId, runtime);
    if (rolloutGate.deniedResponse) {
      return rolloutGate.deniedResponse;
    }

    if (input.persist_telemetry === true && !runtime.allowTelemetryPersistence) {
      return writeOptionDeniedResult(workspaceId);
    }

    const citationGuard =
      (input.citation_guard as "off" | "penalize" | "strict" | undefined) ?? "penalize";
    const normalizedMaxAgeDays = memoryRetrieval.normalizeMaxAgeDays(
      asOptionalNumber(input.max_age_days),
    );
    const maxResults = memoryRetrieval.clampInteger(
      asOptionalNumber(input.limit),
      memoryRetrieval.DEFAULT_LIST_LIMIT,
      1,
      memoryRetrieval.MAX_LIST_LIMIT,
    );
    const retrieval = memoryRetrieval.retrieveMemoryList(readHandle.db, {
      workspaceId,
      memoryType: asOptionalString(input.memory_type),
      project: asOptionalString(input.project),
      importance: asOptionalString(input.importance),
      limit: maxResults,
      role: roleHint,
      maxAgeDays: normalizedMaxAgeDays,
      citationGuard,
    });
    const rows = retrieval.rows;
    const ranked = retrieval.items as Array<{ row: MemoryRow; score: number }>;
    const results = ranked.map((item) =>
      memoryRetrieval.formatMemoryForMcp(item.row, {
        role: roleHint,
        citationGuard,
        scoreOverride: item.score,
      }),
    );
    const response: Record<string, unknown> = {
      results,
      count: results.length,
      total_before_dedupe: rows.length,
      workspace_id: workspaceId,
      role_hint_applied: roleHint,
      citation_guard_applied: citationGuard,
      max_age_days_applied: normalizedMaxAgeDays,
    };

    if (input.include_citation_coverage === true) {
      response["citation_coverage"] = {
        candidates: memoryRetrieval.summarizeCitationCoverage(rows),
        selected: memoryRetrieval.summarizeCitationCoverage(ranked.map((item) => item.row)),
      };
    }

    const retrievalTelemetry = memoryRetrieval.buildRetrievalTelemetrySummary(
      rows,
      ranked as Array<{ row: MemoryRow; score: number }>,
    );
    const telemetryPayload: Record<string, unknown> = {
      tool: "memory_list",
      workspace_id: workspaceId,
      query: asOptionalString(input.project) ?? null,
      filters: {
        memory_type: asOptionalString(input.memory_type) ?? null,
        project: asOptionalString(input.project) ?? null,
        importance: asOptionalString(input.importance) ?? null,
        limit: maxResults,
        role: roleHint,
        max_age_days: normalizedMaxAgeDays,
        citation_guard: citationGuard,
      },
      candidate_ids: rows.slice(0, TELEMETRY_ID_SAMPLE_LIMIT).map((row) => row.id),
      candidate_count_total: rows.length,
      selected_ids: ranked.slice(0, TELEMETRY_ID_SAMPLE_LIMIT).map(({ row }) => row.id),
      selected_keys: ranked.slice(0, TELEMETRY_ID_SAMPLE_LIMIT).map(({ row }) => row.memory_key),
      selected_count_total: ranked.length,
      total_before_dedupe: rows.length,
      total_after_dedupe: ranked.length,
      ...retrievalTelemetry,
      rollout: rolloutGate.rollout,
    };

    if (input.include_telemetry === true) {
      response["telemetry"] = telemetryPayload;
    }

    if (input.persist_telemetry === true) {
      response["telemetry_persist"] = persistRetrievalTelemetry(
        runtime,
        "memory_list",
        workspaceId,
        telemetryPayload,
      );
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  } catch (err) {
    return buildReadToolErrorResult("memory_list", workspaceId, err);
  } finally {
    readHandle?.close();
  }
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
