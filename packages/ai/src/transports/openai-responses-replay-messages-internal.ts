import {
  hasRuntimeContextMarker,
  isRuntimeContextMessage,
  runtimeContextContentToText,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
} from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  ResponseFunctionCallOutputItemList,
  ResponseInput,
  ResponseInputItem,
  ResponseInputMessageContentList,
} from "openai/resources/responses/responses.js";
import { getAiTransportHost } from "../host.js";
import { isImageWithMediaPayload } from "../media-payload.js";
import { transformProviderMessages } from "../provider-transcript-transform.js";
import {
  describeToolResultMediaPlaceholder,
  extractToolResultBlockText,
  extractToolResultText,
} from "../providers/tool-result-text.js";
import { shortHash } from "../utils/hash.js";
import { stripSystemPromptCacheBoundary } from "../utils/system-prompt-cache-boundary.js";
import {
  buildOpenAIResponsesCompactionReplayPlan,
  isSafeResponsesReplayItemId,
  type OpenAIResponsesReplayMode,
} from "./openai-responses-compaction-replay.js";
import {
  OPENAI_RESPONSES_REASONING_REPLAY_BLOCK_META_KEY,
  OPENAI_RESPONSES_REASONING_REPLAY_META_KEY,
  OPENAI_RESPONSES_REPLAY_ITEM_ID_MAX_LENGTH,
  type OpenAIResponsesReasoningReplayMetadata,
  type ReplayableResponseOutputMessage,
  type ReplayableResponseReasoningItem,
} from "./openai-responses-contracts.js";
import { supportsNativeOpenAIResponsesEndpoint } from "./openai-responses-endpoint.js";
import { createResponsesInputReplay } from "./openai-responses-input-replay.js";
import { resolveReplayableResponsesMessageId } from "./openai-responses-replay.js";
import {
  buildProviderReplayContext,
  isProviderReplayContext,
  providerReplayContextMatches,
  type ProviderReplayContext,
} from "./provider-replay-context.js";
import { sanitizeTransportPayloadText } from "./transport-stream-shared.js";

function resolveResponsesInstructionRole(model: Model): "developer" | "system" {
  const supportsDeveloperRole =
    !isRecord(model.compat) || model.compat.supportsDeveloperRole !== false;
  return model.reasoning && supportsDeveloperRole ? "developer" : "system";
}

export function stripEncryptedReasoningContentFields(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const stripped = stripEncryptedReasoningContentFields(item);
      changed ||= !Object.is(stripped, item);
      return stripped;
    });
    return changed ? next : value;
  }

  const source = value as Record<string, unknown>;
  if (source.type === "compaction") {
    return value;
  }
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    if (key === "encrypted_content") {
      changed = true;
      continue;
    }
    const stripped = stripEncryptedReasoningContentFields(child);
    changed ||= !Object.is(stripped, child);
    next[key] = stripped;
  }
  return changed ? next : value;
}

function isOpenAIResponsesReasoningReplayMetadata(
  value: unknown,
): value is OpenAIResponsesReasoningReplayMetadata {
  return isProviderReplayContext(value) && value.v === 1 && value.source === "openai-responses";
}

function readOpenAIResponsesReasoningReplayBlockMetadata(
  block: Record<string, unknown>,
): OpenAIResponsesReasoningReplayMetadata | null | undefined {
  if (!Object.hasOwn(block, OPENAI_RESPONSES_REASONING_REPLAY_BLOCK_META_KEY)) {
    return undefined;
  }
  const value = block[OPENAI_RESPONSES_REASONING_REPLAY_BLOCK_META_KEY];
  return isOpenAIResponsesReasoningReplayMetadata(value) ? value : null;
}

function normalizeOpenAIResponsesReasoningReplayItem(
  item: ReplayableResponseReasoningItem,
): ReplayableResponseReasoningItem {
  return Array.isArray(item.summary) ? item : { ...item, summary: [] };
}

function prepareOpenAIResponsesReasoningItemForReplay(
  item: ReplayableResponseReasoningItem,
  context: ProviderReplayContext,
  blockMetadata?: OpenAIResponsesReasoningReplayMetadata | null,
  options?: { preserveUnattributedEncryptedContent?: boolean },
): ReplayableResponseReasoningItem {
  const hasRawMetadata = Object.hasOwn(item, OPENAI_RESPONSES_REASONING_REPLAY_META_KEY);
  const { [OPENAI_RESPONSES_REASONING_REPLAY_META_KEY]: rawMetadata, ...rest } = item;
  if (!("encrypted_content" in rest)) {
    return normalizeOpenAIResponsesReasoningReplayItem(rest);
  }
  const metadata =
    blockMetadata !== undefined
      ? (blockMetadata ?? undefined)
      : isOpenAIResponsesReasoningReplayMetadata(rawMetadata)
        ? rawMetadata
        : undefined;
  const preserveUnattributed =
    blockMetadata === undefined &&
    !hasRawMetadata &&
    options?.preserveUnattributedEncryptedContent === true;
  if (preserveUnattributed || (metadata && providerReplayContextMatches(metadata, context))) {
    return normalizeOpenAIResponsesReasoningReplayItem(rest);
  }
  return normalizeOpenAIResponsesReasoningReplayItem(
    stripEncryptedReasoningContentFields(rest) as ReplayableResponseReasoningItem,
  );
}

function normalizeResponsesReplayItemId(id: string | undefined): string | undefined {
  if (!id) {
    return undefined;
  }
  if (id.length <= OPENAI_RESPONSES_REPLAY_ITEM_ID_MAX_LENGTH) {
    return id;
  }
  return `msg_${shortHash(id)}`;
}

export { encodeTextSignatureV1 } from "../utils/text-signature.js";

function orderResponsesAsyncToolResults(source: Context["messages"]): Context["messages"] {
  const turnKey = (message: AssistantMessage) => {
    // Early fragments keep this identity when the provider ID arrives at completion.
    const id = message.turnId || message.responseId;
    return id ? `${message.provider}:${message.api}:${message.model}:${id}` : undefined;
  };
  const lastAssistant = new Map<string, number>();
  for (const [index, message] of source.entries()) {
    if (message.role === "assistant") {
      const key = turnKey(message);
      if (key) {
        lastAssistant.set(key, index);
      }
    }
  }
  const owners = new Map<string, string>();
  const pending = new Map<number, Context["messages"]>();
  const ordered: Context["messages"] = [];
  for (const [index, message] of source.entries()) {
    if (message.role === "assistant") {
      const key = turnKey(message);
      if (key) {
        for (const block of message.content) {
          if (block.type === "toolCall" && block.async) {
            owners.set(block.id, key);
          }
        }
      }
    }
    const owner = message.role === "toolResult" ? owners.get(message.toolCallId) : undefined;
    const lastIndex = owner ? lastAssistant.get(owner) : undefined;
    if (lastIndex !== undefined && lastIndex > index) {
      const results = pending.get(lastIndex) ?? [];
      results.push(message);
      pending.set(lastIndex, results);
    } else {
      ordered.push(message);
    }
    const results = pending.get(index);
    if (results) {
      ordered.push(...results);
      pending.delete(index);
    }
  }
  return ordered;
}

function parseOpenAIResponsesTextSignature(
  signature: string | undefined,
): { id?: string; phase?: "commentary" | "final_answer" } | undefined {
  if (!signature) {
    return undefined;
  }
  if (signature.startsWith("{")) {
    try {
      const parsed = JSON.parse(signature) as { v?: unknown; id?: unknown; phase?: unknown };
      if (parsed.v === 1) {
        const id = typeof parsed.id === "string" ? parsed.id : undefined;
        const phase =
          parsed.phase === "commentary" || parsed.phase === "final_answer"
            ? parsed.phase
            : undefined;
        // A reasoning-dropped replay keeps the phase but omits the paired id.
        if (id !== undefined || phase !== undefined) {
          return { id, phase };
        }
        return undefined;
      }
    } catch {
      // Keep legacy plain-string behavior below.
    }
  }
  return { id: signature };
}

const responsesInputSource = Symbol("openclaw.responsesInputSource");

/** Source identity survives payload spreads but never enters serialized provider input. */
export function bindResponsesInputMessage(
  source: Extract<Context["messages"][number], { role: "user" }>,
): (input: unknown) => boolean {
  const identity = {};
  Object.defineProperty(source, responsesInputSource, { value: identity, enumerable: true });
  return (input) =>
    typeof input === "object" &&
    input !== null &&
    Reflect.get(input, responsesInputSource) === identity;
}

export function buildResponsesInputMessage(
  role: "user" | "system" | "developer",
  content: ResponseInputMessageContentList,
  source?: Extract<Context["messages"][number], { role: "user" }>,
): ResponseInputItem.Message {
  const identity = source && Reflect.get(source, responsesInputSource);
  return {
    type: "message",
    role,
    content,
    ...(identity ? { [responsesInputSource]: identity } : {}),
  };
}

export { createAssistantOutput as createOpenAIResponsesAssistantOutput } from "./assistant-output.js";

type ConvertResponsesMessagesOptions = {
  includeSystemPrompt?: boolean;
  replayReasoningItems?: boolean;
  replayResponsesItemIds?: boolean;
  sessionId?: string;
  authProfileId?: string;
  replayMode?: OpenAIResponsesReplayMode;
};

function convertResponsesMessagesWithStyle(
  model: Model,
  context: Context,
  allowedToolCallProviders: ReadonlySet<string>,
  options: ConvertResponsesMessagesOptions | undefined,
  conversionStyle: "provider" | "transport",
): ResponseInput {
  const messages: ResponseInput = [];
  const providerStyle = conversionStyle === "provider";
  const shouldReplayReasoningItems = options?.replayReasoningItems ?? true;
  const shouldReplayResponsesItemIds = options?.replayResponsesItemIds ?? true;
  const replayContext = buildProviderReplayContext(model, {
    sessionId: options?.sessionId,
    authProfileId: options?.authProfileId,
  });
  const shouldNormalizeSameModelToolCallIds = model.provider === "github-copilot";
  const sanitizeIdPart = (part: string) => {
    const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
    return providerStyle ? sanitized : sanitized.replace(/_+$/, "");
  };
  const normalizeIdPart = (part: string) => {
    const sanitized = sanitizeIdPart(part);
    const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
    return normalized.replace(/_+$/, "");
  };
  const buildForeignResponsesItemId = (itemId: string) => `fc_${shortHash(itemId)}`;
  const buildSameProviderCopilotResponsesItemId = (itemId: string) => {
    const sanitized = sanitizeIdPart(itemId);
    const candidate = sanitized.startsWith("fc_") ? sanitized : `fc_${sanitized}`;
    return candidate.length > 64 ? buildForeignResponsesItemId(itemId) : candidate;
  };
  const normalizeToolCallId = (
    id: string,
    _targetModel: Model,
    source: { provider: string; api: Api },
  ) => {
    if (!allowedToolCallProviders.has(model.provider) || !id.includes("|")) {
      return normalizeIdPart(id);
    }
    const separatorIndex = id.indexOf("|");
    const callId = id.slice(0, separatorIndex);
    const itemId = id.slice(separatorIndex + 1);
    const normalizedCallId = normalizeIdPart(callId);
    const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
    let normalizedItemId = isForeignToolCall
      ? buildForeignResponsesItemId(itemId)
      : model.provider === "github-copilot"
        ? providerStyle
          ? normalizeIdPart(itemId)
          : buildSameProviderCopilotResponsesItemId(itemId)
        : normalizeIdPart(itemId);
    if (!normalizedItemId.startsWith("fc_")) {
      normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
    }
    return `${normalizedCallId}|${normalizedItemId}`;
  };
  const replayPlan = buildOpenAIResponsesCompactionReplayPlan(context.messages, model, {
    sessionId: options?.sessionId,
    authProfileId: options?.authProfileId,
    mode: options?.replayMode,
  });
  const transformMessages = (source: Context["messages"]) =>
    providerStyle
      ? transformProviderMessages(source, model, normalizeToolCallId)
      : getAiTransportHost().transformTransportMessages(source, model, normalizeToolCallId, {
          normalizeSameModelToolCallIds: shouldNormalizeSameModelToolCallIds,
          preserveUnframedToolResults: replayPlan.preserveUnframedToolResults,
        });
  // Results are durable when jobs finish, but Responses continuation must replay
  // every output fragment before adding results to that response's input suffix.
  const transformedMessages = orderResponsesAsyncToolResults(
    transformMessages(replayPlan.messages),
  );
  const includeSystemPrompt = options?.includeSystemPrompt ?? true;
  if (includeSystemPrompt && context.systemPrompt) {
    messages.push(
      buildResponsesInputMessage(resolveResponsesInstructionRole(model), [
        {
          type: "input_text",
          text: sanitizeTransportPayloadText(stripSystemPromptCacheBoundary(context.systemPrompt)),
        },
      ]),
    );
  }
  // The compact endpoint's output is already canonical provider input, not
  // internal user content to normalize or reinterpret as text/image blocks.
  if (replayPlan.compactedWindow) {
    messages.push(...replayPlan.compactedWindow);
  }
  let replayMessages = replayPlan.compaction
    ? [replayPlan.compaction, ...transformedMessages]
    : transformedMessages;
  // Responses continuation requires the complete prior input before tool output.
  // Each carrier stays with its preceding user/checkpoint; moving it past an
  // appended steering user would rewrite the already admitted request prefix.
  const isCarrier = (message: (typeof replayMessages)[number]) =>
    "role" in message && hasRuntimeContextMarker(message);
  if (replayMessages.some(isCarrier)) {
    const anchored: typeof replayMessages = [];
    // A canonical window is already emitted above; its checkpoint anchors an otherwise userless tail.
    let insertionIndex = replayPlan.compactedWindow ? 0 : undefined;
    for (const message of replayMessages) {
      if (isCarrier(message) && insertionIndex !== undefined) {
        anchored.splice(insertionIndex++, 0, message);
        continue;
      }
      anchored.push(message);
      if (
        !isCarrier(message) &&
        ("role" in message ? message.role === "user" : message.type === "compaction")
      ) {
        insertionIndex = anchored.length;
      }
    }
    replayMessages = anchored;
  }
  let msgIndex = 0;
  const appendAssistant = createResponsesInputReplay(model);
  const inHistorySystemUpdates = supportsNativeOpenAIResponsesEndpoint(model);
  for (const msg of replayMessages) {
    if (!("role" in msg)) {
      messages.push(msg);
      continue;
    }
    if (inHistorySystemUpdates && isRuntimeContextMessage(msg)) {
      messages.push(
        buildResponsesInputMessage(resolveResponsesInstructionRole(model), [
          {
            type: "input_text",
            text: sanitizeTransportPayloadText(runtimeContextContentToText(msg.content)),
          },
        ]),
      );
    } else if (msg.role === "user") {
      const role =
        msg.operatorMessage &&
        inHistorySystemUpdates &&
        (typeof msg.content === "string" || msg.content.every((block) => block.type === "text"))
          ? resolveResponsesInstructionRole(model)
          : "user";
      const content: ResponseInputMessageContentList =
        typeof msg.content === "string"
          ? [{ type: "input_text", text: sanitizeTransportPayloadText(msg.content) }]
          : (
              msg.content.map((item) =>
                item.type === "text"
                  ? { type: "input_text", text: sanitizeTransportPayloadText(item.text) }
                  : {
                      type: "input_image",
                      detail: "auto",
                      image_url: `data:${item.mimeType};base64,${item.data}`,
                    },
              ) as ResponseInputMessageContentList
            ).filter(
              (item) =>
                providerStyle || model.input.includes("image") || item.type !== "input_image",
            );
      if (content.length > 0) {
        messages.push(buildResponsesInputMessage(role, content, msg));
      } else if (providerStyle) {
        continue;
      }
    } else if (msg.role === "assistant") {
      const output: ResponseInput = [];
      let textFallbackOrdinal = 0;
      let previousReplayItemWasReasoning = false;
      const isDifferentModel =
        msg.model !== model.id && msg.provider === model.provider && msg.api === model.api;
      for (const block of msg.content) {
        if (block.type === "thinking") {
          if (
            shouldReplayReasoningItems &&
            block.thinkingSignature &&
            (providerStyle || block.thinkingSignature.startsWith("{"))
          ) {
            // Persisted signatures are provider-owned data. Skip malformed or unrelated
            // shapes so one corrupt history item cannot prevent the next request.
            let reasoningItem: unknown;
            try {
              reasoningItem = JSON.parse(block.thinkingSignature);
            } catch {
              continue;
            }
            if (!isRecord(reasoningItem) || reasoningItem.type !== "reasoning") {
              continue;
            }
            const replayableReasoningItem = prepareOpenAIResponsesReasoningItemForReplay(
              reasoningItem as ReplayableResponseReasoningItem,
              replayContext,
              readOpenAIResponsesReasoningReplayBlockMetadata(isRecord(block) ? block : {}),
              providerStyle ? { preserveUnattributedEncryptedContent: true } : undefined,
            );
            if (!shouldReplayResponsesItemIds) {
              delete replayableReasoningItem.id;
            }
            if (
              shouldReplayResponsesItemIds &&
              !providerStyle &&
              model.provider === "github-copilot" &&
              !isSafeResponsesReplayItemId(replayableReasoningItem.id)
            ) {
              continue;
            }
            output.push(replayableReasoningItem as ResponseInputItem);
            previousReplayItemWasReasoning = true;
          }
        } else if (block.type === "text") {
          const textSignature = parseOpenAIResponsesTextSignature(block.textSignature);
          let msgId = resolveReplayableResponsesMessageId({
            replayResponsesItemIds: shouldReplayResponsesItemIds,
            textSignatureId: textSignature?.id,
            fallbackId: `msg_${msgIndex}`,
            fallbackOrdinal: textFallbackOrdinal,
            previousReplayItemWasReasoning,
          });
          if (!textSignature?.id) {
            textFallbackOrdinal += 1;
          }
          msgId = normalizeResponsesReplayItemId(msgId);
          const messageItem: ReplayableResponseOutputMessage = {
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
            ...(msgId ? { id: msgId } : {}),
            phase: textSignature?.phase,
          };
          output.push(messageItem as ResponseInputItem);
          previousReplayItemWasReasoning = false;
        } else if (block.type === "toolCall") {
          const separatorIndex = block.id.indexOf("|");
          const callId = separatorIndex === -1 ? block.id : block.id.slice(0, separatorIndex);
          const itemIdRaw = separatorIndex === -1 ? undefined : block.id.slice(separatorIndex + 1);
          const itemId =
            shouldReplayResponsesItemIds && !(isDifferentModel && itemIdRaw?.startsWith("fc_"))
              ? itemIdRaw
              : undefined;
          output.push({
            type: "function_call",
            ...(itemId ? { id: itemId } : {}),
            call_id: callId,
            name: block.name,
            ...(block.async ? { async: true } : {}),
            arguments: providerStyle
              ? JSON.stringify(block.arguments)
              : typeof block.arguments === "string"
                ? block.arguments
                : JSON.stringify(block.arguments ?? {}),
          });
          previousReplayItemWasReasoning = false;
        }
      }
      // Completed encrypted reasoning is self-contained, including steered async
      // fragments. After route checks strip ciphertext, bare ids still need a following item.
      while (true) {
        const last = output.at(-1);
        if (
          last?.type !== "reasoning" ||
          !last.id?.startsWith("rs_") ||
          (typeof last.encrypted_content === "string" && last.encrypted_content.length > 0)
        ) {
          break;
        }
        output.pop();
      }
      appendAssistant(messages, output, msg);
      if (output.length === 0 && providerStyle) {
        continue;
      }
    } else if (msg.role === "toolResult") {
      const textResult = extractToolResultText(msg.content);
      const hasText = textResult.trim().length > 0;
      const mediaPlaceholder = describeToolResultMediaPlaceholder(msg.content);
      const hasImages = msg.content.some(isImageWithMediaPayload);
      const separatorIndex = msg.toolCallId.indexOf("|");
      const callId =
        separatorIndex === -1 ? msg.toolCallId : msg.toolCallId.slice(0, separatorIndex);
      let output: string | ResponseFunctionCallOutputItemList = hasText
        ? textResult
        : (mediaPlaceholder ?? "(no output)");
      if (hasImages && model.input.includes("image")) {
        const parts: ResponseFunctionCallOutputItemList = [];
        const hasExplicitText = msg.content.some(
          (item) => item.type === "text" && extractToolResultBlockText(item),
        );
        if (hasText && !hasExplicitText) {
          parts.push({ type: "input_text", text: textResult });
        } else if (!hasText && mediaPlaceholder === "(see attached media)") {
          parts.push({ type: "input_text", text: mediaPlaceholder });
        }
        let textSeparator = "";
        for (const item of msg.content) {
          if (isImageWithMediaPayload(item)) {
            parts.push({
              type: "input_image",
              detail: "auto",
              image_url: `data:${item.mimeType};base64,${item.data}`,
            });
          } else if (hasText && item.type === "text") {
            const text = extractToolResultBlockText(item);
            if (text) {
              // Preserve text joining for compatibility routes that flatten these parts.
              const joinedText = `${textSeparator}${text}`;
              textSeparator = "\n";
              const previous = parts.at(-1);
              if (previous?.type === "input_text") {
                previous.text += joinedText;
              } else {
                parts.push({ type: "input_text", text: joinedText });
              }
            }
          }
        }
        output = parts;
      }
      messages.push({
        type: "function_call_output",
        call_id: callId,
        output,
      });
    }
    msgIndex += 1;
  }
  return messages;
}

export function convertResponsesMessages(
  model: Model,
  context: Context,
  allowedToolCallProviders: ReadonlySet<string>,
  options?: ConvertResponsesMessagesOptions,
): ResponseInput {
  return convertResponsesMessagesWithStyle(
    model,
    context,
    allowedToolCallProviders,
    options,
    "transport",
  );
}

export function convertProviderResponsesMessages<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  allowedToolCallProviders: ReadonlySet<string>,
  options?: {
    includeSystemPrompt?: boolean;
    replayResponsesItemIds?: boolean;
    sessionId?: string;
    authProfileId?: string;
    replayMode?: OpenAIResponsesReplayMode;
  },
): ResponseInput {
  return convertResponsesMessagesWithStyle(
    model,
    context,
    allowedToolCallProviders,
    options,
    "provider",
  );
}
