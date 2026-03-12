import type { AgentMessage, AgentToolResult } from "@mariozechner/pi-agent-core";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ImageSanitizationLimits } from "../image-sanitization.js";
import type { ToolCallIdMode } from "../tool-call-id.js";
import { sanitizeToolCallIdsForCloudCodeAssist } from "../tool-call-id.js";
import { sanitizeContentBlocksImages } from "../tool-images.js";
import { stripThoughtSignatures } from "./bootstrap.js";

type ContentBlock = AgentToolResult<unknown>["content"][number];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

const log = createSubsystemLogger("agent/embedded");

/**
 * Normalize malformed assistant message content into a provider-safe array.
 *
 * Some third-party providers return `content` as a plain string, a single
 * block-like object, or omit it entirely.  This helper coerces all shapes
 * into the expected `AssistantMessage["content"]` array so that downstream
 * iteration never encounters a non-iterable value.
 */
function normalizeAssistantContent(
  content: unknown,
  context?: { label?: string },
): AssistantMessage["content"] {
  if (Array.isArray(content)) {
    return content as AssistantMessage["content"];
  }
  if (typeof content === "string") {
    if (!content.trim()) {
      return [] as AssistantMessage["content"];
    }
    return [{ type: "text", text: content }] as AssistantMessage["content"];
  }
  if (content && typeof content === "object") {
    const record = content as { type?: unknown; text?: unknown };
    if (typeof record.type === "string") {
      return [content as AssistantMessage["content"][number]] as AssistantMessage["content"];
    }
    if (typeof record.text === "string") {
      return [{ type: "text", text: record.text }] as AssistantMessage["content"];
    }
    log.warn("dropping unrecognized assistant replay content object during session sanitization", {
      label: context?.label,
      contentKeys: Object.keys(record).slice(0, 8),
      typeType: typeof record.type,
      textType: typeof record.text,
    });
  }
  return [] as AssistantMessage["content"];
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
        imageSanitization,
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
          imageSanitization,
        )) as unknown as typeof userMsg.content;
        out.push({ ...userMsg, content: nextContent });
        continue;
      }
    }

    if (role === "assistant") {
      const assistantMsg = msg as Extract<AgentMessage, { role: "assistant" }>;
      const normalizedContent = normalizeAssistantContent(assistantMsg.content, { label });
      const normalizedAssistantMsg =
        normalizedContent === assistantMsg.content
          ? assistantMsg
          : ({ ...assistantMsg, content: normalizedContent } as typeof assistantMsg);
      if (normalizedAssistantMsg.stopReason === "error") {
        const content = normalizedContent;
        const nextContent = (await sanitizeContentBlocksImages(
          content as unknown as ContentBlock[],
          label,
          imageSanitization,
        )) as unknown as typeof normalizedAssistantMsg.content;
        out.push({ ...normalizedAssistantMsg, content: nextContent });
        continue;
      }
      const content = normalizedContent;
      if (!allowNonImageSanitization) {
        const nextContent = (await sanitizeContentBlocksImages(
          content as unknown as ContentBlock[],
          label,
          imageSanitization,
        )) as unknown as typeof assistantMsg.content;
        out.push({ ...normalizedAssistantMsg, content: nextContent });
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
        imageSanitization,
      )) as unknown as typeof assistantMsg.content;
      if (finalContent.length === 0) {
        continue;
      }
      out.push({ ...normalizedAssistantMsg, content: finalContent });
      continue;
    }

    out.push(msg);
  }
  return out;
}
