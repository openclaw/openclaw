import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages.js";
import type { AssistantMessageEvent, Context, MaybePromise, Model } from "@openclaw/llm-core";
import { appendAssistantThinking } from "@openclaw/llm-core/event-stream";
import {
  asRecord,
  asOptionalObjectRecord,
  readStringField,
} from "@openclaw/normalization-core/record-coerce";
import { calculateCost } from "../model-utils.js";
import type { AnthropicOptions } from "../provider-options.js";
import {
  usesClaudeStreamingRefusalContract,
  mapAnthropicStopReason,
} from "../providers/anthropic-model-contract.js";
import { applyAnthropicRefusal } from "../providers/anthropic-refusal.js";
import {
  applyAnthropicFallbackBoundary,
  readAnthropicFallbackBoundary,
  resolveAnthropicFallbackServingModelCost,
} from "../providers/anthropic-server-fallback.js";
import {
  logAnthropicThinkingDrops,
  readAnthropicInputTransformations,
} from "../providers/anthropic-thinking-replay.js";
import { resolveOriginalAnthropicToolName } from "../providers/anthropic-tool-projection.js";
import {
  applyAnthropicMessageDeltaUsage,
  applyAnthropicMessageStartUsage,
  type AnthropicPromptUsageSnapshot,
} from "../providers/anthropic-usage.js";
import { createDeferredEventBuffer } from "../utils/deferred-event-buffer.js";
import {
  createToolArgumentPreviewSchedule,
  parseStreamingJson,
  type ToolArgumentPreviewSchedule,
} from "../utils/json-parse.js";
import { notifyLlmRequestActivity } from "../utils/llm-request-activity.js";
import {
  createCompactionCapture,
  isAnthropicReplayRejection,
  suppressAnthropicCompaction,
  type AnthropicCompactionBlock,
} from "./anthropic-compaction-replay.js";
import { buildAnthropicRequest, prepareAnthropicRequest } from "./anthropic-messages.js";
import { isDirectAnthropicModel, logAnthropicContextEdits } from "./anthropic-payload-policy.js";
import { serializeAnthropicRequestBody } from "./anthropic-request-body.js";
import { createAssistantOutput } from "./assistant-output.js";
import { resolveProviderEndpoint } from "./host-policy.js";
import { parseJsonObjectPreservingUnsafeIntegers } from "./json-unsafe-integers.js";
import {
  coerceTransportToolCallArguments,
  failTransportStream,
  finalizeTerminalToolCallArguments,
  finalizeTransportStream,
  iterateModelStream,
  notifyProviderHttpResponse,
  sanitizeTransportPayloadText,
  transportAbortError,
  type WritableTransportStream,
} from "./transport-stream-shared.js";

type LifecycleOptions = AnthropicOptions & { authProfileId?: string };

/** Entry points retain their SDK/fetch adapters; request and terminal ownership is shared. */
export async function runAnthropicStreamLifecycle(params: {
  model: Model<"anthropic-messages">;
  stream: WritableTransportStream;
  options?: LifecycleOptions;
  profile: "provider" | "transport";
  prepare: () => MaybePromise<{
    context: Context;
    options: LifecycleOptions | undefined;
    isOAuthToken: boolean;
    serverSideFallback: boolean;
    directApiKeyBetaHeader?: string;
    claudeCodeVersion?: string;
    request: (
      body: MessageCreateParamsStreaming,
      headers: Record<string, string> | undefined,
      encodeBody: () => string | Blob,
    ) => Promise<{ response: Response; events: AsyncIterable<object> | Iterable<object> }>;
    checkResponse?: (response: Response) => Promise<void>;
  }>;
}): Promise<void> {
  const { model, stream, options, profile } = params;
  const output = createAssistantOutput(model, "anthropic-messages");
  // Classifier refusals can invalidate partial output until the terminal stop reason is known.
  const refusalBuffer = usesClaudeStreamingRefusalContract(model)
    ? createDeferredEventBuffer<AssistantMessageEvent>(stream)
    : undefined;
  let replayedCompaction: AnthropicCompactionBlock | undefined;
  try {
    const prepared = await params.prepare();
    const built = await buildAnthropicRequest(
      model,
      prepared.context,
      prepared.options,
      profile,
      prepared.isOAuthToken,
      prepared.serverSideFallback,
      prepared.claudeCodeVersion,
    );
    replayedCompaction = built.replayedCompaction;
    const {
      params: body,
      headers,
      messageSources,
    } = await prepareAnthropicRequest(
      built.params,
      model,
      prepared.options,
      prepared.directApiKeyBetaHeader,
    );
    const wireBody = { ...body, stream: true as const };
    const { response, events } = await prepared.request(wireBody, headers, () =>
      serializeAnthropicRequestBody(wireBody, messageSources),
    );
    await notifyProviderHttpResponse({ options: prepared.options, response, model });
    await prepared.checkResponse?.(response);
    await (async () => {
      const reducerOptions = prepared.options ?? {};
      const isOAuthToken = prepared.isOAuthToken;
      const toolProjection = built.toolProjection;
      type AnthropicStreamBlock = (typeof output.content)[number];
      const managed = profile === "transport";
      const eventSink = refusalBuffer ?? stream;
      let costModel = model;
      const applyServingModelCost = (servingModelId: string | null) => {
        costModel = {
          ...model,
          cost: resolveAnthropicFallbackServingModelCost({
            requestedModelId: model.id,
            servingModelId,
            requestedCost: model.cost,
          }),
        };
        calculateCost(costModel, output.usage);
      };
      let messageStartPromptUsage: AnthropicPromptUsageSnapshot | undefined;
      let inputTransformations: unknown[] | undefined;
      try {
        const blocks: AnthropicStreamBlock[] = output.content;
        const blockIndexes = new Map<number, number>();
        // Preview schedules are per active tool call; WeakMap keys die with the block.
        const toolArgumentPreviewSchedules = new WeakMap<
          Extract<AnthropicStreamBlock, { type: "toolCall" }>,
          ToolArgumentPreviewSchedule
        >();
        const seededToolArguments = new WeakMap<AnthropicStreamBlock, unknown>();
        const sealedToolCalls: Array<{
          block: Extract<AnthropicStreamBlock, { type: "toolCall" }>;
          contentIndex: number;
        }> = [];
        const compactionCapture = createCompactionCapture(output, model, reducerOptions);
        // Signature deltas are opaque and only complete at content_block_stop.
        // Keep partial bytes out of output so interrupted streams cannot poison replay.
        const pendingThinkingSignatures = new Map<number, string>();
        const allowReasoningContentReplay =
          managed && resolveProviderEndpoint(model).endpointClass === "xiaomi-native";
        const reasoningContentBlocks = {
          thinking: new Map<number, number>(),
          text: new Map<number, number>(),
        };
        let sawMessageStart = false;
        let sawMessageStop = false;
        let sawStopReason = false;
        let sawFallbackBoundary = false;
        let terminalFallbackModel: string | undefined;
        const emitContentEnd = (
          block: Extract<AnthropicStreamBlock, { type: "thinking" | "text" }>,
          contentIndex: number,
        ) => {
          eventSink.push({
            type: `${block.type}_end`,
            contentIndex,
            content: block.type === "thinking" ? block.thinking : block.text,
            partial: output,
          });
        };
        const emitContentStart = (kind: "thinking" | "text", contentIndex: number, delta = "") => {
          eventSink.push({ type: `${kind}_start`, contentIndex, partial: output });
          if (delta.length > 0) {
            eventSink.push({ type: `${kind}_delta`, contentIndex, delta, partial: output });
          }
        };
        const appendContentDelta = (
          block: Extract<AnthropicStreamBlock, { type: "thinking" | "text" }>,
          contentIndex: number,
          delta: string,
        ) => {
          if (block.type === "thinking") {
            appendAssistantThinking(block, delta);
          } else {
            block.text += delta;
          }
          eventSink.push({ type: `${block.type}_delta`, contentIndex, delta, partial: output });
        };
        const eventIndexKey = (eventIndex: unknown) =>
          typeof eventIndex === "number" ? eventIndex : -1;
        const appendReasoningContentDelta = (
          kind: "thinking" | "text",
          eventIndex: unknown,
          rawText: unknown,
        ): boolean => {
          if (typeof rawText !== "string") {
            return false;
          }
          const text = sanitizeTransportPayloadText(rawText);
          if (text.length === 0) {
            return false;
          }
          const indexes = reasoningContentBlocks[kind];
          const key = eventIndexKey(eventIndex);
          let contentIndex = indexes.get(key);
          let block = contentIndex === undefined ? undefined : blocks[contentIndex];
          if (contentIndex === undefined || !block || block.type !== kind) {
            block =
              kind === "thinking"
                ? { type: "thinking", thinking: "", thinkingSignature: "reasoning_content" }
                : { type: "text", text: "" };
            output.content.push(block);
            contentIndex = output.content.length - 1;
            indexes.set(key, contentIndex);
            emitContentStart(kind, contentIndex);
          }
          if (block.type === "thinking") {
            block.thinkingSignature = "reasoning_content";
          }
          appendContentDelta(block, contentIndex, text);
          return true;
        };
        const finishReasoningContentSidecars = (eventIndex: unknown) => {
          const key = eventIndexKey(eventIndex);
          for (const kind of ["thinking", "text"] as const) {
            const indexes = reasoningContentBlocks[kind];
            const contentIndex = indexes.get(key);
            if (contentIndex === undefined) {
              continue;
            }
            indexes.delete(key);
            const block = output.content[contentIndex];
            if (block?.type === kind) {
              emitContentEnd(block, contentIndex);
            }
          }
        };
        for await (const rawEvent of iterateModelStream(events, reducerOptions.signal)) {
          const event = asRecord(rawEvent);
          // A serving-model fallback replaces the initial snapshot; report only once at completion.
          inputTransformations = readAnthropicInputTransformations(event) ?? inputTransformations;
          if (managed) {
            notifyLlmRequestActivity(reducerOptions.signal);
          }
          if (event.type === "error") {
            const error = asOptionalObjectRecord(event.error);
            throw Object.assign(
              new Error(readStringField(error, "message") || "Anthropic Messages stream failed"),
              { error },
            );
          }
          if (event.type === "message_start") {
            sawMessageStart = true;
            const message = asOptionalObjectRecord(event.message);
            const usage = asRecord(message?.usage);
            output.responseId = typeof message?.id === "string" ? message.id : undefined;
            output.responseModel = typeof message?.model === "string" ? message.model : undefined;
            messageStartPromptUsage = applyAnthropicMessageStartUsage(output.usage, usage);
            calculateCost(costModel, output.usage);
            // Defer start until after message_start so that pre-stream SSE errors
            // (e.g. invalid thinking signatures) arrive before any non-error event
            // is yielded, keeping yieldedOutput=false in pumpStreamWithRecovery
            // and allowing the thinking-block recovery retry to fire.
            eventSink.push({ type: "start", partial: output });
            continue;
          }
          if (event.type === "message_stop") {
            sawMessageStop = true;
            continue;
          }
          if (event.type === "content_block_start") {
            const contentBlock = asOptionalObjectRecord(event.content_block);
            const index = typeof event.index === "number" ? event.index : -1;
            if (
              reducerOptions.anthropicServerCompaction === true &&
              compactionCapture.begin(index, contentBlock, output.content.length)
            ) {
              continue;
            }
            const fallbackBoundary = refusalBuffer
              ? readAnthropicFallbackBoundary(contentBlock)
              : null;
            if (fallbackBoundary) {
              sawFallbackBoundary = true;
              // Server-side fallback boundary: pre-boundary thinking/tool
              // blocks must not replay or execute, and the buffered preview
              // events reference them, so rebuild the deferred timeline from
              // the surviving text prefix the fallback model continued from.
              refusalBuffer?.discard();
              sealedToolCalls.length = 0;
              blockIndexes.clear();
              pendingThinkingSignatures.clear();
              applyAnthropicFallbackBoundary({
                output,
                boundary: fallbackBoundary,
                provider: model.provider,
              });
              // Fallback-only iteration partials stay outside the serving-model
              // estimate. Compaction responses are the exception: usage policy
              // aggregates their complete billed iteration list.
              applyServingModelCost(fallbackBoundary.toModel);
              eventSink.push({ type: "start", partial: output });
              for (const [i, block] of blocks.entries()) {
                if (block.type !== "text") {
                  continue;
                }
                emitContentStart("text", i, block.text);
                emitContentEnd(block, i);
              }
              continue;
            }
            pendingThinkingSignatures.delete(index);
            if (
              contentBlock?.type === "text" ||
              contentBlock?.type === "thinking" ||
              contentBlock?.type === "redacted_thinking"
            ) {
              const block: AnthropicStreamBlock =
                contentBlock.type === "text"
                  ? {
                      type: "text",
                      text:
                        typeof contentBlock.text === "string"
                          ? sanitizeTransportPayloadText(contentBlock.text)
                          : "",
                    }
                  : contentBlock.type === "thinking"
                    ? {
                        type: "thinking",
                        thinking:
                          typeof contentBlock.thinking === "string" ? contentBlock.thinking : "",
                        thinkingSignature:
                          typeof contentBlock.signature === "string" ? contentBlock.signature : "",
                      }
                    : {
                        type: "thinking",
                        thinking: "[Reasoning redacted]",
                        thinkingSignature:
                          typeof contentBlock.data === "string" ? contentBlock.data : "",
                        redacted: true,
                      };
              const delta =
                block.type === "text" ? block.text : block.redacted ? "" : block.thinking;
              output.content.push(block);
              const contentIndex = output.content.length - 1;
              blockIndexes.set(index, contentIndex);
              emitContentStart(block.type, contentIndex, delta);
              continue;
            }
            if (contentBlock?.type === "tool_use") {
              const block: AnthropicStreamBlock = {
                type: "toolCall",
                id: typeof contentBlock.id === "string" ? contentBlock.id : "",
                name:
                  typeof contentBlock.name === "string"
                    ? isOAuthToken
                      ? resolveOriginalAnthropicToolName(contentBlock.name, toolProjection)
                      : contentBlock.name
                    : "",
                arguments: asRecord(contentBlock.input),
                partialJson: "",
              };
              output.content.push(block);
              blockIndexes.set(index, output.content.length - 1);
              // Standalone callers may supply encoded input; terminal validation owns its shape.
              seededToolArguments.set(
                block,
                managed ? block.arguments : (contentBlock.input ?? {}),
              );
              toolArgumentPreviewSchedules.set(block, createToolArgumentPreviewSchedule());
              eventSink.push({
                type: "toolcall_start",
                contentIndex: output.content.length - 1,
                partial: output,
              });
            }
            continue;
          }
          if (event.type === "content_block_delta") {
            const delta = asOptionalObjectRecord(event.delta);
            const eventIndex = typeof event.index === "number" ? event.index : undefined;
            if (eventIndex !== undefined && compactionCapture.delta(eventIndex, delta)) {
              continue;
            }
            let index = eventIndex === undefined ? undefined : blockIndexes.get(eventIndex);
            let block = index === undefined ? undefined : blocks[index];
            if (allowReasoningContentReplay) {
              const appendedThinking = appendReasoningContentDelta(
                "thinking",
                event.index,
                delta?.reasoning_content,
              );
              const hasNativeAnthropicDelta =
                (delta?.type === "text_delta" && typeof delta.text === "string") ||
                (delta?.type === "thinking_delta" && typeof delta.thinking === "string") ||
                (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") ||
                (delta?.type === "signature_delta" && typeof delta.signature === "string");
              let appendedContent = false;
              if (
                !hasNativeAnthropicDelta &&
                typeof delta?.content === "string" &&
                delta.content.length > 0
              ) {
                const text = sanitizeTransportPayloadText(delta.content);
                if (text.length > 0) {
                  if (block?.type === "text" && index !== undefined) {
                    appendContentDelta(block, index, text);
                    appendedContent = true;
                  } else {
                    appendedContent = appendReasoningContentDelta("text", event.index, text);
                  }
                }
              }
              if ((appendedThinking || appendedContent) && !hasNativeAnthropicDelta) {
                continue;
              }
            }
            if (
              managed &&
              !block &&
              delta?.type === "text_delta" &&
              typeof delta.text === "string"
            ) {
              block = { type: "text", text: "" };
              output.content.push(block);
              index = output.content.length - 1;
              if (typeof event.index === "number") {
                blockIndexes.set(event.index, index);
              }
              emitContentStart("text", index);
            }
            if (index === undefined) {
              continue;
            }
            if (
              block?.type === "text" &&
              delta?.type === "text_delta" &&
              typeof delta.text === "string"
            ) {
              appendContentDelta(block, index, delta.text);
              continue;
            }
            if (
              block?.type === "thinking" &&
              delta?.type === "thinking_delta" &&
              typeof delta.thinking === "string"
            ) {
              appendContentDelta(block, index, delta.thinking);
              continue;
            }
            if (
              block?.type === "toolCall" &&
              delta?.type === "input_json_delta" &&
              typeof delta.partial_json === "string"
            ) {
              const partialJson = `${block.partialJson ?? ""}${delta.partial_json}`;
              block.partialJson = partialJson;
              // Preview refresh is scheduled geometrically; content_block_stop
              // re-parses the full buffer authoritatively either way.
              if (toolArgumentPreviewSchedules.get(block)?.(partialJson.length)) {
                block.arguments = managed
                  ? coerceTransportToolCallArguments(
                      parseJsonObjectPreservingUnsafeIntegers(partialJson) ??
                        parseStreamingJson(partialJson),
                    )
                  : parseStreamingJson(partialJson);
              }
              eventSink.push({
                type: "toolcall_delta",
                contentIndex: index,
                delta: delta.partial_json,
                partial: output,
              });
              continue;
            }
            if (
              block?.type === "thinking" &&
              delta?.type === "signature_delta" &&
              typeof delta.signature === "string"
            ) {
              const signatureIndex = eventIndexKey(event.index);
              const pendingSignature = pendingThinkingSignatures.get(signatureIndex);
              if (pendingSignature === undefined) {
                // The streamed signature replaces any seed from content_block_start.
                block.thinkingSignature = "";
                pendingThinkingSignatures.set(signatureIndex, delta.signature);
              } else {
                pendingThinkingSignatures.set(signatureIndex, pendingSignature + delta.signature);
              }
            }
            continue;
          }
          if (event.type === "content_block_stop") {
            const eventIndex = typeof event.index === "number" ? event.index : undefined;
            if (eventIndex !== undefined && compactionCapture.complete(eventIndex)) {
              continue;
            }
            const pendingSignature =
              eventIndex === undefined ? undefined : pendingThinkingSignatures.get(eventIndex);
            if (eventIndex !== undefined) {
              pendingThinkingSignatures.delete(eventIndex);
            }
            const index = eventIndex === undefined ? undefined : blockIndexes.get(eventIndex);
            const block = index === undefined ? undefined : blocks[index];
            if (eventIndex === undefined || index === undefined || !block) {
              finishReasoningContentSidecars(event.index);
              continue;
            }
            blockIndexes.delete(eventIndex);
            if (block.type === "thinking" && pendingSignature !== undefined) {
              block.thinkingSignature = pendingSignature;
            }
            if (block.type === "toolCall") {
              sealedToolCalls.push({ block, contentIndex: index });
            } else {
              emitContentEnd(block, index);
            }
            finishReasoningContentSidecars(event.index);
            continue;
          }
          if (event.type === "message_delta") {
            logAnthropicContextEdits(event);
            const delta = asOptionalObjectRecord(event.delta);
            const usage = asOptionalObjectRecord(event.usage);
            if (typeof delta?.stop_reason === "string" && delta.stop_reason) {
              sawStopReason = true;
              const iteration = Array.isArray(usage?.iterations)
                ? asOptionalObjectRecord(usage.iterations.at(-1))
                : undefined;
              terminalFallbackModel =
                iteration?.type === "fallback_message" &&
                typeof iteration.model === "string" &&
                iteration.model.trim()
                  ? iteration.model
                  : undefined;
              if (delta.stop_reason === "refusal") {
                applyAnthropicRefusal(output, delta.stop_details, model.provider);
              } else {
                output.stopReason = mapAnthropicStopReason(delta.stop_reason);
              }
            }
            applyAnthropicMessageDeltaUsage(output.usage, usage, messageStartPromptUsage);
            if (
              sawStopReason &&
              messageStartPromptUsage &&
              typeof usage?.output_tokens === "number"
            ) {
              output.usage.usageReport = { state: "available" };
            }
            calculateCost(costModel, output.usage);
          }
        }
        // Anthropic completes every SSE response with message_stop. Compatible
        // proxy providers are not held to that first-party transport contract.
        if ((isDirectAnthropicModel(model) || (!managed && refusalBuffer)) && !sawMessageStop) {
          throw new Error("Anthropic stream ended before message_stop");
        }
        if (reducerOptions.signal?.aborted) {
          throw transportAbortError(reducerOptions.signal);
        }
        if (output.stopReason === "aborted" || output.stopReason === "error") {
          throw new Error(output.errorMessage ?? "An unknown error occurred");
        }
        if ([...blockIndexes.values()].some((index) => blocks[index]?.type === "toolCall")) {
          throw new Error("Provider completed stream with an incomplete tool call");
        }
        // Proxies may omit message_stop, but EOF cannot complete a started response
        // without a terminal fact. Preserve their existing empty/ping-only behavior.
        if ((sawMessageStart || blocks.length > 0) && !sawMessageStop && !sawStopReason) {
          throw new Error("Anthropic stream ended before a terminal event");
        }
        // Fine-grained tool streaming delivers tool input without server-side JSON
        // validation, so repair invalid string literals before rejecting the turn.
        finalizeTerminalToolCallArguments(
          sealedToolCalls.map(({ block }) => block),
          (block) =>
            block.partialJson && block.partialJson.length > 0
              ? block.partialJson
              : seededToolArguments.get(block),
          undefined,
          { repairStringLiterals: true },
        );
        // Sticky fallback has no content boundary. Commit its explicit terminal identity
        // only after validation; failed streams must not acquire a fallback diagnostic.
        if (refusalBuffer && terminalFallbackModel && !sawFallbackBoundary) {
          output.responseModel = terminalFallbackModel;
          applyServingModelCost(terminalFallbackModel);
          output.diagnostics = [
            ...(output.diagnostics ?? []),
            {
              type: "provider_fallback",
              timestamp: Date.now(),
              details: {
                provider: model.provider,
                fromModel: model.id,
                toModel: terminalFallbackModel,
              },
            },
          ];
        }
        for (const sealed of sealedToolCalls) {
          delete sealed.block.partialJson;
          eventSink.push({
            type: "toolcall_end",
            contentIndex: sealed.contentIndex,
            toolCall: sealed.block,
            partial: output,
          });
        }
        refusalBuffer?.flush();
      } finally {
        logAnthropicThinkingDrops(inputTransformations);
      }
    })();
    finalizeTransportStream({ stream, output });
  } catch (error) {
    failTransportStream({
      stream,
      output,
      signal: options?.signal,
      error,
      cleanup: () => {
        refusalBuffer?.discard();
        output.content = refusalBuffer
          ? []
          : output.content.filter((block) => block.type !== "toolCall");
        if (
          replayedCompaction &&
          isAnthropicReplayRejection(profile === "provider" ? error : output)
        ) {
          suppressAnthropicCompaction(output, model, options, replayedCompaction);
        }
      },
    });
  }
}
