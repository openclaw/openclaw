import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import type { Model } from "../llm/types.js";
import { redactSensitiveText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { AUTH_PROFILE_COOLDOWN_ERROR_CODE, isFailoverError } from "./failover/error.js";
import type {
  AgentHarness,
  AgentHarnessIsolatedCompletionAuthorization,
  AgentHarnessIsolatedCompletionParamsV2,
  AgentHarnessIsolatedCompletionResult,
} from "./harness/types.js";
import {
  observeIsolatedCompletionUsage,
  type IsolatedCompletionDiagnostics,
} from "./isolated-completion-diagnostics.js";
import {
  prepareIsolatedHostAuthorization,
  resolveIsolatedStreamParams,
  type AgentHarnessIsolatedCompletionParams,
  type createIsolatedCompletionModelAuthority,
} from "./isolated-completion-model-authority.js";
import type { RunIsolatedCompletionParams } from "./isolated-completion-types.js";
import type { ModelRef } from "./model-ref-shared.js";
import { completeWithAuthProfileFailover } from "./simple-completion-profile-failover.js";
import type { prepareSimpleCompletionModel } from "./simple-completion-runtime.js";

type V2Dispatch = (
  authorization: AgentHarnessIsolatedCompletionAuthorization,
  model?: Model,
) => Promise<AgentHarnessIsolatedCompletionResult>;
type HostAuthorization = Extract<AgentHarnessIsolatedCompletionAuthorization, { owner: "host" }>;

export function createIsolatedHarnessDispatcher(params: {
  harness: AgentHarness;
  commonParams: Omit<
    AgentHarnessIsolatedCompletionParamsV2,
    "authorization" | "timeoutMs" | "streamParams" | "onResult" | "outputSchema"
  >;
  request: RunIsolatedCompletionParams;
  usageOwner: Omit<Parameters<typeof observeIsolatedCompletionUsage>[0], "runtimeKind">;
  diagnostics?: IsolatedCompletionDiagnostics;
  modelAuthority: ReturnType<typeof createIsolatedCompletionModelAuthority>;
  getModelForAuthorization: () => ModelRef | undefined;
  remainingTimeoutMs: () => number;
  assertCurrent: () => void;
}): {
  v2: V2Dispatch;
  legacy: (authorization: HostAuthorization) => Promise<AgentHarnessIsolatedCompletionResult>;
} {
  const { harness, commonParams, request, usageOwner, diagnostics, assertCurrent } = params;
  const v2: V2Dispatch = (authorization, completionModel) => {
    assertCurrent();
    const execution = params.modelAuthority.bind(params.getModelForAuthorization(), authorization);
    execution.assertCurrent();
    const dispatch = () =>
      observeIsolatedCompletionUsage<AgentHarnessIsolatedCompletionResult>(
        { ...usageOwner, runtimeKind: "harness", assertCurrent: execution.assertCurrent },
        (onResult) =>
          harness.runIsolatedCompletionV2!({
            ...commonParams,
            ...execution,
            onResult,
            timeoutMs: params.remainingTimeoutMs(),
            authorization:
              authorization.owner === "host"
                ? prepareIsolatedHostAuthorization(harness, authorization)
                : authorization,
            ...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
            streamParams: resolveIsolatedStreamParams(request, completionModel),
          }),
        (completion) => completion.assistant,
      );
    const pending = diagnostics ? diagnostics.dispatch("harness", dispatch) : dispatch();
    return pending.then((completion) => {
      execution.assertCurrent();
      assertCurrent();
      return completion;
    });
  };
  const legacy = async ({ model, auth, sourceAuthFingerprint }: HostAuthorization) => {
    const harnessParams: Omit<AgentHarnessIsolatedCompletionParams, "timeoutMs"> = {
      ...commonParams,
      streamParams: resolveIsolatedStreamParams(request, model),
      model,
      auth,
      sourceAuthFingerprint,
    };
    assertCurrent();
    const execution = params.modelAuthority.bind(params.getModelForAuthorization());
    const dispatch = () =>
      observeIsolatedCompletionUsage<AgentHarnessIsolatedCompletionResult>(
        { ...usageOwner, runtimeKind: "harness", assertCurrent: execution.assertCurrent },
        (onResult) =>
          harness.runIsolatedCompletion!(
            prepareIsolatedHostAuthorization(harness, {
              ...harnessParams,
              ...execution,
              onResult,
              timeoutMs: params.remainingTimeoutMs(),
            }),
          ),
        (completion) => completion.assistant,
      );
    const result = await (diagnostics ? diagnostics.dispatch("harness", dispatch) : dispatch());
    execution.assertCurrent();
    return result;
  };
  return { v2, legacy };
}

const log = createSubsystemLogger("isolated-completion");

export async function runBuiltInIsolatedCompletionWithProfiles(params: {
  usageOwner: Omit<Parameters<typeof observeIsolatedCompletionUsage>[0], "runtimeKind">;
  signal?: AbortSignal;
  assertCurrent: () => void;
  prepare: () => Promise<
    Extract<Awaited<ReturnType<typeof prepareSimpleCompletionModel>>, { model: Model }>
  >;
  dispatch: V2Dispatch;
}): Promise<AgentHarnessIsolatedCompletionResult> {
  const { config, agentDir, completionId, purpose, provider, model: modelId } = params.usageOwner;
  const observation = {
    event: "isolated_completion_auth_exhausted",
    completionId,
    purpose,
    provider,
    model: modelId,
  };
  const prepared = await params.prepare().catch((error: unknown) => {
    params.assertCurrent();
    if (isFailoverError(error) && error.code === AUTH_PROFILE_COOLDOWN_ERROR_CODE) {
      log.warn("Isolated completion auth profiles are cooling down", {
        ...observation,
        reason: "all_profiles_in_cooldown",
        rateLimitResetAt: error.rateLimitResetAt,
      });
    }
    throw error;
  });
  const assistant = await completeWithAuthProfileFailover({
    prepared,
    cfg: config,
    agentDir,
    assertCurrent: params.assertCurrent,
    signal: params.signal,
    complete: async ({ model, auth, sourceAuthFingerprint }) =>
      (await params.dispatch({ owner: "host", model, auth, sourceAuthFingerprint }, model))
        .assistant,
    // Never replay a completion that returned text or tool output.
    canRotate: (result, reason) =>
      (reason === "rate_limit" || reason === "billing") &&
      result.content.every((block) => block.type === "text" && !block.text.trim()),
    onExhausted: ({ attempts, profileCount, failedProfileCount }) => {
      log.warn("Isolated completion auth profiles exhausted", {
        ...observation,
        reason: "eligible_profiles_exhausted",
        profileCount,
        failedProfileCount,
        attempts: attempts.map(({ profileId, ...outcome }) => ({
          ...outcome,
          profileId: sanitizeForLog(redactSensitiveText(profileId)).slice(0, 128),
        })),
      });
    },
    warn: (message) => log.warn(message),
  });
  return { assistant };
}
