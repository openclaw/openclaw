/**
 * Resolves transcript persistence policy for a single embedded-agent attempt.
 */
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../../../plugins/provider-runtime-model.types.js";
import type { AgentRuntimePlan } from "../../runtime-plan/types.js";
import { resolveTranscriptPolicy, type TranscriptPolicy } from "../../transcript-policy.js";

type AttemptRuntimeModelContext = NonNullable<
  Parameters<AgentRuntimePlan["transcript"]["resolvePolicy"]>[0]
>;

export function shouldForceToolCallIdSanitization(params: {
  forceToolCallIdSanitizationApi?: string;
  modelApi?: string;
}): boolean {
  return (
    params.forceToolCallIdSanitizationApi !== undefined &&
    params.forceToolCallIdSanitizationApi === params.modelApi
  );
}

export function shouldRetryWithForcedToolCallIdSanitization(params: {
  cloudCodeAssistFormatError: boolean;
  errorMessage?: string;
  forceToolCallIdSanitizationApi?: string;
  modelApi?: string;
}): boolean {
  const isOpenAIResponsesApi =
    params.modelApi === "openai-responses" ||
    params.modelApi === "openai-chatgpt-responses" ||
    params.modelApi === "azure-openai-responses";
  return (
    params.cloudCodeAssistFormatError &&
    !shouldForceToolCallIdSanitization(params) &&
    !isOpenAIResponsesApi &&
    /tool[._\s-]+(?:use|call)[._\s-]+id/i.test(params.errorMessage ?? "")
  );
}

/**
 * Adapts the RuntimePlan model context to the legacy provider-runtime model
 * shape used by transcript-policy fallbacks.
 */
function asProviderRuntimeModel(
  model: AttemptRuntimeModelContext["model"],
): ProviderRuntimeModel | undefined {
  return typeof model?.id === "string" ? (model as ProviderRuntimeModel) : undefined;
}

/**
 * Resolves the transcript policy for an embedded attempt. RuntimePlan owns the
 * policy when present; otherwise the older provider/config/env resolver remains
 * the compatibility path for callers that have not produced a runtime plan yet.
 */
export function resolveAttemptTranscriptPolicy(params: {
  runtimePlan?: AgentRuntimePlan;
  runtimePlanModelContext: AttemptRuntimeModelContext;
  provider: string;
  modelId: string;
  forceToolCallIdSanitization?: boolean;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): TranscriptPolicy {
  const policy =
    params.runtimePlan?.transcript.resolvePolicy(params.runtimePlanModelContext) ??
    resolveTranscriptPolicy({
      modelApi: params.runtimePlanModelContext.modelApi,
      provider: params.provider,
      modelId: params.modelId,
      config: params.config,
      workspaceDir: params.runtimePlanModelContext.workspaceDir,
      env: params.env ?? process.env,
      model: asProviderRuntimeModel(params.runtimePlanModelContext.model),
    });
  if (!params.forceToolCallIdSanitization) {
    return policy;
  }
  return {
    ...policy,
    sanitizeToolCallIds: true,
    toolCallIdMode: "strict",
  };
}
