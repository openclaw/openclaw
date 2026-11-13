import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import type { BaseOpenAIStreamOptions } from "../provider-options.js";
import type { OpenAIResponsesReplayMode } from "../transports/openai-responses-compaction-replay.js";
import type { createResponsesV2CompactionCollector } from "../transports/openai-responses-compaction-v2.js";
import { awaitProviderLifecycleCallback } from "../transports/transport-stream-shared.js";
import type { Context, Model } from "../types.js";
import { prepareSystemPrompt } from "../utils/system-prompt-cache-boundary.js";
import type { RequestBody } from "./openai-chatgpt-responses-websocket-state.js";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.js";
import { supportsOpenAITemperature } from "./openai-reasoning-effort.js";
import {
  resolveOpenAIRequestReasoning,
  type OpenAIRequestReasoningEffort,
} from "./openai-request-reasoning.js";
import { resolveOpenAIResponsesTextFormat } from "./openai-response-format.js";
import {
  convertResponsesMessages,
  convertResponsesToolPayload,
} from "./openai-responses-shared.js";

export interface OpenAICodexResponsesOptions extends BaseOpenAIStreamOptions {
  reasoningEffort?: OpenAIRequestReasoningEffort;
  reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
  serviceTier?: ResponseCreateParamsStreaming["service_tier"];
  textVerbosity?: "low" | "medium" | "high";
}

export const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "opencode"]);

function buildRequestBody(
  model: Model<"openai-chatgpt-responses">,
  context: Context,
  allowedToolCallProviders: ReadonlySet<string>,
  options?: OpenAICodexResponsesOptions,
  replayMode: OpenAIResponsesReplayMode = "checkpoint",
  retainUserProvenance = false,
): RequestBody {
  const messages = convertResponsesMessages(model, context, allowedToolCallProviders, {
    includeSystemPrompt: false,
    replayResponsesItemIds: false,
    sessionId: options?.sessionId,
    authProfileId: options?.authProfileId,
    mutableInput: Boolean(options?.onPayload),
    replayMode,
    retainUserProvenance,
  });

  const body: RequestBody = {
    model: model.id,
    store: false,
    stream: true,
    instructions:
      prepareSystemPrompt(context.systemPrompt ?? "", context.preparedSystemPrompt).stripped ||
      "You are a helpful assistant.",
    input: messages,
    text: { verbosity: options?.textVerbosity || "low" },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key:
      options?.cacheRetention === "none"
        ? undefined
        : clampOpenAIPromptCacheKey(options?.promptCacheKey ?? options?.sessionId),
  };

  if (options?.responseFormat !== undefined) {
    body.text = {
      ...body.text,
      format: resolveOpenAIResponsesTextFormat(options.responseFormat),
    };
  }

  if (options?.temperature !== undefined && supportsOpenAITemperature(model)) {
    body.temperature = options.temperature;
  }

  if (options?.serviceTier !== undefined) {
    body.service_tier = options.serviceTier;
  }

  if (context.tools) {
    // Explicit false prevents the backend from normalizing optional properties into required ones.
    const tools = convertResponsesToolPayload(context.tools, {
      strict: false,
      mutableParameters: Boolean(options?.onPayload),
    });
    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
      body.parallel_tool_calls = true;
    }
  }

  const effort =
    options?.reasoningEffort === undefined
      ? undefined
      : resolveOpenAIRequestReasoning(model, options.reasoningEffort).effort;
  if (effort !== undefined) {
    body.reasoning = {
      effort,
      ...(effort === "none"
        ? {}
        : { summary: options?.reasoningSummary === undefined ? "auto" : options.reasoningSummary }),
    };
  }

  return body;
}

/**
 * Build the Codex request body, apply the host payload hook with caller
 * cancellation, then restore the users a V2 compaction replay must keep.
 */
export async function buildHookedRequestBody(params: {
  model: Model<"openai-chatgpt-responses">;
  context: Context;
  options?: OpenAICodexResponsesOptions;
  replayMode: OpenAIResponsesReplayMode;
  v2Compaction?: ReturnType<typeof createResponsesV2CompactionCollector>;
}): Promise<RequestBody> {
  let body = buildRequestBody(
    params.model,
    params.context,
    CODEX_TOOL_CALL_PROVIDERS,
    params.options,
    params.replayMode,
    Boolean(params.v2Compaction),
  );
  const restoreUsers = params.v2Compaction?.preserveUsers(body.input ?? []);
  const nextBody = await awaitProviderLifecycleCallback(
    params.options?.onPayload ? () => params.options?.onPayload?.(body, params.model) : undefined,
    params.options?.signal,
  );
  if (nextBody !== undefined) {
    // SAFETY: The host payload hook replaces this adapter's request body, preserving its wire shape.
    body = nextBody as RequestBody;
  }
  if (restoreUsers) {
    body.input = [...restoreUsers(body.input ?? []), { type: "compaction_trigger" }];
    params.v2Compaction?.assertReplayFits(body.input, params.model);
  }
  return body;
}
