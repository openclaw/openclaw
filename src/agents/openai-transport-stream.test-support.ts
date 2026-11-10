import "./ai-transport-runtime-host.js";
import { buildOpenAIResponsesReasoningReplayMetadata } from "../../packages/ai/src/transports/openai-responses-compaction-replay.js";
import { normalizeResponsesFailedEvent } from "../../packages/ai/src/transports/openai-responses-debug.js";
import {
  buildOpenAIResponsesParams,
  sanitizeOpenAICodexResponsesParams,
} from "../../packages/ai/src/transports/openai-responses-params-internal.js";
import {
  createResponsesStreamWithRecovery,
  resolveAzureOpenAIApiVersion,
} from "../../packages/ai/src/transports/openai-responses-replay-internal.js";
import { processResponsesStream } from "../../packages/ai/src/transports/openai-responses-stream-internal.js";
import { buildOpenAIClientHeaders } from "../../packages/ai/src/transports/openai-transport-params.js";

export const testing = {
  buildOpenAIResponsesParams,
  buildOpenAIClientHeaders,
  sanitizeOpenAICodexResponsesParams,
  processResponsesStream,
  buildOpenAIResponsesReasoningReplayMetadata,
  normalizeResponsesFailedEvent,
  createResponsesStreamWithRecovery,
  resolveAzureOpenAIApiVersion,
};
