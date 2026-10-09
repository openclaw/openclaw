import { randomUUID } from "node:crypto";
import type {
  AssistantMessageEvent,
  Model,
  TextContent as TextBlock,
  ThinkingContent as ThinkingBlock,
  ToolCall,
} from "@openclaw/llm-core";
import { appendAssistantThinking } from "@openclaw/llm-core/event-stream";
import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { readNonEmptyStringPreservingWhitespace } from "@openclaw/normalization-core/string-coerce";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import type { OpenAICompletionsOptions } from "../provider-options.js";
import {
  createOpenAICompletionsToolCallDeltaNormalizer,
  createOpenAIEncryptedToolCallReasoningTracker,
  finalizeOpenAICompletionsToolCalls,
  hasOpenAICompletionsDeltaContent,
} from "../providers/openai-completions-tool-calls.js";
import { mapOpenAIStopReason } from "../providers/openai-stop-reason.js";
import {
  clearPendingCommentaryText,
  rememberPendingCommentaryTags,
  tagInterruptedTextPhases,
  tagPendingCommentaryText,
  tagUnresolvedTextAsCommentary,
  type PendingCommentaryTags,
} from "../utils/assistant-text-phase.js";
import {
  createToolArgumentPreviewSchedule,
  parseStreamingJson,
  type ToolArgumentPreviewSchedule,
} from "../utils/json-parse.js";
import { notifyLlmRequestActivity } from "../utils/llm-request-activity.js";
import { createReasoningTagTextPartitioner } from "../utils/reasoning-tag-text-partitioner.js";
import { withFirstStreamEventTimeout } from "../utils/stream-first-event-timeout.js";
import { createDeepSeekTextFilter } from "./deepseek-text-filter.js";
import { detectOpenAICompletionsCompat } from "./openai-completions-compat.js";
import {
  createDsmlRecoverer,
  type DeepSeekDsmlRecoveredPart,
  type RecoveredDeepSeekDsmlToolCall,
} from "./openai-completions-dsml.js";
import { getCompat } from "./openai-transport-params.js";
import {
  isOpenAICompletionsThinkingEnabled,
  log,
  parseOpenAICompletionsUsage,
  readOpenAICompletionsContentDeltas,
  readOpenAICompletionsReasoningBatch,
  type MutableAssistantOutput,
  type OpenAICompletionsContentDelta as CompletionsReasoningDelta,
  type OpenAICompletionsTextSource,
  type OpenAIModeModel,
} from "./openai-transport-shared.js";
import { iterateModelStream, throwIfModelStreamAborted } from "./transport-stream-shared.js";

type OpenAICompatibleChoice = ChatCompletionChunk["choices"][number] & {
  // Some compatible providers attach usage per choice instead of per chunk.
  usage?: ChatCompletionChunk["usage"];
  // Some compatible providers stream a complete message in place of delta.
  message?: ChatCompletionChunk["choices"][number]["delta"];
};

type OpenAICompatibleChatCompletionChunk = Omit<ChatCompletionChunk, "choices"> & {
  choices: OpenAICompatibleChoice[];
};

type CompletionsStreamOptions = {
  signal?: AbortSignal;
  emitReasoning?: boolean;
  strictReasoningTags?: boolean;
  firstEventTimeoutMs?: number;
  abortFirstEventStream?: (reason: Error) => void;
  onFirstEventTimeout?: (reason: Error) => void;
  sawStreamDONE?: () => boolean;
} & (
  | {
      mode: "direct";
      beforeContentBlock: (nextType: "text" | "thinking" | "toolCall") => void;
      provisionalCommentaryTags: PendingCommentaryTags;
    }
  | { mode?: "managed"; beforeContentBlock?: never }
);

function extractToolCallThoughtSignature(toolCall: unknown): string | undefined {
  const tc = toolCall as Record<string, unknown> | undefined;
  if (!tc) {
    return undefined;
  }
  const extra = (tc.extra_content as Record<string, unknown> | undefined)?.google as
    | Record<string, unknown>
    | undefined;
  return (
    readNonEmptyStringPreservingWhitespace(extra?.thought_signature) ??
    readNonEmptyStringPreservingWhitespace(
      (tc.function as { thought_signature?: unknown } | undefined)?.thought_signature,
    ) ??
    readNonEmptyStringPreservingWhitespace(tc.thought_signature)
  );
}

export async function processCompletionsStream(
  responseStream: AsyncIterable<ChatCompletionChunk>,
  output: MutableAssistantOutput,
  model: Model,
  stream: { push(event: AssistantMessageEvent): void },
  options?: CompletionsStreamOptions,
) {
  const MAX_POST_TOOL_CALL_BUFFER_BYTES = 256_000;
  const directMode = options?.mode === "direct";
  const emitReasoning = options?.emitReasoning ?? true;
  const openAIModel = model as OpenAIModeModel;
  const compat = getCompat(openAIModel);
  const visibleReasoningDetailTypes = new Set(compat.visibleReasoningDetailTypes);
  const shouldFilterDeepSeekDsmlText = !directMode && compat.thinkingFormat === "deepseek";
  const deepSeekTextFilter = shouldFilterDeepSeekDsmlText ? createDeepSeekTextFilter() : null;
  const deepSeekToolCallRecoverer = shouldFilterDeepSeekDsmlText ? createDsmlRecoverer() : null;
  const reasoningTagTextPartitioner = createReasoningTagTextPartitioner();
  if (options?.strictReasoningTags) {
    reasoningTagTextPartitioner.markStrict();
  }
  type ToolCallBlock = ToolCall & { partialArgs: string };
  let currentBlock: TextBlock | ThinkingBlock | ToolCallBlock | null = null;
  let directTextBlock: TextBlock | null = null;
  let directThinkingBlock: ThinkingBlock | null = null;
  let currentTextSource: OpenAICompletionsTextSource | undefined;
  let pendingInterruptedTextBlock: TextBlock | null = null;
  let confirmedInterruptedTextBlock: TextBlock | null = null;
  let pendingPostToolCallDeltas: CompletionsReasoningDelta[] = [];
  let pendingPostToolCallBytes = 0;
  const toolCallBlocksByIndex = new Map<number, ToolCallBlock>();
  const toolCallBlocksById = new Map<string, ToolCallBlock>();
  const encryptedReasoning = createOpenAIEncryptedToolCallReasoningTracker();
  // Preview schedules are per active tool call; WeakMap keys die with the block.
  const toolArgumentPreviewSchedules = new WeakMap<ToolCallBlock, ToolArgumentPreviewSchedule>();
  const provisionalCommentaryTags = directMode ? options.provisionalCommentaryTags : new Map();
  const contentBlockIndices = new WeakMap<TextBlock | ThinkingBlock, number>();
  const toolCallBlockIndices = new WeakMap<ToolCallBlock, number>();
  let explicitVisibleTextBlocks: Set<TextBlock> | undefined;
  const normalizeToolCallDeltas = createOpenAICompletionsToolCallDeltaNormalizer();
  let finishReason: string | undefined;
  let sawNativeToolCallDelta = false;
  const blockIndex = () =>
    directMode && currentBlock && currentBlock.type !== "toolCall"
      ? (contentBlockIndices.get(currentBlock) ?? output.content.length - 1)
      : output.content.length - 1;
  let chunkPushedEvent = false;
  const pushStreamEvent = (event: AssistantMessageEvent) => {
    chunkPushedEvent = true;
    stream.push(event);
  };
  const queuePostToolCallDelta = (next: CompletionsReasoningDelta) => {
    const nextBytes = Buffer.byteLength(next.text, "utf8");
    if (pendingPostToolCallBytes + nextBytes > MAX_POST_TOOL_CALL_BUFFER_BYTES) {
      throw new Error("Exceeded post-tool-call delta buffer limit");
    }
    pendingPostToolCallBytes += nextBytes;
    const previous = pendingPostToolCallDeltas[pendingPostToolCallDeltas.length - 1];
    if (
      !previous ||
      previous.kind !== next.kind ||
      (previous.kind === "text" && next.kind === "text" && previous.source !== next.source) ||
      (previous.kind === "thinking" &&
        next.kind === "thinking" &&
        previous.signature !== next.signature)
    ) {
      pendingPostToolCallDeltas.push(next);
      return;
    }
    previous.text += next.text;
  };
  const appendThinkingDelta = (reasoningDelta: { signature?: string; text: string }) => {
    flushPendingPostToolCallDeltas();
    if (directMode && directThinkingBlock) {
      currentBlock = directThinkingBlock;
    }
    if (!currentBlock || currentBlock.type !== "thinking") {
      options?.beforeContentBlock?.("thinking");
      const thinkingSignature = reasoningDelta.signature;
      currentBlock = {
        type: "thinking",
        thinking: "",
        ...(thinkingSignature ? { thinkingSignature } : {}),
      };
      if (directMode) {
        directTextBlock = null;
        directThinkingBlock = currentBlock;
      }
      output.content.push(currentBlock);
      contentBlockIndices.set(currentBlock, output.content.length - 1);
      pushStreamEvent({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
    }
    appendAssistantThinking(currentBlock, reasoningDelta.text);
    pushStreamEvent({
      type: "thinking_delta",
      contentIndex: blockIndex(),
      delta: reasoningDelta.text,
      partial: output,
    });
  };
  const appendTextDelta = (text: string, source?: OpenAICompletionsTextSource) => {
    flushPendingPostToolCallDeltas();
    if (directMode && directTextBlock) {
      currentBlock = directTextBlock;
    }
    if (currentBlock?.type === "text" && currentTextSource !== source) {
      currentBlock = null;
    }
    if (!currentBlock || currentBlock.type !== "text") {
      options?.beforeContentBlock?.("text");
      currentBlock = { type: "text", text: "" };
      currentTextSource = source;
      if (directMode) {
        directTextBlock = currentBlock;
        directThinkingBlock = null;
      }
      if (source === "reasoning_detail") {
        (explicitVisibleTextBlocks ??= new Set()).add(currentBlock);
      }
      output.content.push(currentBlock);
      contentBlockIndices.set(currentBlock, output.content.length - 1);
      pushStreamEvent({ type: "text_start", contentIndex: blockIndex(), partial: output });
    }
    currentBlock.text += text;
    if (pendingInterruptedTextBlock && text.trim()) {
      confirmedInterruptedTextBlock = pendingInterruptedTextBlock;
      pendingInterruptedTextBlock = null;
    }
    pushStreamEvent({
      type: "text_delta",
      contentIndex: blockIndex(),
      delta: text,
      ...(directMode ? { partial: output } : {}),
    });
  };
  const flushPendingPostToolCallDeltas = () => {
    if (currentBlock?.type === "toolCall" || pendingPostToolCallDeltas.length === 0) {
      return;
    }
    const bufferedDeltas = pendingPostToolCallDeltas;
    // Detach the buffer so each append below sees an empty queue.
    pendingPostToolCallDeltas = [];
    pendingPostToolCallBytes = 0;
    for (const delta of bufferedDeltas) {
      if (delta.kind === "text") {
        appendTextDelta(delta.text, delta.source);
      } else if (emitReasoning) {
        appendThinkingDelta(delta);
      }
    }
  };
  const appendVisibleTextDelta = (text: string) => {
    if (!text) {
      return;
    }
    if (currentBlock?.type === "toolCall" && !directMode) {
      queuePostToolCallDelta({ kind: "text", text });
    } else {
      appendTextDelta(text);
    }
  };
  const appendReasoningDeltas = (reasoningDeltas: readonly CompletionsReasoningDelta[]) => {
    for (const reasoningDelta of reasoningDeltas) {
      if (reasoningDelta.kind === "thinking" && !emitReasoning) {
        continue;
      }
      if (currentBlock?.type === "toolCall" && !directMode) {
        queuePostToolCallDelta({ ...reasoningDelta });
        continue;
      }
      if (reasoningDelta.kind === "text") {
        appendTextDelta(reasoningDelta.text, reasoningDelta.source);
      } else {
        appendThinkingDelta(
          directMode && model.provider === "opencode-go" && reasoningDelta.signature === "reasoning"
            ? { ...reasoningDelta, signature: "reasoning_content" }
            : reasoningDelta,
        );
      }
    }
  };
  const appendRecoveredToolCall = (toolCall: RecoveredDeepSeekDsmlToolCall) => {
    if (currentBlock?.type === "toolCall") {
      currentBlock = null;
      flushPendingPostToolCallDeltas();
    }
    rememberPendingCommentaryTags(
      provisionalCommentaryTags,
      tagPendingCommentaryText(output.content),
    );
    const block: ToolCallBlock = {
      type: "toolCall",
      // DSML has no provider call id. A response-local counter would alias a
      // later assistant response and could collapse distinct mutating calls.
      id: `call_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      name: toolCall.name,
      arguments: toolCall.arguments,
      partialArgs: toolCall.partialArgs,
    };
    currentBlock = block;
    output.content.push(block);
    toolCallBlockIndices.set(block, output.content.length - 1);
    pushStreamEvent({
      type: "toolcall_start",
      contentIndex: toolCallBlockIndices.get(block) ?? -1,
      partial: output,
    });
    pushStreamEvent({
      type: "toolcall_delta",
      contentIndex: toolCallBlockIndices.get(block) ?? -1,
      delta: toolCall.partialArgs,
      partial: output,
    });
  };
  const appendRecoveredParts = (recoveredParts: readonly DeepSeekDsmlRecoveredPart[]) => {
    for (const recoveredPart of recoveredParts) {
      if (recoveredPart.kind === "toolCall") {
        appendRecoveredToolCall(recoveredPart);
        continue;
      }
      const parts = deepSeekTextFilter?.push(recoveredPart.text) ?? [recoveredPart.text];
      for (const part of parts) {
        appendVisibleTextDelta(part);
      }
    }
  };
  const appendPartitionedVisibleDelta = (delta: { kind: "text" | "thinking"; text: string }) => {
    if (delta.kind === "text") {
      appendRecoveredParts(
        deepSeekToolCallRecoverer?.push(delta.text) ?? [{ kind: "text", text: delta.text }],
      );
    }
  };
  const emitReasoningUsageActivity = (hasReasoningUsageActivity: boolean) => {
    if (directMode || !hasReasoningUsageActivity || chunkPushedEvent || !emitReasoning) {
      return;
    }
    const latestBlock = output.content[output.content.length - 1];
    if (currentBlock?.type === "text" || currentBlock?.type === "toolCall") {
      return;
    }
    if (latestBlock?.type === "text" || latestBlock?.type === "toolCall") {
      return;
    }
    appendThinkingDelta({ text: "" });
  };
  const flushReasoningTagTextPartitioner = () => {
    for (const delta of reasoningTagTextPartitioner.flush()) {
      appendPartitionedVisibleDelta(delta);
    }
  };
  const sealTextBeforeReasoning = () => {
    if (currentBlock?.type !== "text" && !reasoningTagTextPartitioner.hasPending()) {
      return;
    }
    flushReasoningTagTextPartitioner();
    if (currentBlock?.type !== "text") {
      return;
    }
    // Resumed reasoning makes the preceding visible text interim. Preserve
    // the candidate boundary only if later text confirms a final answer.
    if (currentTextSource !== "reasoning_detail" && currentBlock.text.trim()) {
      pendingInterruptedTextBlock = currentBlock;
    }
    currentBlock = null;
    if (directMode) {
      directTextBlock = null;
    }
    currentTextSource = undefined;
  };
  const beginReasoning = (hasFollowingVisibleText: boolean, forceStrict = false) => {
    if (!output.openclawDelivery?.textPhaseRequiresTerminal) {
      output.openclawDelivery = {
        ...output.openclawDelivery,
        textPhaseRequiresTerminal: true,
      };
    }
    if (forceStrict || reasoningTagTextPartitioner.hasPending()) {
      reasoningTagTextPartitioner.markStrict();
    }
    // Let following text finish syntax already owned by the Markdown
    // parser; otherwise packet batching cannot erase a lane boundary.
    if (!hasFollowingVisibleText || !reasoningTagTextPartitioner.hasPendingSyntax()) {
      sealTextBeforeReasoning();
    }
  };
  const guardedStream = withFirstStreamEventTimeout(responseStream as AsyncIterable<unknown>, {
    provider: model.provider,
    api: model.api,
    model: model.id,
    timeoutMs: options?.firstEventTimeoutMs ?? 0,
    stage: "completions",
    abort: options?.abortFirstEventStream,
    onTimeout: options?.onFirstEventTimeout,
    hint: "The provider may be stalled while parsing the tool payload; retry with a smaller tool surface or enable OPENCLAW_DEBUG_MODEL_PAYLOAD=tools to inspect exposed tools.",
  });
  const events = directMode ? guardedStream : iterateModelStream(guardedStream, options?.signal);
  for await (const rawChunk of events) {
    throwIfModelStreamAborted(options?.signal);
    chunkPushedEvent = false;
    if (!rawChunk || typeof rawChunk !== "object") {
      continue;
    }
    const chunk = rawChunk as OpenAICompatibleChatCompletionChunk;
    output.responseId ||= chunk.id;
    // Retain the provider-returned model when it differs from the requested id so
    // routed/alias responses are not misattributed, matching the direct provider
    // stream and the anthropic/responses managed transports.
    if (typeof chunk.model === "string" && chunk.model.length > 0 && chunk.model !== model.id) {
      output.responseModel ||= chunk.model;
    }
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    const usage = chunk.usage || choice?.usage;
    const hasReasoningUsageActivity = Boolean(
      asPositiveFiniteNumber(usage?.completion_tokens_details?.reasoning_tokens),
    );
    if (usage) {
      output.usage = parseOpenAICompletionsUsage(usage, model, {
        includeReasoningTokens: !directMode,
      });
    }
    const rawChoiceDelta = choice?.delta ?? choice?.message;
    // Classify before legacy-tool buffering and hidden-reasoning display filtering.
    notifyLlmRequestActivity(
      options?.signal,
      Boolean(
        usage ||
        choice?.finish_reason ||
        (rawChoiceDelta &&
          (rawChoiceDelta.tool_calls?.length || hasOpenAICompletionsDeltaContent(rawChoiceDelta))),
      ),
    );
    if (!choice) {
      emitReasoningUsageActivity(hasReasoningUsageActivity);
      continue;
    }
    if (choice.finish_reason) {
      const finishReasonResult = mapOpenAIStopReason(choice.finish_reason, {
        allowSingularToolCall: true,
      });
      output.stopReason = finishReasonResult.stopReason;
      finishReason = finishReasonResult.stopReason;
      if (finishReasonResult.errorMessage) {
        output.errorMessage = finishReasonResult.errorMessage;
      }
    }
    if (!rawChoiceDelta) {
      emitReasoningUsageActivity(hasReasoningUsageActivity);
      continue;
    }
    for (const normalizedDelta of normalizeToolCallDeltas(rawChoiceDelta, choice.finish_reason)) {
      const choiceDelta = normalizedDelta.delta;
      const deltaFields = choiceDelta as Record<string, unknown>;
      const reasoningBatch = readOpenAICompletionsReasoningBatch(
        deltaFields,
        visibleReasoningDetailTypes,
      );
      const reasoningDeltas = reasoningBatch.deltas;
      const hasReasoningThinking = reasoningBatch.hasThinking;
      // Share the content/refusal owner to avoid duplicate mirrored refusals.
      const contentDeltas = readOpenAICompletionsContentDeltas(
        choiceDelta.content,
        choiceDelta.refusal,
        reasoningBatch.mirroredThinking,
      );
      const lastVisibleTextIndex = contentDeltas.findLastIndex((delta) => delta.kind === "text");
      const hasSameChunkVisibleText = reasoningBatch.hasVisibleText || lastVisibleTextIndex !== -1;
      if (hasReasoningThinking) {
        beginReasoning(hasSameChunkVisibleText, true);
        appendReasoningDeltas(reasoningDeltas);
      }
      for (const [contentDeltaIndex, contentDelta] of contentDeltas.entries()) {
        if (contentDelta.kind === "text") {
          const routedDeltas = hasReasoningThinking
            ? reasoningTagTextPartitioner.push(contentDelta.text)
            : reasoningTagTextPartitioner.pushVisible(contentDelta.text);
          for (const routedDelta of routedDeltas) {
            appendPartitionedVisibleDelta(routedDelta);
          }
        } else {
          const hasLaterVisibleText = contentDeltaIndex < lastVisibleTextIndex;
          beginReasoning(hasLaterVisibleText);
          if (emitReasoning) {
            if (currentBlock?.type === "toolCall" && !directMode) {
              queuePostToolCallDelta(contentDelta);
            } else {
              appendThinkingDelta(contentDelta);
            }
          }
        }
      }
      if (!hasReasoningThinking) {
        appendReasoningDeltas(reasoningDeltas);
      }
      const toolCallDeltas = normalizedDelta.toolCalls;
      if (toolCallDeltas.length > 0) {
        sawNativeToolCallDelta = true;
        flushReasoningTagTextPartitioner();
        rememberPendingCommentaryTags(
          provisionalCommentaryTags,
          tagPendingCommentaryText(output.content),
        );
        for (const toolCall of toolCallDeltas) {
          const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
          let block =
            streamIndex !== undefined ? toolCallBlocksByIndex.get(streamIndex) : undefined;
          if (!block && toolCall.id) {
            block = toolCallBlocksById.get(toolCall.id);
          }
          if (!block) {
            if (currentBlock?.type === "toolCall") {
              currentBlock = null;
              flushPendingPostToolCallDeltas();
            }
            const initialSig = directMode ? undefined : extractToolCallThoughtSignature(toolCall);
            options?.beforeContentBlock?.("toolCall");
            if (directMode) {
              directThinkingBlock = null;
            }
            block = {
              type: "toolCall",
              id: toolCall.id || "",
              name: toolCall.function?.name || "",
              arguments: {},
              partialArgs: "",
              ...(initialSig ? { thoughtSignature: initialSig } : {}),
            };
            encryptedReasoning.rememberToolCall(block.id, block);
            toolArgumentPreviewSchedules.set(block, createToolArgumentPreviewSchedule());
            output.content.push(block);
            toolCallBlockIndices.set(block, output.content.length - 1);
            pushStreamEvent({
              type: "toolcall_start",
              contentIndex: toolCallBlockIndices.get(block) ?? -1,
              partial: output,
            });
          }
          if (streamIndex !== undefined && !toolCallBlocksByIndex.has(streamIndex)) {
            toolCallBlocksByIndex.set(streamIndex, block);
          }
          if (toolCall.id) {
            const previousId = block.id;
            if (!directMode || !block.id) {
              block.id = toolCall.id;
            }
            toolCallBlocksById.set(toolCall.id, block);
            if (block.id === toolCall.id) {
              encryptedReasoning.rememberToolCall(toolCall.id, block, previousId);
            }
          }
          currentBlock = block;
          // Mirror the pinned OpenAI SDK and the managed transport: a nonempty
          // function-name snapshot replaces the stored name so fragmented or
          // corrected streamed names cannot freeze on the first fragment. In
          // direct mode the first tool identity is authoritative, so only a
          // continuation whose id explicitly conflicts with the established
          // block keeps the first name; an absent id is treated as a
          // continuation (the block was already resolved by index or id above),
          // matching how the pinned SDK accumulates a later name-only frame.
          const conflictingId = directMode && block.id && toolCall.id && block.id !== toolCall.id;
          if (toolCall.function?.name && !conflictingId) {
            block.name = toolCall.function.name;
          }
          const deltaSig = directMode ? undefined : extractToolCallThoughtSignature(toolCall);
          if (deltaSig) {
            block.thoughtSignature = deltaSig;
          }
          const toolArgumentsDelta = toolCall.function?.arguments;
          if (toolArgumentsDelta) {
            block.partialArgs += toolArgumentsDelta;
            // Preview refresh is scheduled geometrically; the terminal
            // finalize re-parses the full buffer authoritatively either way.
            if (toolArgumentPreviewSchedules.get(block)?.(block.partialArgs.length)) {
              block.arguments = parseStreamingJson(block.partialArgs);
            }
          }
          if (toolArgumentsDelta || directMode) {
            pushStreamEvent({
              type: "toolcall_delta",
              contentIndex: toolCallBlockIndices.get(block) ?? -1,
              delta: toolArgumentsDelta ?? "",
              partial: output,
            });
          }
        }
      }
      encryptedReasoning.consumeDetails(deltaFields.reasoning_details);
    }
    flushPendingPostToolCallDeltas();
    emitReasoningUsageActivity(hasReasoningUsageActivity);
  }
  // The SDK can end an aborted SSE iterator normally; cancellation must win
  // before buffered terminal markers can promote provisional tool calls.
  throwIfModelStreamAborted(options?.signal);
  if (!finishReason && (directMode || options?.sawStreamDONE?.() === false)) {
    throw new Error("Stream ended without finish_reason");
  }
  flushReasoningTagTextPartitioner();
  appendRecoveredParts(deepSeekToolCallRecoverer?.flush() ?? []);
  for (const part of deepSeekTextFilter?.flush() ?? []) {
    appendVisibleTextDelta(part);
  }
  currentBlock = null;
  flushPendingPostToolCallDeltas();
  // Only an explicit stop or observed SSE terminal may authorize silent tool calls.
  finalizeOpenAICompletionsToolCalls(output, {
    allowSilentToolCallPromotion:
      finishReason === "stop" || (sawNativeToolCallDelta && (options?.sawStreamDONE?.() ?? false)),
    onConfirmedToolCall(block, contentIndex) {
      if (directMode) {
        return;
      }
      pushStreamEvent({
        type: "toolcall_end",
        contentIndex,
        toolCall: block,
        partial: output,
      });
    },
  });
  if (
    confirmedInterruptedTextBlock &&
    output.stopReason !== "toolUse" &&
    output.stopReason !== "error" &&
    output.stopReason !== "aborted"
  ) {
    tagInterruptedTextPhases(
      output.content,
      confirmedInterruptedTextBlock,
      explicitVisibleTextBlocks,
    );
  }
  if (output.stopReason !== "toolUse") {
    clearPendingCommentaryText(provisionalCommentaryTags);
  }
  if (output.stopReason === "error" || output.stopReason === "aborted") {
    tagUnresolvedTextAsCommentary(output);
  }
  if (output.stopReason === "toolUse") {
    tagPendingCommentaryText(output.content);
  }
  if (
    !output.usage.contextUsage &&
    !options?.signal?.aborted &&
    output.stopReason !== "error" &&
    output.stopReason !== "aborted"
  ) {
    output.usage.contextUsage = { state: "unavailable" };
    if (!compat.supportsUsageInStreaming) {
      warnMissingStreamingUsage(openAIModel);
    }
  }
}

// One hint per provider/model per process, capped so a long-lived Gateway that
// cycles through many custom models cannot grow the memo without bound.
const MAX_MISSING_USAGE_HINT_KEYS = 256;
const missingUsageHintKeys = new Set<string>();

function warnMissingStreamingUsage(model: OpenAIModeModel) {
  if (detectOpenAICompletionsCompat(model).capabilities.endpointClass !== "custom") {
    return;
  }
  const key = `${model.provider}/${model.id}`;
  if (missingUsageHintKeys.has(key) || missingUsageHintKeys.size >= MAX_MISSING_USAGE_HINT_KEYS) {
    return;
  }
  missingUsageHintKeys.add(key);
  log.warn(
    `${key} returned no token usage; context size is estimated and token accounting is unavailable. ` +
      "If this endpoint supports stream_options.include_usage, set compat.supportsUsageInStreaming: true " +
      `on the model in models.providers.${model.provider}.models.`,
    { provider: model.provider, model: model.id },
  );
}

export function shouldEmitOpenAICompletionsReasoning(
  model: OpenAIModeModel,
  options: OpenAICompletionsOptions | undefined,
) {
  if (!model.reasoning) {
    return false;
  }
  const effort = options?.reasoningEffort ?? options?.reasoning ?? "high";
  return Boolean(effort) && isOpenAICompletionsThinkingEnabled(effort);
}
