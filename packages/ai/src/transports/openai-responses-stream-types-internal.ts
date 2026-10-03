import type {
  ResponseCreateParamsStreaming,
  ResponseOutputMessage,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import type {
  AzureResponsesTextContentPart,
  AzureResponsesTextDeltaEvent,
} from "../providers/openai-responses-stream-compat.js";
import type { Usage } from "../types.js";
import type { FirstStreamEventInternalOptions } from "../utils/stream-first-event-timeout.js";
import type { OpenAIResponsesReasoningReplayMetadata } from "./openai-responses-contracts.js";

type ResponsesTextContentPart =
  | ResponseOutputMessage["content"][number]
  | AzureResponsesTextContentPart;
type ResponsesContentPartAddedEvent = Extract<
  ResponseStreamEvent,
  { type: "response.content_part.added" }
>;
type ResponsesOutputItemDoneEvent = Extract<
  ResponseStreamEvent,
  { type: "response.output_item.done" }
>;

export type CompletedResponse = Extract<
  ResponseStreamEvent,
  { type: "response.completed" }
>["response"];

export type ResponsesStreamOutputMessage = Omit<ResponseOutputMessage, "content"> & {
  content: ResponsesTextContentPart[] | null;
};

export type OpenAIResponsesStreamEvent =
  | ResponseStreamEvent
  | (Omit<ResponsesContentPartAddedEvent, "part"> & {
      part: Extract<ResponsesTextContentPart, { type: "text" }>;
    })
  | (Omit<ResponsesOutputItemDoneEvent, "item"> & {
      item: ResponsesStreamOutputMessage;
    })
  | AzureResponsesTextDeltaEvent;

export type ResponsesStreamOptions = FirstStreamEventInternalOptions & {
  onGeneratedImage?: (base64: string) => Promise<string | undefined> | string | undefined;
  canRetryIdentityConflict?: () => boolean;
  asyncToolExecution?: boolean;
  serviceTier?: ResponseCreateParamsStreaming["service_tier"];
  onServiceTier?: (responseTier: CompletedResponse["service_tier"]) => void;
  resolveServiceTier?: (
    responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
    requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
  ) => ResponseCreateParamsStreaming["service_tier"] | undefined;
  applyServiceTierPricing?: (
    usage: Usage,
    serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
  ) => void;
  signal?: AbortSignal;
  reasoningReplayMetadata?: OpenAIResponsesReasoningReplayMetadata;
  resolveResponseModel?: () => string | undefined;
};
