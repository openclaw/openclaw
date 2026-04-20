import type { AgentMessage, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ImageSanitizationLimits } from "../image-sanitization.js";
import type { ToolCallIdMode } from "../tool-call-id.js";
import { sanitizeToolCallIdsForCloudCodeAssist } from "../tool-call-id.js";
import { sanitizeContentBlocksImages, sanitizeToolResultImages } from "../tool-images.js";
import { stripThoughtSignatures } from "./bootstrap.js";

type ContentBlock = AgentToolResult<unknown>["content"][number];

const LEGACY_HEIF_ALLOWED_TOOL_NAMES = new Set(["read"]);

function readToolImageSanitizationDetails(
  details: unknown,
  toolName: unknown,
): Pick<ImageSanitizationLimits, "maxDimensionPx" | "maxBytes"> & {
  rejectHeifFamily?: boolean;
} {
  const record =
    details && typeof details === "object"
      ? (((details as { imageSanitization?: unknown }).imageSanitization ?? undefined) as
          | Record<string, unknown>
          | undefined)
      : undefined;
  const hasSanitizationRecord = !!record && typeof record === "object" && !Array.isArray(record);
  if (!hasSanitizationRecord) {
    // Legacy sessions were persisted before the replay guard existed and do
    // not carry imageSanitization metadata. Preserve historical replay for
    // tools that were known to pass HEIF-family content through (the read
    // tool); leave other legacy tool results under the default reject path so
    // untrusted MCP-style legacy content is not retroactively trusted.
    if (typeof toolName === "string" && LEGACY_HEIF_ALLOWED_TOOL_NAMES.has(toolName)) {
      return { rejectHeifFamily: false };
    }
    return {};
  }
  // Omit absent keys so the spread in sanitizeSessionMessagesImages does not
  // overwrite caller-configured limits with undefined.
  const result: Pick<ImageSanitizationLimits, "maxDimensionPx" | "maxBytes"> & {
    rejectHeifFamily?: boolean;
  } = {};
  if (typeof record.maxDimensionPx === "number") {
    result.maxDimensionPx = record.maxDimensionPx;
  }
  if (typeof record.maxBytes === "number") {
    result.maxBytes = record.maxBytes;
  }
  if (typeof record.rejectHeifFamily === "boolean") {
    result.rejectHeifFamily = record.rejectHeifFamily;
  }
  return result;
}

function isThinkingOrRedactedBlock(block: unknown): boolean {
  if (!block || typeof block !== "object") {
    return false;
  }
  const rec = block as { type?: unknown };
  return rec.type === "thinking" || rec.type === "redacted_thinking";
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
      const toolImageSanitization = readToolImageSanitizationDetails(
        toolMsg.details,
        (toolMsg as { toolName?: unknown }).toolName,
      );
      const sanitized = await sanitizeToolResultImages(
        {
          content: Array.isArray(toolMsg.content) ? toolMsg.content : [],
          details: toolMsg.details,
        },
        label,
        {
          ...imageSanitization,
          ...toolImageSanitization,
        },
      );
      out.push({
        ...toolMsg,
        content: sanitized.content as unknown as typeof toolMsg.content,
        details: sanitized.details as typeof toolMsg.details,
      });
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
      if (assistantMsg.stopReason === "error") {
        const content = assistantMsg.content;
        if (Array.isArray(content)) {
          const nextContent = (await sanitizeContentBlocksImages(
            content as unknown as ContentBlock[],
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
          const nextContent = (await sanitizeContentBlocksImages(
            strippedContent as unknown as ContentBlock[],
            label,
            imageSanitization,
          )) as unknown as typeof assistantMsg.content;
          out.push({ ...assistantMsg, content: nextContent });
          continue;
        }

        const filteredContent =
          options?.preserveSignatures &&
          strippedContent.some((block) => isThinkingOrRedactedBlock(block))
            ? strippedContent
            : strippedContent.filter((block) => {
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
        out.push({ ...assistantMsg, content: finalContent });
        continue;
      }
    }

    out.push(msg);
  }
  return out;
}
