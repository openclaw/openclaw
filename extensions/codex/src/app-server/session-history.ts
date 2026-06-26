/**
 * Reads OpenClaw session history for Codex transcript mirroring and sanitizes
 * image payloads before replaying messages into the app-server projector.
 */
import fs from "node:fs/promises";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { SessionEntry } from "openclaw/plugin-sdk/agent-sessions";
import {
  buildSessionContext,
  migrateSessionEntries,
  parseSessionEntries,
} from "openclaw/plugin-sdk/agent-sessions";
import {
  readSessionTranscriptEvents,
  resolveSessionTranscriptFileTarget,
  type SessionTranscriptFileTargetParams,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { sanitizeCodexHistoryImagePayloads } from "./image-payload-sanitizer.js";

export type CodexMirroredSessionHistoryTarget = {
  agentId?: string;
  sessionFile: string;
  sessionId: string;
  sessionKey?: string;
};

type SqliteSessionFileMarker = {
  agentId: string;
  sessionId: string;
  storePath: string;
};

/** Returns sanitized session-context messages for a Codex mirrored session file. */
export async function readCodexMirroredSessionHistoryMessages(
  target: CodexMirroredSessionHistoryTarget,
): Promise<AgentMessage[] | undefined> {
  try {
    const entries = await readCodexMirroredSessionEntries(target);
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
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
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

async function readCodexMirroredSessionEntries(
  target: CodexMirroredSessionHistoryTarget,
): Promise<SessionEntry[]> {
  const sqliteMarker = parseSqliteSessionFileMarker(target.sessionFile);
  if (sqliteMarker) {
    if (
      sqliteMarker.sessionId !== target.sessionId ||
      (target.agentId !== undefined && sqliteMarker.agentId !== target.agentId)
    ) {
      return [];
    }
    return (await readSessionTranscriptEvents({
      agentId: sqliteMarker.agentId,
      sessionId: sqliteMarker.sessionId,
      ...(target.sessionKey ? { sessionKey: target.sessionKey } : {}),
      storePath: sqliteMarker.storePath,
    })) as SessionEntry[];
  }
  resolveSessionTranscriptFileTarget(resolveCodexHistoryTranscriptTarget(target));
  return parseSessionEntries(await fs.readFile(target.sessionFile, "utf-8")) as SessionEntry[];
}

function resolveCodexHistoryTranscriptTarget(
  target: CodexMirroredSessionHistoryTarget,
): SessionTranscriptFileTargetParams {
  return {
    ...(target.agentId ? { agentId: target.agentId } : {}),
    sessionFile: target.sessionFile,
    sessionId: target.sessionId,
    sessionKey: target.sessionKey ?? "",
  };
}

function parseSqliteSessionFileMarker(
  sessionFile: string | undefined,
): SqliteSessionFileMarker | undefined {
  const match = /^sqlite:([^:]+):([^:]+):(.*)$/u.exec(sessionFile?.trim() ?? "");
  if (!match?.[1] || !match[2] || !match[3]) {
    return undefined;
  }
  return {
    agentId: match[1],
    sessionId: match[2],
    storePath: match[3],
  };
}
