import {
  loadSqliteSessionTranscriptEvents,
  resolveSqliteSessionTranscriptScope,
} from "../../config/sessions/transcript-store.sqlite.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import {
  limitAgentHookHistoryMessages,
  MAX_AGENT_HOOK_HISTORY_MESSAGES,
} from "../harness/hook-history.js";
import {
  migrateSessionEntries,
  type FileEntry,
} from "../transcript/session-transcript-contract.js";

export const MAX_CLI_SESSION_HISTORY_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_CLI_SESSION_HISTORY_MESSAGES = MAX_AGENT_HOOK_HISTORY_MESSAGES;
export const MAX_CLI_SESSION_RESEED_HISTORY_CHARS = 12 * 1024;

type HistoryMessage = {
  role?: unknown;
  content?: unknown;
  summary?: unknown;
};
type HistoryEntry = {
  type?: unknown;
  message?: unknown;
  summary?: unknown;
};

type RawTranscriptReseedReason =
  | "auth-profile"
  | "auth-epoch"
  | "system-prompt"
  | "mcp"
  | "missing-transcript"
  | "session-expired";

const RAW_TRANSCRIPT_RESEED_ALLOWED_REASONS = new Set<RawTranscriptReseedReason>([
  "missing-transcript",
  "system-prompt",
  "mcp",
  "session-expired",
]);

function coerceHistoryText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object") {
        return [];
      }
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" && text.trim().length > 0 ? [text.trim()] : [];
    })
    .join("\n")
    .trim();
}

export function buildCliSessionHistoryPrompt(params: {
  messages: unknown[];
  prompt: string;
  maxHistoryChars?: number;
}): string | undefined {
  const maxHistoryChars = params.maxHistoryChars ?? MAX_CLI_SESSION_RESEED_HISTORY_CHARS;
  const renderedHistoryRaw = params.messages
    .flatMap((message) => {
      if (!message || typeof message !== "object") {
        return [];
      }
      const entry = message as HistoryMessage;
      const role =
        entry.role === "assistant"
          ? "Assistant"
          : entry.role === "user"
            ? "User"
            : entry.role === "compactionSummary"
              ? "Compaction summary"
              : undefined;
      if (!role) {
        return [];
      }
      const text =
        entry.role === "compactionSummary" && typeof entry.summary === "string"
          ? entry.summary.trim()
          : coerceHistoryText(entry.content);
      return text ? [`${role}: ${text}`] : [];
    })
    .join("\n\n")
    .trim();
  const renderedHistory =
    renderedHistoryRaw.length > maxHistoryChars
      ? `${renderedHistoryRaw.slice(0, maxHistoryChars).trimEnd()}\n[OpenClaw reseed history truncated]`
      : renderedHistoryRaw;

  if (!renderedHistory) {
    return undefined;
  }

  return [
    "Continue this conversation using the OpenClaw transcript below as prior session history.",
    "Treat it as authoritative context for this fresh CLI session.",
    "",
    "<conversation_history>",
    renderedHistory,
    "</conversation_history>",
    "",
    "<next_user_message>",
    params.prompt,
    "</next_user_message>",
  ].join("\n");
}

function resolveSafeCliTranscriptLocator(params: {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
}): { agentId: string; sessionId: string } {
  const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  return {
    agentId: sessionAgentId ?? defaultAgentId,
    sessionId: params.sessionId,
  };
}

async function loadCliSessionEntries(params: {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
}): Promise<unknown[]> {
  try {
    const scope = resolveSqliteSessionTranscriptScope(resolveSafeCliTranscriptLocator(params));
    if (!scope) {
      return [];
    }
    const entries = loadSqliteSessionTranscriptEvents(scope)
      .map((entry) => entry.event)
      .filter((entry): entry is FileEntry => Boolean(entry && typeof entry === "object"));
    if (JSON.stringify(entries).length > MAX_CLI_SESSION_HISTORY_FILE_BYTES) {
      return [];
    }
    migrateSessionEntries(entries);
    return entries.filter((entry) => entry.type !== "session");
  } catch {
    return [];
  }
}

export async function loadCliSessionHistoryMessages(params: {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
}): Promise<unknown[]> {
  const history = (await loadCliSessionEntries(params)).flatMap((entry) => {
    const candidate = entry as HistoryEntry;
    return candidate.type === "message" ? [candidate.message] : [];
  });
  return limitAgentHookHistoryMessages(history, MAX_CLI_SESSION_HISTORY_MESSAGES);
}

export async function loadCliSessionReseedMessages(params: {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
  allowRawTranscriptReseed?: boolean;
  rawTranscriptReseedReason?: RawTranscriptReseedReason;
}): Promise<unknown[]> {
  const entries = await loadCliSessionEntries(params);
  const loadRawTail = () => {
    if (
      params.allowRawTranscriptReseed !== true ||
      !params.rawTranscriptReseedReason ||
      !RAW_TRANSCRIPT_RESEED_ALLOWED_REASONS.has(params.rawTranscriptReseedReason)
    ) {
      return [];
    }
    const rawTail = entries.flatMap((entry) => {
      const candidate = entry as HistoryEntry;
      return candidate.type === "message" ? [candidate.message] : [];
    });
    return limitAgentHookHistoryMessages(rawTail, MAX_CLI_SESSION_HISTORY_MESSAGES);
  };
  const latestCompactionIndex = entries.findLastIndex((entry) => {
    const candidate = entry as HistoryEntry;
    return candidate.type === "compaction" && typeof candidate.summary === "string";
  });
  if (latestCompactionIndex < 0) {
    return loadRawTail();
  }

  const compaction = entries[latestCompactionIndex] as HistoryEntry;
  const summary = typeof compaction.summary === "string" ? compaction.summary.trim() : "";
  if (!summary) {
    return loadRawTail();
  }

  const tailMessages = entries.slice(latestCompactionIndex + 1).flatMap((entry) => {
    const candidate = entry as HistoryEntry;
    return candidate.type === "message" ? [candidate.message] : [];
  });
  return [
    {
      role: "compactionSummary",
      summary,
    },
    ...limitAgentHookHistoryMessages(tailMessages, MAX_CLI_SESSION_HISTORY_MESSAGES - 1),
  ];
}
