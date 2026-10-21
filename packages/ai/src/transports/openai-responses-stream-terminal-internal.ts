import { randomUUID } from "node:crypto";
import type {
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { calculateCost } from "../model-utils.js";
import { resolveResponsesMessageSnapshotCollapse } from "../providers/openai-responses-stream-compat.js";
import {
  applyResponsesCacheWritePricing,
  mapResponsesTerminalUsage,
  readResponsesReasoningTokens,
  resolveResponsesTerminalStopReason,
} from "../providers/openai-responses-terminal-usage.js";
import {
  type createResponsesToolCallTracker,
  readResponsesToolCallItemIdentity,
  type ResponsesToolCallState,
} from "../providers/openai-responses-tool-call-tracker.js";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  TextContent,
  TextSignatureV1,
  ThinkingContent,
  ToolCall,
  Usage,
} from "../types.js";
import { appendAssistantMessageDiagnostic } from "../utils/diagnostics.js";
import { captureOpenAIResponsesCompaction } from "./openai-responses-compaction-replay.js";
import {
  OPENAI_RESPONSES_COMPACTION_REPLAY_TYPE,
  OPENAI_RESPONSES_REASONING_REPLAY_BLOCK_META_KEY,
  type OpenAIResponsesReasoningReplayMetadata,
} from "./openai-responses-contracts.js";
import { encodeTextSignatureV1 } from "./openai-responses-replay-internal.js";
import { normalizeOpenAIResponsesReasoningReplayItem } from "./openai-responses-replay.js";
import type { ResponsesOutputTracker } from "./openai-responses-stream-slots-internal.js";
import type { ResponsesStreamOptions } from "./openai-responses-stream-types-internal.js";
import {
  IncompleteToolCallError,
  parseTerminalToolCallArguments,
} from "./transport-stream-shared.js";

export type ResponsesEventSink = { push(event: AssistantMessageEvent): void };
export type TextBlockReference = {
  block: TextContent;
  index: number;
  phase: TextSignatureV1["phase"] | undefined;
};
export type ResponsesThinkingBlock = ThinkingContent & {
  [OPENAI_RESPONSES_REASONING_REPLAY_BLOCK_META_KEY]?: OpenAIResponsesReasoningReplayMetadata;
};

type TerminalOutput = AssistantMessage & {
  usage: Usage & { reasoningTokens?: number };
};
type TerminalOptions = Pick<
  ResponsesStreamOptions,
  | "serviceTier"
  | "promptCacheTtl"
  | "onServiceTier"
  | "resolveServiceTier"
  | "applyServiceTierPricing"
  | "reasoningReplayMetadata"
  | "resolveResponseModel"
>;

function splitToolCallId(id: string): [string, string | undefined] {
  const separator = id.indexOf("|");
  return separator === -1 ? [id, undefined] : [id.slice(0, separator), id.slice(separator + 1)];
}

export function resolveResponsesToolCallId(
  item: { call_id?: unknown; id?: unknown },
  fallbackId?: string,
): string {
  const callId = typeof item.call_id === "string" ? item.call_id.trim() : "";
  const itemId = typeof item.id === "string" ? item.id.trim() : "";
  const [fallbackCallId, fallbackItemId = ""] = splitToolCallId(fallbackId ?? "");
  const resolvedCallId =
    callId || fallbackCallId || `call_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const resolvedItemId = itemId || fallbackItemId;
  return resolvedItemId ? `${resolvedCallId}|${resolvedItemId}` : resolvedCallId;
}

export function resolveCompletedResponsesToolCall(
  item: Extract<ResponseOutputItem, { type: "function_call" }>,
  streamed?: { name?: string; arguments?: string | Record<string, unknown> },
): Pick<ToolCall, "name" | "arguments"> {
  if (item.status && item.status !== "completed") {
    throw new IncompleteToolCallError(
      "Responses stream completed with an incomplete terminal tool call",
    );
  }
  const streamedName = streamed?.name?.trim() || undefined;
  const completedName = typeof item.name === "string" ? item.name.trim() || undefined : undefined;
  if (streamedName && completedName && streamedName !== completedName) {
    throw new Error(
      `Responses stream changed tool-call function name from ${streamedName} to ${completedName}`,
    );
  }
  const name = completedName ?? streamedName;
  if (!name) {
    throw new Error("Responses stream completed tool call without a function name");
  }
  const argumentsValue = parseTerminalToolCallArguments(
    streamed?.arguments ?? item.arguments,
    "Responses stream completed tool call with invalid JSON arguments",
  );
  return { name, arguments: argumentsValue };
}

export function createResponsesTerminalController(params: {
  output: TerminalOutput;
  stream: ResponsesEventSink;
  model: Model;
  options?: TerminalOptions;
  outputs: ResponsesOutputTracker;
  toolCalls: Pick<
    ReturnType<typeof createResponsesToolCallTracker<ResponsesToolCallState & { block: ToolCall }>>,
    "resolve" | "values" | "hasActive"
  >;
  getLastTextBlock: () => TextBlockReference | null;
  setLastTextBlock: (block: TextBlockReference | null) => void;
}) {
  const { output, stream, model, options } = params;
  const blocks = output.content;
  const pendingReasoning = new Set<number>();
  const deferredToolCompletions: Extract<AssistantMessageEvent, { type: "toolcall_end" }>[] = [];
  const recordPendingReasoning = (contentIndex: number) => {
    pendingReasoning.add(contentIndex);
  };
  const releaseDeferredToolCompletions = () => {
    for (const event of deferredToolCompletions) {
      stream.push(event);
    }
    deferredToolCompletions.length = 0;
    pendingReasoning.clear();
  };
  let rejectedToolCallId: string | undefined;
  const recordIncompleteToolCall = (
    event: { output_index?: unknown },
    item: Extract<ResponseOutputItem, { type: "function_call" }>,
  ) => {
    const streamed = params.toolCalls.resolve(event, readResponsesToolCallItemIdentity(item));
    rejectedToolCallId =
      streamed?.block.id ?? (item.call_id ? resolveResponsesToolCallId(item) : undefined);
  };
  const settleReasoning = (items: ResponseOutputItem[]) => {
    for (const [outputIndex, item] of items.entries()) {
      if (item.type !== "reasoning") {
        continue;
      }
      const tracked = params.outputs.get(item, outputIndex);
      const block = tracked && blocks[tracked.contentIndex];
      if (block?.type !== "thinking") {
        continue;
      }
      // Continuation retains this terminal item, whose ciphertext can differ from item.done.
      block.thinkingSignature = JSON.stringify(
        normalizeOpenAIResponsesReasoningReplayItem(item, model.api),
      );
      if (item.encrypted_content && options?.reasoningReplayMetadata) {
        Object.assign(block, {
          [OPENAI_RESPONSES_REASONING_REPLAY_BLOCK_META_KEY]: options.reasoningReplayMetadata,
        });
      }
    }
  };
  const appendText = (item: ResponseOutputMessage, initialIndex?: number): number | undefined => {
    let contentIndex = initialIndex;
    const text = (Array.isArray(item.content) ? item.content : [])
      .map((part) => {
        const content = part as { type: string; text?: string; refusal?: string };
        return content.type === "output_text" || content.type === "text"
          ? (content.text ?? "")
          : (content.refusal ?? "");
      })
      .join("");
    const block = contentIndex === undefined ? undefined : blocks[contentIndex];
    const started = block?.type === "text" ? block : undefined;
    if (!text && !started) {
      return undefined;
    }
    const phase = item.phase ?? undefined;
    if (started && contentIndex !== undefined) {
      const previousText = started.text;
      started.text = text;
      started.textSignature = encodeTextSignatureV1(item.id, phase);
      params.setLastTextBlock({ block: started, index: contentIndex, phase });
      if (text.startsWith(previousText)) {
        const delta = text.slice(previousText.length);
        if (delta) {
          stream.push({ type: "text_delta", contentIndex, delta });
        }
      }
    } else {
      const previous = params.getLastTextBlock();
      const collapse = resolveResponsesMessageSnapshotCollapse({
        prior: previous && { text: previous.block.text, phase: previous.phase },
        nextText: text,
        nextPhase: phase,
      });
      if (collapse.kind === "extend" && previous) {
        previous.block.text = collapse.text;
        previous.block.textSignature = encodeTextSignatureV1(item.id, phase);
        contentIndex = previous.index;
      } else {
        const newBlock: TextContent = {
          type: "text",
          text,
          textSignature: encodeTextSignatureV1(item.id, phase),
        };
        blocks.push(newBlock);
        contentIndex = blocks.length - 1;
        params.setLastTextBlock({ block: newBlock, index: contentIndex, phase });
        stream.push({ type: "text_start", contentIndex, partial: output });
      }
    }
    stream.push({ type: "text_end", contentIndex, content: text, partial: output });
    return contentIndex;
  };
  const emitToolCallCompletion = (
    item: { type: "function_call"; id?: string; call_id?: string },
    outputIndex: number | undefined,
    started: { block: ToolCall; contentIndex: number } | undefined,
    validated: Pick<ToolCall, "name" | "arguments" | "async">,
  ): void => {
    // Complete the same public block with authoritative identities and arguments;
    // scratch JSON must never survive into transcript replay.
    const completed = { id: resolveResponsesToolCallId(item, started?.block.id), ...validated };
    const toolCall: ToolCall = started
      ? Object.assign(started.block, completed)
      : { type: "toolCall", ...completed };
    delete toolCall.partialJson;
    const contentIndex = started?.contentIndex ?? blocks.length;
    if (!started) {
      blocks.push(toolCall);
      stream.push({ type: "toolcall_start", contentIndex, partial: output });
    }
    params.outputs.set(item, contentIndex, outputIndex, true);
    const completion: Extract<AssistantMessageEvent, { type: "toolcall_end" }> = {
      type: "toolcall_end",
      contentIndex,
      toolCall,
      partial: output,
    };
    if (toolCall.async) {
      for (const index of pendingReasoning) {
        if (index < contentIndex) {
          // Persistence freezes async prefixes; wait for the terminal reasoning snapshot.
          deferredToolCompletions.push(completion);
          return;
        }
      }
    }
    stream.push(completion);
  };
  const recoverTerminalOutput = (
    items: ResponseOutputItem[],
    completeToolCall?: (outputIndex: number) => void,
  ) => {
    let hasCompletedLaterOutput = false;
    for (const [outputIndex, item] of [...items.entries()].toReversed()) {
      const tracked = params.outputs.get(item, outputIndex);
      if (item.type === "reasoning") {
        // Terminal snapshots only backfill streamed reasoning; missing reasoning is never emitted.
        hasCompletedLaterOutput ||= tracked !== undefined;
        continue;
      }
      if (item.type !== "message" && item.type !== "function_call") {
        continue;
      }
      if (tracked) {
        hasCompletedLaterOutput = true;
        continue;
      }
      if (item.type === "function_call" && !completeToolCall) {
        continue;
      }
      // Previously emitted content indexes cannot be reordered after a missing earlier item.
      if (hasCompletedLaterOutput) {
        throw new Error("Responses stream omitted an output item before completed output");
      }
    }
    for (const [terminalIndex, item] of items.entries()) {
      if (item.type === "message") {
        const tracked = params.outputs.get(item, terminalIndex);
        if (tracked?.completed) {
          continue;
        }
        const appendedIndex = appendText(item, tracked?.contentIndex);
        if (appendedIndex !== undefined) {
          params.outputs.set(item, appendedIndex, terminalIndex, true);
        }
      } else {
        params.setLastTextBlock(null);
        const alreadyCapturedCompaction =
          item.type === "compaction" &&
          output.providerReplay?.type === OPENAI_RESPONSES_COMPACTION_REPLAY_TYPE &&
          output.providerReplay.id === item.id &&
          output.providerReplay.data === item.encrypted_content;
        if (item.type === "compaction" && !alreadyCapturedCompaction) {
          let replayIndex = blocks.length;
          for (const [laterIndex, laterItem] of items.entries()) {
            if (laterIndex <= terminalIndex) {
              continue;
            }
            const laterContentIndex = params.outputs.get(laterItem, laterIndex)?.contentIndex;
            if (laterContentIndex !== undefined) {
              replayIndex = laterContentIndex;
              break;
            }
          }
          captureOpenAIResponsesCompaction(
            output,
            item,
            replayIndex,
            model,
            options?.reasoningReplayMetadata,
          );
        } else if (completeToolCall && item.type === "function_call") {
          if (params.outputs.get(item, terminalIndex)?.completed) {
            continue;
          }
          completeToolCall(terminalIndex);
        }
      }
    }
  };
  const finalizeTerminalFacts = (
    response: Extract<
      ResponseStreamEvent,
      { type: "response.completed" | "response.incomplete" | "response.failed" }
    >["response"],
    responseId = response.id,
  ) => {
    options?.onServiceTier?.(response.service_tier, response);
    output.responseId = responseId || output.responseId;
    output.responseModel = options?.resolveResponseModel
      ? options.resolveResponseModel()?.trim() || undefined
      : response.model?.trim() || undefined;
    const usage = mapResponsesTerminalUsage(response.usage);
    const reasoningTokens = readResponsesReasoningTokens(response.usage);
    if (usage) {
      output.usage = {
        ...usage,
        ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
        usageReport: { state: "available" },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
    } else {
      output.usage.usageReport = { state: "unavailable" };
    }
    calculateCost(model, output.usage);
    applyResponsesCacheWritePricing(output.usage, response.usage, options?.promptCacheTtl);
    if (options?.applyServiceTierPricing) {
      const tier = options.resolveServiceTier
        ? options.resolveServiceTier(response.service_tier, options.serviceTier)
        : (response.service_tier ?? options.serviceTier);
      options.applyServiceTierPricing(output.usage, tier);
    }
  };
  const finalizeResponse = (
    response: Extract<
      ResponseStreamEvent,
      { type: "response.completed" | "response.incomplete" }
    >["response"] & { end_turn?: unknown },
    terminalEventType: "response.completed" | "response.incomplete",
    rejectedToolCall: { error: unknown } | undefined,
  ) => {
    settleReasoning(response.output ?? []);
    finalizeTerminalFacts(response);
    const terminal = resolveResponsesTerminalStopReason({
      status: response.status,
      terminalEventType,
      incompleteReason: response.incomplete_details?.reason,
      hasToolCall: blocks.some((block) => block.type === "toolCall"),
    });
    output.stopReason = terminal.stopReason;
    if (terminal.errorMessage !== undefined) {
      output.errorMessage = terminal.errorMessage;
    }
    if (terminalEventType === "response.completed" && typeof response.end_turn === "boolean") {
      output.endTurn = response.end_turn;
    }
    const incompleteReason = response.incomplete_details?.reason;
    const incompleteCall = response.output?.find(
      (item) => item.type === "function_call" && item.status && item.status !== "completed",
    );
    const incompleteToolCallId =
      rejectedToolCallId ??
      (terminalEventType === "response.incomplete" && !rejectedToolCall
        ? params.toolCalls.values()[0]?.block.id
        : undefined) ??
      (incompleteCall?.type === "function_call" && incompleteCall.call_id
        ? resolveResponsesToolCallId(incompleteCall)
        : undefined);
    appendAssistantMessageDiagnostic(output, {
      type: "openai_responses_terminal",
      timestamp: Date.now(),
      details: {
        eventType: terminalEventType,
        // Keep the canonical status interpretation before tool validation replaces
        // output.stopReason with an error. Conflicting statuses cannot authorize retry.
        stopReason: terminal.stopReason,
        ...(incompleteToolCallId ? { incompleteToolCallId } : {}),
        ...(terminalEventType === "response.incomplete"
          ? {
              incompleteReason:
                incompleteReason === "max_output_tokens" ||
                incompleteReason === "max_messages" ||
                incompleteReason === "content_filter" ||
                incompleteReason === "steered"
                  ? incompleteReason
                  : "unknown",
            }
          : {}),
        endTurn:
          typeof response.end_turn === "boolean"
            ? response.end_turn
            : response.end_turn === undefined
              ? "absent"
              : "invalid",
      },
    });
    const failure =
      rejectedToolCall ??
      (terminalEventType === "response.incomplete" && params.toolCalls.hasActive()
        ? {
            error: new IncompleteToolCallError(
              "Responses stream completed with unresolved tool calls",
            ),
          }
        : undefined);
    if (failure) {
      const error = output.errorMessage ? new Error(output.errorMessage) : failure.error;
      throw error;
    }
  };
  return {
    finalizeResponse,
    finalizeFailedResponse: finalizeTerminalFacts,
    recordIncompleteToolCall,
    recoverTerminalOutput,
    emitToolCallCompletion,
    recordPendingReasoning,
    releaseDeferredToolCompletions,
  };
}
