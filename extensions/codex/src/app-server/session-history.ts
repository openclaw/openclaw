import type { FileEntry, SessionEntry } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  buildSessionContext,
  loadSqliteSessionTranscriptEvents,
  migrateSessionEntries,
  resolveSqliteSessionTranscriptScopeForLocator,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";

export type CodexMirroredSessionHistoryScope = {
  transcriptLocator: string;
  agentId?: string;
  sessionId?: string;
};

export async function readCodexMirroredSessionHistoryMessages(
  scope: CodexMirroredSessionHistoryScope,
): Promise<AgentMessage[] | undefined> {
  try {
    const resolvedScope =
      resolveSqliteSessionTranscriptScopeForLocator({
        transcriptLocator: scope.transcriptLocator,
      }) ??
      (scope.agentId && scope.sessionId
        ? { agentId: scope.agentId, sessionId: scope.sessionId }
        : undefined);
    if (!resolvedScope) {
      return [];
    }
    const entries = loadSqliteSessionTranscriptEvents(resolvedScope)
      .map((entry) => entry.event)
      .filter((entry): entry is FileEntry => Boolean(entry && typeof entry === "object"));
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
