import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { ChatHistoryMode } from "./context-policy.js";
import { resolveStateDir } from "../config/paths.js";
import { normalizeAgentId } from "../routing/session-key.js";

export type AgentContextLayout = {
  rootDir: string;
  chatsDir: string;
  chatIndexFile: string;
  memoryDir: string;
  shortTermDir: string;
  midTermDir: string;
  longTermFile: string;
};

export type ChatSummaryRecord = {
  agentId: string;
  chatId: string;
  sessionKey: string;
  sessionId?: string;
  createdAt: number;
  updatedAt: number;
  summaryGeneration: number;
  basedOnPreviousSummary: boolean;
  sourceMessageCount: number;
  currentGoal: string[];
  keyDecisions: string[];
  importantFacts: string[];
  currentStatus: string[];
  nextActions: string[];
  technicalFacts: {
    commitHashes: string[];
    envNames: string[];
    filePaths: string[];
    ids: string[];
    errorSnippets: string[];
  };
};

export type SyntheticSummaryMessage = {
  role: "assistant";
  content: Array<{ type: "text"; text: string }>;
  timestamp: number;
  synthetic: true;
  summary: true;
};

export type ChatIndexEntry = {
  agentId: string;
  chatId: string;
  sessionKey: string;
  sessionId?: string;
  historyMode: ChatHistoryMode;
  summaryUpdatedAt?: number;
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
};

type MessageTextSnapshot = {
  role: string;
  text: string;
};

type TechnicalFactsBucket = ChatSummaryRecord["technicalFacts"];

function sanitizeFileToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "chat";
}

function toChatId(sessionKey: string): string {
  return sanitizeFileToken(Buffer.from(sessionKey).toString("base64url").slice(0, 48));
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath: string, value: unknown) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function extractMessageText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? text.trim() : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function isSyntheticSummaryMessage(message: unknown): message is SyntheticSummaryMessage {
  if (!message || typeof message !== "object") {
    return false;
  }
  const raw = message as Record<string, unknown>;
  return raw.synthetic === true && raw.summary === true && raw.role === "assistant";
}

export function filterSyntheticSummaryMessages(messages: unknown[]): unknown[] {
  const syntheticIndexes = messages
    .map((message, index) => (isSyntheticSummaryMessage(message) ? index : -1))
    .filter((index) => index >= 0);
  if (syntheticIndexes.length <= 1) {
    return messages;
  }
  const keepIndex = syntheticIndexes[syntheticIndexes.length - 1];
  return messages.filter(
    (message, index) => !isSyntheticSummaryMessage(message) || index === keepIndex,
  );
}

function collectMessageSnapshots(messages: unknown[]): MessageTextSnapshot[] {
  return messages
    .map((message) => {
      const role =
        typeof (message as { role?: unknown })?.role === "string"
          ? String((message as { role?: unknown }).role)
          : "unknown";
      return {
        role,
        text: extractMessageText(message),
      };
    })
    .filter((entry) => entry.text.length > 0);
}

function dedupeLines(lines: string[], maxItems: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const normalized = line.replace(/\s+/g, " ").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= maxItems) {
      break;
    }
  }
  return out;
}

function dedupeExact(lines: string[], maxItems: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const value = line.trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
    if (out.length >= maxItems) {
      break;
    }
  }
  return out;
}

function pickImportantLines(
  messages: MessageTextSnapshot[],
  role: string,
  maxItems: number,
): string[] {
  return dedupeLines(
    messages
      .filter((entry) => entry.role === role)
      .flatMap((entry) => entry.text.split(/\n+/))
      .map((line) => line.replace(/^[-*\d.\s]+/, "").trim())
      .filter((line) => line.length > 0),
    maxItems,
  );
}

function pickActionLines(messages: MessageTextSnapshot[], maxItems: number): string[] {
  const candidates = messages.flatMap((entry) =>
    entry.text
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => /^(?:[-*]|\d+\.|todo\b|next\b|action\b)/i.test(line)),
  );
  return dedupeLines(
    candidates.map((line) => line.replace(/^[-*\d.\s]+/, "").trim()),
    maxItems,
  );
}

function buildFallbackStatus(messages: MessageTextSnapshot[]): string[] {
  const last = messages.at(-1)?.text;
  if (!last) {
    return [];
  }
  return [last.replace(/\s+/g, " ").trim()];
}

function extractCurrentGoal(
  messages: MessageTextSnapshot[],
  previous?: ChatSummaryRecord | null,
): string[] {
  const userLines = dedupeLines(
    messages
      .filter((entry) => entry.role === "user")
      .flatMap((entry) => entry.text.split(/\n+/))
      .map((line) => line.replace(/^[-*\d.\s]+/, "").trim())
      .filter(Boolean),
    3,
  );
  if (userLines.length > 0) {
    return userLines.slice(-2);
  }
  return previous?.currentGoal ?? [];
}

function extractTechnicalFacts(messages: MessageTextSnapshot[]): TechnicalFactsBucket {
  const lines = messages.flatMap((entry) => entry.text.split(/\n+/).map((line) => line.trim()));
  const joined = lines.join("\n");
  return {
    commitHashes: dedupeExact(
      Array.from(joined.matchAll(/\b[a-f0-9]{7,40}\b/gi), (match) => match[0]),
      20,
    ),
    envNames: dedupeExact(
      Array.from(joined.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g), (match) => match[0]),
      20,
    ),
    filePaths: dedupeExact(
      Array.from(
        joined.matchAll(
          /(?:[A-Za-z]:\\[^\s]+|(?:\.{0,2}\/|\/)[^\s:]+(?::\d+)?|\.[A-Za-z0-9_.-]+|\b[\w.-]+\/[\w./-]+(?::\d+)?|\b[\w.-]+\.(?:ts|tsx|js|jsx|json|md|py|rs|yaml|yml|sh)(?::\d+)?)\b/g,
        ),
        (match) => match[0],
      ),
      20,
    ),
    ids: dedupeExact(
      Array.from(
        joined.matchAll(
          /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[A-Z]{2,}-\d+|agent:[a-z0-9._-]+:[^\s]+)\b/gi,
        ),
        (match) => match[0],
      ),
      20,
    ),
    errorSnippets: dedupeLines(
      lines.filter((line) =>
        /(?:error|exception|failed|failure|enoent|eacces|traceback)/i.test(line),
      ),
      12,
    ),
  };
}

function mergeTechnicalFacts(
  previous: TechnicalFactsBucket | undefined,
  current: TechnicalFactsBucket,
): TechnicalFactsBucket {
  return {
    commitHashes: dedupeExact([...(previous?.commitHashes ?? []), ...current.commitHashes], 20),
    envNames: dedupeExact([...(previous?.envNames ?? []), ...current.envNames], 20),
    filePaths: dedupeExact([...(previous?.filePaths ?? []), ...current.filePaths], 20),
    ids: dedupeExact([...(previous?.ids ?? []), ...current.ids], 20),
    errorSnippets: dedupeLines([...(previous?.errorSnippets ?? []), ...current.errorSnippets], 12),
  };
}

export function resolveAgentContextLayout(agentId: string): AgentContextLayout {
  const normalized = normalizeAgentId(agentId);
  const rootDir = path.join(resolveStateDir(), "agents", normalized);
  const chatsDir = path.join(rootDir, "chats");
  const memoryDir = path.join(rootDir, "memory");
  return {
    rootDir,
    chatsDir,
    chatIndexFile: path.join(chatsDir, "index.json"),
    memoryDir,
    shortTermDir: path.join(memoryDir, "short_term_chat"),
    midTermDir: path.join(memoryDir, "mid_term_summaries"),
    longTermFile: path.join(memoryDir, "long_term_facts.json"),
  };
}

export function ensureAgentContextLayout(agentId: string): AgentContextLayout {
  const layout = resolveAgentContextLayout(agentId);
  ensureDir(layout.chatsDir);
  ensureDir(layout.shortTermDir);
  ensureDir(layout.midTermDir);
  if (!fs.existsSync(layout.chatIndexFile)) {
    writeJsonFile(layout.chatIndexFile, []);
  }
  if (!fs.existsSync(layout.longTermFile)) {
    writeJsonFile(layout.longTermFile, []);
  }
  return layout;
}

export function ensureConfiguredAgentContextLayouts(cfg: OpenClawConfig) {
  const agentIds = new Set<string>();
  for (const entry of cfg.agents?.list ?? []) {
    if (entry?.id) {
      agentIds.add(normalizeAgentId(entry.id));
    }
  }
  agentIds.add("main");
  for (const agentId of agentIds) {
    ensureAgentContextLayout(agentId);
  }
}

export function buildChatSummaryRecord(params: {
  agentId: string;
  sessionKey: string;
  sessionId?: string;
  messages: unknown[];
  previous?: ChatSummaryRecord | null;
}): ChatSummaryRecord {
  const agentId = normalizeAgentId(params.agentId);
  const chatId = params.previous?.chatId ?? toChatId(params.sessionKey);
  const sourceMessages = params.messages.filter((message) => !isSyntheticSummaryMessage(message));
  const snapshots = collectMessageSnapshots(sourceMessages);
  const technicalFacts = mergeTechnicalFacts(
    params.previous?.technicalFacts,
    extractTechnicalFacts(snapshots),
  );
  const now = Date.now();
  return {
    agentId,
    chatId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    createdAt: params.previous?.createdAt ?? now,
    updatedAt: now,
    summaryGeneration: (params.previous?.summaryGeneration ?? 0) + 1,
    basedOnPreviousSummary: Boolean(params.previous),
    sourceMessageCount: sourceMessages.length,
    currentGoal: extractCurrentGoal(snapshots, params.previous),
    keyDecisions: pickImportantLines(snapshots.slice(-20), "assistant", 5),
    importantFacts: dedupeLines(
      [
        ...pickImportantLines(snapshots.slice(-20), "user", 5),
        ...pickImportantLines(snapshots.slice(-20), "assistant", 5),
      ],
      6,
    ),
    currentStatus: dedupeLines(
      [
        ...pickImportantLines(snapshots.slice(-8), "assistant", 3),
        ...buildFallbackStatus(snapshots),
      ],
      3,
    ),
    nextActions: pickActionLines(snapshots.slice(-20), 5),
    technicalFacts,
  };
}

export function formatChatSummary(summary: ChatSummaryRecord): string {
  const blocks = [
    ["Current goal", summary.currentGoal],
    ["Key decisions", summary.keyDecisions],
    ["Important facts", summary.importantFacts],
    ["Current status", summary.currentStatus],
    [
      "Important technical facts",
      [
        ...summary.technicalFacts.commitHashes.map((item) => `commit/hash: ${item}`),
        ...summary.technicalFacts.envNames.map((item) => `env: ${item}`),
        ...summary.technicalFacts.filePaths.map((item) => `path: ${item}`),
        ...summary.technicalFacts.ids.map((item) => `id: ${item}`),
        ...summary.technicalFacts.errorSnippets.map((item) => `error: ${item}`),
      ],
    ],
    ["Next actions", summary.nextActions],
  ] as const;
  const lines = ["[Context summary]"];
  for (const [label, items] of blocks) {
    if (!items.length) {
      continue;
    }
    lines.push(`${label}:`);
    for (const item of items) {
      lines.push(`- ${item}`);
    }
  }
  return lines.join("\n");
}

export function readChatSummary(params: {
  agentId: string;
  sessionKey: string;
}): ChatSummaryRecord | null {
  const layout = ensureAgentContextLayout(params.agentId);
  const summaryPath = path.join(layout.midTermDir, `${toChatId(params.sessionKey)}.json`);
  return readJsonFile<ChatSummaryRecord | null>(summaryPath, null);
}

export function writeChatSummary(summary: ChatSummaryRecord) {
  const layout = ensureAgentContextLayout(summary.agentId);
  writeJsonFile(path.join(layout.midTermDir, `${summary.chatId}.json`), summary);
  writeJsonFile(path.join(layout.shortTermDir, `${summary.chatId}.json`), {
    sessionKey: summary.sessionKey,
    sessionId: summary.sessionId,
    updatedAt: summary.updatedAt,
    summary: formatChatSummary(summary),
  });
}

export function readChatIndex(agentId: string): ChatIndexEntry[] {
  const layout = ensureAgentContextLayout(agentId);
  return readJsonFile<ChatIndexEntry[]>(layout.chatIndexFile, []);
}

export function upsertChatIndex(params: {
  agentId: string;
  sessionKey: string;
  sessionId?: string;
  historyMode?: ChatHistoryMode;
  archivedAt?: number;
  summaryUpdatedAt?: number;
}) {
  const agentId = normalizeAgentId(params.agentId);
  const layout = ensureAgentContextLayout(agentId);
  const chatId = toChatId(params.sessionKey);
  const items = readChatIndex(agentId);
  const now = Date.now();
  const next: ChatIndexEntry[] = [];
  let found = false;
  for (const item of items) {
    if (item.chatId !== chatId) {
      next.push(item);
      continue;
    }
    found = true;
    next.push({
      ...item,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId ?? item.sessionId,
      historyMode: params.historyMode ?? item.historyMode,
      archivedAt: params.archivedAt ?? item.archivedAt,
      summaryUpdatedAt: params.summaryUpdatedAt ?? item.summaryUpdatedAt,
      updatedAt: now,
    });
  }
  if (!found) {
    next.push({
      agentId,
      chatId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      historyMode: params.historyMode ?? "summary",
      archivedAt: params.archivedAt,
      summaryUpdatedAt: params.summaryUpdatedAt,
      createdAt: now,
      updatedAt: now,
    });
  }
  writeJsonFile(
    layout.chatIndexFile,
    next.toSorted((a, b) => b.updatedAt - a.updatedAt),
  );
}

export function archiveChatIndexEntry(
  agentId: string,
  sessionKey: string,
  archivedAt = Date.now(),
) {
  upsertChatIndex({ agentId, sessionKey, archivedAt });
}

export function syncSessionEntryContextMetadata(params: {
  entry: SessionEntry;
  agentId: string;
  sessionKey: string;
}) {
  params.entry.agentId = normalizeAgentId(params.agentId);
  params.entry.chatId = params.entry.chatId?.trim() || toChatId(params.sessionKey);
  params.entry.historyLoadMode = params.entry.historyLoadMode === "full" ? "full" : "summary";
}

export function buildSummaryContextMessages(params: {
  messages: unknown[];
  summary: ChatSummaryRecord | null;
  tailCount: number;
  mode: ChatHistoryMode;
}): unknown[] {
  const normalizedMessages = filterSyntheticSummaryMessages(params.messages);
  if (params.mode === "full") {
    return normalizedMessages;
  }
  const tailSource = normalizedMessages.filter((message) => !isSyntheticSummaryMessage(message));
  const tail = params.tailCount > 0 ? tailSource.slice(-params.tailCount) : [];
  if (!params.summary) {
    return tail;
  }
  return [
    {
      role: "assistant",
      content: [{ type: "text", text: formatChatSummary(params.summary) }],
      timestamp: params.summary.updatedAt,
      synthetic: true,
      summary: true,
    },
    ...tail,
  ];
}
