import type { Model } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type OpenAI from "openai";
import type { OpenAIResponsesCompactEndpointResult } from "./openai-responses-compact-request.js";
import { buildOpenAIResponsesReasoningReplayMetadata } from "./openai-responses-compaction-replay.js";
import {
  getOpenAIResponsesCompactionOutputError,
  isOpenAIResponsesCompactionOutput,
} from "./openai-responses-compaction-window.js";
import type { OpenAIResponsesOptions } from "./openai-responses-contracts.js";
import { supportsNativeOpenAIResponsesEndpoint } from "./openai-responses-endpoint.js";
import {
  buildOpenAIResponsesCompactSystemMessage,
  type buildOpenAIResponsesParams,
} from "./openai-responses-params-internal.js";
import { buildOpenAISdkRequestOptions } from "./openai-transport-params.js";

export async function postOpenAIResponsesCompaction(params: {
  client: OpenAI;
  model: Model;
  request: ReturnType<typeof buildOpenAIResponsesParams>;
  options: OpenAIResponsesOptions | undefined;
}): Promise<OpenAIResponsesCompactEndpointResult> {
  const instructions =
    typeof params.request.instructions === "string" && params.request.instructions.length > 0
      ? params.request.instructions
      : undefined;
  // Public OpenAI accepts `instructions`, which keeps the prompt out of the returned window
  // (https://developers.openai.com/api/reference/resources/responses/methods/compact);
  // xAI and other compatible routes require it first in input.
  const body =
    instructions && !supportsNativeOpenAIResponsesEndpoint(params.model)
      ? {
          model: params.request.model,
          input: [
            buildOpenAIResponsesCompactSystemMessage(params.model, instructions),
            ...(params.request.input ?? []),
          ],
        }
      : {
          model: params.request.model,
          input: params.request.input,
          ...(instructions ? { instructions } : {}),
        };
  const response = await params.client.post<unknown>("/responses/compact", {
    ...buildOpenAISdkRequestOptions(params.model, params.options?.signal, {
      timeoutMs: params.options?.timeoutMs,
    }),
    body,
  });
  if (!isRecord(response) || response.object !== "response.compaction") {
    throw new Error("Responses compact endpoint must return a response.compaction object");
  }
  const output = response.output;
  if (!isOpenAIResponsesCompactionOutput(output, params.model)) {
    throw new Error(
      `Responses compact endpoint: ${getOpenAIResponsesCompactionOutputError(output, params.model)}`,
    );
  }
  const window = output;
  const item = window.at(-1);
  if (window.length > 1 && !supportsNativeOpenAIResponsesEndpoint(params.model)) {
    throw new Error("Responses compact endpoint: retained messages require native OpenAI");
  }
  const usage = isRecord(response.usage) ? response.usage : undefined;
  if (!usage || typeof usage.input_tokens !== "number" || typeof usage.output_tokens !== "number") {
    throw new Error(
      "Responses compact endpoint: usage must include input_tokens and output_tokens",
    );
  }
  return {
    output: window,
    item,
    historyMode: window.length > 1 ? "retained-users" : "compacted-prefix",
    usage,
    model: params.model,
    replayMetadata: buildOpenAIResponsesReasoningReplayMetadata(params.model, {
      authProfileId: params.options?.authProfileId,
      sessionId: params.options?.sessionId,
    }),
  } as OpenAIResponsesCompactEndpointResult; // SAFETY: Output, trailing item, and usage passed the endpoint guards above.
}
