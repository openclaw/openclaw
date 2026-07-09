// Slack plugin module implements session transcript prompt context behavior.
import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import {
  readRecentUserAssistantTextForSession,
  type SessionRecentConversationText,
} from "openclaw/plugin-sdk/session-store-runtime";

type BuildSlackSessionTranscriptHistoryEntriesParams = {
  agentId: string;
  beforeTimestampMs?: number;
  limit: number;
  minTimestampMs?: number;
  sessionKey: string;
  storePath?: string;
};

function toSessionTranscriptHistoryEntry(entry: SessionRecentConversationText): HistoryEntry {
  const senderBase = entry.role === "assistant" ? "Assistant" : "User";
  return {
    ...(entry.id ? { messageId: `session:${entry.id}` } : {}),
    sender: entry.sourceChannel
      ? `${senderBase} (${entry.role}, ${entry.sourceChannel})`
      : `${senderBase} (${entry.role})`,
    ...(entry.timestamp !== undefined ? { timestamp: entry.timestamp } : {}),
    body: entry.text,
  };
}

export async function buildSlackSessionTranscriptHistoryEntries(
  params: BuildSlackSessionTranscriptHistoryEntriesParams,
): Promise<HistoryEntry[]> {
  const entries = await readRecentUserAssistantTextForSession({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    limit: params.limit,
    ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
    ...(params.beforeTimestampMs !== undefined
      ? { beforeTimestampMs: params.beforeTimestampMs }
      : {}),
    ...(params.minTimestampMs !== undefined ? { minTimestampMs: params.minTimestampMs } : {}),
  });
  return entries.map(toSessionTranscriptHistoryEntry);
}

function resolveHistoryTextDedupeKey(entry: HistoryEntry): string | undefined {
  const body = entry.body.trim();
  if (!body) {
    return undefined;
  }
  if (typeof entry.timestamp !== "number" || !Number.isFinite(entry.timestamp)) {
    return undefined;
  }
  return `${entry.timestamp}:${body}`;
}

export function mergeSlackSessionTranscriptInboundHistory(params: {
  sessionEntries: HistoryEntry[];
  inboundHistory: HistoryEntry[] | undefined;
}): HistoryEntry[] | undefined {
  if (params.sessionEntries.length === 0) {
    return params.inboundHistory;
  }
  const inboundEntries = params.inboundHistory ?? [];
  const inboundTextKeys = new Set(
    inboundEntries
      .map((entry) => resolveHistoryTextDedupeKey(entry))
      .filter((key) => key !== undefined),
  );
  // Dedupe within the transcript window too: real transcripts can contain
  // duplicated rows for one turn (e.g. streamed replies persisted twice), and
  // those would otherwise both reach prompt context.
  const seenSessionKeys = new Set<string>();
  const sessionOnlyEntries = params.sessionEntries.filter((entry) => {
    const key = resolveHistoryTextDedupeKey(entry);
    if (key === undefined) {
      return true;
    }
    if (inboundTextKeys.has(key) || seenSessionKeys.has(key)) {
      return false;
    }
    seenSessionKeys.add(key);
    return true;
  });
  return [...sessionOnlyEntries, ...inboundEntries].toSorted(
    (left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0),
  );
}
