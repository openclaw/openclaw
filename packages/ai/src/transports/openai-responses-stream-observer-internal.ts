import { observeAsyncIterator, type Model } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { emitModelTransportDebug } from "./model-transport-debug.js";
import {
  isResponsesTerminalEventType,
  type OpenAIResponsesRequestParams,
} from "./openai-responses-contracts.js";
import type { OpenAIResponsesStreamEvent } from "./openai-responses-stream-internal.js";
import { log } from "./openai-transport-shared.js";

const STRING_DELTA_EVENTS = new Set([
  "response.function_call_arguments.delta",
  "response.output_text.delta",
  "response.reasoning_summary_text.delta",
  "response.reasoning_text.delta",
  "response.refusal.delta",
  "response.text.delta",
]);

export function adaptResponsesStreamEvent(rawEvent: unknown): OpenAIResponsesStreamEvent {
  // Guarded HTTP turns a unary JSON body into one SSE data event. Reuse the
  // terminal consumer for Responses snapshots instead of projecting a second answer.
  const event =
    isRecord(rawEvent) &&
    rawEvent.type === undefined &&
    rawEvent.object === "response" &&
    typeof rawEvent.status === "string" &&
    isResponsesTerminalEventType("response." + rawEvent.status)
      ? { type: "response." + rawEvent.status, response: rawEvent }
      : rawEvent;
  if (!isRecord(event) || typeof event.type !== "string") {
    throw new Error("Responses stream delivered a malformed event without a string type");
  }
  if (STRING_DELTA_EVENTS.has(event.type) && typeof event.delta !== "string") {
    throw new Error(`Responses stream delivered malformed ${event.type} delta`);
  }
  if (
    (event.type === "response.output_item.added" || event.type === "response.output_item.done") &&
    !isRecord(event.item)
  ) {
    throw new Error(`Responses stream delivered malformed ${event.type} item`);
  }
  if (
    (event.type === "response.created" || isResponsesTerminalEventType(event.type)) &&
    !isRecord(event.response)
  ) {
    throw new Error(`Responses stream delivered malformed ${event.type} response`);
  }
  return event as OpenAIResponsesStreamEvent;
}

export function observeResponsesStream<TEvent>(
  stream: AsyncIterable<TEvent>,
  model: Model,
  requestStartedAt?: number,
  request?: Pick<OpenAIResponsesRequestParams, "service_tier" | "max_output_tokens">,
  transport: "sse" | "websocket" = "sse",
): AsyncIterableIterator<TEvent> {
  let startedAt = 0;
  const eventTypes = new Map<string, number>();
  let eventCount = 0;
  let responseId: string | undefined;
  let servedTier: string | undefined;
  let outputTokens: number | undefined;
  let reasoningTokens: number | undefined;
  let terminalType: string | undefined;
  let incompleteReason: string | undefined;
  let requestDetails = "";
  return observeAsyncIterator({
    iterator: () => stream[Symbol.asyncIterator](),
    onStart() {
      startedAt = Date.now();
      requestDetails =
        `transport=${transport} requestedTier=${request?.service_tier ?? "unspecified"} ` +
        `max_output_tokens=${request?.max_output_tokens ?? "provider-default"}`;
      emitModelTransportDebug(
        log,
        `[responses] stream_start provider=${model.provider} api=${model.api} model=${model.id} ${requestDetails}`,
      );
    },
    onEvent(event) {
      const record = isRecord(event) ? event : undefined;
      const type = typeof record?.type === "string" ? record.type : "unknown";
      const response = isRecord(record?.response) ? record.response : undefined;
      if (typeof response?.id === "string") {
        responseId = response.id;
      }
      if (typeof response?.service_tier === "string") {
        servedTier = response.service_tier;
      }
      if (isRecord(response?.usage)) {
        if (typeof response.usage.output_tokens === "number") {
          outputTokens = response.usage.output_tokens;
        }
        const details = response.usage.output_tokens_details;
        if (isRecord(details) && typeof details.reasoning_tokens === "number") {
          reasoningTokens = details.reasoning_tokens;
        }
      }
      if (isResponsesTerminalEventType(type)) {
        terminalType = type;
        const details = response?.incomplete_details;
        if (isRecord(details) && typeof details.reason === "string") {
          incompleteReason = details.reason;
        }
      }
      eventCount += 1;
      eventTypes.set(type, (eventTypes.get(type) ?? 0) + 1);
      if (eventCount === 1) {
        emitModelTransportDebug(
          log,
          `[responses] first_event provider=${model.provider} api=${model.api} model=${model.id} ` +
            `elapsedMs=${Date.now() - (requestStartedAt ?? startedAt)} ` +
            `headersToEventMs=${Date.now() - startedAt} type=${type} responseId=${responseId ?? "unknown"}`,
        );
      }
    },
    onFinally() {
      const types = [...eventTypes].map(([type, count]) => `${type}:${count}`).join(",");
      emitModelTransportDebug(
        log,
        `[responses] stream_done provider=${model.provider} api=${model.api} model=${model.id} ` +
          `${requestDetails} responseId=${responseId ?? "unknown"} servedTier=${servedTier ?? "unknown"} ` +
          `outputTokens=${outputTokens ?? "unknown"} reasoningTokens=${reasoningTokens ?? "unknown"} ` +
          `streamDurationMs=${Date.now() - startedAt} elapsedMs=${Date.now() - (requestStartedAt ?? startedAt)} ` +
          `terminal=${terminalType ?? "none"} incompleteReason=${incompleteReason ?? "none"} events=${eventCount} types=${types}`,
      );
    },
  });
}
