/** Executes an already-prepared model without importing model/auth preparation. */
import { reasoningTagTextPolicy } from "@openclaw/ai/internal/openai";
import { defaultApiRegistry } from "@openclaw/ai/internal/runtime";
import {
  prepareHeadersForSimpleCompletion,
  prepareModelForSimpleCompletion,
} from "@openclaw/ai/transports";
import { resolveProviderThinkingLevel, type ThinkLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  bindModelLlmRuntime,
  getModelCompletionOwner,
  getModelCompletionTransport,
  getModelLlmRuntime,
} from "../llm/model-runtime-binding.js";
import { completeSimple } from "../llm/stream.js";
import type { AssistantMessage, Model, SimpleStreamOptions } from "../llm/types.js";
import type { ResolvedProviderAuth } from "./model-auth.js";

type SimpleCompletionModelOptions = {
  headers?: Record<string, string>;
  sessionId?: string;
  maxTokens?: number;
  temperature?: number;
  serviceTier?: SimpleStreamOptions["serviceTier"];
  reasoning?: ThinkLevel;
  strictReasoningTags?: boolean;
  signal?: AbortSignal;
};

type PreparedCompletionParams = {
  assertCurrent?: () => void;
  model: Model;
  auth: ResolvedProviderAuth;
  context: Parameters<typeof completeSimple>[1];
  cfg?: OpenClawConfig;
  options?: SimpleCompletionModelOptions;
};

export async function completeWithPreparedSimpleCompletionModel(
  params: PreparedCompletionParams,
): Promise<AssistantMessage> {
  const owner = getModelCompletionOwner(params.model);
  if (!owner) {
    return await completePreparedModel(params);
  }
  return await owner.run(() =>
    completePreparedModel({
      ...params,
      assertCurrent: () => {
        owner.assertCurrent();
        params.assertCurrent?.();
      },
    }),
  );
}

async function completePreparedModel(params: PreparedCompletionParams): Promise<AssistantMessage> {
  // Direct SDK calls prepare transport hooks before entering the stream facade.
  await import("./ai-transport-runtime-host.js");
  params.assertCurrent?.();
  params.options?.signal?.throwIfAborted();
  const runtime = getModelLlmRuntime(params.model);
  let completionModel =
    getModelCompletionTransport(params.model) ??
    prepareModelForSimpleCompletion({
      // Direct SDK callers that did not use the preparation helper keep the shipped
      // process-default behavior; all prepared host paths carry their lifecycle owner.
      apiRegistry: runtime?.registry ?? defaultApiRegistry,
      model: params.model,
      cfg: params.cfg,
      auth: { mode: params.auth.mode, authFlow: params.auth.authFlow },
    });
  if (runtime) {
    completionModel = bindModelLlmRuntime(completionModel, runtime);
  }
  const { reasoning: rawReasoning, strictReasoningTags, ...options } = params.options ?? {};
  const providerReasoning = resolveProviderThinkingLevel({
    provider: completionModel.provider,
    model: completionModel.id,
    catalog: [completionModel],
    agentRuntime: "openclaw",
    level: rawReasoning,
  });
  const reasoning = providerReasoning === "adaptive" ? "medium" : providerReasoning;
  const headers = prepareHeadersForSimpleCompletion(completionModel, options);
  const completionOptions: SimpleStreamOptions = {
    ...options,
    ...(reasoning ? { reasoning } : {}),
    apiKey: params.auth.apiKey,
    ...(headers ? { headers } : {}),
  };
  if (strictReasoningTags) {
    reasoningTagTextPolicy.markStrict(completionOptions);
  }
  return await completeSimple(
    completionModel,
    params.context,
    completionOptions,
    params.assertCurrent,
  );
}
