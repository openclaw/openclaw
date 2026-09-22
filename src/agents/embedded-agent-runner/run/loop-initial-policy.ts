import { resolveSessionAgentIds } from "../../agent-scope.js";
import { isStrictAgenticExecutionContractActive } from "../../execution-contract.js";
import { claimQuotaContinuation, type QuotaContinuation } from "../quota-continuation.js";
import { CONTINUATION_PROMPT } from "./continuation-prompt.js";
import { resolveMaxRunRetryIterations } from "./helpers.js";
import type {
  RunEmbeddedAgentInternalParams,
  RunEmbeddedAgentParamsWithSessionFile,
} from "./internal-params.js";
import { createRunRetryBudget } from "./retry-budget.js";

export function prepareQuotaRunParams(
  input: RunEmbeddedAgentParamsWithSessionFile,
): RunEmbeddedAgentParamsWithSessionFile {
  const { quotaContinuation, ...params } = input;
  params.quotaBudget?.initialize(params.timeoutMs);
  if (!quotaContinuation) {
    return params;
  }
  const remaining = params.quotaBudget?.remainingMs(params.timeoutMs) ?? 0;
  if (remaining <= 0) {
    throw new Error("Quota continuation execution budget expired before preparation");
  }
  return { ...params, timeoutMs: remaining };
}

export async function claimQuotaRunParams(
  params: RunEmbeddedAgentParamsWithSessionFile,
  token: QuotaContinuation | undefined,
  harnessId: string,
  api: string,
): Promise<RunEmbeddedAgentParamsWithSessionFile> {
  if (!token) {
    return params;
  }
  await claimQuotaContinuation(token, params, harnessId, api);
  return {
    ...params,
    activeQuotaContinuation: token,
    prompt: CONTINUATION_PROMPT,
    transcriptPrompt: undefined,
    suppressNextUserMessagePersistence: true,
    skipPreparedUserTurnMessage: true,
  };
}

export function resolveEmbeddedLoopPolicy(
  params: RunEmbeddedAgentInternalParams,
  provider: string,
  modelId: string,
  profiles: number,
  token?: QuotaContinuation,
) {
  const { sessionKey, config, agentId } = params;
  const { sessionAgentId } = resolveSessionAgentIds({ sessionKey, config, agentId });
  const strictAgenticActive = isStrictAgenticExecutionContractActive({
    config,
    sessionKey,
    agentId,
    provider,
    modelId,
  });
  const executionContract = strictAgenticActive
    ? ("strict-agentic" as const)
    : ("default" as const);
  const retryLimit = resolveMaxRunRetryIterations(profiles);
  const runRetryBudget =
    token && params.quotaBudget
      ? params.quotaBudget.continueRetries(retryLimit)
      : createRunRetryBudget(retryLimit);
  params.quotaBudget?.observeRetries(runRetryBudget);
  return { sessionAgentId, strictAgenticActive, executionContract, runRetryBudget };
}
