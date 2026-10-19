import { adjustMaxTokensForThinking } from "@openclaw/ai/internal/shared";
import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Model } from "../llm/types.js";
import type { AdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import type { AgentHarness, AgentHarnessIsolatedCompletionParamsV2 } from "./harness/types.js";
import type { IsolatedCompletionPurpose } from "./isolated-completion-purpose.js";
import {
  unwrapModelHeaderSentinelsForProviderEgress,
  unwrapSecretSentinelsForProviderEgress,
} from "./provider-secret-egress.js";

export type AgentHarnessIsolatedCompletionParams = Parameters<
  NonNullable<AgentHarness["runIsolatedCompletion"]>
>[0];

export type RunIsolatedCompletionParams = {
  purpose?: IsolatedCompletionPurpose;
  config?: OpenClawConfig;
  provider: string;
  model: string;
  /** Explicit credential owner. CLI and harness paths must not replace it with another profile. */
  authProfileId?: string;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  /** Concrete owner already resolved by the caller, when available. */
  agentHarnessRuntimeOverride?: string;
  systemPrompt: string;
  prompt: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  /** Private credential directories must remain outside the configured Gateway owner. */
  preparedModelRuntimeMode?: "isolated-read-only";
  /** Duration of dispatch through the selected runtime, excluding model/auth preparation. */
  onRequestComplete?: (durationMs: number) => void;
  /** Revalidate the caller's authority before credential handoff and dispatch. */
  assertCurrent?: () => void;
  /** Explicit requester restriction; automatic metadata callers remain system-owned. */
  operatorAuthority?: AdmittedRunOperatorAuthority;
  /** Adapt host authorization failures to the calling completion API's error contract. */
  mapOperatorAuthorizationError?: (error: unknown) => Error;
  thinkLevel?: ThinkLevel;
  outputTextPolicy?: AgentHarnessIsolatedCompletionParamsV2["outputTextPolicy"];
  /** Internal answer budget; reasoning reserves still obey model and explicit stream limits. */
  answerTokenBudget?: number;
  streamParams?: AgentHarnessIsolatedCompletionParamsV2["streamParams"];
};

export function resolveIsolatedStreamParams(
  { answerTokenBudget, streamParams, thinkLevel }: RunIsolatedCompletionParams,
  model?: Model,
): RunIsolatedCompletionParams["streamParams"] {
  let maxTokens = answerTokenBudget ?? streamParams?.maxTokens;
  if (maxTokens === undefined) {
    return streamParams;
  }
  const modelMaxTokens = model?.maxTokens ?? Number.POSITIVE_INFINITY;
  if (answerTokenBudget !== undefined && model?.reasoning && thinkLevel !== "off") {
    maxTokens = adjustMaxTokensForThinking(answerTokenBudget, modelMaxTokens, "medium").maxTokens;
  }
  return {
    ...streamParams,
    maxTokens: Math.min(maxTokens, modelMaxTokens, streamParams?.maxTokens ?? maxTokens),
  };
}

export function prepareIsolatedHostAuthorization<
  T extends Pick<AgentHarnessIsolatedCompletionParams, "model" | "auth">,
>(harness: AgentHarness, authorization: T): T {
  if (harness.id === "openclaw") {
    return authorization;
  }
  // External harnesses are the provider egress boundary. Keep credentials
  // sentinelized until this owner is selected, then hand it usable values.
  const boundary = "plugin harness isolated completion handoff";
  const apiKey = authorization.auth.apiKey
    ? unwrapSecretSentinelsForProviderEgress(authorization.auth.apiKey, boundary)
    : authorization.auth.apiKey;
  const model = unwrapModelHeaderSentinelsForProviderEgress(authorization.model, boundary);
  if (apiKey === authorization.auth.apiKey && model === authorization.model) {
    return authorization;
  }
  return {
    ...authorization,
    model,
    auth: { ...authorization.auth, apiKey },
  };
}
