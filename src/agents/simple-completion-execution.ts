/** Executes an already-prepared model without importing model/auth preparation. */
import { randomUUID } from "node:crypto";
import { reasoningTagTextPolicy } from "@openclaw/ai/internal/openai";
import { defaultApiRegistry } from "@openclaw/ai/internal/runtime";
import {
  prepareHeadersForSimpleCompletion,
  prepareModelForSimpleCompletion,
} from "@openclaw/ai/transports";
import { resolveProviderThinkingLevel, type ThinkLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasInternalDiagnosticEventListeners } from "../infra/diagnostic-event-listener-presence.js";
import { areDiagnosticsEnabledForProcess } from "../infra/diagnostic-events.js";
import {
  createDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import {
  bindModelLlmRuntime,
  getModelCompletionOwner,
  getModelCompletionTransport,
  getModelLlmRuntime,
} from "../llm/model-runtime-binding.js";
import { completeSimple } from "../llm/stream.js";
import type { AssistantMessage, Model, SimpleStreamOptions } from "../llm/types.js";
import { createModelLifecycle } from "./embedded-agent-runner/run/attempt.model-diagnostic-lifecycle.js";
import { createModelObserver } from "./embedded-agent-runner/run/attempt.model-diagnostic-observation.js";
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
    provider: params.model.provider,
    model: params.model.id,
    catalog: [params.model],
    agentRuntime: "openclaw",
    level: rawReasoning,
  });
  const reasoning = providerReasoning === "adaptive" ? "medium" : providerReasoning;
  const headers = prepareHeadersForSimpleCompletion(params.model, options);
  const completionOptions: SimpleStreamOptions = {
    ...options,
    ...(reasoning ? { reasoning } : {}),
    apiKey: params.auth.apiKey,
    ...(headers ? { headers } : {}),
  };
  if (strictReasoningTags) {
    reasoningTagTextPolicy.markStrict(completionOptions);
  }
  if (!areDiagnosticsEnabledForProcess() || !hasInternalDiagnosticEventListeners()) {
    return await completeSimple(
      completionModel,
      params.context,
      completionOptions,
      params.assertCurrent,
    );
  }
  // The prepared completion boundary is shared by metadata and plugin requests.
  // Usage remains owned by their callers; this lifecycle records only the request.
  const callId = randomUUID();
  const lifecycle = createModelLifecycle({
    ctx: {
      config: params.cfg,
      runId: callId,
      provider: params.model.provider,
      model: params.model.id,
      api: params.model.api,
      transport: "auto",
      trace: getActiveDiagnosticTraceContext() ?? createDiagnosticTraceContext(),
      nextCallId: () => callId,
      suppressPluginHooks: true,
    },
    options: completionOptions,
    createObserver: (capturePromptStats) =>
      createModelObserver({
        config: params.cfg,
        streamContext: params.context,
        capturePromptStats,
        suppressPluginHooks: true,
      }),
  });
  try {
    if (strictReasoningTags) {
      reasoningTagTextPolicy.markStrict(lifecycle.propagatedOptions);
    }
    const result = await completeSimple(
      completionModel,
      params.context,
      lifecycle.propagatedOptions,
      params.assertCurrent,
    );
    lifecycle.observer.observeFinalResult(lifecycle.eventBase, lifecycle.startedAt, result);
    lifecycle.emitCompleted();
    return result;
  } catch (error) {
    lifecycle.emitError(error);
    throw error;
  }
}
