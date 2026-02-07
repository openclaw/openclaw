import fsAsync from "node:fs/promises";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("agents/strip-oversized-image");

interface SessionEntry {
  type: string;
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

/**
 * Strip an oversized image from a session JSONL file to prevent infinite retry loops.
 *
 * When the LLM API rejects a request due to an oversized image, the user message
 * containing the image is already persisted in the session file. Without cleanup,
 * every subsequent request will include the same oversized image and fail.
 *
 * This function reads the session file, locates the offending image content block,
 * replaces it with a text placeholder, and rewrites the file.
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

  // Find the message entries (in order) to map the API's messageIndex
  // to the actual entry in the file. The API counts all messages in the
  // context array (user, assistant, toolResult) in order.
  const messageEntries: { entryIndex: number; entry: SessionEntry }[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].type === "message" && entries[i].message) {
      messageEntries.push({ entryIndex: i, entry: entries[i] });
    }
  }

  if (messageIndex < 0 || messageIndex >= messageEntries.length) {
    return false;
  }

  const target = messageEntries[messageIndex];
  const msg = target.entry.message;
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
