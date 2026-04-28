import type { AgentMessage, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ImageSanitizationLimits } from "../image-sanitization.js";
import type { ToolCallIdMode } from "../tool-call-id.js";
import { sanitizeToolCallIdsForCloudCodeAssist } from "../tool-call-id.js";
import { sanitizeContentBlocksImages } from "../tool-images.js";
import { stripThoughtSignatures } from "./bootstrap.js";

type ContentBlock = AgentToolResult<unknown>["content"][number];

/**
 * Drop `{ type: "text", text: "" }` blocks (whitespace-only counts as empty)
 * from a content array. Anthropic's API rejects a request whose
 * `messages.N.content.K` contains a `ContentBlock` with a blank `text` field
 * with `Validation error: The text field in the ContentBlock object at … is
 * blank.`. Once that 400 fires for a session, every subsequent turn replays
 * the same transcript and hits the same error — the session is wedged.
 *
 * This helper is intentionally permissive: it only rewrites text blocks and
 * passes everything else through (tool_use, tool_result, image, thinking,
 * redacted_thinking, …). See #73640.
 */
function dropEmptyTextBlocks<T>(content: readonly T[]): T[] {
  return content.filter((block) => {
    if (!block || typeof block !== "object") {
      return true;
    }
    const rec = block as { type?: unknown; text?: unknown };
    if (rec.type !== "text") {
      return true;
    }
    return typeof rec.text === "string" && rec.text.trim().length > 0;
  });
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
    preserveNativeAnthropicToolUseIds?: boolean;
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
  } & ImageSanitizationLimits,
): Promise<AgentMessage[]> {
  const sanitizeMode = options?.sanitizeMode ?? "full";
  const allowNonImageSanitization = sanitizeMode === "full";
  const imageSanitization = {
    maxDimensionPx: options?.maxDimensionPx,
    maxBytes: options?.maxBytes,
  };
  const shouldSanitizeToolCallIds = options?.sanitizeToolCallIds === true;
  // We sanitize historical session messages because Anthropic can reject a request
  // if the transcript contains oversized base64 images (default max side 1200px).
  const sanitizedIds = shouldSanitizeToolCallIds
    ? sanitizeToolCallIdsForCloudCodeAssist(messages, options.toolCallIdMode, {
        preserveNativeAnthropicToolUseIds: options?.preserveNativeAnthropicToolUseIds,
      })
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
      // Drop blank-text content blocks before passing to image sanitization
      // so Anthropic's `text field … is blank` 400 cannot fire on toolResult
      // payloads. See #73640.
      const filtered = dropEmptyTextBlocks(content);
      const nextContent = (await sanitizeContentBlocksImages(
        filtered,
        label,
        imageSanitization,
      )) as unknown as typeof toolMsg.content;
      // Skip emitting a content-empty toolResult so we do not trade the
      // `text field is blank` 400 for a `content array is empty` 400 — the
      // assistant full-mode path below already does the same skip.
      if (nextContent.length === 0) {
        continue;
      }
      out.push({ ...toolMsg, content: nextContent });
      continue;
    }

    if (role === "user") {
      const userMsg = msg as Extract<AgentMessage, { role: "user" }>;
      const content = userMsg.content;
      if (Array.isArray(content)) {
        // Same blank-text guard for user content blocks (#73640).
        const filtered = dropEmptyTextBlocks(content as unknown as ContentBlock[]);
        const nextContent = (await sanitizeContentBlocksImages(
          filtered,
          label,
          imageSanitization,
        )) as unknown as typeof userMsg.content;
        // Same content-empty skip as toolResult: an empty user content
        // array is also rejected by Anthropic.
        if ((nextContent as unknown as readonly unknown[]).length === 0) {
          continue;
        }
        out.push({ ...userMsg, content: nextContent });
        continue;
      }
    }

    if (role === "assistant") {
      const assistantMsg = msg as Extract<AgentMessage, { role: "assistant" }>;
      if (assistantMsg.stopReason === "error") {
        const content = assistantMsg.content;
        if (Array.isArray(content)) {
          // Same blank-text guard for error-stopped assistant turns (#73640).
          // Note: error-stopped assistant messages with `content: []` are
          // intentionally preserved (downstream replay/classifier relies on
          // them — see `keeps empty assistant error messages` regression).
          // Anthropic 400 risk is bounded here because error turns are not
          // re-sent in the next request.
          const filtered = dropEmptyTextBlocks(content as unknown as ContentBlock[]);
          const nextContent = (await sanitizeContentBlocksImages(
            filtered,
            label,
            imageSanitization,
          )) as unknown as typeof assistantMsg.content;
          out.push({ ...assistantMsg, content: nextContent });
        } else {
          out.push(assistantMsg);
        }
        continue;
      }
      const content = assistantMsg.content;
      if (Array.isArray(content)) {
        const strippedContent = options?.preserveSignatures
          ? content // Keep signatures for Antigravity Claude
          : stripThoughtSignatures(content, options?.sanitizeThoughtSignatures); // Strip for Gemini
        if (!allowNonImageSanitization) {
          // images-only mode: still drop blank-text blocks so Anthropic does
          // not 400 on the next request (#73640). Image sanitization alone
          // does not touch text blocks.
          const filtered = dropEmptyTextBlocks(strippedContent as unknown as ContentBlock[]);
          const nextContent = (await sanitizeContentBlocksImages(
            filtered,
            label,
            imageSanitization,
          )) as unknown as typeof assistantMsg.content;
          // Mirror the assistant full-mode skip so we do not emit a
          // content-empty assistant message in images-only mode either.
          if ((nextContent as unknown as readonly unknown[]).length === 0) {
            continue;
          }
          out.push({ ...assistantMsg, content: nextContent });
          continue;
        }

        // Full mode: drop blank-text blocks unconditionally. Previously
        // this branch kept the original content when preserveSignatures was
        // set AND a thinking/redacted block was present, which meant
        // companion blank-text blocks survived and Anthropic would 400 on
        // the next request. Dropping empties is safe — `dropEmptyTextBlocks`
        // only filters `{ type: "text", text: "" }` and passes thinking,
        // redacted_thinking, tool_use, tool_result, and image blocks
        // through unchanged. See #73640.
        const filteredContent = dropEmptyTextBlocks(strippedContent as unknown as ContentBlock[]);
        const finalContent = (await sanitizeContentBlocksImages(
          filteredContent as unknown as ContentBlock[],
          label,
          imageSanitization,
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
