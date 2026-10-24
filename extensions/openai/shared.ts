import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createLazyRuntimeModule,
  createLazyRuntimeSurface,
} from "openclaw/plugin-sdk/lazy-runtime";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-metadata";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import {
  normalizeOptionalString,
  normalizeLowercaseStringOrEmpty,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  classifyOpenAIBaseUrl,
  isOpenAIApiBaseUrl,
  isOpenAICodexBaseUrl,
  OPENAI_API_BASE_URL,
} from "./base-url.js";
import { buildOpenAIReplayPolicy } from "./replay-policy.js";
import { TOKEN_SHARING_AUTH_FLOW } from "./token-sharing.js";

const DEFAULT_OPENAI_WS_DEGRADE_COOLDOWN_MS = 60_000;
const AZURE_PROVIDER_IDS = new Set(["azure-openai", "azure-openai-responses"]);

function isAzureOpenAIBaseUrl(baseUrl?: string): boolean {
  return normalizeLowercaseStringOrEmpty(URL.parse(baseUrl?.trim() ?? "")?.hostname).endsWith(
    ".openai.azure.com",
  );
}

function normalizeIdentityValue(value: string): string {
  return value
    .trim()
    .replace(/[\r\n]+/g, " ")
    .slice(0, 160);
}

function usesKnownNativeOpenAIRoute(provider: string, baseUrl?: string): boolean {
  const normalizedProvider = normalizeProviderId(provider);
  if (!normalizedProvider) {
    return false;
  }
  if (normalizedProvider === "openai") {
    return !baseUrl || isOpenAIApiBaseUrl(baseUrl) || isOpenAICodexBaseUrl(baseUrl);
  }
  if (AZURE_PROVIDER_IDS.has(normalizedProvider)) {
    return !baseUrl || isAzureOpenAIBaseUrl(baseUrl);
  }
  return false;
}

export const OPENAI_DEFAULT_RUNTIME_CONTEXT_TOKENS = 272_000;
export const OPENAI_CODEX_GPT_61_SOL_CONTEXT_TOKENS = 500_000;

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
    resolveTransportTurnState: (ctx) => {
      if (!usesKnownNativeOpenAIRoute(ctx.provider, ctx.model?.baseUrl)) {
        return undefined;
      }
      const sessionId = ctx.sessionId ? normalizeIdentityValue(ctx.sessionId) : undefined;
      const sessionHeaders = sessionId
        ? { "x-client-request-id": sessionId, "x-openclaw-session-id": sessionId }
        : undefined;
      if (!sessionHeaders) {
        return ctx.transport === "websocket"
          ? { websocket: { degradeCooldownMs: DEFAULT_OPENAI_WS_DEGRADE_COOLDOWN_MS } }
          : undefined;
      }

      const turnId = normalizeIdentityValue(ctx.turnId);
      const attempt = String(Math.max(1, ctx.attempt));

      return {
        headers: {
          ...sessionHeaders,
          "x-openclaw-turn-id": turnId,
          "x-openclaw-turn-attempt": attempt,
        },
        metadata: {
          openclaw_session_id: sessionHeaders["x-openclaw-session-id"] ?? "",
          openclaw_turn_id: turnId,
          openclaw_turn_attempt: attempt,
          openclaw_transport: ctx.transport,
        },
        ...(ctx.transport === "websocket"
          ? {
              websocket: {
                headers: sessionHeaders,
                degradeCooldownMs: DEFAULT_OPENAI_WS_DEGRADE_COOLDOWN_MS,
              },
            }
          : {}),
      };
    },
  };
}
