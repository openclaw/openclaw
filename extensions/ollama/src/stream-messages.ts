import type { AssistantMessage, Message, ThinkingContent } from "openclaw/plugin-sdk/llm";
import {
  describeUnsupportedToolResultMedia,
  extractToolResultText,
  formatToolResultText,
  isImageWithMediaPayload,
  splitSystemPromptRelocatableBoundary,
  stripSystemPromptCacheBoundary,
} from "openclaw/plugin-sdk/provider-transport-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
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

function extractTextContent(content: Message["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function extractOllamaImages(content: Message["content"]): string[] {
  if (typeof content === "string") {
    return [];
  }
  return content.filter((part) => part.type === "image").map((part) => part.data);
}

function extractOllamaThinking(content: AssistantMessage["content"]): string {
  return content
    .filter((part): part is ThinkingContent => part.type === "thinking" && !part.redacted)
    .map((part) => part.thinking)
    .join("");
}

function extractToolCalls(
  content: AssistantMessage["content"],
  options: OllamaToolCallNameOptions = {},
): OllamaToolCall[] {
  return content
    .filter((part) => part.type === "toolCall")
    .map((part) => {
      const id = normalizeOptionalString(part.id);
      const call: OllamaToolCall = {
        function: {
          name: normalizeOllamaToolCallName(part.name, options),
          arguments: part.arguments,
        },
      };
      if (id) {
        call.id = id;
      }
      return call;
    });
}

export function convertToOllamaMessages(
  messages: Message[],
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

    const content = msg.content;
    const text = extractToolResultText(content, { includeStructured: true });
    const images = content.filter(isImageWithMediaPayload).map((part) => part.data);
    const omittedMediaPlaceholder = describeUnsupportedToolResultMedia(content, {
      images: true,
      audio: false,
    });
    const mediaPlaceholder = images.length > 0 ? "(see attached image)" : undefined;
    result.push({
      role: "tool",
      content: formatToolResultText({
        text,
        mediaPlaceholder,
        omittedMediaPlaceholder,
        isError: msg.isError,
      }),
      ...(images.length > 0 ? { images } : {}),
      ...(msg.toolCallId ? { tool_call_id: msg.toolCallId } : {}),
      ...(msg.toolName ? { tool_name: msg.toolName } : {}),
    });
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
