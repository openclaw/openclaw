import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";

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
 * ## Failed-user-turn recovery
 *
 * After stripping error turns, the preceding user turn becomes the tail. If
 * left in place, the orphan-user repair in `attempt.ts` (~line 1470) would
 * branch it away from the session — silently losing the user's original
 * request, because the platform marks GUI messages read immediately after
 * delivery (before run completion), so no replay source exists.
 *
 * To prevent this, `stripTrailingErrorTurns` also strips the exposed trailing
 * user turn and returns its prompt payload (text plus any image blocks). The
 * caller re-injects that payload by prepending the recovered text to the
 * current prompt and prepending recovered images to the current image list, so
 * the user's original request is re-sent to the LLM on recovery. This means:
 * - The failed user→error pair is removed from session history (clean slate)
 * - The user's original text and images are preserved for the next prompt
 * - No orphan-user repair fires (the tail is no longer a user turn)
 * - `prompt()` creates a fresh user turn with the recovered text
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
 * Result of stripping trailing error turns from a session.
 *
 * - `prompt`: recovered text prompt for the trailing user turn. This can be
 *   an empty string for image-only prompts.
 * - `images`: recovered image blocks from the trailing user turn.
 */
export interface RecoveredUserInput {
  prompt: string;
  images: ImageContent[];
}

/**
 * Result of stripping trailing error turns from a session.
 *
 * - `errorCount`: number of infrastructure-error assistant turns removed
 * - `recoveredUserInput`: prompt payload of the trailing user turn that was
 *   also removed to prevent silent loss by orphan-user repair. `null` if
 *   no user turn was exposed (e.g., error turns followed an assistant turn,
 *   or the session was empty after stripping).
 */
export interface StripErrorResult {
  errorCount: number;
  recoveredUserInput: RecoveredUserInput | null;
}

function recoverTrailingUserInput(msg: unknown): RecoveredUserInput | null {
  if (!msg || typeof msg !== "object") {
    return null;
  }

  const user = msg as {
    role?: string;
    content?: string | Array<{ type?: string; text?: string; data?: string; mimeType?: string }>;
  };
  if (user.role !== "user") {
    return null;
  }
  if (typeof user.content === "string") {
    return { prompt: user.content, images: [] };
  }
  if (!Array.isArray(user.content)) {
    return null;
  }

  const promptParts: string[] = [];
  const images: ImageContent[] = [];
  for (const block of user.content) {
    if (!block || typeof block !== "object") {
      return null;
    }
    if (block.type === "text" && typeof block.text === "string") {
      promptParts.push(block.text);
      continue;
    }
    if (
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      images.push({
        type: "image",
        data: block.data,
        mimeType: block.mimeType,
      });
      continue;
    }
    return null;
  }
  return {
    prompt: promptParts.join("\n"),
    images,
  };
}

export function mergeRecoveredUserInput(
  params: {
    prompt: string;
    images?: ImageContent[];
  },
  recoveredUserInput: RecoveredUserInput,
): {
  prompt: string;
  images?: ImageContent[];
} {
  const promptSegments = [recoveredUserInput.prompt, params.prompt].filter(
    (segment): segment is string => typeof segment === "string" && segment.length > 0,
  );
  const mergedPrompt = promptSegments.join("\n\n");
  const mergedImages =
    recoveredUserInput.images.length > 0
      ? [...recoveredUserInput.images, ...(params.images ?? [])]
      : params.images;
  if (mergedImages && mergedImages.length > 0) {
    return {
      prompt: mergedPrompt,
      images: mergedImages,
    };
  }
  return { prompt: mergedPrompt };
}

/**
 * Strip trailing infrastructure-error assistant turns from the messages array.
 *
 * If stripping exposes a trailing user turn, that turn is ALSO stripped and
 * its prompt payload (text + images) returned in `recoveredUserInput`. The
 * caller must re-inject this payload into the next prompt to prevent silent
 * message loss — see module docstring for the full rationale. If the exposed
 * user turn cannot be recovered safely, stripping is aborted so data is
 * preserved instead of being dropped.
 */
export function stripTrailingErrorTurns(activeSession: {
  messages: AgentMessage[];
  agent: { replaceMessages: (messages: AgentMessage[]) => void };
}): StripErrorResult {
  const original = activeSession.messages;
  const stripped = original.slice();

  // Phase 1: strip trailing infrastructure-error assistant turns.
  while (stripped.length > 0) {
    const last = stripped.at(-1);
    if (isPureInfrastructureError(last)) {
      stripped.pop();
      continue;
    }
    break;
  }

  const errorCount = original.length - stripped.length;
  if (errorCount === 0) {
    return { errorCount: 0, recoveredUserInput: null };
  }

  // Phase 2: if stripping exposed a trailing user turn, strip it too and
  // capture its prompt payload. Without this, the orphan-user repair
  // (~line 1470 in attempt.ts) would branch it away — silently losing the
  // user's request, because the platform marks GUI messages read on delivery
  // (before run completion) so no replay source exists.
  let recoveredUserInput: RecoveredUserInput | null = null;
  const tail = stripped.at(-1);
  if ((tail as { role?: string } | undefined)?.role === "user") {
    recoveredUserInput = recoverTrailingUserInput(tail);
    if (recoveredUserInput === null) {
      return { errorCount: 0, recoveredUserInput: null };
    }
    stripped.pop();
  }

  activeSession.agent.replaceMessages(stripped);
  return { errorCount, recoveredUserInput };
}

// ---------------------------------------------------------------------------
// Session file entry stripping
// ---------------------------------------------------------------------------

/**
 * Strip matching trailing entries from the sessionManager's persistent file
 * entries. Follows the `stripSessionsYieldArtifacts` pattern: mutate
 * fileEntries, delete IDs from byId, update leafId, and rewrite the file.
 *
 * When `stripUserTurn` is true, also strips the trailing user turn exposed
 * after error removal — matching the in-memory stripping behavior of
 * `stripTrailingErrorTurns`.
 */
export function stripTrailingErrorFileEntries(
  sessionManager: unknown,
  stripUserTurn: boolean = false,
): boolean {
  const sm = sessionManager as SessionManagerInternals | undefined;
  const fileEntries = sm?.fileEntries;
  const byId = sm?.byId;
  if (!fileEntries || !byId) {
    return false;
  }

  let changed = false;

  // Phase 1: strip trailing error entries.
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

  // Phase 2: strip the exposed trailing user turn if requested.
  if (stripUserTurn && changed && fileEntries.length > 1) {
    const tail = fileEntries.at(-1);
    if (tail && tail.type === "message" && tail.message?.role === "user") {
      fileEntries.pop();
      if (tail.id) {
        byId.delete(tail.id);
      }
      sm.leafId = tail.parentId ?? null;
    }
  }

  if (changed) {
    sm._rewriteFile?.();
  }
  return changed;
}
