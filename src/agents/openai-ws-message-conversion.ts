import { randomUUID } from "node:crypto";
import type { Context, Message, StopReason } from "@mariozechner/pi-ai";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import {
  encodeAssistantTextSignature,
  normalizeAssistantPhase,
  parseAssistantTextSignature,
} from "../shared/chat-message-content.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  normalizeOpenAIStrictToolParameters,
  resolveOpenAIStrictToolFlagForInventory,
} from "./openai-tool-schema.js";
import type {
  ContentPart,
  FunctionToolDefinition,
  InputItem,
  OpenAIResponsesAssistantPhase,
  ResponseObject,
} from "./openai-ws-connection.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "./stream-message-shared.js";
import { normalizeUsage } from "./usage.js";

type AnyMessage = Message & { role: string; content: unknown };
type AssistantMessageWithPhase = AssistantMessage & { phase?: OpenAIResponsesAssistantPhase };
type ReplayModelInfo = { input?: ReadonlyArray<string>; api?: string };
type ReplayableReasoningItem = Extract<InputItem, { type: "reasoning" }>;
type ReplayableReasoningSignature = {
  type: "reasoning" | `reasoning.${string}`;
  id?: string;
  content?: unknown;
  encrypted_content?: string;
  summary?: unknown;
};
type ToolCallReplayId = { callId: string; itemId?: string };
type PlannedTurnInput = {
  inputItems: InputItem[];
  previousResponseId?: string;
  mode: "incremental_tool_results" | "full_context_initial" | "full_context_restart";
};

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = normalizeOptionalString(value) ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function supportsImageInput(modelOverride?: ReplayModelInfo): boolean {
  return !Array.isArray(modelOverride?.input) || modelOverride.input.includes("image");
}

function usesOpenAICompletionsImageParts(modelOverride?: ReplayModelInfo): boolean {
  return modelOverride?.api === "openai-completions";
}

function toImageUrlFromBase64(params: { mediaType?: string; data: string }): string {
  return `data:${params.mediaType ?? "image/jpeg"};base64,${params.data}`;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  let text = "";
  for (const part of content as Array<{ type?: unknown; text?: unknown }>) {
    if (!part || typeof part !== "object" || typeof part.text !== "string") {
      continue;
    }
    if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
      text += part.text;
    }
  }
  return text;
}

function contentToOpenAIParts(content: unknown, modelOverride?: ReplayModelInfo): ContentPart[] {
  if (typeof content === "string") {
    return content ? [{ type: "input_text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const includeImages = supportsImageInput(modelOverride);
  const useImageUrl = usesOpenAICompletionsImageParts(modelOverride);
  const parts: ContentPart[] = [];
  for (const part of content as Array<{
    type?: string;
    text?: string;
    data?: string;
    mimeType?: string;
    source?: unknown;
  }>) {
    if (
      (part.type === "text" || part.type === "input_text" || part.type === "output_text") &&
      typeof part.text === "string"
    ) {
      parts.push({ type: "input_text", text: part.text });
      continue;
    }

    if (!includeImages) {
      continue;
    }

    if (part.type === "image" && typeof part.data === "string") {
      if (useImageUrl) {
        parts.push({
          type: "image_url",
          image_url: {
            url: toImageUrlFromBase64({ mediaType: part.mimeType, data: part.data }),
          },
        });
        continue;
      }
      parts.push({
        type: "input_image",
        source: {
          type: "base64",
          media_type: part.mimeType ?? "image/jpeg",
          data: part.data,
        },
      });
      continue;
    }

    if (
      part.type === "input_image" &&
      part.source &&
      typeof part.source === "object" &&
      typeof (part.source as { type?: unknown }).type === "string"
    ) {
      const source = part.source as
        | { type: "url"; url: string }
        | { type: "base64"; media_type: string; data: string };
      if (useImageUrl) {
        parts.push({
          type: "image_url",
          image_url: {
            url:
              source.type === "url"
                ? source.url
                : toImageUrlFromBase64({ mediaType: source.media_type, data: source.data }),
          },
        });
        continue;
      }
      parts.push({
        type: "input_image",
        source,
      });
    }
  }
  return parts;
}

function isReplayableReasoningType(value: unknown): value is "reasoning" | `reasoning.${string}` {
  return typeof value === "string" && (value === "reasoning" || value.startsWith("reasoning."));
}

function toReplayableReasoningId(value: unknown): string | null {
  const id = toNonEmptyString(value);
  return id && id.startsWith("rs_") ? id : null;
}

function toReasoningSignature(
  value: unknown,
  options?: { requireReplayableId?: boolean },
): ReplayableReasoningSignature | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as {
    type?: unknown;
    id?: unknown;
    content?: unknown;
    encrypted_content?: unknown;
    summary?: unknown;
  };
  if (!isReplayableReasoningType(record.type)) {
    return null;
  }
  const reasoningId = toReplayableReasoningId(record.id);
  if (options?.requireReplayableId && !reasoningId) {
    return null;
  }
  return {
    type: record.type,
    ...(reasoningId ? { id: reasoningId } : {}),
    ...(record.content !== undefined ? { content: record.content } : {}),
    ...(typeof record.encrypted_content === "string"
      ? { encrypted_content: record.encrypted_content }
      : {}),
    ...(record.summary !== undefined ? { summary: record.summary } : {}),
  };
}

function encodeThinkingSignature(signature: ReplayableReasoningSignature): string {
  return JSON.stringify(signature);
}

function parseReasoningItem(value: unknown): ReplayableReasoningItem | null {
  const signature = toReasoningSignature(value);
  if (!signature) {
    return null;
  }
  return {
    type: "reasoning",
    ...(signature.id ? { id: signature.id } : {}),
    ...(signature.content !== undefined ? { content: signature.content } : {}),
    ...(signature.encrypted_content !== undefined
      ? { encrypted_content: signature.encrypted_content }
      : {}),
    ...(signature.summary !== undefined ? { summary: signature.summary } : {}),
  };
}

function parseThinkingSignature(value: unknown): ReplayableReasoningItem | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  try {
    return parseReasoningItem(JSON.parse(value));
  } catch {
    return null;
  }
}

function encodeToolCallReplayId(params: ToolCallReplayId): string {
  return params.itemId ? `${params.callId}|${params.itemId}` : params.callId;
}

function decodeToolCallReplayId(value: unknown): ToolCallReplayId | null {
  const raw = toNonEmptyString(value);
  if (!raw) {
    return null;
  }
  const separatorIndex = raw.indexOf("|");
  const callId = separatorIndex >= 0 ? raw.slice(0, separatorIndex) : raw;
  const itemId = separatorIndex >= 0 ? raw.slice(separatorIndex + 1) : undefined;
  return {
    callId,
    ...(itemId ? { itemId } : {}),
  };
}

function extractReasoningSummaryText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (!Array.isArray(value)) {
    return "";
  }
  const parts: string[] = [];
  for (const item of value) {
    const text =
      typeof item === "string"
        ? item.trim()
        : item && typeof item === "object"
          ? (normalizeOptionalString((item as { text?: unknown }).text) ?? "")
          : "";
    if (text) {
      parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

function extractResponseReasoningText(item: unknown): string {
  if (!item || typeof item !== "object") {
    return "";
  }
  const record = item as { summary?: unknown; content?: unknown };
  const summaryText = extractReasoningSummaryText(record.summary);
  if (summaryText) {
    return summaryText;
  }
  if (typeof record.content === "string") {
    return normalizeOptionalString(record.content) ?? "";
  }
  if (Array.isArray(record.content)) {
    const parts: string[] = [];
    for (const part of record.content) {
      const text =
        typeof part === "string"
          ? part.trim()
          : part && typeof part === "object"
            ? (normalizeOptionalString((part as { text?: unknown }).text) ?? "")
            : "";
      if (text) {
        parts.push(text);
      }
    }
    return parts.join("\n").trim();
  }
  return "";
}

export function convertTools(
  tools: Context["tools"],
  options?: { strict?: boolean | null },
): FunctionToolDefinition[] {
  if (!tools || tools.length === 0) {
    return [];
  }
  const strict = resolveOpenAIStrictToolFlagForInventory(tools, options?.strict);
  return tools.map((tool) => {
    return {
      type: "function" as const,
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : undefined,
      parameters: normalizeOpenAIStrictToolParameters(
        tool.parameters ?? {},
        strict === true,
      ) as Record<string, unknown>,
      ...(strict === undefined ? {} : { strict }),
    };
  });
}

export function planTurnInput(params: {
  context: Context;
  model: ReplayModelInfo;
  previousResponseId: string | null;
  lastContextLength: number;
}): PlannedTurnInput {
  if (params.previousResponseId && params.lastContextLength > 0) {
    const toolResults: Message[] = [];
    for (let index = params.lastContextLength; index < params.context.messages.length; index += 1) {
      const message = params.context.messages[index];
      if (message && (message as AnyMessage).role === "toolResult") {
        toolResults.push(message);
      }
    }
    if (toolResults.length > 0) {
      return {
        mode: "incremental_tool_results",
        previousResponseId: params.previousResponseId,
        inputItems: convertMessagesToInputItems(toolResults, params.model),
      };
    }
    return {
      mode: "full_context_restart",
      inputItems: convertMessagesToInputItems(params.context.messages, params.model),
    };
  }

  return {
    mode: "full_context_initial",
    inputItems: convertMessagesToInputItems(params.context.messages, params.model),
  };
}

export function convertMessagesToInputItems(
  messages: Message[],
  modelOverride?: ReplayModelInfo,
): InputItem[] {
  const items: InputItem[] = [];

  for (const msg of messages) {
    const m = msg as AnyMessage & {
      phase?: unknown;
      toolCallId?: unknown;
      toolUseId?: unknown;
    };

    if (m.role === "user") {
      const parts = contentToOpenAIParts(m.content, modelOverride);
      if (parts.length === 0) {
        continue;
      }
      items.push({
        type: "message",
        role: "user",
        content:
          parts.length === 1 && parts[0]?.type === "input_text"
            ? (parts[0] as { type: "input_text"; text: string }).text
            : parts,
      });
      continue;
    }

    if (m.role === "assistant") {
      const content = m.content;
      const assistantMessagePhase = normalizeAssistantPhase(m.phase);
      if (Array.isArray(content)) {
        const textParts: string[] = [];
        let currentTextPhase: OpenAIResponsesAssistantPhase | undefined;
        const hasExplicitBlockPhase = content.some((block) => {
          if (!block || typeof block !== "object") {
            return false;
          }
          const record = block as { type?: unknown; textSignature?: unknown };
          return (
            record.type === "text" &&
            Boolean(parseAssistantTextSignature(record.textSignature)?.phase)
          );
        });
        const pushAssistantText = (phase?: OpenAIResponsesAssistantPhase) => {
          if (textParts.length === 0) {
            return;
          }
          items.push({
            type: "message",
            role: "assistant",
            content: textParts.join(""),
            ...(phase ? { phase } : {}),
          });
          textParts.length = 0;
        };

        for (const block of content as Array<{
          type?: string;
          text?: string;
          textSignature?: unknown;
          id?: unknown;
          name?: unknown;
          arguments?: unknown;
          thinkingSignature?: unknown;
        }>) {
          if (block.type === "text" && typeof block.text === "string") {
            const parsedSignature = parseAssistantTextSignature(block.textSignature);
            const blockPhase =
              parsedSignature?.phase ??
              (parsedSignature?.id
                ? assistantMessagePhase
                : hasExplicitBlockPhase
                  ? undefined
                  : assistantMessagePhase);
            if (textParts.length > 0 && blockPhase !== currentTextPhase) {
              pushAssistantText(currentTextPhase);
            }
            textParts.push(block.text);
            currentTextPhase = blockPhase;
            continue;
          }

          if (block.type === "thinking") {
            pushAssistantText(currentTextPhase);
            const reasoningItem = parseThinkingSignature(block.thinkingSignature);
            if (reasoningItem) {
              items.push(reasoningItem);
            }
            continue;
          }

          if (block.type !== "toolCall") {
            continue;
          }

          pushAssistantText(currentTextPhase);
          const replayId = decodeToolCallReplayId(block.id);
          const toolName = toNonEmptyString(block.name);
          if (!replayId || !toolName) {
            continue;
          }
          items.push({
            type: "function_call",
            ...(replayId.itemId ? { id: replayId.itemId } : {}),
            call_id: replayId.callId,
            name: toolName,
            arguments:
              typeof block.arguments === "string"
                ? block.arguments
                : JSON.stringify(block.arguments ?? {}),
          });
        }

        pushAssistantText(currentTextPhase);
        continue;
      }

      const text = contentToText(content);
      if (!text) {
        continue;
      }
      items.push({
        type: "message",
        role: "assistant",
        content: text,
        ...(assistantMessagePhase ? { phase: assistantMessagePhase } : {}),
      });
      continue;
    }

    if (m.role !== "toolResult") {
      continue;
    }

    const toolCallId = toNonEmptyString(m.toolCallId) ?? toNonEmptyString(m.toolUseId);
    if (!toolCallId) {
      continue;
    }
    const replayId = decodeToolCallReplayId(toolCallId);
    if (!replayId) {
      continue;
    }
    const parts = Array.isArray(m.content) ? contentToOpenAIParts(m.content, modelOverride) : [];
    let textOutput = Array.isArray(m.content) ? "" : contentToText(m.content);
    const imageParts: ContentPart[] = [];
    for (const part of parts) {
      if (part.type === "input_text") {
        textOutput += part.text;
      } else if (part.type === "input_image" || part.type === "image_url") {
        imageParts.push(part);
      }
    }
    items.push({
      type: "function_call_output",
      call_id: replayId.callId,
      output: textOutput || (imageParts.length > 0 ? "(see attached image)" : ""),
    });
    if (imageParts.length > 0) {
      items.push({
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Attached image(s) from tool result:" },
          ...imageParts,
        ],
      });
    }
  }

  return items;
}

export function buildAssistantMessageFromResponse(
  response: ResponseObject,
  modelInfo: { api: string; provider: string; id: string },
): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  let hasExplicitPhasedAssistantText = false;
  let hasFinalAnswerText = false;
  for (const item of response.output ?? []) {
    if (item.type !== "message") {
      continue;
    }
    const itemPhase = normalizeAssistantPhase(item.phase);
    for (const part of item.content ?? []) {
      if (part.type !== "output_text" || !part.text) {
        continue;
      }
      if (itemPhase) {
        hasExplicitPhasedAssistantText = true;
        if (itemPhase === "final_answer") {
          hasFinalAnswerText = true;
        }
      }
    }
  }
  let includedAssistantPhase: OpenAIResponsesAssistantPhase | undefined;
  let hasMultipleIncludedAssistantPhases = false;
  let hasIncludedUnphasedAssistantText = false;
  let hasToolCalls = false;

  for (const item of response.output ?? []) {
    if (item.type === "message") {
      const itemPhase = normalizeAssistantPhase(item.phase);
      for (const part of item.content ?? []) {
        if (part.type === "output_text" && part.text) {
          const shouldIncludeText = hasFinalAnswerText
            ? itemPhase === "final_answer"
            : hasExplicitPhasedAssistantText
              ? itemPhase === undefined
              : true;
          if (!shouldIncludeText) {
            continue;
          }
          if (itemPhase) {
            if (!includedAssistantPhase) {
              includedAssistantPhase = itemPhase;
            } else if (includedAssistantPhase !== itemPhase) {
              hasMultipleIncludedAssistantPhases = true;
            }
          } else {
            hasIncludedUnphasedAssistantText = true;
          }
          content.push({
            type: "text",
            text: part.text,
            textSignature: encodeAssistantTextSignature({
              id: item.id,
              ...(itemPhase ? { phase: itemPhase } : {}),
            }),
          });
        }
      }
    } else if (item.type === "function_call") {
      const toolName = toNonEmptyString(item.name);
      if (!toolName) {
        continue;
      }
      const callId = toNonEmptyString(item.call_id);
      const itemId = toNonEmptyString(item.id);
      hasToolCalls = true;
      content.push({
        type: "toolCall",
        id: encodeToolCallReplayId({
          callId: callId ?? `call_${randomUUID()}`,
          itemId: itemId ?? undefined,
        }),
        name: toolName,
        arguments: (() => {
          try {
            return JSON.parse(item.arguments) as Record<string, unknown>;
          } catch {
            return item.arguments as unknown as Record<string, unknown>;
          }
        })(),
      });
    } else {
      if (!isReplayableReasoningType(item.type)) {
        continue;
      }
      const reasoningSignature = toReasoningSignature(item, { requireReplayableId: true });
      const reasoning = extractResponseReasoningText(item);
      if (!reasoning && !reasoningSignature) {
        continue;
      }
      content.push({
        type: "thinking",
        thinking: reasoning,
        ...(reasoningSignature
          ? { thinkingSignature: encodeThinkingSignature(reasoningSignature) }
          : {}),
      } as AssistantMessage["content"][number]);
    }
  }

  const stopReason: StopReason = hasToolCalls ? "toolUse" : "stop";
  const normalizedUsage = normalizeUsage(response.usage);
  const rawTotalTokens = normalizedUsage?.total;
  const resolvedTotalTokens =
    rawTotalTokens && rawTotalTokens > 0
      ? rawTotalTokens
      : (normalizedUsage?.input ?? 0) +
        (normalizedUsage?.output ?? 0) +
        (normalizedUsage?.cacheRead ?? 0) +
        (normalizedUsage?.cacheWrite ?? 0);

  const message = buildAssistantMessage({
    model: modelInfo,
    content,
    stopReason,
    usage: buildUsageWithNoCost({
      input: normalizedUsage?.input ?? 0,
      output: normalizedUsage?.output ?? 0,
      cacheRead: normalizedUsage?.cacheRead ?? 0,
      cacheWrite: normalizedUsage?.cacheWrite ?? 0,
      totalTokens: resolvedTotalTokens > 0 ? resolvedTotalTokens : undefined,
    }),
  });

  const finalAssistantPhase =
    includedAssistantPhase &&
    !hasMultipleIncludedAssistantPhases &&
    !hasIncludedUnphasedAssistantText
      ? includedAssistantPhase
      : undefined;

  return finalAssistantPhase
    ? ({ ...message, phase: finalAssistantPhase } as AssistantMessageWithPhase)
    : message;
}

export function convertResponseToInputItems(
  response: ResponseObject,
  modelInfo: { api: string; provider: string; id: string; input?: ReadonlyArray<string> },
): InputItem[] {
  return convertMessagesToInputItems(
    [buildAssistantMessageFromResponse(response, modelInfo)] as Message[],
    modelInfo,
  );
}
