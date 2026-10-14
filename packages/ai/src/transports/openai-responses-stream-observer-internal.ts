import type { Model } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { emitModelTransportDebug } from "./model-transport-debug.js";
import type { OpenAIResponsesRequestParams } from "./openai-responses-contracts.js";
import type { OpenAIResponsesStreamEvent } from "./openai-responses-stream-internal.js";
import { log } from "./openai-transport-shared.js";
import { iterateModelStream } from "./transport-stream-shared.js";

const STRING_DELTA_EVENTS = new Set([
  "response.function_call_arguments.delta",
  "response.output_text.delta",
  "response.reasoning_summary_text.delta",
  "response.reasoning_text.delta",
  "response.refusal.delta",
  "response.text.delta",
]);

export async function* adaptResponsesStream(
  stream: AsyncIterable<unknown>,
  signal?: AbortSignal,
): AsyncGenerator<OpenAIResponsesStreamEvent> {
  for await (const event of iterateModelStream(stream, signal)) {
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
      (event.type === "response.created" ||
        event.type === "response.completed" ||
        event.type === "response.incomplete" ||
        event.type === "response.failed") &&
      !isRecord(event.response)
    ) {
      throw new Error(`Responses stream delivered malformed ${event.type} response`);
    }
    yield event as OpenAIResponsesStreamEvent;
  }
}

export async function* observeResponsesStream<TEvent>(
  stream: AsyncIterable<TEvent>,
  model: Model,
  requestStartedAt?: number,
  request?: Pick<OpenAIResponsesRequestParams, "service_tier" | "max_output_tokens">,
  transport: "sse" | "websocket" = "sse",
): AsyncGenerator<TEvent> {
  const startedAt = Date.now();
  const eventTypes = new Map<string, number>();
  let eventCount = 0;
  let responseId: string | undefined;
  let servedTier: string | undefined;
  let outputTokens: number | undefined;
  let reasoningTokens: number | undefined;
  let terminalType: string | undefined;
  let incompleteReason: string | undefined;
  const requestDetails =
    `transport=${transport} requestedTier=${request?.service_tier ?? "unspecified"} ` +
    `max_output_tokens=${request?.max_output_tokens ?? "provider-default"}`;
  emitModelTransportDebug(
    log,
    `[responses] stream_start provider=${model.provider} api=${model.api} model=${model.id} ${requestDetails}`,
  );
  try {
    for await (const event of stream) {
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
      if (
        type === "response.completed" ||
        type === "response.incomplete" ||
        type === "response.failed"
      ) {
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
      yield event;
    }
  } finally {
    const types = [...eventTypes].map(([type, count]) => `${type}:${count}`).join(",");
    emitModelTransportDebug(
      log,
      `[responses] stream_done provider=${model.provider} api=${model.api} model=${model.id} ` +
        `${requestDetails} responseId=${responseId ?? "unknown"} servedTier=${servedTier ?? "unknown"} ` +
        `outputTokens=${outputTokens ?? "unknown"} reasoningTokens=${reasoningTokens ?? "unknown"} ` +
        `streamDurationMs=${Date.now() - startedAt} elapsedMs=${Date.now() - (requestStartedAt ?? startedAt)} ` +
        `terminal=${terminalType ?? "none"} incompleteReason=${incompleteReason ?? "none"} events=${eventCount} types=${types}`,
    );
  }
}
