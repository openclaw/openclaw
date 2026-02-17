import type { AgentMessage, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ToolCallIdMode } from "../tool-call-id.js";
import { sanitizeToolCallIdsForCloudCodeAssist } from "../tool-call-id.js";
import { sanitizeContentBlocksImages } from "../tool-images.js";
import { stripThoughtSignatures } from "./bootstrap.js";

type ContentBlock = AgentToolResult<unknown>["content"][number];

/**
 * Default maximum number of images kept in conversation history when sending
 * requests to the LLM provider.  Keeping more than this causes HTTP 400
 * "Max images exceeded" errors with providers that enforce a per-request
 * image cap (e.g. 8 for several hosted APIs).
 *
 * Older images beyond this limit are replaced with a lightweight placeholder
 * text so the message structure stays valid while staying within provider
 * constraints.
 */
export const DEFAULT_MAX_HISTORY_IMAGES = 8;

/** Count image-type blocks in a content array. */
function countImageBlocks(content: unknown[]): number {
  let count = 0;
  for (const block of content) {
    if (
      block != null &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "image"
    ) {
      count++;
    }
  }
  return count;
}

/** Count the total number of image blocks across all messages. */
function countHistoryImages(messages: AgentMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    const content = (msg as { content?: unknown }).content;
    if (Array.isArray(content)) {
      total += countImageBlocks(content);
    }
  }
  return total;
}

/**
 * Replace the oldest image blocks in a content array with placeholder text.
 *
 * @param content   Content blocks to process.
 * @param toDropRef Mutable counter; decremented for each block replaced.
 *                  Pass the same object across multiple calls so the
 *                  budget is shared over all messages.
 * @param label     Label to embed in the placeholder string.
 */
function dropOldestImageBlocks(
  content: ContentBlock[],
  toDropRef: { remaining: number },
  label: string,
): ContentBlock[] {
  if (toDropRef.remaining === 0) {
    return content;
  }
  const result: ContentBlock[] = [];
  for (const block of content) {
    if (
      toDropRef.remaining > 0 &&
      block != null &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "image"
    ) {
      toDropRef.remaining--;
      result.push({
        type: "text",
        text: `[${label}] image removed from history`,
      } as ContentBlock);
    } else {
      result.push(block);
    }
  }
  return result;
}

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
    /**
     * Maximum number of images to retain across the entire conversation history.
     * When the history contains more images than this limit the oldest ones are
     * replaced with a text placeholder so providers that enforce a per-request
     * image cap do not return HTTP 400 errors.
     *
     * Set to undefined (the default) to disable pruning.
     * Set to 0 to remove all historical images.
     */
    maxHistoryImages?: number;
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

  // --- Image-count pruning ---
  // Replace the oldest image blocks with placeholder text when the total number
  // of images in the history exceeds maxHistoryImages.  This prevents providers
  // that cap the number of images per request (e.g. 8) from returning HTTP 400
  // even when the current user message contains no images at all.
  const maxHistoryImages = options?.maxHistoryImages;
  const toDropRef =
    maxHistoryImages != null && maxHistoryImages >= 0
      ? { remaining: Math.max(0, countHistoryImages(sanitizedIds) - maxHistoryImages) }
      : { remaining: 0 };

  const out: AgentMessage[] = [];
  for (const msg of sanitizedIds) {
    if (!msg || typeof msg !== "object") {
      out.push(msg);
      continue;
    }

    const role = (msg as { role?: unknown }).role;
    if (role === "toolResult") {
      const toolMsg = msg as Extract<AgentMessage, { role: "toolResult" }>;
      const rawContent = Array.isArray(toolMsg.content)
        ? (toolMsg.content as unknown as ContentBlock[])
        : [];
      const prunedContent = dropOldestImageBlocks(rawContent, toDropRef, label);
      const nextContent = (await sanitizeContentBlocksImages(
        prunedContent,
        label,
      )) as unknown as typeof toolMsg.content;
      out.push({ ...toolMsg, content: nextContent });
      continue;
    }

    if (role === "user") {
      const userMsg = msg as Extract<AgentMessage, { role: "user" }>;
      const content = userMsg.content;
      if (Array.isArray(content)) {
        const prunedContent = dropOldestImageBlocks(
          content as unknown as ContentBlock[],
          toDropRef,
          label,
        );
        const nextContent = (await sanitizeContentBlocksImages(
          prunedContent,
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
          const prunedContent = dropOldestImageBlocks(
            content as unknown as ContentBlock[],
            toDropRef,
            label,
          );
          const nextContent = (await sanitizeContentBlocksImages(
            prunedContent,
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
          const prunedContent = dropOldestImageBlocks(
            content as unknown as ContentBlock[],
            toDropRef,
            label,
          );
          const nextContent = (await sanitizeContentBlocksImages(
            prunedContent,
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
        const prunedContent = dropOldestImageBlocks(
          filteredContent as unknown as ContentBlock[],
          toDropRef,
          label,
        );
        const finalContent = (await sanitizeContentBlocksImages(
          prunedContent,
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
