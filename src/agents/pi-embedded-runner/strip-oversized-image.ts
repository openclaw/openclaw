import fsAsync from "node:fs/promises";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { acquireSessionWriteLock } from "../session-write-lock.js";

const log = createSubsystemLogger("agents/strip-oversized-image");

interface SessionEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  summary?: string;
  firstKeptEntryId?: string;
  customType?: string;
  message?: {
    role: string;
    content: unknown;
  };
  [key: string]: unknown;
}

/** Custom entry type marking that Google turn ordering prepended a synthetic user message. */
const GOOGLE_TURN_ORDERING_CUSTOM_TYPE = "google-turn-ordering-bootstrap";

interface ContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

/** An entry tagged with its position in the JSONL file. */
interface FileEntry {
  fileIndex: number;
  entry: SessionEntry;
}

/** An API-visible message, either backed by a real file entry or synthetic. */
interface EffectiveMessage {
  fileEntry: FileEntry | null; // null for synthetic (e.g. compaction summary)
  role?: string;
}

/**
 * Build the context path from root to leaf by following parentId links.
 * Returns entries in root→leaf order, matching the order the session
 * manager uses to construct the API messages array.
 */
function buildContextPath(fileEntries: FileEntry[]): FileEntry[] {
  const byId = new Map<string, FileEntry>();
  for (const fe of fileEntries) {
    if (fe.entry.id) {
      byId.set(fe.entry.id, fe);
    }
  }

  // The leaf is the last entry with an id (append-only semantics)
  let leaf: FileEntry | undefined;
  for (let i = fileEntries.length - 1; i >= 0; i--) {
    if (fileEntries[i].entry.id) {
      leaf = fileEntries[i];
      break;
    }
  }
  if (!leaf) {
    return [];
  }

  // Walk from leaf to root via parentId chain
  const path: FileEntry[] = [];
  let current: FileEntry | undefined = leaf;
  while (current) {
    path.unshift(current);
    const parentId: string | null | undefined = current.entry.parentId;
    current = parentId ? byId.get(parentId) : undefined;
  }

  return path;
}

/**
 * Check if a session entry produces an API-visible message.
 * Matches the entry types that SessionManager.buildSessionContext() converts
 * into AgentMessage objects: regular messages, custom messages, and
 * branch summaries.
 */
function isMessageProducing(entry: SessionEntry): boolean {
  if (entry.type === "message" && entry.message) {
    return true;
  }
  if (entry.type === "branch_summary") {
    return true;
  }
  if (entry.type === "custom_message") {
    return true;
  }
  return false;
}

/**
 * Build the effective message list as the API would see it, accounting for
 * compaction (which injects a synthetic summary at position 0 and excludes
 * pre-compaction messages before firstKeptEntryId).
 */
function buildEffectiveMessages(path: FileEntry[]): EffectiveMessage[] {
  // Find the last compaction entry in the path
  let lastCompactionIdx = -1;
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i].entry.type === "compaction") {
      lastCompactionIdx = i;
      break;
    }
  }

  if (lastCompactionIdx === -1) {
    // No compaction: all message-producing entries in path order
    return path
      .filter((fe) => isMessageProducing(fe.entry))
      .map((fe) => ({
        fileEntry: fe,
        role: fe.entry.message?.role,
      }));
  }

  const compaction = path[lastCompactionIdx].entry;
  const firstKeptId = compaction.firstKeptEntryId;

  // Find the first kept entry's position in the path
  let firstKeptIdx = lastCompactionIdx + 1; // fallback: start after compaction
  if (firstKeptId) {
    const idx = path.findIndex((fe) => fe.entry.id === firstKeptId);
    if (idx >= 0) {
      firstKeptIdx = idx;
    }
  }

  const messages: EffectiveMessage[] = [];

  // Synthetic compaction summary at position 0 (no backing file entry)
  // The runtime uses role: "compactionSummary" which is NOT counted as a user turn
  // by limitHistoryTurns, so we must use the same role here for correct windowing.
  messages.push({ fileEntry: null, role: "compactionSummary" });

  // Kept messages: from firstKeptIdx up to (not including) the compaction entry
  for (let i = firstKeptIdx; i < lastCompactionIdx; i++) {
    if (isMessageProducing(path[i].entry)) {
      messages.push({ fileEntry: path[i], role: path[i].entry.message?.role });
    }
  }

  // Messages after the compaction entry
  for (let i = lastCompactionIdx + 1; i < path.length; i++) {
    if (isMessageProducing(path[i].entry)) {
      messages.push({ fileEntry: path[i], role: path[i].entry.message?.role });
    }
  }

  return messages;
}

/**
 * Apply history windowing to limit to the last N user turns.
 * This mirrors the logic in limitHistoryTurns() from history.ts.
 *
 * Returns messages from the point where we'd start (last N user turns).
 */
function applyHistoryWindow(
  messages: EffectiveMessage[],
  limit: number | undefined,
): EffectiveMessage[] {
  if (!limit || limit <= 0 || messages.length === 0) {
    return messages;
  }

  let userCount = 0;
  let lastUserIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userCount++;
      if (userCount > limit) {
        return messages.slice(lastUserIndex);
      }
      lastUserIndex = i;
    }
  }
  return messages;
}

/**
 * Check if the context path includes the Google turn ordering marker, indicating that
 * sanitization prepended a synthetic user message to the API request.
 * When present, the API message indices are offset by 1 from session entries.
 *
 * IMPORTANT: Only check entries in the context path, not all entries in the file.
 * Markers on dead branches should not affect the active path's index mapping.
 */
function hasGoogleTurnOrderingMarkerInPath(contextPath: FileEntry[]): boolean {
  return contextPath.some(
    (fe) => fe.entry.type === "custom" && fe.entry.customType === GOOGLE_TURN_ORDERING_CUSTOM_TYPE,
  );
}

export interface StripOversizedImageOptions {
  /**
   * DM history turns limit — if set, the API only saw the last N user turns
   * from history PLUS the new user prompt. Since the session now includes
   * that new prompt, we apply windowing with limit+1 to reconstruct the
   * same message array the API saw.
   */
  historyTurnsLimit?: number;
}

/**
 * Strip an oversized image from a session JSONL file to prevent infinite retry loops.
 *
 * When the LLM API rejects a request due to an oversized image, the user message
 * containing the image is already persisted in the session file. Without cleanup,
 * every subsequent request will include the same oversized image and fail.
 *
 * This function reads the session file, reconstructs the context path (root→leaf
 * via parentId chain — the same ordering the API sees), applies history windowing
 * if configured, locates the offending image content block, replaces it with a
 * text placeholder, and rewrites the file.
 *
 * @param sessionFile Path to the session JSONL file
 * @param messageIndex Index into the context messages array (as reported by the API error)
 * @param contentIndex Index of the image block within the message content. If undefined,
 *   all image blocks in the message are stripped.
 * @param options Additional options including history windowing configuration
 * @returns true if an image was stripped, false otherwise
 */
export async function stripOversizedImageFromSession(
  sessionFile: string,
  messageIndex: number,
  contentIndex: number | undefined,
  options?: StripOversizedImageOptions,
): Promise<boolean> {
  // Acquire session write lock to prevent concurrent mutations
  let lock: { release: () => Promise<void> } | undefined;
  try {
    lock = await acquireSessionWriteLock({ sessionFile });
  } catch (err) {
    log.warn(`Failed to acquire session lock for image stripping: ${String(err)}`);
    return false;
  }

  try {
    let raw: string;
    try {
      raw = await fsAsync.readFile(sessionFile, "utf-8");
    } catch {
      return false;
    }

    // Split preserving the trailing newline structure
    const lines = raw.endsWith("\n") ? raw.slice(0, -1).split("\n") : raw.split("\n");
    const parsedEntries: Array<{ line: string; parsed: SessionEntry | null }> = [];
    for (const line of lines) {
      try {
        parsedEntries.push({ line, parsed: JSON.parse(line) as SessionEntry });
      } catch {
        // Keep the raw line for unparseable entries — we won't modify these
        parsedEntries.push({ line, parsed: null });
      }
    }

    // Build fileEntries only from successfully parsed entries
    const fileEntries: FileEntry[] = [];
    for (let i = 0; i < parsedEntries.length; i++) {
      const { parsed } = parsedEntries[i];
      if (parsed) {
        fileEntries.push({ fileIndex: i, entry: parsed });
      }
    }

    // Build the context path (root → leaf via parentId chain)
    const contextPath = buildContextPath(fileEntries);
    if (contextPath.length === 0) {
      return false;
    }

    // Build the effective message list as the API would see it
    const effectiveMessages = buildEffectiveMessages(contextPath);

    // Apply history windowing if configured — the API only saw the windowed subset.
    // Important: The API flow is: sanitize (may prepend bootstrap) → limit → add new prompt.
    // The bootstrap is counted as a user turn during limiting. We simulate this by prepending
    // a synthetic boot message before applying the window, then check if it survived windowing.
    //
    // The session now includes the new prompt, so we use limit+1 to reconstruct the same window.
    const effectiveLimit = options?.historyTurnsLimit ? options.historyTurnsLimit + 1 : undefined;

    // Check if bootstrap was likely prepended (marker in path AND first message is non-user)
    const hasMarkerInPath = hasGoogleTurnOrderingMarkerInPath(contextPath);
    const firstEffectiveRole = effectiveMessages[0]?.role;
    const simulateBootstrap =
      hasMarkerInPath &&
      firstEffectiveRole !== undefined &&
      firstEffectiveRole !== "user" &&
      firstEffectiveRole !== "compactionSummary";

    // If bootstrap was prepended, include a synthetic boot message for windowing calculation
    // so that limitHistoryTurns counts the bootstrap as a user turn (matching API behavior).
    const messagesToWindow = simulateBootstrap
      ? [{ fileEntry: null, role: "user" } as EffectiveMessage, ...effectiveMessages]
      : effectiveMessages;

    const windowedWithMaybeBoot = applyHistoryWindow(messagesToWindow, effectiveLimit);

    // Check if the synthetic boot survived windowing (i.e., it's still at position 0)
    const bootSurvived =
      simulateBootstrap &&
      windowedWithMaybeBoot[0]?.fileEntry === null &&
      windowedWithMaybeBoot[0]?.role === "user";

    // Remove the synthetic boot from windowed results (we only needed it for windowing calculation)
    const windowedMessages = bootSurvived ? windowedWithMaybeBoot.slice(1) : windowedWithMaybeBoot;

    // Offset is 1 if bootstrap survived windowing (it's at API index 0, not in session entries)
    const googleTurnOrderingOffset = bootSurvived ? 1 : 0;
    const adjustedIndex = messageIndex - googleTurnOrderingOffset;

    if (adjustedIndex < 0 || adjustedIndex >= windowedMessages.length) {
      return false;
    }

    const target = windowedMessages[adjustedIndex];
    if (!target.fileEntry) {
      // Synthetic entry (e.g. compaction summary) — nothing to strip in the file
      return false;
    }

    const msg = target.fileEntry.entry.message;
    if (!msg || !Array.isArray(msg.content)) {
      return false;
    }

    const content = msg.content as ContentBlock[];

    let didStrip = false;

    if (contentIndex !== undefined) {
      // Strip a specific content block
      if (contentIndex < 0 || contentIndex >= content.length) {
        return false;
      }
      const block = content[contentIndex];
      if (!block || block.type !== "image") {
        return false;
      }
      content[contentIndex] = {
        type: "text",
        text: "[image omitted: exceeds size limit]",
      };
      didStrip = true;
    } else {
      // Strip all image blocks in the message
      for (let i = 0; i < content.length; i++) {
        if (content[i]?.type === "image") {
          content[i] = {
            type: "text",
            text: "[image omitted: exceeds size limit]",
          };
          didStrip = true;
        }
      }
    }

    if (!didStrip) {
      return false;
    }

    // Rewrite the session file (still under lock)
    // Re-stringify only the modified entry; preserve raw lines for everything else
    const modifiedIndex = target.fileEntry.fileIndex;
    const outputLines = parsedEntries.map((pe, i) => {
      if (i === modifiedIndex && pe.parsed) {
        return JSON.stringify(pe.parsed);
      }
      return pe.line;
    });
    const newContent = outputLines.join("\n") + "\n";
    try {
      await fsAsync.writeFile(sessionFile, newContent, "utf-8");
      log.info(
        `Stripped oversized image from session: message=${messageIndex} content=${contentIndex ?? "all"}`,
      );
      return true;
    } catch (err) {
      log.warn(`Failed to rewrite session file after stripping image: ${String(err)}`);
      return false;
    }
  } finally {
    await lock?.release();
  }
}
