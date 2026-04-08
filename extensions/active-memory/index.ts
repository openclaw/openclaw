import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_PROVIDER,
  parseModelRef,
  resolveAgentDir,
  resolveAgentEffectiveModelPrimary,
  resolveAgentWorkspaceDir,
} from "openclaw/plugin-sdk/agent-runtime";
import { resolveSessionStoreEntry, updateSessionStore } from "openclaw/plugin-sdk/config-runtime";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_MEMORIES = 2;
const DEFAULT_MAX_MEMORY_CHARS = 180;
const DEFAULT_RECENT_USER_TURNS = 2;
const DEFAULT_RECENT_ASSISTANT_TURNS = 1;
const DEFAULT_RECENT_USER_CHARS = 220;
const DEFAULT_RECENT_ASSISTANT_CHARS = 180;
const DEFAULT_REQUIRE_CONCRETE_RELEVANCE = true;
const DEFAULT_DROP_GENERIC_PREFERENCES = true;
const DEFAULT_CACHE_TTL_MS = 15_000;
const DEFAULT_MAX_CACHE_ENTRIES = 1000;
const DEFAULT_MODEL_REF = "github-copilot/gpt-5.4-mini";
const DEFAULT_QUERY_MODE = "recent" as const;
const DEFAULT_TRANSCRIPT_DIR = "active-memory";

const NO_RECALL_VALUES = new Set([
  "",
  "none",
  "no_reply",
  "no reply",
  "nothing useful",
  "no relevant memory",
  "no relevant memories",
  "timeout",
  "[]",
  "{}",
  "null",
  "n/a",
]);

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "do",
  "for",
  "from",
  "get",
  "got",
  "had",
  "has",
  "have",
  "i",
  "if",
  "im",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "me",
  "my",
  "not",
  "of",
  "on",
  "or",
  "so",
  "that",
  "the",
  "their",
  "them",
  "then",
  "they",
  "this",
  "to",
  "up",
  "was",
  "we",
  "what",
  "when",
  "with",
  "would",
  "you",
  "your",
]);

const RECALLED_CONTEXT_LINE_PATTERNS = [
  /^🧩\s*active memory:/i,
  /^🔎\s*active memory debug:/i,
  /^🧠\s*memory search:/i,
  /^memory search:/i,
  /^active memory debug:/i,
  /^active memory:/i,
];

type ActiveRecallPluginConfig = {
  agents?: string[];
  model?: string;
  modelFallbackPolicy?: "default-remote" | "resolved-only";
  allowedChatTypes?: Array<"direct" | "group" | "channel">;
  timeoutMs?: number;
  queryMode?: "message" | "recent" | "full";
  maxMemories?: number;
  maxMemoryChars?: number;
  recentUserTurns?: number;
  recentAssistantTurns?: number;
  recentUserChars?: number;
  recentAssistantChars?: number;
  logging?: boolean;
  requireConcreteRelevance?: boolean;
  dropGenericPreferencesOnNonPreferenceTurns?: boolean;
  cacheTtlMs?: number;
  persistTranscripts?: boolean;
  transcriptDir?: string;
};

type ResolvedActiveRecallPluginConfig = {
  agents: string[];
  model?: string;
  modelFallbackPolicy: "default-remote" | "resolved-only";
  allowedChatTypes: Array<"direct" | "group" | "channel">;
  timeoutMs: number;
  queryMode: "message" | "recent" | "full";
  maxMemories: number;
  maxMemoryChars: number;
  recentUserTurns: number;
  recentAssistantTurns: number;
  recentUserChars: number;
  recentAssistantChars: number;
  logging: boolean;
  requireConcreteRelevance: boolean;
  dropGenericPreferencesOnNonPreferenceTurns: boolean;
  cacheTtlMs: number;
  persistTranscripts: boolean;
  transcriptDir: string;
};

type ActiveRecallCandidate = {
  text: string;
  path?: string;
  score?: number;
};

type ActiveRecallRecentTurn = {
  role: "user" | "assistant";
  text: string;
};

type PluginDebugEntry = {
  pluginId: string;
  lines: string[];
};

type ActiveRecallResult =
  | {
      status: "empty" | "timeout" | "unavailable";
      elapsedMs: number;
      memories: ActiveRecallCandidate[];
    }
  | { status: "ok"; elapsedMs: number; rawReply: string; memories: ActiveRecallCandidate[] };

type CachedActiveRecallResult = {
  expiresAt: number;
  result: ActiveRecallResult;
};

type ActiveMemoryChatType = "direct" | "group" | "channel";

const ACTIVE_MEMORY_STATUS_PREFIX = "🧩 Active Memory:";
const ACTIVE_MEMORY_DEBUG_PREFIX = "🔎 Active Memory Debug:";

const activeRecallCache = new Map<string, CachedActiveRecallResult>();

function parseOptionalPositiveInt(value: unknown, fallback: number): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value as number)));
}

function normalizeTranscriptDir(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return DEFAULT_TRANSCRIPT_DIR;
  }
  const normalized = raw.replace(/\\/g, "/");
  const parts = normalized.split("/").map((part) => part.trim());
  const safeParts = parts.filter((part) => part.length > 0 && part !== "." && part !== "..");
  return safeParts.length > 0 ? path.join(...safeParts) : DEFAULT_TRANSCRIPT_DIR;
}

function resolveSafeTranscriptDir(baseSessionsDir: string, transcriptDir: string): string {
  const normalized = transcriptDir.trim();
  if (!normalized || normalized.includes(":") || path.isAbsolute(normalized)) {
    return path.resolve(baseSessionsDir, DEFAULT_TRANSCRIPT_DIR);
  }
  const resolvedBase = path.resolve(baseSessionsDir);
  const candidate = path.resolve(resolvedBase, normalized);
  if (candidate !== resolvedBase && !candidate.startsWith(resolvedBase + path.sep)) {
    return path.resolve(resolvedBase, DEFAULT_TRANSCRIPT_DIR);
  }
  return candidate;
}

function normalizePluginConfig(pluginConfig: unknown): ResolvedActiveRecallPluginConfig {
  const raw = (
    pluginConfig && typeof pluginConfig === "object" ? pluginConfig : {}
  ) as ActiveRecallPluginConfig;
  const allowedChatTypes = Array.isArray(raw.allowedChatTypes)
    ? raw.allowedChatTypes.filter(
        (value): value is ActiveMemoryChatType =>
          value === "direct" || value === "group" || value === "channel",
      )
    : [];
  return {
    agents: Array.isArray(raw.agents)
      ? raw.agents.map((agentId) => String(agentId).trim()).filter(Boolean)
      : [],
    model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : undefined,
    modelFallbackPolicy:
      raw.modelFallbackPolicy === "resolved-only" ? "resolved-only" : "default-remote",
    allowedChatTypes: allowedChatTypes.length > 0 ? allowedChatTypes : ["direct"],
    timeoutMs: clampInt(
      parseOptionalPositiveInt(raw.timeoutMs, DEFAULT_TIMEOUT_MS),
      DEFAULT_TIMEOUT_MS,
      250,
      60_000,
    ),
    queryMode:
      raw.queryMode === "message" || raw.queryMode === "recent" || raw.queryMode === "full"
        ? raw.queryMode
        : DEFAULT_QUERY_MODE,
    maxMemories: clampInt(
      parseOptionalPositiveInt(raw.maxMemories, DEFAULT_MAX_MEMORIES),
      DEFAULT_MAX_MEMORIES,
      1,
      5,
    ),
    maxMemoryChars: clampInt(raw.maxMemoryChars, DEFAULT_MAX_MEMORY_CHARS, 40, 500),
    recentUserTurns: clampInt(raw.recentUserTurns, DEFAULT_RECENT_USER_TURNS, 0, 4),
    recentAssistantTurns: clampInt(raw.recentAssistantTurns, DEFAULT_RECENT_ASSISTANT_TURNS, 0, 3),
    recentUserChars: clampInt(raw.recentUserChars, DEFAULT_RECENT_USER_CHARS, 40, 1000),
    recentAssistantChars: clampInt(
      raw.recentAssistantChars,
      DEFAULT_RECENT_ASSISTANT_CHARS,
      40,
      1000,
    ),
    logging: raw.logging === true,
    requireConcreteRelevance: raw.requireConcreteRelevance ?? DEFAULT_REQUIRE_CONCRETE_RELEVANCE,
    dropGenericPreferencesOnNonPreferenceTurns:
      raw.dropGenericPreferencesOnNonPreferenceTurns ?? DEFAULT_DROP_GENERIC_PREFERENCES,
    cacheTtlMs: clampInt(raw.cacheTtlMs, DEFAULT_CACHE_TTL_MS, 1000, 120_000),
    persistTranscripts: raw.persistTranscripts === true,
    transcriptDir: normalizeTranscriptDir(raw.transcriptDir),
  };
}

function isEnabledForAgent(
  config: ResolvedActiveRecallPluginConfig,
  agentId: string | undefined,
): boolean {
  if (!agentId) {
    return false;
  }
  return config.agents.includes(agentId);
}

function isEligibleInteractiveSession(ctx: {
  trigger?: string;
  sessionKey?: string;
  sessionId?: string;
  messageProvider?: string;
  channelId?: string;
}): boolean {
  if (ctx.trigger !== "user") {
    return false;
  }
  if (!ctx.sessionKey && !ctx.sessionId) {
    return false;
  }
  const provider = (ctx.messageProvider ?? "").trim().toLowerCase();
  if (provider === "webchat") {
    return true;
  }
  return Boolean(ctx.channelId && ctx.channelId.trim());
}

function resolveChatType(ctx: {
  sessionKey?: string;
  messageProvider?: string;
}): ActiveMemoryChatType | undefined {
  const sessionKey = ctx.sessionKey?.trim().toLowerCase();
  if (sessionKey) {
    if (sessionKey.includes(":group:")) {
      return "group";
    }
    if (sessionKey.includes(":channel:")) {
      return "channel";
    }
    if (sessionKey.includes(":direct:") || sessionKey.includes(":dm:")) {
      return "direct";
    }
  }
  const provider = (ctx.messageProvider ?? "").trim().toLowerCase();
  if (provider === "webchat") {
    return "direct";
  }
  return undefined;
}

function isAllowedChatType(
  config: ResolvedActiveRecallPluginConfig,
  ctx: {
    sessionKey?: string;
    messageProvider?: string;
  },
): boolean {
  const chatType = resolveChatType(ctx);
  if (!chatType) {
    return false;
  }
  return config.allowedChatTypes.includes(chatType);
}

function buildCacheKey(params: {
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
  query: string;
}): string {
  const hash = crypto.createHash("sha1").update(params.query).digest("hex");
  return `${params.agentId}:${params.sessionKey ?? params.sessionId ?? "none"}:${hash}`;
}

function getCachedResult(cacheKey: string): ActiveRecallResult | undefined {
  const cached = activeRecallCache.get(cacheKey);
  if (!cached) {
    return undefined;
  }
  if (cached.expiresAt <= Date.now()) {
    activeRecallCache.delete(cacheKey);
    return undefined;
  }
  return cached.result;
}

function setCachedResult(cacheKey: string, result: ActiveRecallResult, ttlMs: number): void {
  sweepExpiredCacheEntries();
  if (activeRecallCache.has(cacheKey)) {
    activeRecallCache.delete(cacheKey);
  }
  activeRecallCache.set(cacheKey, {
    expiresAt: Date.now() + ttlMs,
    result,
  });
  while (activeRecallCache.size > DEFAULT_MAX_CACHE_ENTRIES) {
    const oldestKey = activeRecallCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    activeRecallCache.delete(oldestKey);
  }
}

function sweepExpiredCacheEntries(now = Date.now()): void {
  for (const [cacheKey, cached] of activeRecallCache.entries()) {
    if (cached.expiresAt <= now) {
      activeRecallCache.delete(cacheKey);
    }
  }
}

function shouldCacheResult(result: ActiveRecallResult): boolean {
  return result.status === "ok" || result.status === "empty";
}

function resolveStatusUpdateAgentId(ctx: { agentId?: string; sessionKey?: string }): string {
  const explicit = ctx.agentId?.trim();
  if (explicit) {
    return explicit;
  }
  const sessionKey = ctx.sessionKey?.trim();
  if (!sessionKey) {
    return "";
  }
  const match = /^agent:([^:]+):/i.exec(sessionKey);
  return match?.[1]?.trim() ?? "";
}

function formatElapsedMsCompact(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return "0ms";
  }
  if (elapsedMs >= 1000) {
    const seconds = elapsedMs / 1000;
    return `${seconds % 1 === 0 ? seconds.toFixed(0) : seconds.toFixed(1)}s`;
  }
  return `${Math.round(elapsedMs)}ms`;
}

function buildPluginStatusLine(params: {
  result: ActiveRecallResult;
  config: ResolvedActiveRecallPluginConfig;
}): string {
  const parts = [
    ACTIVE_MEMORY_STATUS_PREFIX,
    params.result.status,
    formatElapsedMsCompact(params.result.elapsedMs),
    params.config.queryMode,
  ];
  if (params.result.status === "ok") {
    parts.push(`${params.result.memories.length} mem`);
  }
  return parts.join(" ");
}

function buildPluginDebugLine(memories: ActiveRecallCandidate[]): string | null {
  const cleaned = memories.map((memory) => sanitizeDebugText(memory.text)).filter(Boolean);
  if (cleaned.length === 0) {
    return null;
  }
  return `${ACTIVE_MEMORY_DEBUG_PREFIX} ${cleaned.join("; ")}`;
}

function sanitizeDebugText(text: string): string {
  let sanitized = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    const isControl = (code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
    if (!isControl) {
      sanitized += ch;
    }
  }
  return sanitized.replace(/\s+/g, " ").trim();
}

async function persistPluginStatusLines(params: {
  api: OpenClawPluginApi;
  agentId: string;
  sessionKey?: string;
  statusLine?: string;
  debugMemories?: ActiveRecallCandidate[];
}): Promise<void> {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey || !params.agentId.trim()) {
    return;
  }
  const debugLine = buildPluginDebugLine(params.debugMemories ?? []);
  try {
    const storePath = params.api.runtime.agent.session.resolveStorePath(
      params.api.config.session?.store,
      {
        agentId: params.agentId,
      },
    );
    if (!params.statusLine && !debugLine) {
      const store = params.api.runtime.agent.session.loadSessionStore(storePath);
      const existingEntry = resolveSessionStoreEntry({ store, sessionKey }).existing;
      const hasActiveMemoryEntry = Array.isArray(existingEntry?.pluginDebugEntries)
        ? existingEntry.pluginDebugEntries.some((entry) => entry?.pluginId === "active-memory")
        : false;
      if (!hasActiveMemoryEntry) {
        return;
      }
    }
    await updateSessionStore(storePath, (store) => {
      const resolved = resolveSessionStoreEntry({ store, sessionKey });
      const existing = resolved.existing;
      if (!existing) {
        return;
      }
      const previousEntries = Array.isArray(existing.pluginDebugEntries)
        ? existing.pluginDebugEntries
        : [];
      const nextEntries = previousEntries.filter(
        (entry): entry is PluginDebugEntry =>
          Boolean(entry) &&
          typeof entry === "object" &&
          typeof entry.pluginId === "string" &&
          entry.pluginId !== "active-memory",
      );
      const nextLines: string[] = [];
      if (params.statusLine) {
        nextLines.push(params.statusLine);
      }
      if (debugLine) {
        nextLines.push(debugLine);
      }
      if (nextLines.length > 0) {
        nextEntries.push({
          pluginId: "active-memory",
          lines: nextLines,
        });
      }
      store[resolved.normalizedKey] = {
        ...existing,
        pluginDebugEntries: nextEntries.length > 0 ? nextEntries : undefined,
      };
    });
  } catch (error) {
    params.api.logger.debug?.(
      `active-memory: failed to persist session status note (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeNoRecallValue(value: string): boolean {
  return NO_RECALL_VALUES.has(value.trim().toLowerCase());
}

function extractLatestUserMessage(query: string): string {
  const marker = "Latest user message:";
  const idx = query.lastIndexOf(marker);
  if (idx >= 0) {
    return query.slice(idx + marker.length).trim();
  }
  return query.trim();
}

function tokenizeMeaningful(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function isPreferenceSeekingTurn(latestUserMessage: string): boolean {
  const text = latestUserMessage.toLowerCase();
  if (
    /\b(what should|should i|which|pick|choose|order|get|grab|buy|listen|watch|drink|eat|want|sounds right|fits me|safe pick|usual|normally|probably|preference|prefer)\b/.test(
      text,
    )
  ) {
    return true;
  }
  return text.endsWith("?");
}

function isGenericPreferenceMemory(memory: string): boolean {
  const text = memory.toLowerCase();
  return /\b(prefers|usually|default|safe pick|comfort food|counts|better dip|default coffee order|likes?|dislikes?)\b/.test(
    text,
  );
}

function filterWeakRecallCandidates(params: {
  query: string;
  candidates: ActiveRecallCandidate[];
  maxMemories: number;
  maxMemoryChars: number;
  requireConcreteRelevance: boolean;
  dropGenericPreferencesOnNonPreferenceTurns: boolean;
}): ActiveRecallCandidate[] {
  const latestUserMessage = extractLatestUserMessage(params.query);
  const latestTokens = new Set(tokenizeMeaningful(latestUserMessage));
  const preferenceSeeking = isPreferenceSeekingTurn(latestUserMessage);
  const filtered = params.candidates.filter((candidate) => {
    const candidateTokens = tokenizeMeaningful(candidate.text);
    const overlap = candidateTokens.filter((token) => latestTokens.has(token)).length;
    if (overlap > 0) {
      return true;
    }
    if (
      params.dropGenericPreferencesOnNonPreferenceTurns &&
      !preferenceSeeking &&
      isGenericPreferenceMemory(candidate.text)
    ) {
      return false;
    }
    if (params.requireConcreteRelevance) {
      return false;
    }
    return preferenceSeeking;
  });
  return filtered.slice(0, params.maxMemories).map((candidate) => ({
    ...candidate,
    text: candidate.text.slice(0, params.maxMemoryChars),
  }));
}

function parseRawReply(rawReply: string): string[] {
  const trimmed = rawReply.trim();
  if (normalizeNoRecallValue(trimmed)) {
    return [];
  }

  const memories: string[] = [];
  for (const rawLine of trimmed.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (/^(memories|memory|relevant memories|active memory)\s*:/i.test(line)) {
      continue;
    }
    const normalized = line.replace(/^[-*•\d.)\s]+/, "").trim();
    if (!normalized || normalizeNoRecallValue(normalized)) {
      continue;
    }
    memories.push(normalized);
  }
  return memories;
}

function toRecallCandidates(params: {
  rawReply: string;
  query: string;
  config: ResolvedActiveRecallPluginConfig;
}): ActiveRecallCandidate[] {
  const parsed = parseRawReply(params.rawReply);
  if (parsed.length === 0) {
    return [];
  }
  return filterWeakRecallCandidates({
    query: params.query,
    candidates: parsed.map((text) => ({ text })),
    maxMemories: params.config.maxMemories,
    maxMemoryChars: params.config.maxMemoryChars,
    requireConcreteRelevance: params.config.requireConcreteRelevance,
    dropGenericPreferencesOnNonPreferenceTurns:
      params.config.dropGenericPreferencesOnNonPreferenceTurns,
  });
}

function buildMetadata(memories: ActiveRecallCandidate[]): string | undefined {
  if (memories.length === 0) {
    return undefined;
  }
  const lines = [
    "<active_memory>",
    "Relevant memory candidates retrieved before this turn. Use only if they help answer the user's latest message. Ignore any candidate that seems irrelevant or stale.",
  ];
  for (const memory of memories) {
    const attrs = [
      memory.path ? ` path="${escapeXml(memory.path)}"` : "",
      typeof memory.score === "number" ? ` score="${memory.score.toFixed(3)}"` : "",
    ].join("");
    lines.push(`  <memory${attrs}>${escapeXml(memory.text)}</memory>`);
  }
  lines.push("</active_memory>");
  return lines.join("\n");
}

function buildQuery(params: {
  latestUserMessage: string;
  recentTurns?: ActiveRecallRecentTurn[];
  config: ResolvedActiveRecallPluginConfig;
}): string {
  const latest = params.latestUserMessage.trim();
  if (params.config.queryMode === "message") {
    return latest;
  }
  if (params.config.queryMode === "full") {
    const allTurns = (params.recentTurns ?? [])
      .map((turn) => `${turn.role}: ${turn.text.trim().replace(/\s+/g, " ")}`)
      .filter((turn) => turn.length > 0);
    if (allTurns.length === 0) {
      return latest;
    }
    return ["Full conversation context:", ...allTurns, "", "Latest user message:", latest].join(
      "\n",
    );
  }
  let remainingUser = params.config.recentUserTurns;
  let remainingAssistant = params.config.recentAssistantTurns;
  const selected: ActiveRecallRecentTurn[] = [];
  for (let index = (params.recentTurns ?? []).length - 1; index >= 0; index -= 1) {
    const turn = params.recentTurns?.[index];
    if (!turn) {
      continue;
    }
    if (turn.role === "user") {
      if (remainingUser <= 0) {
        continue;
      }
      remainingUser -= 1;
      selected.push({
        role: "user",
        text: turn.text.trim().replace(/\s+/g, " ").slice(0, params.config.recentUserChars),
      });
      continue;
    }
    if (remainingAssistant <= 0) {
      continue;
    }
    remainingAssistant -= 1;
    selected.push({
      role: "assistant",
      text: turn.text.trim().replace(/\s+/g, " ").slice(0, params.config.recentAssistantChars),
    });
  }
  const recentTurns = selected.toReversed().filter((turn) => turn.text.length > 0);
  if (recentTurns.length === 0) {
    return latest;
  }
  return [
    "Recent conversation tail:",
    ...recentTurns.map((turn) => `${turn.role}: ${turn.text}`),
    "",
    "Latest user message:",
    latest,
  ].join("\n");
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    if (!item || typeof item !== "object") {
      continue;
    }
    const typed = item as { type?: unknown; text?: unknown; content?: unknown };
    if (typeof typed.text === "string") {
      parts.push(typed.text);
      continue;
    }
    if (typed.type === "text" && typeof typed.content === "string") {
      parts.push(typed.content);
    }
  }
  return parts.join(" ").trim();
}

function stripRecalledContextNoise(text: string): string {
  const cleanedLines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) {
        return false;
      }
      if (line.includes("<active_memory>") || line.includes("</active_memory>")) {
        return false;
      }
      return !RECALLED_CONTEXT_LINE_PATTERNS.some((pattern) => pattern.test(line));
    });
  return cleanedLines.join(" ").replace(/\s+/g, " ").trim();
}

function extractRecentTurns(messages: unknown[]): ActiveRecallRecentTurn[] {
  const turns: ActiveRecallRecentTurn[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const typed = message as { role?: unknown; content?: unknown };
    const role = typed.role === "user" || typed.role === "assistant" ? typed.role : undefined;
    if (!role) {
      continue;
    }
    const rawText = extractTextContent(typed.content);
    const text = role === "assistant" ? stripRecalledContextNoise(rawText) : rawText;
    if (!text) {
      continue;
    }
    turns.push({ role, text });
  }
  return turns;
}

function getModelRef(
  api: OpenClawPluginApi,
  agentId: string,
  config: ResolvedActiveRecallPluginConfig,
  ctx?: {
    modelProviderId?: string;
    modelId?: string;
  },
) {
  const currentRunModel =
    ctx?.modelProviderId && ctx?.modelId ? `${ctx.modelProviderId}/${ctx.modelId}` : undefined;
  const agentPrimaryModel = resolveAgentEffectiveModelPrimary(api.config, agentId);
  const configured =
    config.model ||
    currentRunModel ||
    agentPrimaryModel ||
    (config.modelFallbackPolicy === "default-remote" ? DEFAULT_MODEL_REF : undefined);
  if (!configured) {
    return undefined;
  }
  const parsed = parseModelRef(configured, DEFAULT_PROVIDER);
  if (parsed) {
    return parsed;
  }
  const parsedAgentPrimary = agentPrimaryModel
    ? parseModelRef(agentPrimaryModel, DEFAULT_PROVIDER)
    : undefined;
  return (
    parsedAgentPrimary ?? {
      provider: DEFAULT_PROVIDER,
      model: configured,
    }
  );
}

async function runRecallSidecar(params: {
  api: OpenClawPluginApi;
  config: ResolvedActiveRecallPluginConfig;
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
  query: string;
  currentModelProviderId?: string;
  currentModelId?: string;
  abortSignal?: AbortSignal;
}): Promise<{ rawReply: string; transcriptPath?: string }> {
  const workspaceDir = resolveAgentWorkspaceDir(params.api.config, params.agentId);
  const agentDir = resolveAgentDir(params.api.config, params.agentId);
  const modelRef = getModelRef(params.api, params.agentId, params.config, {
    modelProviderId: params.currentModelProviderId,
    modelId: params.currentModelId,
  });
  if (!modelRef) {
    return { rawReply: "NONE" };
  }
  const sidecarSessionId = `active-memory-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const sidecarScope = params.sessionKey ?? params.sessionId ?? crypto.randomUUID();
  const sidecarSuffix = `active-memory:${crypto
    .createHash("sha1")
    .update(`${sidecarScope}:${params.query}`)
    .digest("hex")
    .slice(0, 12)}`;
  const sidecarSessionKey = params.sessionKey
    ? `${params.sessionKey}:${sidecarSuffix}`
    : `agent:${params.agentId}:${sidecarSuffix}`;
  const storePath = params.api.runtime.agent.session.resolveStorePath(
    params.api.config.session?.store,
    {
      agentId: params.agentId,
    },
  );
  const resolvedStorePath =
    storePath || path.join(os.tmpdir(), "openclaw-active-memory-sessions.json");
  const baseSessionsDir = path.dirname(path.resolve(resolvedStorePath));
  const tempDir = params.config.persistTranscripts
    ? undefined
    : await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-active-memory-"));
  const persistedDir = params.config.persistTranscripts
    ? resolveSafeTranscriptDir(baseSessionsDir, params.config.transcriptDir)
    : undefined;
  if (persistedDir) {
    await fs.mkdir(persistedDir, { recursive: true });
  }
  const sessionFile = params.config.persistTranscripts
    ? path.join(persistedDir!, `${sidecarSessionId}.jsonl`)
    : path.join(tempDir!, "session.jsonl");
  const prompt = [
    "You are Active Memory, a fast sidecar memory model.",
    "Use only memory_search and memory_get.",
    "Search for memories relevant to the user's latest message.",
    "If the provided conversation context already contains recalled-memory summaries, debug output, or prior memory/tool traces, ignore that text and do not search for those same surfaced memories again unless the latest user message clearly requires re-checking them.",
    "Return memories only if they would concretely change or personalize the answer.",
    "If the connection is weak, broad, or only vaguely related, reply with NONE.",
    "Do not return generic lifestyle or food preferences unless the latest user message is clearly asking for a choice, recommendation, habit, or preference-sensitive answer.",
    "If nothing seems strongly useful, reply with NONE.",
    "If something is useful, reply with up to 3 short bullet points only.",
    "Do not answer the user directly.",
    "Do not explain your reasoning.",
    "",
    "Conversation context:",
    params.query,
  ].join("\n");

  try {
    const result = await params.api.runtime.agent.runEmbeddedPiAgent({
      sessionId: sidecarSessionId,
      sessionKey: sidecarSessionKey,
      agentId: params.agentId,
      sessionFile,
      workspaceDir,
      agentDir,
      config: params.api.config,
      prompt,
      provider: modelRef.provider,
      model: modelRef.model,
      timeoutMs: params.config.timeoutMs,
      runId: sidecarSessionId,
      trigger: "manual",
      toolsAllow: ["memory_search", "memory_get"],
      disableMessageTool: true,
      bootstrapContextMode: "lightweight",
      verboseLevel: "off",
      thinkLevel: "off",
      reasoningLevel: "off",
      silentExpected: true,
      abortSignal: params.abortSignal,
    });
    const rawReply = (result.payloads ?? [])
      .map((payload) => payload.text?.trim() ?? "")
      .filter(Boolean)
      .join("\n")
      .trim();
    return {
      rawReply: rawReply || "NONE",
      transcriptPath: params.config.persistTranscripts ? sessionFile : undefined,
    };
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function maybeResolveActiveRecall(params: {
  api: OpenClawPluginApi;
  config: ResolvedActiveRecallPluginConfig;
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
  query: string;
  currentModelProviderId?: string;
  currentModelId?: string;
}): Promise<ActiveRecallResult> {
  const startedAt = Date.now();
  const cacheKey = buildCacheKey({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    query: params.query,
  });
  const cached = getCachedResult(cacheKey);
  const logPrefix = `active-memory: agent=${params.agentId} session=${params.sessionKey ?? params.sessionId ?? "none"}`;
  if (cached) {
    await persistPluginStatusLines({
      api: params.api,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      statusLine: `${buildPluginStatusLine({ result: cached, config: params.config })} cached`,
      debugMemories: cached.memories,
    });
    if (params.config.logging) {
      params.api.logger.info?.(
        `${logPrefix} cached status=${cached.status} memories=${String(cached.memories.length)} queryChars=${String(params.query.length)}`,
      );
    }
    return cached;
  }

  if (params.config.logging) {
    params.api.logger.info?.(
      `${logPrefix} start timeoutMs=${String(params.config.timeoutMs)} queryChars=${String(params.query.length)}`,
    );
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error(`active-memory timeout after ${params.config.timeoutMs}ms`));
  }, params.config.timeoutMs);
  timeoutId.unref?.();

  try {
    const { rawReply, transcriptPath } = await runRecallSidecar({
      ...params,
      abortSignal: controller.signal,
    });
    const memories = toRecallCandidates({
      rawReply,
      query: params.query,
      config: params.config,
    });
    if (params.config.logging && transcriptPath) {
      params.api.logger.info?.(`${logPrefix} transcript=${transcriptPath}`);
    }
    const result = {
      status: memories.length > 0 ? ("ok" as const) : ("empty" as const),
      elapsedMs: Date.now() - startedAt,
      rawReply,
      memories,
    } satisfies ActiveRecallResult;
    if (params.config.logging) {
      params.api.logger.info?.(
        `${logPrefix} done status=${result.status} elapsedMs=${String(result.elapsedMs)} memories=${String(result.memories.length)}`,
      );
    }
    await persistPluginStatusLines({
      api: params.api,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      statusLine: buildPluginStatusLine({ result, config: params.config }),
      debugMemories: result.memories,
    });
    if (shouldCacheResult(result)) {
      setCachedResult(cacheKey, result, params.config.cacheTtlMs);
    }
    return result;
  } catch (error) {
    if (controller.signal.aborted) {
      const result: ActiveRecallResult = {
        status: "timeout",
        elapsedMs: Date.now() - startedAt,
        memories: [],
      };
      if (params.config.logging) {
        params.api.logger.info?.(
          `${logPrefix} done status=${result.status} elapsedMs=${String(result.elapsedMs)} memories=${String(result.memories.length)}`,
        );
      }
      await persistPluginStatusLines({
        api: params.api,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        statusLine: buildPluginStatusLine({ result, config: params.config }),
      });
      return result;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (params.config.logging) {
      params.api.logger.warn?.(`${logPrefix} failed error=${message}`);
    }
    const result: ActiveRecallResult = {
      status: "unavailable",
      elapsedMs: Date.now() - startedAt,
      memories: [],
    };
    await persistPluginStatusLines({
      api: params.api,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      statusLine: buildPluginStatusLine({ result, config: params.config }),
    });
    return result;
  } finally {
    clearTimeout(timeoutId);
  }
}

export default definePluginEntry({
  id: "active-memory",
  name: "Active Memory",
  description: "Proactively surfaces relevant memory before eligible conversational replies.",
  register(api: OpenClawPluginApi) {
    const config = normalizePluginConfig(api.pluginConfig);
    api.on("before_prompt_build", async (event, ctx) => {
      const effectiveAgentId = resolveStatusUpdateAgentId(ctx);
      if (!isEnabledForAgent(config, effectiveAgentId)) {
        await persistPluginStatusLines({
          api,
          agentId: effectiveAgentId,
          sessionKey: ctx.sessionKey,
        });
        return;
      }
      if (!isEligibleInteractiveSession(ctx)) {
        await persistPluginStatusLines({
          api,
          agentId: effectiveAgentId,
          sessionKey: ctx.sessionKey,
        });
        return;
      }
      if (!isAllowedChatType(config, ctx)) {
        await persistPluginStatusLines({
          api,
          agentId: effectiveAgentId,
          sessionKey: ctx.sessionKey,
        });
        return;
      }
      const query = buildQuery({
        latestUserMessage: event.prompt,
        recentTurns: extractRecentTurns(event.messages),
        config,
      });
      const result = await maybeResolveActiveRecall({
        api,
        config,
        agentId: effectiveAgentId,
        sessionKey: ctx.sessionKey,
        sessionId: ctx.sessionId,
        query,
        currentModelProviderId: ctx.modelProviderId,
        currentModelId: ctx.modelId,
      });
      if (result.memories.length === 0) {
        return;
      }
      const metadata = buildMetadata(result.memories);
      if (!metadata) {
        return;
      }
      return {
        appendSystemContext: metadata,
      };
    });
  },
});
