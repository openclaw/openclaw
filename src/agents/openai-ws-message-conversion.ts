import { randomUUID } from "node:crypto";
import type { Context, Message, StopReason } from "@mariozechner/pi-ai";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type {
  ContentPart,
  FunctionToolDefinition,
  InputItem,
  OpenAIResponsesAssistantPhase,
  ResponseObject,
} from "./openai-ws-connection.js";
import { normalizeToolParameterSchema } from "./pi-tools.schema.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "./stream-message-shared.js";
import { normalizeUsage } from "./usage.js";

type AnyMessage = Message & { role: string; content: unknown };
type AssistantMessageWithPhase = AssistantMessage & { phase?: OpenAIResponsesAssistantPhase };
export type ReplayModelInfo = { input?: ReadonlyArray<string> };
type ReplayableReasoningItem = Extract<InputItem, { type: "reasoning" }>;
type ReplayableReasoningSignature = {
  type: "reasoning" | `reasoning.${string}`;
  id?: string;
};
type ToolCallReplayId = { callId: string; itemId?: string };
export type PlannedTurnInput = {
  inputItems: InputItem[];
  previousResponseId?: string;
  mode: "incremental_tool_results" | "full_context_initial" | "full_context_restart";
};

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeAssistantPhase(value: unknown): OpenAIResponsesAssistantPhase | undefined {
  return value === "commentary" || value === "final_answer" ? value : undefined;
}

function encodeAssistantTextSignature(params: {
  id: string;
  phase?: OpenAIResponsesAssistantPhase;
}): string {
  return JSON.stringify({
    v: 1,
    id: params.id,
    ...(params.phase ? { phase: params.phase } : {}),
  });
}

function parseAssistantTextSignature(
  value: unknown,
): { id: string; phase?: OpenAIResponsesAssistantPhase } | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  if (!value.startsWith("{")) {
    return { id: value };
  }
  try {
    const parsed = JSON.parse(value) as { v?: unknown; id?: unknown; phase?: unknown };
    if (parsed.v !== 1 || typeof parsed.id !== "string") {
      return null;
    }
    return {
      id: parsed.id,
      ...(normalizeAssistantPhase(parsed.phase)
        ? { phase: normalizeAssistantPhase(parsed.phase) }
        : {}),
    };
  } catch {
    return null;
  }
}

function supportsImageInput(modelOverride?: ReplayModelInfo): boolean {
  return !Array.isArray(modelOverride?.input) || modelOverride.input.includes("image");
}

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(
      (part): part is { type?: string; text?: string } => Boolean(part) && typeof part === "object",
    )
    .filter(
      (part) =>
        (part.type === "text" || part.type === "input_text" || part.type === "output_text") &&
        typeof part.text === "string",
    )
    .map((part) => part.text as string)
    .join("");
}

function contentToOpenAIParts(content: unknown, modelOverride?: ReplayModelInfo): ContentPart[] {
  if (typeof content === "string") {
    return content ? [{ type: "input_text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const includeImages = supportsImageInput(modelOverride);
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
      parts.push({
        type: "input_image",
        source: part.source as
          | { type: "url"; url: string }
          | { type: "base64"; media_type: string; data: string },
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

function toReasoningSignature(value: unknown): ReplayableReasoningSignature | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as { type?: unknown; id?: unknown };
  if (!isReplayableReasoningType(record.type)) {
    return null;
  }
  const reasoningId = toReplayableReasoningId(record.id);
  return {
    type: record.type,
    ...(reasoningId ? { id: reasoningId } : {}),
  };
}

function encodeThinkingSignature(signature: ReplayableReasoningSignature): string {
  return JSON.stringify(signature);
}

function parseReasoningItem(value: unknown): ReplayableReasoningItem | null {
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
  return {
    type: "reasoning",
    ...(reasoningId ? { id: reasoningId } : {}),
    ...(typeof record.content === "string" ? { content: record.content } : {}),
    ...(typeof record.encrypted_content === "string"
      ? { encrypted_content: record.encrypted_content }
      : {}),
    ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
  };
}

function parseThinkingSignature(value: unknown): ReplayableReasoningItem | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  try {
    const signature = toReasoningSignature(JSON.parse(value));
    return signature ? parseReasoningItem(signature) : null;
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
  const [callId, itemId] = raw.split("|", 2);
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
  return value
    .map((item) => {
      if (typeof item === "string") {
        return item.trim();
      }
      if (!item || typeof item !== "object") {
        return "";
      }
      const record = item as { text?: unknown };
      return typeof record.text === "string" ? record.text.trim() : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
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
  return typeof record.content === "string" ? record.content.trim() : "";
}

export function convertTools(tools: Context["tools"]): FunctionToolDefinition[] {
  if (!tools || tools.length === 0) {
    return [];
  }
  return tools.map((tool) => {
    return {
      type: "function" as const,
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : undefined,
      parameters: normalizeToolParameterSchema(tool.parameters ?? {}) as Record<string, unknown>,
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
    const newMessages = params.context.messages.slice(params.lastContextLength);
    const toolResults = newMessages.filter(
      (message) => (message as AnyMessage).role === "toolResult",
    );
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
      let assistantPhase = normalizeAssistantPhase(m.phase);
      if (Array.isArray(content)) {
        const textParts: string[] = [];
        const pushAssistantText = () => {
          if (textParts.length === 0) {
            return;
          }
          items.push({
            type: "message",
            role: "assistant",
            content: textParts.join(""),
            ...(assistantPhase ? { phase: assistantPhase } : {}),
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
            if (!assistantPhase) {
              assistantPhase = parsedSignature?.phase;
            }
            textParts.push(block.text);
            continue;
          }

          if (block.type === "thinking") {
            pushAssistantText();
            const reasoningItem = parseThinkingSignature(block.thinkingSignature);
            if (reasoningItem) {
              items.push(reasoningItem);
            }
            continue;
          }

          if (block.type !== "toolCall") {
            continue;
          }

          pushAssistantText();
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

        pushAssistantText();
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
        ...(assistantPhase ? { phase: assistantPhase } : {}),
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
    const textOutput = contentToText(m.content);
    const imageParts = parts.filter((part) => part.type === "input_image");
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
  let assistantPhase: OpenAIResponsesAssistantPhase | undefined;

  for (const item of response.output ?? []) {
    if (item.type === "message") {
      const itemPhase = normalizeAssistantPhase(item.phase);
      if (itemPhase) {
        assistantPhase = itemPhase;
      }
      for (const part of item.content ?? []) {
        if (part.type === "output_text" && part.text) {
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
            return {} as Record<string, unknown>;
          }
        })(),
      });
    } else {
      if (!isReplayableReasoningType(item.type)) {
        continue;
      }
      const reasoning = extractResponseReasoningText(item);
      if (!reasoning) {
        continue;
      }
      const reasoningId = toReplayableReasoningId(item.id);
      content.push({
        type: "thinking",
        thinking: reasoning,
        ...(reasoningId
          ? {
              thinkingSignature: encodeThinkingSignature({
                id: reasoningId,
                type: item.type,
              }),
            }
          : {}),
      } as AssistantMessage["content"][number]);
    }
  }

  const hasToolCalls = content.some((part) => part.type === "toolCall");
  const stopReason: StopReason = hasToolCalls ? "toolUse" : "stop";
  const normalizedUsage = normalizeUsage(response.usage);

  const message = buildAssistantMessage({
    model: modelInfo,
    content,
    stopReason,
    usage: buildUsageWithNoCost({
      input: normalizedUsage?.input ?? 0,
      output: normalizedUsage?.output ?? 0,
      totalTokens: normalizedUsage?.total ?? 0,
    }),
  });

  return assistantPhase
    ? ({ ...message, phase: assistantPhase } as AssistantMessageWithPhase)
    : message;
}
