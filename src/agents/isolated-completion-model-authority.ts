import { adjustMaxTokensForThinking } from "@openclaw/ai/internal/shared";
import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { Model } from "../llm/types.js";
import {
  bindOperatorModelExecution,
  type AdmittedRunOperatorAuthority,
} from "./admitted-run-context.js";
import type { AgentHarness, AgentHarnessIsolatedCompletionParamsV2 } from "./harness/types.js";
import type { ModelRef } from "./model-ref-shared.js";
import {
  unwrapModelHeaderSentinelsForProviderEgress,
  unwrapSecretSentinelsForProviderEgress,
} from "./provider-secret-egress.js";

export type AgentHarnessIsolatedCompletionParams = Parameters<
  NonNullable<AgentHarness["runIsolatedCompletion"]>
>[0];

export function resolveIsolatedStreamParams(
  {
    answerTokenBudget,
    streamParams,
    thinkLevel,
  }: {
    answerTokenBudget?: number;
    streamParams?: AgentHarnessIsolatedCompletionParamsV2["streamParams"];
    thinkLevel?: ThinkLevel;
  },
  model?: Model,
): AgentHarnessIsolatedCompletionParamsV2["streamParams"] {
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

/** A completion keeps its selected-model fence through the runtime's physical cleanup. */
export function createIsolatedCompletionModelAuthority(params: {
  operatorAuthority?: AdmittedRunOperatorAuthority;
  mapOperatorAuthorizationError?: (error: unknown) => Error;
  abortSignal?: AbortSignal;
  assertCurrent: () => void;
  runtime: AsyncDisposable;
}) {
  const resources = new AsyncDisposableStack();
  let bound:
    | {
        model: ModelRef | undefined;
        execution: NonNullable<ReturnType<typeof bindOperatorModelExecution>>;
      }
    | undefined;
  return {
    bind(model: ModelRef | undefined): { abortSignal?: AbortSignal; assertCurrent?: () => void } {
      params.assertCurrent();
      if (
        !bound ||
        bound.model?.provider !== model?.provider ||
        bound.model?.model !== model?.model
      ) {
        const execution = bindOperatorModelExecution(
          params.operatorAuthority,
          model,
          params.mapOperatorAuthorizationError,
        );
        if (!execution) {
          return {};
        }
        resources.defer(execution.release);
        bound = { model: model ? { ...model } : undefined, execution };
      }
      const { execution } = bound;
      execution.assertCurrent();
      return {
        abortSignal: params.abortSignal
          ? AbortSignal.any([params.abortSignal, execution.signal])
          : execution.signal,
        assertCurrent: () => {
          params.assertCurrent();
          execution.assertCurrent();
        },
      };
    },
    async release() {
      try {
        await params.runtime[Symbol.asyncDispose]();
      } finally {
        await resources.disposeAsync();
      }
    },
  };
}
