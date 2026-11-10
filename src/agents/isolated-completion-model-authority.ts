import { supportsOpenAITemperature } from "@openclaw/ai/internal/openai";
import { adjustMaxTokensForThinking } from "@openclaw/ai/internal/shared";
import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { Model } from "../llm/types.js";
import { assertProviderAuthAuthority } from "../plugins/provider-auth-authority.js";
import {
  bindOperatorModelExecution,
  type AdmittedRunOperatorAuthority,
} from "./admitted-run-context.js";
import type {
  AgentHarness,
  AgentHarnessIsolatedCompletionParamsV2,
  AgentHarnessIsolatedCompletionAuthorization,
} from "./harness/types.js";
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
  // Native harnesses build their own request body, so apply the transport temperature gate here.
  const supported =
    model && streamParams?.temperature !== undefined && !supportsOpenAITemperature(model)
      ? { maxTokens: streamParams.maxTokens }
      : streamParams;
  let maxTokens = answerTokenBudget ?? supported?.maxTokens;
  if (maxTokens === undefined) {
    return supported;
  }
  const modelMaxTokens = model?.maxTokens ?? Number.POSITIVE_INFINITY;
  if (answerTokenBudget !== undefined && model?.reasoning && thinkLevel !== "off") {
    maxTokens = adjustMaxTokensForThinking(answerTokenBudget, modelMaxTokens, "medium").maxTokens;
  }
  return {
    ...supported,
    maxTokens: Math.min(maxTokens, modelMaxTokens, supported?.maxTokens ?? maxTokens),
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
    bind(
      model: ModelRef | undefined,
      authorization?: AgentHarnessIsolatedCompletionAuthorization,
    ): { abortSignal?: AbortSignal; assertCurrent: () => void } {
      const assertCurrent = () => {
        params.assertCurrent();
        if (authorization?.owner === "host") {
          assertProviderAuthAuthority(authorization.auth);
        }
      };
      assertCurrent();
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
          return { assertCurrent };
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
          assertCurrent();
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
