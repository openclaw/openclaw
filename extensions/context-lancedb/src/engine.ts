import fs from "node:fs/promises";
import path from "node:path";
import type * as LanceDb from "@lancedb/lancedb";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  CompactionEntry,
  CustomMessageEntry,
  FileEntry,
  SessionMessageEntry,
} from "@mariozechner/pi-coding-agent";
import type {
  AssembleResult,
  BootstrapResult,
  CompactResult,
  ContextEngine,
  ContextEngineInfo,
  IngestResult,
} from "openclaw/plugin-sdk/compat";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { resolveDefaultSessionStorePath } from "../../../src/config/sessions/paths.js";
import { loadSessionStore, normalizeStoreSessionKey } from "../../../src/config/sessions/store.js";
import type { SessionEntry } from "../../../src/config/sessions/types.js";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderResult,
} from "../../../src/memory/embeddings.js";
import type { PluginLogger } from "../../../src/plugins/types.js";
import { extractTextFromChatContent } from "../../../src/shared/chat-content.js";
import { resolveLanceDbContextConfig, type ResolvedLanceDbContextConfig } from "./config.js";

const SESSIONS_TABLE = "ce_sessions";
const MESSAGES_TABLE = "ce_messages";
const SUMMARIES_TABLE = "ce_summaries";
const SYNC_STATE_TABLE = "ce_sync_state";

type TableName =
  | typeof SESSIONS_TABLE
  | typeof MESSAGES_TABLE
  | typeof SUMMARIES_TABLE
  | typeof SYNC_STATE_TABLE;

type SessionRow = {
  session_id: string;
  session_key: string;
  active_summary_id: string | null;
  latest_message_seq: number;
  summary_covered_until_seq: number;
  updated_at: number;
};

type MessageRole = "user" | "assistant" | "tool" | "toolResult" | "other";

type MessageRow = {
  message_id: string;
  session_id: string;
  session_key: string;
  message_seq: number;
  turn_seq: number;
  role: MessageRole;
  text: string;
  embedding: number[] | null;
};

type SummaryRow = {
  summary_id: string;
  session_id: string;
  session_key: string;
  end_seq: number;
  text: string;
  embedding: number[] | null;
};

type SyncStateRow = {
  session_id: string;
  session_file: string;
  last_ingested_line: number;
  last_optimized_at: number | null;
};

type ContextEngineRuntimeContext = Record<string, unknown>;

type EmbeddingTask = {
  kind: "message" | "summary";
  id: string;
  text: string;
};

type HistoricalTurn = {
  sessionId: string;
  turnSeq: number;
  score: number;
  text: string;
};

type SearchResult<T> = {
  row: T;
  score: number;
};

type EngineDeps = {
  loadLanceDb?: () => Promise<typeof import("@lancedb/lancedb")>;
  embeddingProviderFactory?: (params: {
    config: OpenClawConfig;
    resolved: ResolvedLanceDbContextConfig;
    agentDir?: string;
  }) => Promise<EmbeddingProviderResult>;
};

let lancedbImportPromise: Promise<typeof import("@lancedb/lancedb")> | null = null;
const maintenanceJobs = new Map<string, Promise<void>>();

const loadLanceDb = async (): Promise<typeof import("@lancedb/lancedb")> => {
  if (!lancedbImportPromise) {
    lancedbImportPromise = import("@lancedb/lancedb");
  }
  try {
    return await lancedbImportPromise;
  } catch (err) {
    throw new Error(`lancedb-context: failed to load LanceDB. ${String(err)}`, { cause: err });
  }
};

function quoteSql(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function normalizeSessionKey(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "";
  }
  return normalizeStoreSessionKey(trimmed);
}

function normalizeTextFingerprint(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const clipped = text.slice(0, Math.max(0, maxChars - 3)).trimEnd();
  return `${clipped}...`;
}

function coerceNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return fallback;
}

function coerceString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function coerceNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function coerceVector(value: unknown): number[] | null {
  if (Array.isArray(value)) {
    const vector = value.map((item) => Number(item)).filter((item) => Number.isFinite(item));
    return vector.length > 0 ? vector : null;
  }
  if (value instanceof Float32Array || value instanceof Float64Array) {
    const vector = Array.from(value).filter((item) => Number.isFinite(item));
    return vector.length > 0 ? vector : null;
  }
  return null;
}

function coerceSessionRow(row: Record<string, unknown>): SessionRow {
  return {
    session_id: coerceString(row.session_id),
    session_key: coerceString(row.session_key),
    active_summary_id: coerceNullableString(row.active_summary_id),
    latest_message_seq: coerceNumber(row.latest_message_seq),
    summary_covered_until_seq: coerceNumber(row.summary_covered_until_seq),
    updated_at: coerceNumber(row.updated_at),
  };
}

function coerceMessageRow(row: Record<string, unknown>): MessageRow {
  return {
    message_id: coerceString(row.message_id),
    session_id: coerceString(row.session_id),
    session_key: coerceString(row.session_key),
    message_seq: coerceNumber(row.message_seq),
    turn_seq: coerceNumber(row.turn_seq),
    role: normalizeRole(row.role),
    text: coerceString(row.text),
    embedding: coerceVector(row.embedding),
  };
}

function coerceSummaryRow(row: Record<string, unknown>): SummaryRow {
  return {
    summary_id: coerceString(row.summary_id),
    session_id: coerceString(row.session_id),
    session_key: coerceString(row.session_key),
    end_seq: coerceNumber(row.end_seq),
    text: coerceString(row.text),
    embedding: coerceVector(row.embedding),
  };
}

function coerceSyncStateRow(row: Record<string, unknown>): SyncStateRow {
  return {
    session_id: coerceString(row.session_id),
    session_file: coerceString(row.session_file),
    last_ingested_line: coerceNumber(row.last_ingested_line),
    last_optimized_at:
      typeof row.last_optimized_at === "number" && Number.isFinite(row.last_optimized_at)
        ? row.last_optimized_at
        : null,
  };
}

function estimateTextTokens(text: string): number {
  if (!text.trim()) {
    return 0;
  }
  return Math.max(1, Math.ceil(text.length / 4));
}

function estimateMessageTokens(message: AgentMessage): number {
  const text = extractTextFromChatContent((message as { content?: unknown }).content) ?? "";
  return estimateTextTokens(text);
}

function dotProduct(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return -1;
  }
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) {
    sum += left[index]! * right[index]!;
  }
  return sum;
}

function normalizeRole(role: unknown): MessageRole {
  const value = typeof role === "string" ? role.trim().toLowerCase() : "";
  if (value === "user" || value === "assistant") {
    return value;
  }
  if (value === "tool" || value === "tool_use" || value === "toolcall" || value === "tool_call") {
    return "tool";
  }
  if (value === "toolresult" || value === "tool_result" || value === "tool_result_error") {
    return "toolResult";
  }
  return "other";
}

function isToolLikeRole(role: MessageRole): boolean {
  return role === "tool" || role === "toolResult";
}

function extractMessageText(content: unknown): string {
  return (
    extractTextFromChatContent(content, {
      joinWith: "\n",
      normalizeText: (text) => text.replace(/\s+/g, " ").trim(),
    }) ?? ""
  );
}

function groupMessagesIntoTurns(messages: AgentMessage[]): AgentMessage[][] {
  const turns: AgentMessage[][] = [];
  let current: AgentMessage[] = [];

  for (const message of messages) {
    const role = normalizeRole((message as { role?: unknown }).role);
    if (role === "user" && current.length > 0) {
      turns.push(current);
      current = [message];
      continue;
    }
    current.push(message);
  }

  if (current.length > 0) {
    turns.push(current);
  }

  return turns;
}

function formatCurrentSummary(text: string): string {
  return text.trim();
}

function formatHistoricalSummary(row: SummaryRow): string {
  return `Session ${row.session_id} summary:\n${row.text.trim()}`;
}

function formatHistoricalTurn(turn: HistoricalTurn): string {
  return `Session ${turn.sessionId} turn ${turn.turnSeq}:\n${turn.text.trim()}`;
}

function buildPromptSections(
  sections: Array<{ title: string; blocks: string[] }>,
): string | undefined {
  const rendered = sections
    .filter((section) => section.blocks.length > 0)
    .map((section) => `${section.title}:\n${section.blocks.join("\n\n")}`)
    .join("\n\n");
  return rendered.trim() ? rendered : undefined;
}

function selectRecentTail(
  messages: AgentMessage[],
  tailBudget: number,
): {
  messages: AgentMessage[];
  tokens: number;
  textFingerprints: Set<string>;
} {
  const turns = groupMessagesIntoTurns(messages);
  const kept: AgentMessage[][] = [];
  let usedTokens = 0;

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index] ?? [];
    const turnTokens = turn.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    if (kept.length > 0 && usedTokens + turnTokens > tailBudget) {
      break;
    }
    kept.unshift(turn);
    usedTokens += turnTokens;
  }

  const flat = kept.flat();
  const textFingerprints = new Set(
    flat
      .map((message) =>
        normalizeTextFingerprint(
          extractTextFromChatContent((message as { content?: unknown }).content) ?? "",
        ),
      )
      .filter(Boolean),
  );

  return {
    messages: flat,
    tokens: usedTokens,
    textFingerprints,
  };
}

function shouldScheduleMaintenance(params: {
  syncState: SyncStateRow | null;
  importedRows: number;
  optimizeIntervalMinutes: number;
  nowMs: number;
}): boolean {
  if (params.importedRows === 0) {
    return false;
  }
  if (params.importedRows >= 100) {
    return true;
  }
  const lastOptimizedAt = params.syncState?.last_optimized_at;
  if (lastOptimizedAt == null) {
    return true;
  }
  return params.nowMs - lastOptimizedAt >= params.optimizeIntervalMinutes * 60_000;
}

function extractAgentIdFromSessionFile(sessionFile: string): string | undefined {
  const parts = path.resolve(sessionFile).split(path.sep).filter(Boolean);
  const sessionsIndex = parts.lastIndexOf("sessions");
  if (sessionsIndex < 2 || parts[sessionsIndex - 2] !== "agents") {
    return undefined;
  }
  return parts[sessionsIndex - 1] || undefined;
}

function extractAgentDirFromSessionFile(sessionFile: string): string | undefined {
  const resolved = path.resolve(sessionFile);
  const parts = resolved.split(path.sep).filter(Boolean);
  const sessionsIndex = parts.lastIndexOf("sessions");
  if (sessionsIndex < 2 || parts[sessionsIndex - 2] !== "agents") {
    return undefined;
  }

  const agentRoot = path.join(path.sep, ...parts.slice(0, sessionsIndex));
  return path.join(agentRoot, "agent");
}

function parseTranscriptEntries(content: string): {
  entries: Array<{ line: number; entry: FileEntry }>;
  totalLines: number;
} {
  const lines = content.split(/\r?\n/);
  const entries: Array<{ line: number; entry: FileEntry }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line?.trim()) {
      continue;
    }
    try {
      entries.push({
        line: index + 1,
        entry: JSON.parse(line) as FileEntry,
      });
    } catch {
      // Ignore malformed transcript lines and continue indexing the rest.
    }
  }

  return {
    entries,
    totalLines: lines.length,
  };
}

class LanceDbContextEngineImpl implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "lancedb-context",
    name: "LanceDB Context Engine",
    version: "1.0.0",
    ownsCompaction: false,
  };

  private db: LanceDb.Connection | null = null;
  private tables: Partial<Record<TableName, LanceDb.Table>> = {};
  private initPromise: Promise<void> | null = null;
  private embeddingProviderPromises = new Map<string, Promise<EmbeddingProviderResult>>();

  constructor(
    private readonly resolved: ResolvedLanceDbContextConfig,
    private readonly logger: PluginLogger,
    private readonly deps: Required<EngineDeps>,
  ) {}

  async bootstrap(params: { sessionId: string; sessionFile: string }): Promise<BootstrapResult> {
    const importedMessages = await this.syncSession({
      sessionId: params.sessionId,
      sessionFile: params.sessionFile,
      reason: "bootstrap",
    });
    return {
      bootstrapped: true,
      importedMessages,
    };
  }

  async ingest(_params: {
    sessionId: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    return { ingested: false };
  }

  async afterTurn(params: {
    sessionId: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<void> {
    const sessionKey = normalizeSessionKey(
      typeof params.runtimeContext?.sessionKey === "string"
        ? params.runtimeContext.sessionKey
        : undefined,
    );
    const agentDir =
      typeof params.runtimeContext?.agentDir === "string"
        ? params.runtimeContext.agentDir
        : undefined;
    await this.syncSession({
      sessionId: params.sessionId,
      sessionFile: params.sessionFile,
      sessionKey,
      agentDir,
      reason: "afterTurn",
    });
  }

  async assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    await this.ensureInitialized();

    const sessionRow = await this.getSessionRow(params.sessionId);
    if (!sessionRow) {
      return {
        messages: params.messages,
        estimatedTokens: 0,
      };
    }

    const currentSummary =
      sessionRow.active_summary_id != null
        ? await this.getSummaryRow(sessionRow.active_summary_id)
        : null;
    const currentSessionKey = await this.ensureSessionKey(sessionRow);
    const syncState = await this.getSyncStateRow(params.sessionId);
    const agentDir = syncState?.session_file
      ? extractAgentDirFromSessionFile(syncState.session_file)
      : undefined;

    const effectiveTokenBudget =
      params.tokenBudget && params.tokenBudget > 0 ? params.tokenBudget : 0;
    const tailBudget =
      effectiveTokenBudget > 0
        ? Math.max(
            1_024,
            Math.min(
              this.resolved.assembly.recentTailTokens,
              Math.floor(effectiveTokenBudget * 0.55),
            ),
          )
        : this.resolved.assembly.recentTailTokens;
    const recentTail = selectRecentTail(params.messages, tailBudget);

    const queryText = this.extractQueryText(params.messages);
    const provider = await this.getActiveEmbeddingProvider(agentDir);
    let queryEmbedding: number[] | null = null;
    if (provider && queryText) {
      try {
        queryEmbedding = await provider.embedQuery(queryText);
      } catch (err) {
        this.logger.warn(`lancedb-context: query embedding failed: ${String(err)}`);
      }
    }

    const historicalSummaries =
      currentSessionKey && queryEmbedding
        ? await this.searchHistoricalSummaries({
            currentSessionId: params.sessionId,
            sessionKey: currentSessionKey,
            queryEmbedding,
          })
        : [];
    const summarySessionIds = new Set(historicalSummaries.map((row) => row.session_id));

    const historicalTurns =
      currentSessionKey && queryEmbedding
        ? await this.searchHistoricalTurns({
            currentSessionId: params.sessionId,
            sessionKey: currentSessionKey,
            queryEmbedding,
            excludedSessionIds: summarySessionIds,
          })
        : [];

    const currentSessionTurns = queryEmbedding
      ? await this.searchCurrentSessionTurns({
          sessionId: params.sessionId,
          summaryCoveredUntilSeq: sessionRow.summary_covered_until_seq,
          queryEmbedding,
          recentTailFingerprints: recentTail.textFingerprints,
        })
      : [];

    const maxExtraChars =
      effectiveTokenBudget > 0
        ? Math.min(
            this.resolved.assembly.maxRetrievedChars,
            Math.max(1_200, Math.floor((effectiveTokenBudget - recentTail.tokens) * 4)),
          )
        : this.resolved.assembly.maxRetrievedChars;

    const currentSummaryBlock = currentSummary?.text
      ? truncateText(currentSummary.text, Math.max(400, Math.floor(maxExtraChars * 0.4)))
      : "";
    const historicalSummaryBlocks = historicalSummaries
      .slice(0, this.resolved.assembly.retrievalTopK)
      .map((row) =>
        formatHistoricalSummary({
          ...row,
          text: truncateText(row.text, Math.max(300, Math.floor(maxExtraChars * 0.25))),
        }),
      );
    const historicalMessageBlocks = [...historicalTurns, ...currentSessionTurns]
      .slice(0, this.resolved.assembly.retrievalTopK)
      .map((turn) =>
        formatHistoricalTurn({
          ...turn,
          text: truncateText(turn.text, Math.max(250, Math.floor(maxExtraChars * 0.2))),
        }),
      );

    const systemPromptAddition = buildPromptSections([
      {
        title: "Current session summary",
        blocks: currentSummaryBlock ? [formatCurrentSummary(currentSummaryBlock)] : [],
      },
      {
        title: "Relevant history from earlier sessions in this conversation family",
        blocks: historicalSummaryBlocks,
      },
      {
        title: "Relevant prior messages",
        blocks: historicalMessageBlocks,
      },
    ]);

    return {
      messages: recentTail.messages,
      estimatedTokens: recentTail.tokens + estimateTextTokens(systemPromptAddition ?? ""),
      systemPromptAddition,
    };
  }

  async compact(params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<CompactResult> {
    const { compactEmbeddedPiSessionDirect } =
      await import("../../../src/agents/pi-embedded-runner/compact.runtime.js");

    const runtimeContext = params.runtimeContext ?? {};
    const result = await compactEmbeddedPiSessionDirect({
      ...runtimeContext,
      sessionId: params.sessionId,
      sessionFile: params.sessionFile,
      tokenBudget: params.tokenBudget,
      force: params.force,
      customInstructions: params.customInstructions,
      workspaceDir: (runtimeContext.workspaceDir as string) ?? process.cwd(),
    } as Parameters<typeof compactEmbeddedPiSessionDirect>[0]);

    return {
      ok: result.ok,
      compacted: result.compacted,
      reason: result.reason,
      result: result.result
        ? {
            summary: result.result.summary,
            firstKeptEntryId: result.result.firstKeptEntryId,
            tokensBefore: result.result.tokensBefore,
            tokensAfter: result.result.tokensAfter,
            details: result.result.details,
          }
        : undefined,
    };
  }

  async dispose(): Promise<void> {
    // Keep the DB handle warm for the process lifetime.
  }

  private async syncSession(params: {
    sessionId: string;
    sessionFile: string;
    sessionKey?: string;
    agentDir?: string;
    reason: "bootstrap" | "afterTurn";
  }): Promise<number> {
    await this.ensureInitialized();

    const [existingSession, existingSyncState, existingMessages, existingSummaries] =
      await Promise.all([
        this.getSessionRow(params.sessionId),
        this.getSyncStateRow(params.sessionId),
        this.listMessagesForSession(params.sessionId),
        this.listSummariesForSession(params.sessionId),
      ]);

    const resolvedSessionKey =
      normalizeSessionKey(params.sessionKey) ||
      existingSession?.session_key ||
      (await this.resolveSessionKeyFromStore(params.sessionId, params.sessionFile));
    const resolvedAgentDir = params.agentDir ?? extractAgentDirFromSessionFile(params.sessionFile);

    const transcript = await fs.readFile(params.sessionFile, "utf-8").catch((err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    });

    const nowMs = Date.now();
    const parsed = transcript ? parseTranscriptEntries(transcript) : { entries: [], totalLines: 0 };
    const lastIngestedLine = existingSyncState?.last_ingested_line ?? 0;
    const startLine = lastIngestedLine > parsed.totalLines ? 0 : lastIngestedLine;
    const fullReplay = startLine === 0;

    const existingMessagesById = new Map(existingMessages.map((row) => [row.message_id, row]));
    const existingSummariesById = new Map(existingSummaries.map((row) => [row.summary_id, row]));
    const messageSeqById = new Map(
      existingMessages.map((row) => [row.message_id, row.message_seq]),
    );

    let latestMessageSeq = fullReplay
      ? 0
      : Math.max(
          existingSession?.latest_message_seq ?? 0,
          ...existingMessages.map((row) => row.message_seq),
          0,
        );
    let turnSeq = fullReplay ? 0 : Math.max(...existingMessages.map((row) => row.turn_seq), 0);
    let activeSummaryId = fullReplay ? null : (existingSession?.active_summary_id ?? null);
    let summaryCoveredUntilSeq = fullReplay ? 0 : (existingSession?.summary_covered_until_seq ?? 0);

    const importedMessageRows: MessageRow[] = [];
    const importedSummaryRows: SummaryRow[] = [];
    const embeddingTasks: EmbeddingTask[] = [];

    for (const item of parsed.entries) {
      if (item.line <= startLine) {
        const entry = item.entry;
        if (this.isMessageEntry(entry)) {
          const existingRow = existingMessagesById.get(entry.id);
          if (existingRow) {
            latestMessageSeq = Math.max(latestMessageSeq, existingRow.message_seq);
            turnSeq = Math.max(turnSeq, existingRow.turn_seq);
          }
        } else if (this.isCompactionEntry(entry)) {
          const existingSummary = existingSummariesById.get(entry.id);
          if (existingSummary) {
            activeSummaryId = existingSummary.summary_id;
            summaryCoveredUntilSeq = Math.max(summaryCoveredUntilSeq, existingSummary.end_seq);
          }
        }
        continue;
      }

      const entry = item.entry;
      if (this.isMessageEntry(entry)) {
        const existingRow = existingMessagesById.get(entry.id);
        const projected = this.projectMessageRow({
          entry,
          sessionId: params.sessionId,
          sessionKey: resolvedSessionKey,
          latestMessageSeq,
          turnSeq,
          existingRow,
        });

        latestMessageSeq = projected.row.message_seq;
        turnSeq = projected.row.turn_seq;
        messageSeqById.set(projected.row.message_id, projected.row.message_seq);
        existingMessagesById.set(projected.row.message_id, projected.row);

        importedMessageRows.push(projected.row);
        if (projected.shouldEmbed) {
          embeddingTasks.push({
            kind: "message",
            id: projected.row.message_id,
            text: projected.row.text,
          });
        }
        continue;
      }

      if (this.isCompactionEntry(entry)) {
        const existingSummary = existingSummariesById.get(entry.id);
        const endSeq = this.resolveCompactionEndSeq({
          compaction: entry,
          messageSeqById,
          latestMessageSeq,
        });
        const summaryRow: SummaryRow = {
          summary_id: entry.id,
          session_id: params.sessionId,
          session_key: resolvedSessionKey,
          end_seq: existingSummary?.end_seq ?? endSeq,
          text: entry.summary,
          embedding: existingSummary?.embedding ?? null,
        };

        if (existingSummary?.text !== summaryRow.text) {
          summaryRow.embedding = null;
        }

        importedSummaryRows.push(summaryRow);
        existingSummariesById.set(summaryRow.summary_id, summaryRow);
        activeSummaryId = summaryRow.summary_id;
        summaryCoveredUntilSeq = Math.max(summaryCoveredUntilSeq, summaryRow.end_seq);

        if (summaryRow.text.trim() && summaryRow.embedding == null) {
          embeddingTasks.push({
            kind: "summary",
            id: summaryRow.summary_id,
            text: truncateText(summaryRow.text, this.resolved.limits.maxMessageCharsForEmbedding),
          });
        }
      }
    }

    if (fullReplay && importedMessageRows.length === 0 && existingMessages.length > 0) {
      latestMessageSeq = Math.max(...existingMessages.map((row) => row.message_seq), 0);
      turnSeq = Math.max(...existingMessages.map((row) => row.turn_seq), 0);
    }

    await this.applyEmbeddings({
      messageRows: importedMessageRows,
      summaryRows: importedSummaryRows,
      tasks: embeddingTasks,
      agentDir: resolvedAgentDir,
    });

    if (resolvedSessionKey && resolvedSessionKey !== existingSession?.session_key) {
      await this.backfillSessionKey(params.sessionId, resolvedSessionKey);
    }

    if (importedMessageRows.length > 0) {
      await this.upsertRows(MESSAGES_TABLE, "message_id", importedMessageRows);
    }
    if (importedSummaryRows.length > 0) {
      await this.upsertRows(SUMMARIES_TABLE, "summary_id", importedSummaryRows);
    }

    const nextSessionRow: SessionRow = {
      session_id: params.sessionId,
      session_key: resolvedSessionKey,
      active_summary_id: activeSummaryId,
      latest_message_seq: latestMessageSeq,
      summary_covered_until_seq: summaryCoveredUntilSeq,
      updated_at: nowMs,
    };
    const nextSyncState: SyncStateRow = {
      session_id: params.sessionId,
      session_file: params.sessionFile,
      last_ingested_line: transcript ? parsed.totalLines : lastIngestedLine,
      last_optimized_at: existingSyncState?.last_optimized_at ?? null,
    };

    await this.upsertRows(SESSIONS_TABLE, "session_id", [nextSessionRow]);
    await this.upsertRows(SYNC_STATE_TABLE, "session_id", [nextSyncState]);

    const importedRowCount = importedMessageRows.length + importedSummaryRows.length;
    if (
      shouldScheduleMaintenance({
        syncState: existingSyncState,
        importedRows: importedRowCount,
        optimizeIntervalMinutes: this.resolved.maintenance.optimizeIntervalMinutes,
        nowMs,
      })
    ) {
      this.scheduleMaintenance(params.sessionId);
    }

    return importedMessageRows.length;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.db) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }
    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const lancedb = await this.deps.loadLanceDb();
    this.db = await lancedb.connect(this.resolved.dbPath);
    const existingTables = new Set(await this.db.tableNames());

    this.tables[SESSIONS_TABLE] = existingTables.has(SESSIONS_TABLE)
      ? await this.db.openTable(SESSIONS_TABLE)
      : await this.createTableWithSentinel(SESSIONS_TABLE, this.createSessionSentinelRow());
    this.tables[MESSAGES_TABLE] = existingTables.has(MESSAGES_TABLE)
      ? await this.db.openTable(MESSAGES_TABLE)
      : await this.createTableWithSentinel(MESSAGES_TABLE, this.createMessageSentinelRow());
    this.tables[SUMMARIES_TABLE] = existingTables.has(SUMMARIES_TABLE)
      ? await this.db.openTable(SUMMARIES_TABLE)
      : await this.createTableWithSentinel(SUMMARIES_TABLE, this.createSummarySentinelRow());
    this.tables[SYNC_STATE_TABLE] = existingTables.has(SYNC_STATE_TABLE)
      ? await this.db.openTable(SYNC_STATE_TABLE)
      : await this.createTableWithSentinel(SYNC_STATE_TABLE, this.createSyncStateSentinelRow());
  }

  private async createTableWithSentinel(
    name: TableName,
    sentinelRow: Record<string, unknown>,
  ): Promise<LanceDb.Table> {
    if (!this.db) {
      throw new Error("lancedb-context: database is not initialized");
    }
    const table = await this.db.createTable(name, [sentinelRow]);
    const key = Object.keys(sentinelRow)[0];
    if (typeof key === "string" && typeof sentinelRow[key] === "string") {
      await table.delete(`${key} = ${quoteSql(String(sentinelRow[key]))}`);
    }
    return table;
  }

  private createSessionSentinelRow(): SessionRow {
    return {
      session_id: "__schema__",
      session_key: "",
      active_summary_id: null,
      latest_message_seq: 0,
      summary_covered_until_seq: 0,
      updated_at: 0,
    };
  }

  private createMessageSentinelRow(): MessageRow {
    return {
      message_id: "__schema__",
      session_id: "",
      session_key: "",
      message_seq: 0,
      turn_seq: 0,
      role: "other",
      text: "",
      embedding: Array.from({ length: this.resolved.embedding.dimensions }, () => 0),
    };
  }

  private createSummarySentinelRow(): SummaryRow {
    return {
      summary_id: "__schema__",
      session_id: "",
      session_key: "",
      end_seq: 0,
      text: "",
      embedding: Array.from({ length: this.resolved.embedding.dimensions }, () => 0),
    };
  }

  private createSyncStateSentinelRow(): SyncStateRow {
    return {
      session_id: "__schema__",
      session_file: "",
      last_ingested_line: 0,
      last_optimized_at: null,
    };
  }

  private async getTable(name: TableName): Promise<LanceDb.Table> {
    await this.ensureInitialized();
    const table = this.tables[name];
    if (!table) {
      throw new Error(`lancedb-context: table ${name} not initialized`);
    }
    return table;
  }

  private async upsertRows<T extends Record<string, unknown>>(
    tableName: TableName,
    key: keyof T & string,
    rows: T[],
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    const table = await this.getTable(tableName);
    await table.mergeInsert(key).whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(rows);
  }

  private async queryRows(
    tableName: TableName,
    filter?: string,
  ): Promise<Array<Record<string, unknown>>> {
    const table = await this.getTable(tableName);
    const query = filter ? table.query().where(filter) : table.query();
    return (await query.toArray()) as Array<Record<string, unknown>>;
  }

  private async getSessionRow(sessionId: string): Promise<SessionRow | null> {
    const rows = await this.queryRows(SESSIONS_TABLE, `session_id = ${quoteSql(sessionId)}`);
    const first = rows[0];
    return first ? coerceSessionRow(first) : null;
  }

  private async getSyncStateRow(sessionId: string): Promise<SyncStateRow | null> {
    const rows = await this.queryRows(SYNC_STATE_TABLE, `session_id = ${quoteSql(sessionId)}`);
    const first = rows[0];
    return first ? coerceSyncStateRow(first) : null;
  }

  private async getSummaryRow(summaryId: string): Promise<SummaryRow | null> {
    const rows = await this.queryRows(SUMMARIES_TABLE, `summary_id = ${quoteSql(summaryId)}`);
    const first = rows[0];
    return first ? coerceSummaryRow(first) : null;
  }

  private async listSessionsByKey(sessionKey: string): Promise<SessionRow[]> {
    const rows = await this.queryRows(SESSIONS_TABLE, `session_key = ${quoteSql(sessionKey)}`);
    return rows
      .map((row) => coerceSessionRow(row))
      .sort((left, right) => right.updated_at - left.updated_at);
  }

  private async listMessagesForSession(sessionId: string): Promise<MessageRow[]> {
    const rows = await this.queryRows(MESSAGES_TABLE, `session_id = ${quoteSql(sessionId)}`);
    return rows
      .map((row) => coerceMessageRow(row))
      .sort((left, right) => left.message_seq - right.message_seq);
  }

  private async listSummariesForSession(sessionId: string): Promise<SummaryRow[]> {
    const rows = await this.queryRows(SUMMARIES_TABLE, `session_id = ${quoteSql(sessionId)}`);
    return rows
      .map((row) => coerceSummaryRow(row))
      .sort((left, right) => left.end_seq - right.end_seq);
  }

  private async resolveSessionKeyFromStore(
    sessionId: string,
    sessionFile: string,
  ): Promise<string> {
    const candidates = [path.join(path.dirname(path.resolve(sessionFile)), "sessions.json")];
    const agentId = extractAgentIdFromSessionFile(sessionFile);
    if (agentId) {
      candidates.push(resolveDefaultSessionStorePath(agentId));
    }

    for (const candidate of new Set(candidates)) {
      try {
        const store = loadSessionStore(candidate);
        let bestKey = "";
        let bestUpdatedAt = -1;
        for (const [sessionKey, entry] of Object.entries(store)) {
          const typed = entry as SessionEntry | undefined;
          if (!typed || typed.sessionId !== sessionId) {
            continue;
          }
          const updatedAt = typed.updatedAt ?? 0;
          if (updatedAt >= bestUpdatedAt) {
            bestKey = normalizeSessionKey(sessionKey);
            bestUpdatedAt = updatedAt;
          }
        }
        if (bestKey) {
          return bestKey;
        }
      } catch {
        // Best-effort lookup only.
      }
    }

    return "";
  }

  private async ensureSessionKey(sessionRow: SessionRow): Promise<string> {
    if (sessionRow.session_key) {
      return sessionRow.session_key;
    }
    const syncState = await this.getSyncStateRow(sessionRow.session_id);
    if (!syncState?.session_file) {
      return "";
    }
    const resolved = await this.resolveSessionKeyFromStore(
      sessionRow.session_id,
      syncState.session_file,
    );
    if (!resolved) {
      return "";
    }
    await this.backfillSessionKey(sessionRow.session_id, resolved);
    await this.upsertRows(SESSIONS_TABLE, "session_id", [
      {
        ...sessionRow,
        session_key: resolved,
      },
    ]);
    return resolved;
  }

  private async backfillSessionKey(sessionId: string, sessionKey: string): Promise<void> {
    const normalized = normalizeSessionKey(sessionKey);
    if (!normalized) {
      return;
    }

    const [messages, summaries] = await Promise.all([
      this.listMessagesForSession(sessionId),
      this.listSummariesForSession(sessionId),
    ]);

    const messageUpdates = messages
      .filter((row) => row.session_key !== normalized)
      .map((row) => ({ ...row, session_key: normalized }));
    const summaryUpdates = summaries
      .filter((row) => row.session_key !== normalized)
      .map((row) => ({ ...row, session_key: normalized }));

    await Promise.all([
      messageUpdates.length > 0
        ? this.upsertRows(MESSAGES_TABLE, "message_id", messageUpdates)
        : Promise.resolve(),
      summaryUpdates.length > 0
        ? this.upsertRows(SUMMARIES_TABLE, "summary_id", summaryUpdates)
        : Promise.resolve(),
    ]);
  }

  private isMessageEntry(entry: FileEntry): entry is SessionMessageEntry | CustomMessageEntry {
    return entry.type === "message" || entry.type === "custom_message";
  }

  private isCompactionEntry(entry: FileEntry): entry is CompactionEntry {
    return entry.type === "compaction";
  }

  private projectMessageRow(params: {
    entry: SessionMessageEntry | CustomMessageEntry;
    sessionId: string;
    sessionKey: string;
    latestMessageSeq: number;
    turnSeq: number;
    existingRow?: MessageRow;
  }): {
    row: MessageRow;
    shouldEmbed: boolean;
  } {
    const role =
      params.entry.type === "message"
        ? normalizeRole((params.entry.message as { role?: unknown }).role)
        : "other";
    const rawText =
      params.entry.type === "message"
        ? extractMessageText((params.entry.message as { content?: unknown }).content)
        : extractMessageText(params.entry.content);

    const nextMessageSeq = params.existingRow?.message_seq ?? params.latestMessageSeq + 1;
    const nextTurnSeq =
      params.existingRow?.turn_seq ??
      (role === "user" || params.turnSeq === 0 ? params.turnSeq + 1 : params.turnSeq);

    const text = truncateText(rawText, this.resolved.limits.maxMessageCharsForEmbedding);
    const shouldEmbed =
      text.trim().length > 0 &&
      (!isToolLikeRole(role) || rawText.length <= this.resolved.limits.skipLargeToolResultChars);
    const textChanged = params.existingRow ? params.existingRow.text !== text : true;

    return {
      row: {
        message_id: params.entry.id || `${params.sessionId}:${nextMessageSeq}`,
        session_id: params.sessionId,
        session_key: params.sessionKey,
        message_seq: nextMessageSeq,
        turn_seq: nextTurnSeq,
        role,
        text,
        embedding: textChanged ? null : (params.existingRow?.embedding ?? null),
      },
      shouldEmbed: shouldEmbed && textChanged,
    };
  }

  private resolveCompactionEndSeq(params: {
    compaction: CompactionEntry;
    messageSeqById: Map<string, number>;
    latestMessageSeq: number;
  }): number {
    const firstKeptEntryId = params.compaction.firstKeptEntryId?.trim();
    if (!firstKeptEntryId) {
      return params.latestMessageSeq;
    }
    const firstKeptSeq = params.messageSeqById.get(firstKeptEntryId);
    if (typeof firstKeptSeq === "number") {
      return Math.max(0, firstKeptSeq - 1);
    }
    return params.latestMessageSeq;
  }

  private async getEmbeddingProvider(agentDir?: string): Promise<EmbeddingProviderResult> {
    const cacheKey = agentDir ? path.resolve(agentDir) : "__default__";
    const existing = this.embeddingProviderPromises.get(cacheKey);
    if (existing) {
      return existing;
    }

    const created = this.deps
      .embeddingProviderFactory({
        config: this.resolved.openclawConfig,
        resolved: this.resolved,
        agentDir,
      })
      .catch((err) => {
        this.embeddingProviderPromises.delete(cacheKey);
        throw err;
      });
    this.embeddingProviderPromises.set(cacheKey, created);
    return created;
  }

  private async getActiveEmbeddingProvider(agentDir?: string): Promise<EmbeddingProvider | null> {
    const result = await this.getEmbeddingProvider(agentDir);
    return result.provider;
  }

  private async applyEmbeddings(params: {
    messageRows: MessageRow[];
    summaryRows: SummaryRow[];
    tasks: EmbeddingTask[];
    agentDir?: string;
  }): Promise<void> {
    if (params.tasks.length === 0) {
      return;
    }

    const providerResult = await this.getEmbeddingProvider(params.agentDir);
    if (!providerResult.provider) {
      if (providerResult.providerUnavailableReason) {
        this.logger.warn(
          `lancedb-context: embeddings unavailable; continuing without vectors: ${providerResult.providerUnavailableReason}`,
        );
      }
      return;
    }

    const vectors = await this.embedTexts(
      providerResult.provider,
      params.tasks.map((task) => task.text),
    );
    const byKey = new Map<string, number[]>();
    params.tasks.forEach((task, index) => {
      const vector = vectors[index];
      if (Array.isArray(vector) && vector.length === this.resolved.embedding.dimensions) {
        byKey.set(`${task.kind}:${task.id}`, vector);
      }
    });

    for (const row of params.messageRows) {
      row.embedding = byKey.get(`message:${row.message_id}`) ?? row.embedding;
    }
    for (const row of params.summaryRows) {
      row.embedding = byKey.get(`summary:${row.summary_id}`) ?? row.embedding;
    }
  }

  private async embedTexts(
    provider: EmbeddingProvider,
    texts: string[],
  ): Promise<Array<number[] | null>> {
    try {
      const batch = await provider.embedBatch(texts);
      return batch.map((vector) =>
        vector.length === this.resolved.embedding.dimensions ? vector : null,
      );
    } catch (err) {
      this.logger.warn(
        `lancedb-context: batch embeddings failed, retrying individually: ${String(err)}`,
      );
      const results: Array<number[] | null> = [];
      for (const text of texts) {
        try {
          const vector = await provider.embedQuery(text);
          results.push(vector.length === this.resolved.embedding.dimensions ? vector : null);
        } catch (itemErr) {
          this.logger.warn(`lancedb-context: embedding skipped: ${String(itemErr)}`);
          results.push(null);
        }
      }
      return results;
    }
  }

  private extractQueryText(messages: AgentMessage[]): string {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (normalizeRole((message as { role?: unknown }).role) !== "user") {
        continue;
      }
      const text = extractTextFromChatContent((message as { content?: unknown }).content) ?? "";
      if (text) {
        return text;
      }
    }
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const text =
        extractTextFromChatContent((messages[index] as { content?: unknown }).content) ?? "";
      if (text) {
        return text;
      }
    }
    return "";
  }

  private async searchHistoricalSummaries(params: {
    currentSessionId: string;
    sessionKey: string;
    queryEmbedding: number[];
  }): Promise<SummaryRow[]> {
    const sameKeySessions = (await this.listSessionsByKey(params.sessionKey)).filter(
      (row) => row.session_id !== params.currentSessionId,
    );
    const activeSummaryIds = new Set(
      sameKeySessions
        .map((row) => row.active_summary_id)
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    );
    if (activeSummaryIds.size === 0) {
      return [];
    }

    const rows = await this.vectorSearchRows(
      SUMMARIES_TABLE,
      params.queryEmbedding,
      [
        `session_key = ${quoteSql(params.sessionKey)}`,
        `session_id != ${quoteSql(params.currentSessionId)}`,
        "embedding IS NOT NULL",
      ],
      this.resolved.assembly.retrievalTopK * 6,
      coerceSummaryRow,
    );

    const maxUpdatedAt = Math.max(...sameKeySessions.map((row) => row.updated_at), 1);
    const updatedAtBySession = new Map(
      sameKeySessions.map((row) => [row.session_id, row.updated_at]),
    );

    return rows
      .filter((row) => activeSummaryIds.has(row.summary_id))
      .map((row) => ({
        row,
        score:
          (row.embedding ? dotProduct(params.queryEmbedding, row.embedding) : -1) +
          this.recencyBoost(updatedAtBySession.get(row.session_id), maxUpdatedAt),
      }))
      .filter((item) => item.score >= this.resolved.assembly.retrievalMinScore)
      .sort((left, right) => right.score - left.score)
      .slice(0, this.resolved.assembly.retrievalTopK)
      .map((item) => item.row);
  }

  private async searchHistoricalTurns(params: {
    currentSessionId: string;
    sessionKey: string;
    queryEmbedding: number[];
    excludedSessionIds: Set<string>;
  }): Promise<HistoricalTurn[]> {
    const filterParts = [
      `session_key = ${quoteSql(params.sessionKey)}`,
      `session_id != ${quoteSql(params.currentSessionId)}`,
      "embedding IS NOT NULL",
    ];
    for (const sessionId of params.excludedSessionIds) {
      filterParts.push(`session_id != ${quoteSql(sessionId)}`);
    }

    const rows = await this.searchMessageRows({
      queryEmbedding: params.queryEmbedding,
      filter: filterParts.join(" AND "),
      limit: this.resolved.assembly.retrievalTopK * 8,
    });

    return this.groupTurns(rows);
  }

  private async searchCurrentSessionTurns(params: {
    sessionId: string;
    summaryCoveredUntilSeq: number;
    queryEmbedding: number[];
    recentTailFingerprints: Set<string>;
  }): Promise<HistoricalTurn[]> {
    const filter = [
      `session_id = ${quoteSql(params.sessionId)}`,
      `message_seq > ${Math.max(0, Math.floor(params.summaryCoveredUntilSeq))}`,
      "embedding IS NOT NULL",
    ].join(" AND ");

    const rows = await this.searchMessageRows({
      queryEmbedding: params.queryEmbedding,
      filter,
      limit: this.resolved.assembly.retrievalTopK * 6,
    });

    return this.groupTurns(rows).filter(
      (turn) => !params.recentTailFingerprints.has(normalizeTextFingerprint(turn.text)),
    );
  }

  private async searchMessageRows(params: {
    queryEmbedding: number[];
    filter: string;
    limit: number;
  }): Promise<Array<SearchResult<MessageRow>>> {
    const rows = await this.vectorSearchRows(
      MESSAGES_TABLE,
      params.queryEmbedding,
      [params.filter],
      params.limit,
      coerceMessageRow,
    );

    return rows
      .map((row) => ({
        row,
        score: row.embedding ? dotProduct(params.queryEmbedding, row.embedding) : -1,
      }))
      .filter((item) => item.score >= this.resolved.assembly.retrievalMinScore);
  }

  private async vectorSearchRows<T>(
    tableName: TableName,
    queryEmbedding: number[],
    filters: string[],
    limit: number,
    coerce: (row: Record<string, unknown>) => T,
  ): Promise<T[]> {
    const table = await this.getTable(tableName);
    const filter = filters.filter(Boolean).join(" AND ");
    const query = table.vectorSearch(queryEmbedding);
    const filtered = filter ? query.where(filter) : query;
    const rows = (await filtered.limit(limit).toArray()) as Array<Record<string, unknown>>;
    return rows.map((row) => coerce(row));
  }

  private groupTurns(rows: Array<SearchResult<MessageRow>>): HistoricalTurn[] {
    const groups = new Map<string, HistoricalTurn & { rows: MessageRow[] }>();

    for (const item of rows) {
      const key = `${item.row.session_id}:${item.row.turn_seq}`;
      const existing = groups.get(key);
      if (existing) {
        existing.rows.push(item.row);
        existing.score = Math.max(existing.score, item.score);
        continue;
      }
      groups.set(key, {
        sessionId: item.row.session_id,
        turnSeq: item.row.turn_seq,
        score: item.score,
        text: "",
        rows: [item.row],
      });
    }

    return [...groups.values()]
      .map((group) => ({
        sessionId: group.sessionId,
        turnSeq: group.turnSeq,
        score: group.score,
        text: group.rows
          .sort((left, right) => left.message_seq - right.message_seq)
          .map((row) => `${row.role}: ${row.text}`)
          .join("\n"),
      }))
      .filter((turn) => turn.text.trim().length > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, this.resolved.assembly.retrievalTopK);
  }

  private recencyBoost(updatedAt: number | undefined, maxUpdatedAt: number): number {
    if (!updatedAt || maxUpdatedAt <= 0) {
      return 0;
    }
    return Math.min(0.05, (updatedAt / maxUpdatedAt) * 0.05);
  }

  private scheduleMaintenance(sessionId: string): void {
    const existing = maintenanceJobs.get(this.resolved.dbPath);
    if (existing) {
      return;
    }

    const job = Promise.resolve()
      .then(async () => {
        await this.runMaintenance(sessionId);
      })
      .catch((err) => {
        this.logger.warn(`lancedb-context: maintenance failed: ${String(err)}`);
      })
      .finally(() => {
        maintenanceJobs.delete(this.resolved.dbPath);
      });
    maintenanceJobs.set(this.resolved.dbPath, job);
  }

  private async runMaintenance(sessionId: string): Promise<void> {
    const [sessions, messages, summaries, syncStates, syncState] = await Promise.all([
      this.getTable(SESSIONS_TABLE),
      this.getTable(MESSAGES_TABLE),
      this.getTable(SUMMARIES_TABLE),
      this.getTable(SYNC_STATE_TABLE),
      this.getSyncStateRow(sessionId),
    ]);

    const createIndexIfPossible = async (table: LanceDb.Table, column: string) => {
      try {
        await table.createIndex(column);
      } catch {
        // Best-effort maintenance only.
      }
    };

    await Promise.all([
      createIndexIfPossible(sessions, "session_id"),
      createIndexIfPossible(sessions, "session_key"),
      createIndexIfPossible(messages, "session_id"),
      createIndexIfPossible(messages, "session_key"),
      createIndexIfPossible(messages, "message_seq"),
      createIndexIfPossible(messages, "turn_seq"),
      createIndexIfPossible(messages, "embedding"),
      createIndexIfPossible(summaries, "session_id"),
      createIndexIfPossible(summaries, "session_key"),
      createIndexIfPossible(summaries, "end_seq"),
      createIndexIfPossible(summaries, "embedding"),
      createIndexIfPossible(syncStates, "session_id"),
    ]);

    await Promise.all(
      [sessions, messages, summaries, syncStates].map(async (table) => {
        try {
          await table.optimize();
        } catch {
          // Best-effort maintenance only.
        }
      }),
    );

    if (!syncState) {
      return;
    }
    await this.upsertRows(SYNC_STATE_TABLE, "session_id", [
      {
        ...syncState,
        last_optimized_at: Date.now(),
      },
    ]);
  }
}

function createDefaultEmbeddingProviderFactory(deps?: EngineDeps["embeddingProviderFactory"]) {
  if (deps) {
    return deps;
  }
  return async (params: {
    config: OpenClawConfig;
    resolved: ResolvedLanceDbContextConfig;
    agentDir?: string;
  }) =>
    await createEmbeddingProvider({
      config: params.config,
      agentDir: params.agentDir,
      provider: params.resolved.embedding.provider,
      fallback: params.resolved.embedding.fallback,
      model: params.resolved.embedding.model,
      remote: params.resolved.embedding.remote,
      local: params.resolved.embedding.local,
    });
}

export function createLanceDbContextEngine(params: {
  config: OpenClawConfig;
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  resolvePath: (input: string) => string;
  deps?: EngineDeps;
}): ContextEngine {
  const resolved = resolveLanceDbContextConfig({
    config: params.config,
    pluginConfig: params.pluginConfig,
    resolvePath: params.resolvePath,
  });

  return new LanceDbContextEngineImpl(resolved, params.logger, {
    loadLanceDb: params.deps?.loadLanceDb ?? loadLanceDb,
    embeddingProviderFactory: createDefaultEmbeddingProviderFactory(
      params.deps?.embeddingProviderFactory,
    ),
  });
}
