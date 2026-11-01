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
import { preparedRequestSuffix } from "../provider-options.js";
import { transformProviderMessages } from "../provider-transcript-transform.js";
import {
  describeToolResultMediaPlaceholder,
  extractToolResultBlockText,
  extractToolResultText,
} from "../providers/tool-result-text.js";
import { shortHash } from "../utils/hash.js";
import { prepareSystemPrompt } from "../utils/system-prompt-cache-boundary.js";
import {
  buildOpenAIResponsesCompactionReplayPlan,
  isSafeResponsesReplayItemId,
  type OpenAIResponsesReplayMode,
} from "./openai-responses-compaction-replay.js";
import { tagResponsesCompactionInput } from "./openai-responses-compaction-window.js";
import {
  OPENAI_RESPONSES_REASONING_REPLAY_BLOCK_META_KEY,
  OPENAI_RESPONSES_REASONING_REPLAY_META_KEY,
  OPENAI_RESPONSES_REPLAY_ITEM_ID_MAX_LENGTH,
  RESPONSES_RETAINED_USER,
  type OpenAIResponsesReasoningReplayMetadata,
  type ReplayableResponseOutputMessage,
  type ReplayableResponseReasoningItem,
} from "./openai-responses-contracts.js";
import { supportsNativeOpenAIResponsesEndpoint } from "./openai-responses-endpoint.js";
import { createResponsesInputReplay } from "./openai-responses-input-replay.js";
import {
  normalizeOpenAIResponsesReasoningReplayItem,
  resolveReplayableResponsesMessageId,
} from "./openai-responses-replay.js";
import {
  buildProviderReplayContext,
  isProviderReplayContext,
  providerReplayContextMatches,
  type ProviderReplayContext,
} from "./provider-replay-context.js";
import { buildResponsesInputImage } from "./responses-image-payload-sanitizer.js";
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

function prepareOpenAIResponsesReasoningItemForReplay(
  item: ReplayableResponseReasoningItem,
  context: ProviderReplayContext,
  blockMetadata?: OpenAIResponsesReasoningReplayMetadata | null,
  options?: { preserveUnattributedEncryptedContent?: boolean },
): ReplayableResponseReasoningItem {
  const hasRawMetadata = Object.hasOwn(item, OPENAI_RESPONSES_REASONING_REPLAY_META_KEY);
  const { [OPENAI_RESPONSES_REASONING_REPLAY_META_KEY]: rawMetadata, ...rest } = item;
  if (!("encrypted_content" in rest)) {
    return normalizeOpenAIResponsesReasoningReplayItem(rest, context.api);
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
    return normalizeOpenAIResponsesReasoningReplayItem(rest, context.api);
  }
  return normalizeOpenAIResponsesReasoningReplayItem(
    stripEncryptedReasoningContentFields(rest) as ReplayableResponseReasoningItem,
    context.api,
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

function responsesAssistantTurnKey(message: AssistantMessage) {
  // Early fragments keep this identity when the provider ID arrives at completion.
  const id = message.turnId || message.responseId;
  return id ? `${message.provider}:${message.api}:${message.model}:${id}` : undefined;
}

function orderResponsesAsyncToolResults(source: Context["messages"]): Context["messages"] {
  const lastAssistant = new Map<string, number>();
  for (const [index, message] of source.entries()) {
    if (message.role === "assistant") {
      const key = responsesAssistantTurnKey(message);
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
      const key = responsesAssistantTurnKey(message);
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
): { id?: string; phase?: "commentary" | "final_answer"; sources?: string } | undefined {
  if (!signature) {
    return undefined;
  }
  if (signature.startsWith("{")) {
    try {
      const parsed = JSON.parse(signature) as {
        v?: unknown;
        id?: unknown;
        phase?: unknown;
        sources?: unknown;
      };
      if (parsed.v === 1) {
        const id = typeof parsed.id === "string" ? parsed.id : undefined;
        const phase =
          parsed.phase === "commentary" || parsed.phase === "final_answer"
            ? parsed.phase
            : undefined;
        // A reasoning-dropped replay keeps the phase but omits the paired id.
        if (id !== undefined || phase !== undefined) {
          return {
            id,
            phase,
            ...(typeof parsed.sources === "string" ? { sources: parsed.sources } : {}),
          };
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
  replayResponsesItemIds?: boolean;
  sessionId?: string;
  authProfileId?: string;
  replayMode?: OpenAIResponsesReplayMode;
  retainUserProvenance?: boolean;
  mutableInput?: boolean;
};

// Weak source keys release projections with history. Keep a bounded set of route/position
// variants so interleaved requests reuse their own result without retaining every route.
const responsesMessageProjections = new WeakMap<
  Context["messages"][number],
  Map<string, ResponseInput>
>();

/** Detach hook-editable JSON containers while retaining scalar strings. */
function cloneResponsesInputForPayloadHook<T>(value: T): T {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    // SAFETY: Copying converter-owned JSON preserves the array shape and every member's type.
    return value.map(cloneResponsesInputForPayloadHook) as T;
  }
  // Non-wire source/provenance symbols retain identity through payload spreads.
  const copy = { ...value };
  for (const key of Object.keys(copy)) {
    Reflect.set(copy, key, cloneResponsesInputForPayloadHook(Reflect.get(value, key)));
  }
  return copy;
}

function convertResponsesMessagesWithStyle(
  model: Model,
  context: Context,
  allowedToolCallProviders: ReadonlySet<string>,
  options: ConvertResponsesMessagesOptions | undefined,
  conversionStyle: "provider" | "transport",
): ResponseInput {
  const messages: ResponseInput = [];
  const providerStyle = conversionStyle === "provider";
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
          preserveUnframedToolResults:
            replayPlan.preserveUnframedToolResults || preparedRequestSuffix.has(context),
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
          text: prepareSystemPrompt(context.systemPrompt, context.preparedSystemPrompt)
            .instructions,
        },
      ]),
    );
  }
  // The compact endpoint's output is already canonical provider input, not
  // internal user content to normalize or reinterpret as text/image blocks.
  if (replayPlan.compactedWindow) {
    const window = replayPlan.compactedWindow.map((item) => {
      if (options?.retainUserProvenance && item.type === "message" && item.role === "user") {
        return tagResponsesCompactionInput(item, RESPONSES_RETAINED_USER);
      }
      // SAFETY: Validated window; Responses accepts assistant output_text without an id.
      return item as ResponseInputItem;
    });
    messages.push(...(options?.mutableInput ? cloneResponsesInputForPayloadHook(window) : window));
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
  const convertMessage = (
    msg: Context["messages"][number],
    messageIndex: number,
  ): ResponseInput => {
    const converted: ResponseInput = [];
    if (inHistorySystemUpdates && isRuntimeContextMessage(msg)) {
      converted.push(
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
                  : buildResponsesInputImage(item),
              ) as ResponseInputMessageContentList
            ).filter(
              (item) =>
                providerStyle || model.input.includes("image") || item.type !== "input_image",
            );
      if (content.length > 0) {
        const input = buildResponsesInputMessage(role, content, msg);
        if (
          options?.retainUserProvenance &&
          role === "user" &&
          !msg.synthetic &&
          !msg.operatorMessage &&
          !hasRuntimeContextMarker(msg)
        ) {
          Object.assign(input, { [RESPONSES_RETAINED_USER]: true });
        }
        converted.push(input);
      }
    } else if (msg.role === "assistant") {
      const output = converted;
      const sourceTurnKey = responsesAssistantTurnKey(msg);
      const sourceFragmentId = msg.content.find((block) => block.type === "toolCall")?.id;
      let textFallbackOrdinal = 0;
      let previousReplayItemWasReasoning = false;
      let seenReplayableReasoning = false;
      const isDifferentModel =
        msg.model !== model.id && msg.provider === model.provider && msg.api === model.api;
      for (const block of msg.content) {
        if (block.type === "thinking") {
          if (
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
              // Summaries alone cannot verify stateless reasoning and poison
              // the next cached continuation, even if this request succeeds.
              if (!replayableReasoningItem.encrypted_content) {
                continue;
              }
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
            seenReplayableReasoning ||=
              typeof replayableReasoningItem.id === "string" &&
              replayableReasoningItem.id.startsWith("rs_");
          }
        } else if (block.type === "text") {
          const textSignature = parseOpenAIResponsesTextSignature(block.textSignature);
          let msgId = resolveReplayableResponsesMessageId({
            replayResponsesItemIds: shouldReplayResponsesItemIds,
            textSignatureId: textSignature?.id,
            // Async prefixes own a call; the final tail has none. Both survive history pruning.
            fallbackId: sourceTurnKey
              ? `msg_${shortHash(JSON.stringify([sourceTurnKey, sourceFragmentId]))}`
              : `msg_${messageIndex}`,
            fallbackOrdinal: textFallbackOrdinal,
            previousReplayItemWasReasoning,
          });
          if (!textSignature?.id) {
            textFallbackOrdinal += 1;
          }
          msgId = normalizeResponsesReplayItemId(msgId);
          // Source links are OpenClaw's rendering, not provider output. Replaying the
          // provider text keeps history equal to the stored response for continuation.
          const sources = textSignature?.sources;
          const providerText =
            sources && block.text.endsWith(sources)
              ? block.text.slice(0, -sources.length)
              : block.text;
          const messageItem: ReplayableResponseOutputMessage = {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: sanitizeTransportPayloadText(providerText),
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
          // Orphan fc_* ids can be rejected; omit them on the wire without rewriting history.
          const itemId =
            shouldReplayResponsesItemIds &&
            (!itemIdRaw?.startsWith("fc_") || (seenReplayableReasoning && !isDifferentModel))
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
      return output;
    } else if (msg.role === "toolResult") {
      const textResult = extractToolResultText(msg.content);
      const hasText = textResult.trim().length > 0;
      const mediaPlaceholder = describeToolResultMediaPlaceholder(msg.content);
      const hasImages = msg.content.some(isImageWithMediaPayload);
      const separatorIndex = msg.toolCallId.indexOf("|");
      const rawCallId =
        separatorIndex === -1 ? msg.toolCallId : msg.toolCallId.slice(0, separatorIndex);
      const callId = preparedRequestSuffix.has(context)
        ? preparedRequestSuffix.toolCallId(
            context,
            rawCallId,
            normalizeToolCallId(rawCallId, model, model),
          )
        : rawCallId;
      let output: string | ResponseFunctionCallOutputItemList = hasText
        ? textResult
        : (mediaPlaceholder ?? "(no output)");
      if (hasImages && model.input.includes("image")) {
        const parts: ResponseFunctionCallOutputItemList = [];
        let hasExplicitText = false;
        for (const item of msg.content) {
          if (isImageWithMediaPayload(item)) {
            parts.push(buildResponsesInputImage(item));
          } else if (hasText && item.type === "text") {
            const text = extractToolResultBlockText(item);
            if (text) {
              const joinedText = `${hasExplicitText ? "\n" : ""}${text}`;
              hasExplicitText = true;
              const previous = parts.at(-1);
              if (previous?.type === "input_text") {
                previous.text += joinedText;
              } else {
                parts.push({ type: "input_text", text: joinedText });
              }
            }
          }
        }
        if (hasText && !hasExplicitText) {
          parts.unshift({ type: "input_text", text: textResult });
        } else if (!hasText && mediaPlaceholder === "(see attached media)") {
          parts.unshift({ type: "input_text", text: mediaPlaceholder });
        }
        output = parts;
      }
      converted.push({
        type: "function_call_output",
        call_id: callId,
        output,
      });
    }
    return converted;
  };
  const immutable = getAiTransportHost().immutableData;
  const projectionKey = JSON.stringify([
    conversionStyle,
    replayContext,
    shouldReplayResponsesItemIds,
    inHistorySystemUpdates,
    resolveResponsesInstructionRole(model),
    model.input.includes("image"),
    options?.retainUserProvenance === true,
  ]);
  for (const msg of replayMessages) {
    if (!("role" in msg)) {
      messages.push(...(options?.mutableInput ? cloneResponsesInputForPayloadHook([msg]) : [msg]));
      continue;
    }
    // Prepared suffix results resolve IDs against the current request's call map.
    // Images already have prepared scalar facts. Caching their composed data URLs
    // would retain a second large base64 string alongside each source image.
    const reusable =
      immutable &&
      !preparedRequestSuffix.has(context) &&
      immutable.isDeeplyFrozenPlainData(msg) &&
      (typeof msg.content === "string" || !msg.content.some((block) => block.type === "image"));
    const key = `${projectionKey}:${msgIndex}`;
    let projections = reusable ? responsesMessageProjections.get(msg) : undefined;
    let output = projections?.get(key);
    if (!output) {
      output = convertMessage(msg, msgIndex);
      if (reusable) {
        immutable.freezeJsonSnapshot(output);
        if (!projections) {
          projections = new Map();
          responsesMessageProjections.set(msg, projections);
        }
        if (projections.size >= 8) {
          const oldest = projections.keys().next().value;
          if (oldest !== undefined) {
            projections.delete(oldest);
          }
        }
        projections.set(key, output);
      }
    }
    if (reusable && options?.mutableInput) {
      output = cloneResponsesInputForPayloadHook(output);
    }
    if (msg.role === "assistant") {
      appendAssistant(messages, output, msg);
    } else {
      messages.push(...output);
    }
    if (output.length > 0 || !providerStyle) {
      msgIndex += 1;
    }
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
  options?: ConvertResponsesMessagesOptions,
): ResponseInput {
  return convertResponsesMessagesWithStyle(
    model,
    context,
    allowedToolCallProviders,
    options,
    "provider",
  );
}
