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
<<<<<<< HEAD
import {
  resolveSessionTranscriptTarget,
  type SessionTranscriptTargetParams,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { sanitizeCodexHistoryImagePayloads } from "./image-payload-sanitizer.js";

export type CodexMirroredSessionHistoryTarget = {
  agentId?: string;
  sessionFile: string;
  sessionId: string;
  sessionKey?: string;
};

/** Returns sanitized session-context messages for a Codex mirrored session file. */
export async function readCodexMirroredSessionHistoryMessages(
  target: CodexMirroredSessionHistoryTarget,
): Promise<AgentMessage[] | undefined> {
  try {
    await resolveSessionTranscriptTarget(resolveCodexHistoryTranscriptTarget(target));
    const raw = await fs.readFile(target.sessionFile, "utf-8");
    const entries = parseSessionEntries(raw);
    if (entries.length === 0) {
      return [];
    }
=======
import { sanitizeCodexHistoryImagePayloads } from "./image-payload-sanitizer.js";

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT",
  );
}

/** Returns sanitized session-context messages for a Codex mirrored session file. */
export async function readCodexMirroredSessionHistoryMessages(
  sessionFile: string,
): Promise<AgentMessage[] | undefined> {
  try {
    const raw = await fs.readFile(sessionFile, "utf-8");
    const entries = parseSessionEntries(raw);
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    const firstEntry = entries[0] as { type?: unknown; id?: unknown } | undefined;
    if (firstEntry?.type !== "session" || typeof firstEntry.id !== "string") {
      return undefined;
    }
<<<<<<< HEAD
    migrateSessionEntries(entries as SessionEntry[]);
    const sessionEntries = entries.filter((entry): entry is SessionEntry => {
      return (
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        (entry as { type?: unknown }).type !== "session"
      );
    });
=======
    migrateSessionEntries(entries);
    const sessionEntries = entries.filter(
      (entry): entry is SessionEntry => entry.type !== "session",
    );
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    return sanitizeCodexHistoryImagePayloads(
      buildSessionContext(sessionEntries).messages,
      "codex mirrored history",
    );
<<<<<<< HEAD
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
=======
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    return undefined;
  }
}
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
