import { randomUUID } from "node:crypto";
import type { Api, Context, Model } from "@mariozechner/pi-ai";
import type {
  ResponseFunctionCallOutputItemList,
  ResponseInput,
  ResponseInputMessageContentList,
} from "openai/resources/responses/responses.js";
import { stripSystemPromptCacheBoundary } from "./system-prompt-cache-boundary.js";
import { transformTransportMessages } from "./transport-message-transform.js";
import { sanitizeTransportPayloadText } from "./transport-stream-shared.js";

export function shortHash(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function parseTextSignature(
  signature: string | undefined,
): { id: string; phase?: "commentary" | "final_answer" } | undefined {
  if (!signature) {
    return undefined;
  }
  if (signature.startsWith("{")) {
    try {
      const parsed = JSON.parse(signature) as { v?: unknown; id?: unknown; phase?: unknown };
      if (parsed.v === 1 && typeof parsed.id === "string") {
        return parsed.phase === "commentary" || parsed.phase === "final_answer"
          ? { id: parsed.id, phase: parsed.phase }
          : { id: parsed.id };
      }
    } catch {
      // Keep legacy plain-string behavior below.
    }
  }
  return { id: signature };
}

export function convertResponsesMessages(
  model: Model<Api>,
  context: Context,
  allowedToolCallProviders: Set<string>,
  options?: {
    includeSystemPrompt?: boolean;
    supportsDeveloperRole?: boolean;
    skipAssistant?: boolean;
    stripAssistantIds?: boolean;
  },
): ResponseInput {
  const messages: ResponseInput = [];
  const normalizeIdPart = (part: string) => {
    const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
    const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
    return normalized.replace(/_+$/, "");
  };
  const buildForeignResponsesItemId = (itemId: string) => {
    const normalized = `fc_${shortHash(itemId)}`;
    return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
  };
  const normalizeToolCallId = (
    id: string,
    _targetModel: Model<Api>,
    source: { provider: string; api: Api },
  ) => {
    if (!allowedToolCallProviders.has(model.provider)) {
      return normalizeIdPart(id);
    }
    if (!id.includes("|")) {
      return normalizeIdPart(id);
    }
    const [callId, itemId] = id.split("|");
    const normalizedCallId = normalizeIdPart(callId);
    const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
    let normalizedItemId = isForeignToolCall
      ? buildForeignResponsesItemId(itemId)
      : normalizeIdPart(itemId);
    if (!normalizedItemId.startsWith("fc_")) {
      normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
    }
    return `${normalizedCallId}|${normalizedItemId}`;
  };
  const transformedMessages = transformTransportMessages(
    context.messages,
    model,
    normalizeToolCallId,
  );
  const includeSystemPrompt = options?.includeSystemPrompt ?? true;
  if (includeSystemPrompt && context.systemPrompt) {
    messages.push({
      role: model.reasoning && options?.supportsDeveloperRole !== false ? "developer" : "system",
      content: sanitizeTransportPayloadText(stripSystemPromptCacheBoundary(context.systemPrompt)),
    });
  }
  for (const msg of transformedMessages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        messages.push({
          role: "user",
          content: [{ type: "input_text", text: sanitizeTransportPayloadText(msg.content) }],
        });
      } else {
        const content = (
          msg.content.map((item) =>
            item.type === "text"
              ? { type: "input_text", text: sanitizeTransportPayloadText(item.text) }
              : {
                  type: "input_image",
                  detail: "auto",
                  image_url: `data:${item.mimeType};base64,${item.data}`,
                },
          ) as ResponseInputMessageContentList
        ).filter((item) => model.input.includes("image") || item.type !== "input_image");
        if (content.length > 0) {
          messages.push({ role: "user", content });
        }
      }
    } else if (msg.role === "assistant") {
      if (options?.skipAssistant) {
        continue;
      }
      const output: ResponseInput = [];
      const isDifferentModel =
        msg.model !== model.id && msg.provider === model.provider && msg.api === model.api;
      for (const block of msg.content) {
        if (!options?.stripAssistantIds && block.type === "thinking") {
          if (block.thinkingSignature) {
            output.push(JSON.parse(block.thinkingSignature));
          }
        } else if (block.type === "text") {
          // Clamp to 64 chars: legacy plain-string signatures can be arbitrarily long
          // and the Responses API hard-fails on oversized IDs.
          let msgId = options?.stripAssistantIds
            ? `msg_${randomUUID()}`
            : (parseTextSignature(block.textSignature)?.id ?? `msg_${shortHash(block.text)}`);
          if (msgId.length > 64) {
            msgId = `msg_${shortHash(msgId)}`;
          }
          output.push({
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: sanitizeTransportPayloadText(block.text),
                annotations: [],
              },
            ],
            status: "completed",
            id: msgId,
            phase: parseTextSignature(block.textSignature)?.phase,
          });
        } else if (block.type === "toolCall") {
          const [callId, itemIdRaw] = block.id.split("|");
          const itemId = options?.stripAssistantIds
            ? undefined
            : isDifferentModel && itemIdRaw?.startsWith("fc_")
              ? undefined
              : itemIdRaw;
          output.push({
            type: "function_call",
            id: itemId,
            call_id: callId,
            name: block.name,
            arguments:
              typeof block.arguments === "string"
                ? block.arguments
                : JSON.stringify(block.arguments ?? {}),
          });
        }
      }
      if (output.length > 0) {
        messages.push(...output);
      }
    } else if (msg.role === "toolResult") {
      const textResult = msg.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      const hasImages = msg.content.some((item) => item.type === "image");
      const [callId] = msg.toolCallId.split("|");
      messages.push({
        type: "function_call_output",
        call_id: callId,
        output:
          hasImages && model.input.includes("image")
            ? ([
                ...(textResult
                  ? [{ type: "input_text", text: sanitizeTransportPayloadText(textResult) }]
                  : []),
                ...msg.content
                  .filter((item) => item.type === "image")
                  .map((item) => ({
                    type: "input_image",
                    detail: "auto",
                    image_url: `data:${item.mimeType};base64,${item.data}`,
                  })),
              ] as ResponseFunctionCallOutputItemList)
            : sanitizeTransportPayloadText(textResult || "(see attached image)"),
      });
    }
  }
  return messages;
}

export type PlannedResponsesTurnInput =
  | { type: "fullContext"; inputItems: ResponseInput }
  | { type: "initial"; inputItems: ResponseInput }
  | { type: "incremental"; inputItems: ResponseInput }
  | { type: "restart"; inputItems: ResponseInput };

export function planResponsesTurnInput(params: {
  context: Context;
  model: Model<Api>;
  options?: {
    includeSystemPrompt?: boolean;
    supportsDeveloperRole?: boolean;
    skipAssistant?: boolean;
  };
  session?: {
    previousResponseId: string | null;
    lastContextLength: number;
    /** Digest of the system prompt from the last completed turn; null before first turn. */
    systemPromptDigest: string | null;
  };
}): PlannedResponsesTurnInput {
  const allowedToolCallProviders = new Set([
    "openai",
    "openai-codex",
    "opencode",
    "azure-openai-responses",
  ]);

  const session = params.session;

  if (!session) {
    return {
      type: "fullContext",
      inputItems: convertResponsesMessages(
        params.model,
        params.context,
        allowedToolCallProviders,
        params.options,
      ),
    };
  }

  const newMessages = params.context.messages.slice(session.lastContextLength);
  const previousResponseId = session.previousResponseId;

  const currentPromptDigest = shortHash(params.context.systemPrompt ?? "");
  const systemPromptChanged =
    session.systemPromptDigest !== null && session.systemPromptDigest !== currentPromptDigest;

  if (previousResponseId && newMessages.length > 0 && !systemPromptChanged) {
    return {
      type: "incremental",
      inputItems: convertResponsesMessages(
        params.model,
        { ...params.context, messages: newMessages },
        allowedToolCallProviders,
        {
          ...params.options,
          includeSystemPrompt: false,
          skipAssistant: true,
        },
      ),
    };
  }

  return {
    type: previousResponseId ? "restart" : "initial",
    inputItems: convertResponsesMessages(params.model, params.context, allowedToolCallProviders, {
      ...params.options,
      stripAssistantIds: true,
    }),
  };
}
