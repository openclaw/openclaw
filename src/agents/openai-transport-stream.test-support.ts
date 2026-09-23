import "./ai-transport-runtime-host.js";
import { formatModelTransportDebugBaseUrl } from "../../packages/ai/src/transports/model-transport-url.js";
import { createOpenAIResponsesClient } from "../../packages/ai/src/transports/openai-responses-client.js";
import { buildOpenAIResponsesReasoningReplayMetadata } from "../../packages/ai/src/transports/openai-responses-compaction-replay.js";
import {
  normalizeResponsesFailedEvent,
  summarizeResponsesPayload,
  stringifyRedactedEvent,
} from "../../packages/ai/src/transports/openai-responses-debug.js";
import {
  buildOpenAIResponsesParams,
  sanitizeOpenAICodexResponsesParams,
} from "../../packages/ai/src/transports/openai-responses-params-internal.js";
import {
  createResponsesStreamWithEncryptedContentRetry,
  isInvalidEncryptedContentError,
  resolveAzureOpenAIApiVersion,
} from "../../packages/ai/src/transports/openai-responses-replay-internal.js";
import { processResponsesStream } from "../../packages/ai/src/transports/openai-responses-stream-internal.js";
import {
  assertCodeModeResponsesToolSurface,
  buildOpenAIClientHeaders,
  buildOpenAISdkClientOptions,
  buildOpenAISdkRequestOptions,
  enforceCodeModeResponsesToolSurface,
  getCompat,
} from "../../packages/ai/src/transports/openai-transport-params.js";

export const testing = {
  getCompat,
  assertCodeModeResponsesToolSurface,
  buildOpenAIResponsesParams,
  buildOpenAIClientHeaders,
  buildOpenAISdkClientOptions,
  buildOpenAISdkRequestOptions,
  createOpenAIResponsesClient,
  enforceCodeModeResponsesToolSurface,
  sanitizeOpenAICodexResponsesParams,
  processResponsesStream,
  formatModelTransportDebugBaseUrl,
  buildOpenAIResponsesReasoningReplayMetadata,
  isInvalidEncryptedContentError,
  normalizeResponsesFailedEvent,
  createResponsesStreamWithEncryptedContentRetry,
  resolveAzureOpenAIApiVersion,
  summarizeResponsesPayload,
  stringifyRedactedEvent,
};
