import type { AgentMessage } from "@mariozechner/pi-agent-core";

/**
 * QUEUEFLOOD-02: Strip trailing infrastructure-error assistant turns from a
 * session before the sanitize→validate→limit→context pipeline runs.
 *
 * When an LLM provider goes down, error responses accumulate as permanent
 * session turns (`stopReason: "error"`, empty content). On recovery these eat
 * the context window before the agent can do real work. Stripping them
 * pre-sanitize ensures the token budget is spent on real conversation only.
 *
 * ## Narrow predicate
 *
 * Only strips turns with **no ToolCall entries** in content. Errored turns
 * with partial tool-call state are preserved — the transcript repair and
 * tool-result pairing logic treats these as meaningful work (see
 * `session-transcript-repair.ts:460`, `attempt.test.ts:1305`).
 *
 * ## Orphan-user interaction
 *
 * After stripping, the preceding user turn becomes the tail. The existing
 * orphan-user repair in `attempt.ts` (~line 1470) naturally handles this by
 * branching it off via sessionManager, so the next prompt starts clean. This
 * is the desired behavior: the failed user message was never processed
 * successfully, and the next run will re-prompt with the user's input.
 */

// ---------------------------------------------------------------------------
// Types for sessionManager internals (following stripSessionsYieldArtifacts)
// ---------------------------------------------------------------------------
interface SessionFileEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  message?: { role?: string; stopReason?: string; content?: { type?: string }[] };
  customType?: string;
}

interface SessionManagerInternals {
  fileEntries?: SessionFileEntry[];
  byId?: Map<string, { id: string }>;
  leafId?: string | null;
  _rewriteFile?: () => void;
}

// ---------------------------------------------------------------------------
// Predicate
// ---------------------------------------------------------------------------

/**
 * Returns `true` if the message is a pure infrastructure-error assistant turn:
 * `stopReason === "error"` and no ToolCall entries in content.
 *
 * Pure infrastructure failures (network error, DNS failure, provider down)
 * produce empty-content error turns. Partial-work errors (tool call started
 * but provider failed mid-stream) carry ToolCall entries and must be preserved
 * for transcript repair.
 */
export function isPureInfrastructureError(msg: unknown): boolean {
  if (!msg || typeof msg !== "object") {
    return false;
  }
  const m = msg as { role?: string; stopReason?: string; content?: { type?: string }[] };
  if (m.role !== "assistant") {
    return false;
  }
  if (m.stopReason !== "error") {
    return false;
  }
  if (!Array.isArray(m.content)) {
    return true;
  } // no content at all → pure failure
  return !m.content.some((c) => c?.type === "toolCall");
}

// ---------------------------------------------------------------------------
// Message array stripping
// ---------------------------------------------------------------------------

/**
 * Strip trailing infrastructure-error assistant turns from the messages array.
 * Returns the count of turns stripped (0 if none).
 */
export function stripTrailingErrorTurns(activeSession: {
  messages: AgentMessage[];
  agent: { replaceMessages: (messages: AgentMessage[]) => void };
}): number {
  const original = activeSession.messages;
  const stripped = original.slice();
  while (stripped.length > 0) {
    const last = stripped.at(-1);
    if (isPureInfrastructureError(last)) {
      stripped.pop();
      continue;
    }
    break;
  }
  const count = original.length - stripped.length;
  if (count > 0) {
    activeSession.agent.replaceMessages(stripped);
  }
  return count;
}

// ---------------------------------------------------------------------------
// Session file entry stripping
// ---------------------------------------------------------------------------

/**
 * Strip matching trailing entries from the sessionManager's persistent file
 * entries. Follows the `stripSessionsYieldArtifacts` pattern: mutate
 * fileEntries, delete IDs from byId, update leafId, and rewrite the file.
 */
export function stripTrailingErrorFileEntries(sessionManager: unknown): boolean {
  const sm = sessionManager as SessionManagerInternals | undefined;
  const fileEntries = sm?.fileEntries;
  const byId = sm?.byId;
  if (!fileEntries || !byId) {
    return false;
  }

  let changed = false;
  while (fileEntries.length > 1) {
    const last = fileEntries.at(-1);
    if (!last || last.type === "session") {
      break;
    }
    if (last.type === "message" && isPureInfrastructureError(last.message)) {
      fileEntries.pop();
      if (last.id) {
        byId.delete(last.id);
      }
      sm.leafId = last.parentId ?? null;
      changed = true;
      continue;
    }
    break;
  }
  if (changed) {
    sm._rewriteFile?.();
  }
  return changed;
}
