import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { TranscriptRewriteReplacement } from "../../context-engine/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { acquireSessionWriteLock } from "../session-write-lock.js";
import { log } from "./logger.js";
import { rewriteTranscriptEntriesInSessionManager } from "./transcript-rewrite.js";

/**
 * Marker text written in place of an assistant audio payload that has been
 * removed during context-overflow recovery. Intentionally short so it does not
 * itself inflate the history.
 */
export const ASSISTANT_AUDIO_RECOVERY_MARKER = "[audio payload removed during overflow recovery]";

type AudioLikePart = {
  type: "audio";
  source?: { type?: string; media_type?: string; data?: string };
};

type AssistantContentPart = { type?: string } & Record<string, unknown>;

function isRemovableAssistantAudioPart(part: unknown): part is AudioLikePart {
  if (!part || typeof part !== "object") {
    return false;
  }
  const typed = part as AssistantContentPart;
  if (typed.type !== "audio") {
    return false;
  }
  const source = (typed as AudioLikePart).source;
  if (!source || typeof source !== "object") {
    return false;
  }
  return source.type === "base64";
}

function isAssistantMessageWithRemovableAudio(message: AgentMessage): message is AssistantMessage {
  if ((message as { role?: string }).role !== "assistant") {
    return false;
  }
  const content = (message as AssistantMessage).content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((part) => isRemovableAssistantAudioPart(part));
}

function buildMarkerPart(): AssistantContentPart {
  return { type: "text", text: ASSISTANT_AUDIO_RECOVERY_MARKER };
}

/**
 * Returns a copy of the assistant message with every base64 audio content part
 * replaced by a short text marker. Other parts (text, tool_use, thinking, etc.)
 * are preserved byte-identical.
 *
 * Idempotent: if no audio parts exist, the original message is returned.
 */
export function stripAssistantAudioPayloadsFromMessage(
  message: AssistantMessage,
): AssistantMessage {
  const content = message.content;
  if (!Array.isArray(content)) {
    return message;
  }
  let changed = false;
  const rewritten = content.map((part) => {
    if (isRemovableAssistantAudioPart(part)) {
      changed = true;
      return buildMarkerPart();
    }
    return part;
  });
  if (!changed) {
    return message;
  }
  return {
    ...message,
    content: rewritten as AssistantMessage["content"],
  };
}

/**
 * In-memory variant for unit tests / preview. Mirrors the in-session behavior
 * without touching any SessionManager / filesystem state.
 */
export function stripAssistantAudioPayloadsInMessages(messages: AgentMessage[]): {
  messages: AgentMessage[];
  strippedCount: number;
} {
  let strippedCount = 0;
  const rewritten = messages.map((msg) => {
    if (!isAssistantMessageWithRemovableAudio(msg)) {
      return msg;
    }
    const next = stripAssistantAudioPayloadsFromMessage(msg);
    if (next !== msg) {
      strippedCount += 1;
    }
    return next;
  });
  return { messages: rewritten, strippedCount };
}

/**
 * Presence gate: avoid opening / rewriting the session when no removable
 * assistant-audio payloads exist. Cheap structural check.
 */
export function sessionLikelyHasAssistantAudioPayloads(messages: AgentMessage[]): boolean {
  return messages.some((msg) => isAssistantMessageWithRemovableAudio(msg));
}

type SessionBranchEntry = ReturnType<ReturnType<typeof SessionManager.open>["getBranch"]>[number];

function buildAssistantAudioReplacements(
  branch: readonly SessionBranchEntry[],
): TranscriptRewriteReplacement[] {
  const replacements: TranscriptRewriteReplacement[] = [];
  for (const entry of branch) {
    if (entry.type !== "message") {
      continue;
    }
    const message = entry.message;
    if (!isAssistantMessageWithRemovableAudio(message)) {
      continue;
    }
    const rewritten = stripAssistantAudioPayloadsFromMessage(message);
    if (rewritten === message) {
      continue;
    }
    replacements.push({ entryId: entry.id, message: rewritten });
  }
  return replacements;
}

/**
 * Strip assistant audio payloads on an already-open SessionManager. Internal
 * variant used when a caller already holds a session handle.
 */
function stripAssistantAudioPayloadsInExistingSessionManager(params: {
  sessionManager: ReturnType<typeof SessionManager.open>;
  sessionFile?: string;
  sessionId?: string;
  sessionKey?: string;
}): { stripped: boolean; strippedCount: number; reason?: string } {
  const branch = params.sessionManager.getBranch();
  if (branch.length === 0) {
    return { stripped: false, strippedCount: 0, reason: "empty session" };
  }

  const replacements = buildAssistantAudioReplacements(branch);
  if (replacements.length === 0) {
    return {
      stripped: false,
      strippedCount: 0,
      reason: "no assistant audio payloads",
    };
  }

  const rewriteResult = rewriteTranscriptEntriesInSessionManager({
    sessionManager: params.sessionManager,
    replacements,
  });
  if (rewriteResult.changed && params.sessionFile) {
    emitSessionTranscriptUpdate(params.sessionFile);
  }

  log.info(
    `[assistant-audio-recovery] Stripped ${rewriteResult.rewrittenEntries} assistant audio payload(s) in session ` +
      `sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"}`,
  );

  return {
    stripped: rewriteResult.changed,
    strippedCount: rewriteResult.rewrittenEntries,
    reason: rewriteResult.reason,
  };
}

/**
 * Recovery-only: replace assistant `type: "audio"` (source.type === "base64")
 * content parts in the session branch with a short text marker.
 *
 * Intentionally scoped to assistant audio only. Does not touch:
 *   - tool_result messages (handled by tool-result-truncation)
 *   - assistant text / tool_use / thinking blocks
 *   - image / video / other media parts (out of scope for this fix)
 *
 * Safe to call when no audio is present — returns `stripped: false` without
 * rewriting. Idempotent: a second call is a no-op because prior runs have
 * already replaced audio parts with text markers.
 */
export async function stripAssistantAudioPayloadsInSession(params: {
  sessionFile: string;
  sessionId?: string;
  sessionKey?: string;
}): Promise<{ stripped: boolean; strippedCount: number; reason?: string }> {
  const { sessionFile } = params;
  let sessionLock: Awaited<ReturnType<typeof acquireSessionWriteLock>> | undefined;

  try {
    sessionLock = await acquireSessionWriteLock({ sessionFile });
    const sessionManager = SessionManager.open(sessionFile);
    return stripAssistantAudioPayloadsInExistingSessionManager({
      sessionManager,
      sessionFile,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    });
  } catch (err) {
    const errMsg = formatErrorMessage(err);
    log.warn(`[assistant-audio-recovery] Failed to strip: ${errMsg}`);
    return { stripped: false, strippedCount: 0, reason: errMsg };
  } finally {
    await sessionLock?.release();
  }
}
