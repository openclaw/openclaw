import { parseJsonObjectPreservingUnsafeIntegers } from "openclaw/plugin-sdk/json-unsafe-integers";
import type { ThinkingContent } from "openclaw/plugin-sdk/llm";
import {
  describeUnsupportedToolResultMedia,
  extractToolResultText,
  formatToolResultText,
  isImageWithMediaPayload,
  splitSystemPromptRelocatableBoundary,
  stripSystemPromptCacheBoundary,
} from "openclaw/plugin-sdk/provider-transport-runtime";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeOllamaToolCallName } from "./tool-name-aliases.js";

export interface OllamaChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  images?: string[];
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
  tool_call_id?: string;
}

export interface OllamaToolCall {
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
  };
}

export type OllamaToolCallNameOptions = {
  availableToolNames?: ReadonlySet<string>;
};

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");
}

function extractOllamaImages(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .filter(
      (part): part is { type: "image"; data: string } =>
        isRecord(part) && part.type === "image" && typeof part.data === "string",
    )
    .map((part) => part.data);
}

function extractOllamaThinking(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(
      (part): part is ThinkingContent =>
        isRecord(part) &&
        part.type === "thinking" &&
        typeof part.thinking === "string" &&
        !part.redacted,
    )
    .map((part) => part.thinking)
    .join("");
}

function extractToolCalls(
  content: unknown,
  options: OllamaToolCallNameOptions = {},
): OllamaToolCall[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const result: OllamaToolCall[] = [];
  for (const part of content) {
    if (
      isRecord(part) &&
      (part.type === "toolCall" || part.type === "tool_use") &&
      typeof part.name === "string"
    ) {
      const id = normalizeOptionalString(part.id);
      result.push({
        ...(id ? { id } : {}),
        function: {
          name: normalizeOllamaToolCallName(part.name, options),
          arguments:
            parseJsonObjectPreservingUnsafeIntegers(
              part.type === "toolCall" ? part.arguments : part.input,
            ) ?? {},
        },
      });
    }
  }
  return result;
}

type OllamaInputMessage = {
  role: string;
  content: unknown;
  toolName?: unknown;
  toolCallId?: unknown;
  isError?: unknown;
};

export function convertToOllamaMessages(
  messages: OllamaInputMessage[],
  system?: string,
  options: OllamaToolCallNameOptions = {},
): OllamaChatMessage[] {
  const result: OllamaChatMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      const text = extractTextContent(msg.content);
      const images = extractOllamaImages(msg.content);
      result.push({
        role: "user",
        content: text,
        ...(images.length > 0 ? { images } : {}),
      });
      continue;
    }

    if (msg.role === "assistant") {
      const text = extractTextContent(msg.content);
      const thinking = extractOllamaThinking(msg.content);
      const toolCalls = extractToolCalls(msg.content, options);
      result.push({
        role: "assistant",
        content: text,
        ...(thinking ? { thinking } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    if (msg.role === "tool" || msg.role === "toolResult") {
      const content = Array.isArray(msg.content)
        ? msg.content
        : [{ type: "text", text: typeof msg.content === "string" ? msg.content : "" }];
      const text = extractToolResultText(content, { includeStructured: true });
      const images = content.filter(isImageWithMediaPayload).map((part) => part.data);
      const omittedMediaPlaceholder = describeUnsupportedToolResultMedia(content, {
        images: true,
        audio: false,
      });
      const mediaPlaceholder = images.length > 0 ? "(see attached image)" : undefined;
      const toolName = typeof msg.toolName === "string" ? msg.toolName : undefined;
      const toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : undefined;
      result.push({
        role: "tool",
        content: formatToolResultText({
          text,
          mediaPlaceholder,
          omittedMediaPlaceholder,
          isError: msg.isError === true,
        }),
        ...(images.length > 0 ? { images } : {}),
        ...(toolCallId ? { tool_call_id: toolCallId } : {}),
        ...(toolName ? { tool_name: toolName } : {}),
      });
    }
  }

  if (system) {
    const split = splitSystemPromptRelocatableBoundary(system);
    const carrier = split?.relocatable ? result.find((msg) => msg.role === "user") : undefined;
    if (split && carrier) {
      // The first user stays in place across tool rounds and follow-ups; a trailing carrier moves.
      carrier.content += `\n\n${stripSystemPromptCacheBoundary(split.relocatable)}`;
    }
    result.unshift({
      role: "system",
      content: stripSystemPromptCacheBoundary(split && carrier ? split.remainingPrompt : system),
    });
  }
  return result;
}
