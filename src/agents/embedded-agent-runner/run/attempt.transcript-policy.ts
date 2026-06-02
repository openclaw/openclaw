import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../../../plugins/provider-runtime-model.types.js";
import type { AgentRuntimePlan } from "../../runtime-plan/types.js";
import { resolveTranscriptPolicy, type TranscriptPolicy } from "../../transcript-policy.js";

/** Runtime model context forwarded to the transcript policy resolver for one attempt. */
export type AttemptRuntimeModelContext = NonNullable<
  Parameters<AgentRuntimePlan["transcript"]["resolvePolicy"]>[0]
>;

function asProviderRuntimeModel(
  model: AttemptRuntimeModelContext["model"],
): ProviderRuntimeModel | undefined {
  return typeof model?.id === "string" ? (model as ProviderRuntimeModel) : undefined;
}

/**
 * Resolves the transcript policy from the runtime plan first, falling back to
 * legacy config rules for callers that have not built a runtime plan yet.
 */
export function resolveAttemptTranscriptPolicy(params: {
  runtimePlan?: AgentRuntimePlan;
  runtimePlanModelContext: AttemptRuntimeModelContext;
  provider: string;
  modelId: string;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): TranscriptPolicy {
  return (
    params.runtimePlan?.transcript.resolvePolicy(params.runtimePlanModelContext) ??
    resolveTranscriptPolicy({
      modelApi: params.runtimePlanModelContext.modelApi,
      provider: params.provider,
      modelId: params.modelId,
      config: params.config,
      workspaceDir: params.runtimePlanModelContext.workspaceDir,
      env: params.env ?? process.env,
      model: asProviderRuntimeModel(params.runtimePlanModelContext.model),
    })
  );
}
