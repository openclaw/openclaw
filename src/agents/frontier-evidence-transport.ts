import { openAIResponsesDispatchGuards } from "@openclaw/ai/internal/openai";
import type { StreamFn } from "@openclaw/llm-core";
import {
  readFirstUserText,
  splitLeadingTimestampEnvelope,
} from "./embedded-agent-runner/run/attempt.user-message-boundary.js";
import type { EmbeddedRunAttemptParams } from "./embedded-agent-runner/run/types.js";
import {
  getFrontierEvidenceExpectedAuthProfileId,
  getFrontierEvidencePolicy,
  getFrontierEvidenceTaskDigest,
  registerFrontierEvidenceBinding,
} from "./frontier-evidence-policy.js";
import {
  assertFrontierEvidenceFetchDispatchPolicy,
  assertFrontierEvidenceRequest,
  assertFrontierEvidenceRetryPolicy,
  createFrontierEvidenceBinding,
  FrontierEvidenceMismatchError,
  observeFrontierEvidenceFetchDispatch,
  type FrontierEvidenceBinding,
} from "./frontier-evidence-transport-policy.js";
import { getModelProviderLocalService } from "./provider-local-service.js";
import { getModelProviderRequestTransport } from "./provider-request-config.js";

function reject(code: ConstructorParameters<typeof FrontierEvidenceMismatchError>[0]): never {
  throw new FrontierEvidenceMismatchError(code);
}

function readCurrentTurnTimestampEnvelope(context: Parameters<StreamFn>[1]): string | undefined {
  for (const message of context.messages.toReversed()) {
    if (message.role !== "user") {
      continue;
    }
    const text = readFirstUserText(message.content);
    if (!text) {
      continue;
    }
    const envelope = splitLeadingTimestampEnvelope(text).envelope;
    if (envelope) {
      return envelope;
    }
  }
  return undefined;
}

function assertPreparedRoute(params: {
  attempt: EmbeddedRunAttemptParams;
  agentId: string;
  authProfileId: string | undefined;
  effectiveExtraParams: Record<string, unknown>;
}): void {
  const policy = getFrontierEvidencePolicy();
  if (!policy) {
    return;
  }
  const { attempt } = params;
  if (params.agentId !== policy.defaultAgentId) {
    reject("agent_id_mismatch");
  }
  if (
    attempt.provider !== policy.provider ||
    attempt.model.provider !== policy.provider ||
    attempt.runtimePlan?.resolvedRef.provider !== policy.provider ||
    attempt.runtimePlan?.observability.provider !== policy.provider ||
    attempt.runtimePlan?.providerRuntimeHandle?.provider !== policy.provider
  ) {
    reject("provider_mismatch");
  }
  if (
    attempt.modelId !== policy.model ||
    attempt.model.id !== policy.model ||
    attempt.runtimePlan?.resolvedRef.modelId !== policy.model ||
    attempt.runtimePlan?.observability.modelId !== policy.model ||
    attempt.runtimePlan?.providerRuntimeHandle?.modelId !== policy.model
  ) {
    reject("model_mismatch");
  }
  if (
    attempt.model.api !== policy.api ||
    attempt.runtimePlan?.resolvedRef.modelApi !== policy.api ||
    attempt.runtimePlan?.observability.modelApi !== policy.api
  ) {
    reject("api_mismatch");
  }
  if (
    attempt.model.baseUrl !== policy.baseUrl ||
    attempt.runtimePlan?.auth.modelRoute?.baseUrl !== policy.baseUrl
  ) {
    reject("base_url_mismatch");
  }
  if (
    policy.runtime !== "openclaw" ||
    attempt.agentHarnessId !== "openclaw" ||
    attempt.runtimePlan?.resolvedRef.harnessId !== "openclaw" ||
    attempt.runtimePlan?.observability.harnessId !== "openclaw"
  ) {
    reject("runtime_mismatch");
  }
  if (policy.credentialState !== "frozen_in_memory") {
    reject("credential_state_mismatch");
  }
  if (
    !params.authProfileId ||
    params.authProfileId !== getFrontierEvidenceExpectedAuthProfileId()
  ) {
    reject("auth_profile_mismatch");
  }
  if (
    attempt.fallbackActive === true ||
    attempt.fallbackReason ||
    (attempt.requestedModelId && attempt.requestedModelId !== policy.model)
  ) {
    reject("fallbacks_present");
  }
  if (attempt.runtimePlan?.auth.modelRoute?.requestTransportOverrides === "present") {
    reject("transport_mismatch");
  }
  const requestTransport = getModelProviderRequestTransport(attempt.model);
  if (requestTransport?.proxy) {
    reject("proxy_present");
  }
  if (requestTransport?.tls) {
    reject("tls_present");
  }
  if (getModelProviderLocalService(attempt.model)) {
    reject("local_service_present");
  }
  const authoredControls = [
    "frequencyPenalty",
    "cacheRetention",
    "maxTokens",
    "maxRetries",
    "max_output_tokens",
    "promptCacheKey",
    "presencePenalty",
    "reasoning",
    "reasoningEffort",
    "reasoningSummary",
    "serviceTier",
    "service_tier",
    "stop",
    "temperature",
    "toolChoice",
    "topP",
    "top_p",
  ];
  if (params.effectiveExtraParams.seed !== undefined) {
    reject("request_seed_present");
  }
  if (authoredControls.some((key) => params.effectiveExtraParams[key] !== undefined)) {
    reject("request_authored_params_present");
  }
}

export function bindFrontierEvidenceTransport(params: {
  attempt: EmbeddedRunAttemptParams;
  agentId: string;
  authProfileId: string | undefined;
  effectiveExtraParams: Record<string, unknown>;
  streamFn: StreamFn;
}): {
  streamFn: StreamFn;
  binding?: FrontierEvidenceBinding;
} {
  const policy = getFrontierEvidencePolicy();
  if (!policy) {
    return { streamFn: params.streamFn };
  }
  assertPreparedRoute(params);
  const promptCacheKey = params.attempt.promptCacheKey?.trim();
  const taskDigest = getFrontierEvidenceTaskDigest();
  if (!promptCacheKey || !taskDigest) {
    reject("request_control_mismatch");
  }
  const binding = createFrontierEvidenceBinding(policy, { promptCacheKey, taskDigest });
  registerFrontierEvidenceBinding(binding);
  const streamFn: StreamFn = (model, context, options) => {
    const providerLogicalCallId = options?.requestId?.trim();
    if (!providerLogicalCallId) {
      reject("comparable_input_binding_mismatch");
    }
    const currentTurnTimestampEnvelope = readCurrentTurnTimestampEnvelope(context);
    if (!currentTurnTimestampEnvelope) {
      reject("comparable_input_binding_mismatch");
    }
    binding.beginLogicalCall(
      {
        workspacePath: params.attempt.workspaceDir,
        sessionId: params.attempt.sessionId,
        currentTurnTimestampEnvelope,
      },
      providerLogicalCallId,
    );
    const boundOptions = { ...options };
    // This trusted binding is installed after every provider/config wrapper, so
    // caller-supplied symbols cannot replace the policy observed at fetch dispatch.
    openAIResponsesDispatchGuards.set(boundOptions, {
      beforeTransportDispatch: ({
        model: dispatchedModel,
        request,
        payloadVariant,
        maxRetries,
      }) => {
        assertFrontierEvidenceRetryPolicy(binding, maxRetries);
        assertFrontierEvidenceRequest({
          binding,
          model: dispatchedModel,
          request,
          payloadVariant,
        });
      },
      beforeFetchDispatch: ({ url, init }) =>
        assertFrontierEvidenceFetchDispatchPolicy({
          binding,
          url,
          method: init.method ?? "GET",
        }),
      observeFetchDispatch: ({ url, init }) =>
        observeFrontierEvidenceFetchDispatch({
          binding,
          url,
          method: init.method ?? "GET",
        }),
    });
    return params.streamFn(model, context, boundOptions);
  };
  return { streamFn, binding };
}
