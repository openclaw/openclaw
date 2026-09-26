import type { ResponseReasoningItem } from "openai/resources/responses/responses.js";
import type { AssistantMessage, TextContent } from "../types.js";
import {
  isResponsesProviderTool,
  ResponsesOutputIdentityError,
} from "./openai-responses-stream-errors.js";
import type {
  ResponsesEventSink,
  ResponsesThinkingBlock,
  TextBlockReference,
} from "./openai-responses-stream-terminal-internal.js";
import type { OpenAIResponsesStreamEvent } from "./openai-responses-stream-types-internal.js";

export type ResponsesStreamOutputSlot<TMessage, TToolCall> =
  | {
      type: "thinking";
      item: ResponseReasoningItem;
      block: ResponsesThinkingBlock;
      contentIndex: number;
      outputIndex: number | undefined;
    }
  | {
      type: "text";
      item: TMessage;
      block: TextContent | null;
      contentIndex: number | undefined;
      outputIndex: number | undefined;
      pendingText: string | null;
      collapseCandidate: TextBlockReference | null;
    }
  | { type: "toolCall"; toolCall: TToolCall };

type DeferredTextSlot = {
  pendingText: string | null;
  collapseCandidate: { block: { text: string } } | null;
};

type ResponsesOutputIdentityItem = {
  type: string;
  id?: string | null;
  call_id?: string | null;
};

type ResponsesOutputState = {
  type: string;
  callId?: string | null;
  outputIndex?: number;
  contentIndex: number;
  completed: boolean;
};

export type ResponsesOutputTracker = ReturnType<typeof createResponsesOutputTracker>;

export function createResponsesOutputTracker(params: {
  output: Pick<AssistantMessage, "content">;
  canRetryIdentityConflict?: () => boolean;
}) {
  const outputs = new Map<string | number, ResponsesOutputState>();
  let currentEventType = "unknown";
  let providerToolObserved = false;
  let visibleTextEmitted = false;
  let terminalAllowsRetry = false;
  const identity = (item: ResponsesOutputIdentityItem): string | undefined => {
    if ((item.type === "reasoning" || item.type === "message") && item.id) {
      return `${item.type}:${item.id}`;
    }
    const callId = item.call_id ?? item.id;
    return item.type === "function_call" && callId ? `function_call:${callId}` : undefined;
  };
  const get = (item: ResponsesOutputIdentityItem, outputIndex?: number) => {
    const key = identity(item);
    const output =
      (outputIndex === undefined ? undefined : outputs.get(outputIndex)) ??
      (key === undefined ? undefined : outputs.get(key));
    if (
      !output ||
      (outputIndex !== undefined &&
        output.outputIndex !== undefined &&
        output.outputIndex !== outputIndex)
    ) {
      return undefined;
    }
    if (
      output.type !== item.type ||
      (output.callId && item.call_id && output.callId !== item.call_id)
    ) {
      throw new ResponsesOutputIdentityError({
        outputIndex,
        expectedType: output.type,
        actualType: item.type,
        completed: output.completed,
        completedToolCall: [...outputs.values()].some(
          (candidate) => candidate.type === "function_call" && candidate.completed,
        ),
        eventType: currentEventType,
        retrySafe:
          params.canRetryIdentityConflict?.() === true &&
          !providerToolObserved &&
          !visibleTextEmitted &&
          terminalAllowsRetry &&
          !params.output.content.some((block) => block.type === "text" && block.text.length > 0),
      });
    }
    return output;
  };
  return {
    trackStream(sink: ResponsesEventSink): ResponsesEventSink {
      return {
        push(event) {
          // A later snapshot can clear text that has already reached the consumer.
          visibleTextEmitted ||=
            (event.type === "text_delta" && event.delta.length > 0) ||
            (event.type === "text_end" && event.content.length > 0);
          sink.push(event);
        },
      };
    },
    observeEvent(event: OpenAIResponsesStreamEvent): void {
      currentEventType = event.type;
      // An earlier conflict cannot establish whether a later terminal will reject the response.
      terminalAllowsRetry = false;
      if (
        event.type === "response.output_item.added" ||
        event.type === "response.output_item.done"
      ) {
        providerToolObserved ||= isResponsesProviderTool(event.item);
      } else if (event.type === "response.completed" || event.type === "response.incomplete") {
        let terminalHasRefusal = false;
        for (const item of event.response.output ?? []) {
          providerToolObserved ||= isResponsesProviderTool(item);
          terminalHasRefusal ||=
            item.type === "message" && (item.content ?? []).some((part) => part.type === "refusal");
        }
        terminalAllowsRetry =
          event.type === "response.completed" &&
          event.response.status === "completed" &&
          event.response.error == null &&
          event.response.incomplete_details == null &&
          !terminalHasRefusal;
      }
    },
    get,
    set(
      item: ResponsesOutputIdentityItem,
      contentIndex: number,
      outputIndex?: number,
      completed = false,
    ): void {
      const output: ResponsesOutputState = get(item, outputIndex) ?? {
        type: item.type,
        contentIndex,
        completed,
      };
      Object.assign(output, { contentIndex, completed });
      if (item.call_id) {
        output.callId = item.call_id;
      }
      if (outputIndex !== undefined) {
        output.outputIndex = outputIndex;
        outputs.set(outputIndex, output);
      }
      // Output positions survive encrypted ID rotation. Aliases retain the
      // supported unindexed stream contract without owning lifecycle state.
      const key = identity(item);
      if (key !== undefined) {
        outputs.set(key, output);
      }
    },
  };
}

export function appendResponsesPendingTextDelta<TSlot extends DeferredTextSlot>(
  slot: TSlot,
  delta: string,
  materialize: (slot: TSlot) => void,
): void {
  const offset = slot.pendingText?.length ?? 0;
  slot.pendingText = `${slot.pendingText ?? ""}${delta}`;
  const priorText = slot.collapseCandidate?.block.text ?? "";
  // Earlier deltas already matched; only compare the new overlap with the prior item.
  if (
    offset >= priorText.length ||
    priorText.startsWith(delta.slice(0, priorText.length - offset), offset)
  ) {
    return;
  }
  // Divergence means this is a distinct message; materialize its withheld delta.
  materialize(slot);
}

export function readResponsesOutputIndex(event: object): number | undefined {
  const outputIndex = (event as { output_index?: unknown }).output_index;
  return typeof outputIndex === "number" && Number.isInteger(outputIndex) && outputIndex >= 0
    ? outputIndex
    : undefined;
}

export function createResponsesOutputSlotTracker<TSlot extends { type: string }>() {
  const indexed = new Map<number, TSlot>();
  let unindexed: TSlot | undefined;
  return {
    register(event: object, slot: TSlot): void {
      const outputIndex = readResponsesOutputIndex(event);
      if (outputIndex === undefined) {
        if (unindexed) {
          throw new Error("Responses stream added overlapping unindexed output items");
        }
        unindexed = slot;
        return;
      }
      if (indexed.has(outputIndex)) {
        throw new Error(`Responses stream reused active output index ${outputIndex}`);
      }
      indexed.set(outputIndex, slot);
    },
    resolve<TType extends TSlot["type"]>(
      event: object,
      type: TType,
    ): Extract<TSlot, { type: TType }> | undefined {
      const outputIndex = readResponsesOutputIndex(event);
      let slot = outputIndex === undefined ? unindexed : indexed.get(outputIndex);
      if (outputIndex === undefined && !slot) {
        const matches = [...indexed.values()].filter((candidate) => candidate.type === type);
        slot = matches.length === 1 ? matches[0] : undefined;
      }
      return slot?.type === type ? (slot as Extract<TSlot, { type: TType }>) : undefined;
    },
    get(event: object): TSlot | undefined {
      const outputIndex = readResponsesOutputIndex(event);
      return outputIndex === undefined ? unindexed : indexed.get(outputIndex);
    },
    resolveOutputItem(event: object, item: { type: string }): TSlot | undefined {
      if (item.type === "reasoning") {
        return this.resolve(event, "thinking");
      }
      if (item.type === "message") {
        return this.resolve(event, "text");
      }
      return readResponsesOutputIndex(event) === undefined ? undefined : this.get(event);
    },
    values(): TSlot[] {
      return [...new Set([...indexed.values(), ...(unindexed ? [unindexed] : [])])];
    },
    forget(slot: TSlot): void {
      if (unindexed === slot) {
        unindexed = undefined;
      }
      for (const [outputIndex, candidate] of indexed) {
        if (candidate === slot) {
          indexed.delete(outputIndex);
        }
      }
    },
  };
}
