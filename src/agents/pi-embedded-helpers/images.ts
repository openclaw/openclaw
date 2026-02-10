import type { AgentMessage, AgentToolResult } from "@mariozechner/pi-agent-core";
import { readFileSync, writeFileSync } from "node:fs";
import type { ToolCallIdMode } from "../tool-call-id.js";
import { sanitizeToolCallIdsForCloudCodeAssist } from "../tool-call-id.js";
import { sanitizeContentBlocksImages } from "../tool-images.js";
import { stripThoughtSignatures } from "./bootstrap.js";

type ContentBlock = AgentToolResult<unknown>["content"][number];

export function isEmptyAssistantMessageContent(
  message: Extract<AgentMessage, { role: "assistant" }>,
): boolean {
  const content = message.content;
  if (content == null) {
    return true;
  }
  if (!Array.isArray(content)) {
    return false;
  }
  return content.every((block) => {
    if (!block || typeof block !== "object") {
      return true;
    }
    const rec = block as { type?: unknown; text?: unknown };
    if (rec.type !== "text") {
      return false;
    }
    return typeof rec.text !== "string" || rec.text.trim().length === 0;
  });
}

/**
 * Strip all image blocks from messages, replacing them with a text placeholder.
 * Used as a recovery mechanism when the model returns an empty response and the
 * context contains images that may be causing the failure (e.g. provider claims
 * vision support but actually returns empty on image input).
 *
 * Returns the stripped messages and whether any images were found.
 */
export function stripImageBlocksFromMessages(messages: AgentMessage[]): {
  messages: AgentMessage[];
  hadImages: boolean;
} {
  let hadImages = false;

  const stripBlocks = (blocks: unknown[]): unknown[] =>
    blocks.map((block) => {
      if (!block || typeof block !== "object") {
        return block;
      }
      const rec = block as Record<string, unknown>;
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

  const out: AgentMessage[] = messages
    // Drop empty assistant messages left by previous failed prompts
    .filter((msg) => {
      if (!msg || typeof msg !== "object") {
        return true;
      }
      const m = msg as { role?: unknown; content?: unknown };
      return !(m.role === "assistant" && Array.isArray(m.content) && m.content.length === 0);
    })
    .map((msg) => {
      if (!msg || typeof msg !== "object") {
        return msg;
      }
      const role = (msg as { role?: unknown }).role;

      if (role === "toolResult") {
        const toolMsg = msg as Extract<AgentMessage, { role: "toolResult" }>;
        if (Array.isArray(toolMsg.content)) {
          return { ...toolMsg, content: stripBlocks(toolMsg.content) as typeof toolMsg.content };
        }
      }

      if (role === "user") {
        const userMsg = msg as Extract<AgentMessage, { role: "user" }>;
        if (Array.isArray(userMsg.content)) {
          return {
            ...userMsg,
            content: stripBlocks(userMsg.content) as typeof userMsg.content,
          };
        }
      }

      if (role === "assistant") {
        const assistantMsg = msg as Extract<AgentMessage, { role: "assistant" }>;
        if (Array.isArray(assistantMsg.content)) {
          return {
            ...assistantMsg,
            content: stripBlocks(assistantMsg.content) as typeof assistantMsg.content,
          };
        }
      }

      return msg;
    });

  return { messages: out, hadImages };
}

/**
 * Strip image blocks from a persisted session JSONL file so that subsequent
 * prompts don't reload the images. Operates directly on the file, replacing
 * `{ type: "image", ... }` content blocks with `{ type: "text", text: "[image omitted]" }`.
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

export async function sanitizeSessionMessagesImages(
  messages: AgentMessage[],
  label: string,
  options?: {
    sanitizeMode?: "full" | "images-only";
    sanitizeToolCallIds?: boolean;
    /**
     * Mode for tool call ID sanitization:
     * - "strict" (alphanumeric only)
     * - "strict9" (alphanumeric only, length 9)
     */
    toolCallIdMode?: ToolCallIdMode;
    preserveSignatures?: boolean;
    sanitizeThoughtSignatures?: {
      allowBase64Only?: boolean;
      includeCamelCase?: boolean;
    };
  },
): Promise<AgentMessage[]> {
  const sanitizeMode = options?.sanitizeMode ?? "full";
  const allowNonImageSanitization = sanitizeMode === "full";
  // We sanitize historical session messages because Anthropic can reject a request
  // if the transcript contains oversized base64 images (see MAX_IMAGE_DIMENSION_PX).
  const sanitizedIds =
    allowNonImageSanitization && options?.sanitizeToolCallIds
      ? sanitizeToolCallIdsForCloudCodeAssist(messages, options.toolCallIdMode)
      : messages;
  const out: AgentMessage[] = [];
  for (const msg of sanitizedIds) {
    if (!msg || typeof msg !== "object") {
      out.push(msg);
      continue;
    }

    const role = (msg as { role?: unknown }).role;
    if (role === "toolResult") {
      const toolMsg = msg as Extract<AgentMessage, { role: "toolResult" }>;
      const content = Array.isArray(toolMsg.content) ? toolMsg.content : [];
      const nextContent = (await sanitizeContentBlocksImages(
        content,
        label,
      )) as unknown as typeof toolMsg.content;
      out.push({ ...toolMsg, content: nextContent });
      continue;
    }

    if (role === "user") {
      const userMsg = msg as Extract<AgentMessage, { role: "user" }>;
      const content = userMsg.content;
      if (Array.isArray(content)) {
        const nextContent = (await sanitizeContentBlocksImages(
          content as unknown as ContentBlock[],
          label,
        )) as unknown as typeof userMsg.content;
        out.push({ ...userMsg, content: nextContent });
        continue;
      }
    }

    if (role === "assistant") {
      const assistantMsg = msg as Extract<AgentMessage, { role: "assistant" }>;
      if (assistantMsg.stopReason === "error") {
        const content = assistantMsg.content;
        if (Array.isArray(content)) {
          const nextContent = (await sanitizeContentBlocksImages(
            content as unknown as ContentBlock[],
            label,
          )) as unknown as typeof assistantMsg.content;
          out.push({ ...assistantMsg, content: nextContent });
        } else {
          out.push(assistantMsg);
        }
        continue;
      }
      const content = assistantMsg.content;
      if (Array.isArray(content)) {
        if (!allowNonImageSanitization) {
          const nextContent = (await sanitizeContentBlocksImages(
            content as unknown as ContentBlock[],
            label,
          )) as unknown as typeof assistantMsg.content;
          out.push({ ...assistantMsg, content: nextContent });
          continue;
        }
        const strippedContent = options?.preserveSignatures
          ? content // Keep signatures for Antigravity Claude
          : stripThoughtSignatures(content, options?.sanitizeThoughtSignatures); // Strip for Gemini

        const filteredContent = strippedContent.filter((block) => {
          if (!block || typeof block !== "object") {
            return true;
          }
          const rec = block as { type?: unknown; text?: unknown };
          if (rec.type !== "text" || typeof rec.text !== "string") {
            return true;
          }
          return rec.text.trim().length > 0;
        });
        const finalContent = (await sanitizeContentBlocksImages(
          filteredContent as unknown as ContentBlock[],
          label,
        )) as unknown as typeof assistantMsg.content;
        if (finalContent.length === 0) {
          continue;
        }
        out.push({ ...assistantMsg, content: finalContent });
        continue;
      }
    }

    out.push(msg);
  }
  return out;
}
