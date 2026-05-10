import type { SessionEntry, TranscriptEntry } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  buildSessionContext,
  loadSqliteSessionTranscriptEvents,
  migrateSessionEntries,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";

export type CodexMirroredSessionHistoryScope = {
  agentId: string;
  sessionId: string;
};

export async function readCodexMirroredSessionHistoryMessages(
  scope: CodexMirroredSessionHistoryScope,
): Promise<AgentMessage[] | undefined> {
  try {
    const agentId = scope.agentId.trim();
    const sessionId = scope.sessionId.trim();
    if (!agentId || !sessionId) {
      return [];
    }
    const entries = loadSqliteSessionTranscriptEvents({ agentId, sessionId })
      .map((entry) => entry.event)
      .filter((entry): entry is TranscriptEntry => Boolean(entry && typeof entry === "object"));
    if (entries.length === 0) {
      return [];
    }
    const firstEntry = entries[0] as { type?: unknown; id?: unknown } | undefined;
    if (firstEntry?.type !== "session" || typeof firstEntry.id !== "string") {
      return undefined;
    }
    migrateSessionEntries(entries);
    const sessionEntries = entries.filter(
      (entry): entry is SessionEntry => entry.type !== "session",
    );
    return buildSessionContext(sessionEntries).messages;
  } catch {
    return undefined;
  }
}
