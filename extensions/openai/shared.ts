import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createLazyRuntimeModule,
  createLazyRuntimeSurface,
} from "openclaw/plugin-sdk/lazy-runtime";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-metadata";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { classifyOpenAIBaseUrl, isOpenAICodexBaseUrl, OPENAI_API_BASE_URL } from "./base-url.js";
import { buildOpenAIReplayPolicy } from "./replay-policy.js";
import { TOKEN_SHARING_AUTH_FLOW } from "./token-sharing.js";
import { resolveOpenAITransportTurnState } from "./transport-policy.js";

export const OPENAI_DEFAULT_RUNTIME_CONTEXT_TOKENS = 272_000;

export function resolveConfiguredOpenAIBaseUrl(cfg: OpenClawConfig | undefined): string {
  return normalizeOptionalString(cfg?.models?.providers?.openai?.baseUrl) ?? OPENAI_API_BASE_URL;
}

type OpenAIResponsesProviderHooks = Pick<
  ProviderPlugin,
  | "buildReplayPolicy"
  | "prepareExtraParams"
  | "wrapStreamFn"
  | "wrapSimpleCompletionStreamFn"
  | "resolveTransportTurnState"
  | "isCacheTtlEligible"
>;

const loadResponsesStream = createLazyRuntimeModule(() => import("./responses-stream.runtime.js"));
const wrapOpenAIResponsesProviderStreamFn: NonNullable<
  OpenAIResponsesProviderHooks["wrapStreamFn"]
> = (ctx) => {
  // Catalog registration keeps synchronous hooks; StreamFn already permits async
  // startup, so transport and tool execution load only when the stream is invoked.
  const loadStream = createLazyRuntimeSurface(loadResponsesStream, (runtime) =>
    runtime.wrapOpenAIResponsesStream(ctx),
  );
  return async (...args) => (await loadStream())(...args);
};

export function buildOpenAIResponsesProviderHooks(options?: {
  transport?: "auto" | "sse" | "websocket" | "websocket-cached";
}): OpenAIResponsesProviderHooks {
  return {
    // Native OpenAI caching is automatic; custom routes must explicitly opt in.
    isCacheTtlEligible: ({ provider, baseUrl, supportsPromptCacheKey }) =>
      normalizeProviderId(provider) === "openai" &&
      (supportsPromptCacheKey ??
        (classifyOpenAIBaseUrl(baseUrl) === "platform" || isOpenAICodexBaseUrl(baseUrl))),
    buildReplayPolicy: buildOpenAIReplayPolicy,
    prepareExtraParams: ({ extraParams }) => {
      const transport = extraParams?.transport;
      return ["auto", "sse", "websocket", "websocket-cached"].some(
        (candidate) => candidate === transport,
      )
        ? extraParams
        : { ...extraParams, transport: options?.transport ?? "auto" };
    },
    wrapStreamFn: wrapOpenAIResponsesProviderStreamFn,
    wrapSimpleCompletionStreamFn: (ctx) =>
      ctx.auth?.mode === "oauth" && ctx.auth.authFlow === TOKEN_SHARING_AUTH_FLOW
        ? wrapOpenAIResponsesProviderStreamFn({
            ...ctx,
            // Isolated completions share credential policy but must remain tool-free.
            nativeWebSearchAllowedByToolPolicy: false,
          })
        : undefined,
    resolveTransportTurnState: resolveOpenAITransportTurnState,
  };
}
