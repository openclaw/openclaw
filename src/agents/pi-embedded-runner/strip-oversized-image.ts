import fsAsync from "node:fs/promises";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("agents/strip-oversized-image");

interface SessionEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  summary?: string;
  firstKeptEntryId?: string;
  message?: {
    role: string;
    content: unknown;
  };
  [key: string]: unknown;
}

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
    return path.filter((fe) => isMessageProducing(fe.entry)).map((fe) => ({ fileEntry: fe }));
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
  messages.push({ fileEntry: null });

  // Kept messages: from firstKeptIdx up to (not including) the compaction entry
  for (let i = firstKeptIdx; i < lastCompactionIdx; i++) {
    if (isMessageProducing(path[i].entry)) {
      messages.push({ fileEntry: path[i] });
    }
  }

  // Messages after the compaction entry
  for (let i = lastCompactionIdx + 1; i < path.length; i++) {
    if (isMessageProducing(path[i].entry)) {
      messages.push({ fileEntry: path[i] });
    }
  }

  return messages;
}

/**
 * Strip an oversized image from a session JSONL file to prevent infinite retry loops.
 *
 * When the LLM API rejects a request due to an oversized image, the user message
 * containing the image is already persisted in the session file. Without cleanup,
 * every subsequent request will include the same oversized image and fail.
 *
 * This function reads the session file, reconstructs the context path (root→leaf
 * via parentId chain — the same ordering the API sees), locates the offending
 * image content block, replaces it with a text placeholder, and rewrites the file.
 *
 * @param sessionFile Path to the session JSONL file
 * @param messageIndex Index into the context messages array (as reported by the API error)
 * @param contentIndex Index of the image block within the message content. If undefined,
 *   all image blocks in the message are stripped.
 * @returns true if an image was stripped, false otherwise
 */
export async function stripOversizedImageFromSession(
  sessionFile: string,
  messageIndex: number,
  contentIndex: number | undefined,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await fsAsync.readFile(sessionFile, "utf-8");
  } catch {
    return false;
  }

  const lines = raw.trim().split("\n");
  const entries: SessionEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as SessionEntry);
    } catch {
      entries.push({ type: "unparseable", raw: line });
    }
  }

  const fileEntries: FileEntry[] = entries.map((entry, i) => ({
    fileIndex: i,
    entry,
  }));

  // Build the context path (root → leaf via parentId chain)
  const contextPath = buildContextPath(fileEntries);
  if (contextPath.length === 0) {
    return false;
  }

  // Build the effective message list as the API would see it
  const effectiveMessages = buildEffectiveMessages(contextPath);

  if (messageIndex < 0 || messageIndex >= effectiveMessages.length) {
    return false;
  }

  const target = effectiveMessages[messageIndex];
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

  // Rewrite the session file
  const newContent = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
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
}
