import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { SessionEntry } from "openclaw/plugin-sdk/agent-sessions";
import { buildSessionContext, migrateSessionEntries } from "openclaw/plugin-sdk/agent-sessions";
import {
  readSessionTranscriptEvents,
  type SessionTranscriptTargetParams,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { sanitizeCodexHistoryImagePayloads } from "./image-payload-sanitizer.js";

export type CodexMirroredSessionHistoryTarget = {
  agentId?: string;
  sessionFile: string;
  sessionId: string;
  sessionKey?: string;
};

export async function readCodexMirroredSessionHistoryMessages(
  target: CodexMirroredSessionHistoryTarget,
): Promise<AgentMessage[] | undefined> {
  try {
    const entries = await readSessionTranscriptEvents(resolveCodexHistoryTranscriptTarget(target));
    if (entries.length === 0) {
      return [];
    }
    const firstEntry = entries[0] as { type?: unknown; id?: unknown } | undefined;
    if (firstEntry?.type !== "session" || typeof firstEntry.id !== "string") {
      return undefined;
    }
    migrateSessionEntries(entries as SessionEntry[]);
    const sessionEntries = entries.filter((entry): entry is SessionEntry => {
      return (
        Boolean(entry && typeof entry === "object" && !Array.isArray(entry)) &&
        (entry as { type?: unknown }).type !== "session"
      );
    });
    return sanitizeCodexHistoryImagePayloads(
      buildSessionContext(sessionEntries).messages,
      "codex mirrored history",
    );
  } catch {
    return undefined;
  }
}

function resolveCodexHistoryTranscriptTarget(
  target: CodexMirroredSessionHistoryTarget,
): SessionTranscriptTargetParams {
  return {
    ...(target.agentId ? { agentId: target.agentId } : {}),
    sessionFile: target.sessionFile,
    sessionId: target.sessionId,
    sessionKey: target.sessionKey ?? "",
  };
}
