import type { AgentMessage, AgentToolResult } from "@mariozechner/pi-agent-core";
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
        // Sanitize images first
        const nextContent = (await sanitizeContentBlocksImages(
          content as unknown as ContentBlock[],
          label,
        )) as unknown as ContentBlock[];

        if (!Array.isArray(nextContent)) {
          out.push({ ...userMsg, content: nextContent });
          continue;
        }

        // NEW: Sanitize inbound metadata artifacts from text blocks
        const metadataRegex =
          /(?:Conversation info|Sender|Thread starter|Replied message|Forwarded message context|Chat history since last reply) \(untrusted(?: metadata|,\s+for\s+context)\):\n```json\n[\s\S]*?\n```\n*/g;

        const cleanedContent = nextContent
          .map((block: ContentBlock) => {
            if (
              !block ||
              typeof block !== "object" ||
              (block as { type?: unknown }).type !== "text"
            ) {
              return block;
            }
            const rec = block as { text?: unknown };
            if (typeof rec.text !== "string") {
              return block;
            }
            // Only strip if it matches the start of the block (it's a prefix)
            // or if it's clearly a metadata block insertion.
            // Using replaceAll to catch multiple blocks if they stacked up.
            const cleanedText = rec.text.replace(metadataRegex, "").trim();
            // If the text became empty after stripping (and it wasn't empty before),
            // it means it was PURE metadata. We might want to filter this block out entirely,
            // or keep it as empty text if that's safer.
            // However, usually there is user text AFTER the metadata.
            // If cleanedText is empty, it means the user sent NO text (e.g. only image, or empty).
            return { ...block, text: cleanedText };
          })
          .filter((block: ContentBlock) => {
            // Filter out empty text blocks that resulted from stripping
            if (!block || typeof block !== "object") {
              return true;
            }
            const rec = block as { type?: unknown; text?: unknown };
            if (
              rec.type === "text" &&
              (!rec.text || (typeof rec.text === "string" && rec.text.trim() === ""))
            ) {
              return false;
            }
            return true;
          });

        if (cleanedContent.length > 0) {
          out.push({ ...userMsg, content: cleanedContent });
        }
        // If content became empty (e.g. pure metadata + no user text), drop the message?
        // No, might have been an image-only message where images were also sanitized away (unlikely).
        // Safest is to not push if empty, effectively dropping it.
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
