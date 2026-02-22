/**
 * Image block stripping for agent messages.
 *
 * Extracted from src/agents/pi-embedded-helpers/images.ts on the dev branch.
 * Provides both in-memory stripping and session-file persistence.
 */
import { readFileSync, writeFileSync } from "node:fs";

type ContentBlock = Record<string, unknown>;
type MessageLike = Record<string, unknown>;

export type ImageStripResult = {
  messages: MessageLike[];
  hadImages: boolean;
};

/**
 * Check whether an assistant message has empty content (no meaningful blocks).
 */
export function isEmptyAssistantContent(msg: MessageLike): boolean {
  if (msg.role !== "assistant") {
    return false;
  }
  const content = msg.content;
  if (content === undefined || content === null || content === "") {
    return true;
  }
  if (Array.isArray(content)) {
    return content.every((block) => {
      if (!block || typeof block !== "object") {
        return true;
      }
      const typed = block as { type?: string; text?: string };
      return typed.type === "text" && (!typed.text || typed.text.trim() === "");
    });
  }
  if (typeof content === "string") {
    return content.trim() === "";
  }
  return false;
}

/**
 * Strip all image blocks from messages, replacing them with a text placeholder.
 * Used as a recovery mechanism when the model returns an empty response and the
 * context contains images that may be causing the failure.
 *
 * Returns the stripped messages and whether any images were found.
 */
export function stripImageBlocksFromMessages(messages: MessageLike[]): ImageStripResult {
  let hadImages = false;

  const stripBlocks = (blocks: unknown[]): unknown[] =>
    blocks.map((block) => {
      if (!block || typeof block !== "object") {
        return block;
      }
      const rec = block as ContentBlock;
      if (rec.type === "image") {
        hadImages = true;
        return { type: "text", text: "[image omitted]" };
      }
      // Recurse into nested content arrays (e.g. toolResult blocks with sub-content)
      if (Array.isArray(rec.content)) {
        return { ...rec, content: stripBlocks(rec.content) };
      }
      return block;
    });

  const out: MessageLike[] = messages
    // Drop empty assistant messages left by previous failed prompts
    .filter((msg) => {
      return !(msg.role === "assistant" && Array.isArray(msg.content) && (msg.content as unknown[]).length === 0);
    })
    .map((msg) => {
      if (!msg || typeof msg !== "object") {
        return msg;
      }

      if (
        (msg.role === "toolResult" || msg.role === "user" || msg.role === "assistant") &&
        Array.isArray(msg.content)
      ) {
        return { ...msg, content: stripBlocks(msg.content as unknown[]) };
      }

      return msg;
    });

  return { messages: out, hadImages };
}

/**
 * Strip image blocks from a persisted session JSONL file so that subsequent
 * prompts don't reload the images. Operates directly on the file, replacing
 * image content blocks with `{ type: "text", text: "[image omitted]" }`.
 *
 * Returns the number of image blocks stripped.
 */
export function stripImageBlocksFromSessionFile(sessionFile: string): number {
  let stripped = 0;
  try {
    const raw = readFileSync(sessionFile, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const out: string[] = [];
    for (const line of lines) {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry.type === "message") {
        const msg = entry.message as Record<string, unknown> | undefined;
        const content = msg?.content;
        if (Array.isArray(content)) {
          // Drop empty assistant messages left by previous failed prompts
          if (msg?.role === "assistant" && content.length === 0) {
            stripped++;
            continue;
          }
          const stripFileBlocks = (blocks: unknown[]): unknown[] =>
            blocks.map((block: unknown) => {
              if (!block || typeof block !== "object") {
                return block;
              }
              const rec = block as Record<string, unknown>;
              if (rec.type === "image") {
                stripped++;
                return { type: "text", text: "[image omitted]" };
              }
              if (Array.isArray(rec.content)) {
                return { ...rec, content: stripFileBlocks(rec.content) };
              }
              return block;
            });
          msg!.content = stripFileBlocks(content);
        }
      }
      out.push(JSON.stringify(entry));
    }
    if (stripped > 0) {
      writeFileSync(sessionFile, out.join("\n") + "\n");
    }
  } catch {
    // If the file can't be read/written, skip silently — the in-memory strip
    // still works for the current retry, and the next compaction will drop old entries.
  }
  return stripped;
}
