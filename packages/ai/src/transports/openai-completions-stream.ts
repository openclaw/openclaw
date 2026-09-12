import { randomUUID } from "node:crypto";
import type { AssistantMessageEvent, Model } from "@openclaw/llm-core";
import { appendAssistantThinking } from "@openclaw/llm-core/event-stream";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import type { OpenAICompletionsOptions } from "../provider-options.js";
import {
  createOpenAICompletionsToolCallDeltaNormalizer,
  createOpenAIEncryptedToolCallReasoningTracker,
  extractToolCallThoughtSignature,
  finalizeOpenAICompletionsToolCalls,
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
import {
  createReasoningTagTextPartitioner,
  type ReasoningTagTextDelta,
} from "../utils/reasoning-tag-text-partitioner.js";
import { withFirstStreamEventTimeout } from "../utils/stream-first-event-timeout.js";
import { createDeepSeekTextFilter } from "./deepseek-text-filter.js";
import {
  createDsmlRecoverer,
  type DeepSeekDsmlRecoveredPart,
  type RecoveredDeepSeekDsmlToolCall,
} from "./openai-completions-dsml.js";
import { getCompat } from "./openai-transport-params.js";
import {
  createModelStreamCooperativeScheduler,
  isOpenAICompletionsThinkingEnabled,
  parseOpenAICompletionsUsage,
  createCumulativeReplayGuard,
  readOpenAICompletionsContentDeltas,
  readOpenAICompletionsReasoningBatch,
  throwIfModelStreamAborted,
  type MutableAssistantOutput,
  type OpenAICompatibleChatCompletionChunk,
  type OpenAICompletionsContentDelta as CompletionsReasoningDelta,
  type OpenAICompletionsTextSource,
  type OpenAIModeModel,
} from "./openai-transport-shared.js";

// A deferred emit step for the DSML visible-text chain: text steps carry
// their filtered piece and may be suppressed whole-frame by the replay guard;
// every other step always runs.
type DsmlChainStep = { text?: string; emit(): void };

const textPart = (text: string): DeepSeekDsmlRecoveredPart => ({ kind: "text", text });

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
  const compat = getCompat(model as OpenAIModeModel);
  const replayGuard = createCumulativeReplayGuard(compat.dropCumulativeTextDeltaReplays);
  const visibleReasoningDetailTypes = new Set(compat.visibleReasoningDetailTypes);
  const shouldFilterDeepSeekDsmlText = !directMode && compat.thinkingFormat === "deepseek";
  const deepSeekTextFilter = shouldFilterDeepSeekDsmlText ? createDeepSeekTextFilter() : null;
  const dsmlRecoverer = shouldFilterDeepSeekDsmlText ? createDsmlRecoverer() : null;
  const tagPartitioner = createReasoningTagTextPartitioner();
  if (options?.strictReasoningTags) {
    tagPartitioner.markStrict();
  }
  type ToolCallBlock = {
    type: "toolCall";
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    partialArgs: string;
    thoughtSignature?: string;
  };
  type TextBlock = { type: "text"; text: string; textSignature?: string };
  type ThinkingBlock = { type: "thinking"; thinking: string; thinkingSignature?: string };
  let currentBlock: TextBlock | ThinkingBlock | ToolCallBlock | null = null;
  let directTextBlock: TextBlock | null = null;
  let directThinkingBlock: ThinkingBlock | null = null;
  let currentTextSource: OpenAICompletionsTextSource | undefined;
  let pendingInterruptedTextBlock: TextBlock | null = null;
  let confirmedInterruptedTextBlock: TextBlock | null = null;
  let pendingPostToolCallDeltas: CompletionsReasoningDelta[] = [];
  let pendingPostToolCallBytes = 0;
  let isFlushingPendingPostToolCallDeltas = false;
  const toolCallBlocksByIndex = new Map<number, ToolCallBlock>();
  const toolCallBlocksById = new Map<string, ToolCallBlock>();
  const encryptedReasoning = directMode
    ? createOpenAIEncryptedToolCallReasoningTracker()
    : undefined;
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
  // The replay ledger tracks filtered visible text and advances as each piece
  // is released, before the post-tool-call queue can hold it back. Frame
  // identity is decided once per complete provider frame, on its whole
  // visible contribution; admitted pieces then record without re-comparing.
  // Both visible-text feeders route through this seam; the closures read the
  // declared block union rather than flow narrowing.
  const opensTextBlock = (source?: OpenAICompletionsTextSource) =>
    currentBlock?.type !== "text" || currentTextSource !== source;
  const framesSettled = () =>
    !tagPartitioner.hasPending() &&
    !dsmlRecoverer?.hasPending() &&
    !deepSeekTextFilter?.hasPending();
  const classifyFrame = (visible: string) =>
    replayGuard.classifyFrame(visible, opensTextBlock(), framesSettled());
  const admitText = (text: string, source?: OpenAICompletionsTextSource, wholeFrame = false) =>
    replayGuard.admitTextDelta(text, opensTextBlock(source), wholeFrame);
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
      (previous.kind === "text" && next.kind === "text" && previous.source !== next.source)
    ) {
      pendingPostToolCallDeltas.push(next);
      return;
    }
    if (next.kind === "thinking" && previous.kind === "thinking") {
      if (previous.signature !== next.signature) {
        pendingPostToolCallDeltas.push(next);
        return;
      }
      previous.text += next.text;
      return;
    }
    previous.text += next.text;
  };
  const appendThinkingDeltaInternal = (reasoningDelta: { signature?: string; text: string }) => {
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
  const appendTextDeltaInternal = (text: string, source?: OpenAICompletionsTextSource) => {
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
      replayGuard.onTextStart();
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
    if (
      isFlushingPendingPostToolCallDeltas ||
      currentBlock?.type === "toolCall" ||
      pendingPostToolCallDeltas.length === 0
    ) {
      return;
    }
    isFlushingPendingPostToolCallDeltas = true;
    const bufferedDeltas = pendingPostToolCallDeltas;
    pendingPostToolCallDeltas = [];
    pendingPostToolCallBytes = 0;
    for (const delta of bufferedDeltas) {
      if (delta.kind === "text") {
        appendTextDeltaInternal(delta.text, delta.source);
      } else if (emitReasoning) {
        appendThinkingDeltaInternal(delta);
      }
    }
    isFlushingPendingPostToolCallDeltas = false;
  };
  const appendThinkingDelta = (reasoningDelta: { signature?: string; text: string }) => {
    flushPendingPostToolCallDeltas();
    appendThinkingDeltaInternal(reasoningDelta);
  };
  const appendTextDelta = (text: string, source?: OpenAICompletionsTextSource) => {
    flushPendingPostToolCallDeltas();
    appendTextDeltaInternal(text, source);
  };
  const appendVisibleTextDelta = (text: string) => {
    if (!text || !admitText(text)) {
      return;
    }
    if (currentBlock?.type === "toolCall" && !directMode) {
      queuePostToolCallDelta({ kind: "text", text });
    } else {
      appendTextDelta(text);
    }
  };
  const appendReasoningDeltas = (reasonings: readonly CompletionsReasoningDelta[]) => {
    for (const reasoning of reasonings) {
      if (reasoning.kind === "thinking" && !emitReasoning) {
        continue;
      }
      if (reasoning.kind === "text" && !admitText(reasoning.text, reasoning.source, true)) {
        continue;
      }
      if (currentBlock?.type === "toolCall" && !directMode) {
        queuePostToolCallDelta({ ...reasoning });
        continue;
      }
      if (reasoning.kind === "text") {
        appendTextDelta(reasoning.text, reasoning.source);
      } else if (emitReasoning) {
        appendThinkingDelta(
          directMode && model.provider === "opencode-go" && reasoning.signature === "reasoning"
            ? { ...reasoning, signature: "reasoning_content" }
            : reasoning,
        );
      }
    }
  };
  const appendRecoveredToolCall = (toolCall: RecoveredDeepSeekDsmlToolCall) => {
    const switchingToolCall = currentBlock?.type === "toolCall";
    if (switchingToolCall) {
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
    toolArgumentPreviewSchedules.set(block, createToolArgumentPreviewSchedule());
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
  // Defers the DSML chain's emit steps so a caller can classify the whole
  // filtered output before any of it streams; text steps carry their piece.
  const planRecoveredText = (recovered: DeepSeekDsmlRecoveredPart[], plan: DsmlChainStep[]) => {
    for (const recoveredPart of recovered) {
      if (recoveredPart.kind === "toolCall") {
        plan.push({ emit: () => appendRecoveredToolCall(recoveredPart) });
        continue;
      }
      for (const part of deepSeekTextFilter?.push(recoveredPart.text) ?? [recoveredPart.text]) {
        plan.push({ text: part, emit: () => appendVisibleTextDelta(part) });
      }
    }
  };
  const flushDeepSeekStagesAtEnd = () => {
    const steps: DsmlChainStep[] = [];
    planRecoveredText(dsmlRecoverer?.flush() ?? [], steps);
    for (const part of deepSeekTextFilter?.flush() ?? []) {
      steps.push({ text: part, emit: () => appendVisibleTextDelta(part) });
    }
    for (const step of steps) {
      step.emit();
    }
  };
  const appendRoutedContentDelta = (delta: CompletionsReasoningDelta) => {
    if (delta.kind === "text") {
      appendPartitionedVisibleDelta(delta);
      return;
    }
    if (!emitReasoning) {
      return;
    }
    if (currentBlock?.type === "toolCall" && !directMode) {
      queuePostToolCallDelta(delta);
    } else {
      appendThinkingDelta(delta);
    }
  };
  const appendPartitionedVisibleDelta = (delta: { kind: "text" | "thinking"; text: string }) => {
    if (delta.kind !== "text") {
      return;
    }
    const steps: DsmlChainStep[] = [];
    planRecoveredText(dsmlRecoverer?.push(delta.text) ?? [textPart(delta.text)], steps);
    for (const step of steps) {
      step.emit();
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
    for (const delta of tagPartitioner.flush()) {
      appendPartitionedVisibleDelta(delta);
    }
  };
  const sealTextBeforeReasoning = () => {
    if (currentBlock?.type !== "text" && !tagPartitioner.hasPending()) {
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
    if (forceStrict || tagPartitioner.hasPending()) {
      tagPartitioner.markStrict();
    }
    // Let following text finish syntax already owned by the Markdown
    // parser; otherwise packet batching cannot erase a lane boundary.
    if (!hasFollowingVisibleText || !tagPartitioner.hasPendingSyntax()) {
      sealTextBeforeReasoning();
    }
  };
  const cooperativeScheduler = directMode
    ? undefined
    : createModelStreamCooperativeScheduler(options?.signal);
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
  for await (const rawChunk of guardedStream) {
    throwIfModelStreamAborted(options?.signal);
    chunkPushedEvent = false;
    if (!rawChunk || typeof rawChunk !== "object") {
      if (cooperativeScheduler) {
        await cooperativeScheduler.afterEvent();
      }
      continue;
    }
    // Hidden reasoning is still provider progress; keep the idle watchdog alive without exposing it.
    notifyLlmRequestActivity(options?.signal);
    const chunk = rawChunk as OpenAICompatibleChatCompletionChunk;
    output.responseId ||= chunk.id;
    // Retain the provider-returned model when it differs from the requested id so
    // routed/alias responses are not misattributed, matching the direct provider
    // stream and the anthropic/responses managed transports.
    if (typeof chunk.model === "string" && chunk.model.length > 0 && chunk.model !== model.id) {
      output.responseModel ||= chunk.model;
    }
    let hasReasoningUsageActivity = false;
    if (chunk.usage) {
      output.usage = parseOpenAICompletionsUsage(chunk.usage, model, {
        includeReasoningTokens: !directMode,
      });
      hasReasoningUsageActivity = hasOpenAICompletionsReasoningUsageActivity(chunk.usage);
    }
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!choice) {
      emitReasoningUsageActivity(hasReasoningUsageActivity);
      if (cooperativeScheduler) {
        await cooperativeScheduler.afterEvent();
      }
      continue;
    }
    const choiceUsage = choice.usage;
    if (!chunk.usage && choiceUsage) {
      output.usage = parseOpenAICompletionsUsage(choiceUsage, model, {
        includeReasoningTokens: !directMode,
      });
      hasReasoningUsageActivity = hasOpenAICompletionsReasoningUsageActivity(choiceUsage);
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
    const rawChoiceDelta = choice.delta ?? choice.message;
    if (!rawChoiceDelta) {
      emitReasoningUsageActivity(hasReasoningUsageActivity);
      if (cooperativeScheduler) {
        await cooperativeScheduler.afterEvent();
      }
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
      // Some providers resend accumulated text as one bare delta; appending it
      // doubles output. Visible text streams through the parser and DSML chain
      // into a pending segment plan, and the guard classifies each segment's
      // whole filtered visible contribution before it streams — at reasoning
      // transitions and at the end of the content parts, so block structure,
      // event ordering, and the post-tool-call queue match the unguarded
      // sequence. A settled restatement drops its visible pieces while its
      // recovered tool calls still flow; an unsettled segment always flows.
      let plan: DsmlChainStep[] = [];
      const planRouted = (routed: ReasoningTagTextDelta[]) => {
        for (const piece of routed) {
          if (piece.kind !== "text") {
            continue;
          }
          planRecoveredText(dsmlRecoverer?.push(piece.text) ?? [textPart(piece.text)], plan);
        }
      };
      const settlePlan = () => {
        const admitted = classifyFrame(plan.reduce((text, step) => text + (step.text ?? ""), ""));
        for (const step of plan.filter((candidate) => admitted || candidate.text === undefined)) {
          step.emit();
        }
        plan = [];
      };
      const pushContent = (text: string) =>
        hasReasoningThinking ? tagPartitioner.push(text) : tagPartitioner.pushVisible(text);
      for (const [contentDeltaIndex, contentDelta] of contentDeltas.entries()) {
        if (contentDelta.kind === "text") {
          planRouted(pushContent(contentDelta.text));
        } else {
          // A reasoning part transitions lanes exactly as unguarded flow does:
          // pending parser input marks strict, and buffered text releases
          // unless following text must finish syntax the parser already owns.
          // The released text settles — classified, then streamed — before the
          // reasoning content appends, while text the parser still holds
          // continues into the following segment.
          if (tagPartitioner.hasPending()) {
            tagPartitioner.markStrict();
          }
          const hasLaterVisible = contentDeltaIndex < lastVisibleTextIndex;
          if (!hasLaterVisible || !tagPartitioner.hasPendingSyntax()) {
            planRouted(tagPartitioner.flush());
          }
          settlePlan();
          beginReasoning(hasLaterVisible);
          appendRoutedContentDelta(contentDelta);
        }
      }
      settlePlan();
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
            const switchingToolCall = currentBlock?.type === "toolCall";
            if (switchingToolCall) {
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
            encryptedReasoning?.rememberToolCall(block.id, block);
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
            if (!directMode || !block.id) {
              block.id = toolCall.id;
            }
            toolCallBlocksById.set(toolCall.id, block);
            if (block.id === toolCall.id) {
              encryptedReasoning?.rememberToolCall(toolCall.id, block);
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
      encryptedReasoning?.consumeDetails(deltaFields.reasoning_details);
    }
    flushPendingPostToolCallDeltas();
    emitReasoningUsageActivity(hasReasoningUsageActivity);
    if (cooperativeScheduler) {
      await cooperativeScheduler.afterEvent();
    }
  }
  // The SDK can end an aborted SSE iterator normally; cancellation must win
  // before buffered terminal markers can promote provisional tool calls.
  throwIfModelStreamAborted(options?.signal);
  if (!finishReason && (directMode || options?.sawStreamDONE?.() === false)) {
    throw new Error("Stream ended without finish_reason");
  }
  flushReasoningTagTextPartitioner();
  flushDeepSeekStagesAtEnd();
  currentBlock = null;
  flushPendingPostToolCallDeltas();
  // Only an explicit stop or observed SSE terminal may authorize silent tool calls.
  finalizeOpenAICompletionsToolCalls(output, {
    allowSilentToolCallPromotion:
      finishReason === "stop" || (sawNativeToolCallDelta && (options?.sawStreamDONE?.() ?? false)),
    onConfirmedToolCall(block, contentIndex) {
      if (directMode || block.type !== "toolCall") {
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
}

export function shouldEmitOpenAICompletionsReasoning(
  model: OpenAIModeModel,
  options: OpenAICompletionsOptions | undefined,
) {
  if (!model.reasoning) {
    return false;
  }
  const effort = options?.reasoningEffort ?? options?.reasoning ?? "high";
  if (!effort || !isOpenAICompletionsThinkingEnabled(effort)) {
    return false;
  }
  return true;
}

function hasOpenAICompletionsReasoningUsageActivity(
  rawUsage: NonNullable<ChatCompletionChunk["usage"]>,
) {
  const reasoningTokens = rawUsage.completion_tokens_details?.reasoning_tokens;
  return (
    typeof reasoningTokens === "number" && Number.isFinite(reasoningTokens) && reasoningTokens > 0
  );
}
