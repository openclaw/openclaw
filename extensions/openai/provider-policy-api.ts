import type { ProviderDefaultThinkingPolicyContext } from "openclaw/plugin-sdk/plugin-entry";
// Openai API module exposes the plugin public contract.
import type { ModelApi, ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";
import {
  classifyOpenAIBaseUrl,
  OPENAI_API_BASE_URL,
  OPENAI_CODEX_RESPONSES_BASE_URL,
} from "./base-url.js";
import { resolveUnifiedOpenAIThinkingProfile } from "./thinking-policy.js";

const OPENAI_RESPONSES_API = "openai-responses";
const OPENAI_COMPLETIONS_API = "openai-completions";
const OPENAI_CHATGPT_RESPONSES_API = "openai-chatgpt-responses";
const OPENAI_AGENT_RUNTIME_ID = "openclaw";
const CODEX_AGENT_RUNTIME_ID = "codex";
// Explicit direct aliases excluded from the ChatGPT static catalog. Other
// manifest rows (including gpt-5.4-nano) remain valid observed ChatGPT routes.
const OPENAI_PLATFORM_ONLY_MODEL_IDS = new Set(["chat-latest", "gpt-5.6"]);

const OPENAI_GPT_53_CODEX_SPARK_MODEL_ID = "gpt-5.3-codex-spark";
const OPENAI_CODEX_ROUTABLE_MODEL_IDS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.4-codex",
  "gpt-5.4-pro",
  "gpt-5.4-mini",
  OPENAI_GPT_53_CODEX_SPARK_MODEL_ID,
] as const;
const OPENAI_SUBSCRIPTION_ONLY_MODEL_IDS = [OPENAI_GPT_53_CODEX_SPARK_MODEL_ID] as const;

const openAICodexRoutableModelIds = new Set<string>(OPENAI_CODEX_ROUTABLE_MODEL_IDS);
const openAISubscriptionOnlyModelIds = new Set<string>(OPENAI_SUBSCRIPTION_ONLY_MODEL_IDS);

type OpenAIModelRouteSource = {
  api?: ModelApi | null;
  baseUrl?: unknown;
};

type OpenAIModelRouteCandidate = {
  api: ModelApi;
  baseUrl: string;
  authRequirement: "api-key" | "subscription";
};

type OpenAIModelRouteResolution =
  | {
      kind: "routes";
      routes: readonly [OpenAIModelRouteCandidate, ...OpenAIModelRouteCandidate[]];
      defaultRuntimeId?: string;
    }
  | {
      kind: "incompatible";
      code:
        | "conflicting-official-openai-route"
        | "custom-chatgpt-relay-requires-configuration"
        | "invalid-openai-base-url"
        | "openai-route-provider-mismatch"
        | "platform-only-model-on-chatgpt"
        | "subscription-only-model-on-platform"
        | "unsupported-custom-openai-api"
        | "unsupported-official-openai-api";
      message: string;
    };

type OpenAIResolveModelRoutesContext = {
  provider: string;
  modelId?: string;
  configuredModel?: OpenAIModelRouteSource;
  configuredProvider?: OpenAIModelRouteSource;
  environment?: { baseUrl?: unknown };
  observed?: OpenAIModelRouteSource;
};

function normalizeOptionalRouteApi(value: ModelApi | null | undefined): ModelApi | undefined {
  return typeof value === "string" && value.trim() ? (value.trim() as ModelApi) : undefined;
}

function normalizeOptionalRouteBaseUrl(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeModelId(value: string | undefined): string {
  const trimmed = value?.trim().toLowerCase() ?? "";
  const slashIndex = trimmed.indexOf("/");
  return slashIndex > 0 && trimmed.slice(0, slashIndex) === "openai"
    ? trimmed.slice(slashIndex + 1)
    : trimmed;
}

/** True when OpenAI exposes this exact model on both Platform and ChatGPT. */
function isOpenAICodexRoutableModelId(value: string | undefined): boolean {
  return openAICodexRoutableModelIds.has(normalizeModelId(value));
}

function isOpenAISubscriptionOnlyModelId(value: string): boolean {
  return openAISubscriptionOnlyModelIds.has(value);
}

function firstRouteBaseUrl(...values: unknown[]): unknown {
  for (const value of values) {
    if (typeof value === "string") {
      if (value.trim()) {
        return value.trim();
      }
      continue;
    }
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function concreteBaseUrl(value: unknown, fallback: string): string {
  return normalizeOptionalRouteBaseUrl(value) ?? fallback;
}

function route(
  candidate: OpenAIModelRouteCandidate,
  defaultRuntimeId: string,
): OpenAIModelRouteResolution & { kind: "routes" } {
  return { kind: "routes", routes: [candidate], defaultRuntimeId };
}

/**
 * Resolves concrete OpenAI transports in provider-default order.
 *
 * Candidate order is not credential order. Callers must honor a locked profile,
 * provider auth, then auth.order before choosing a compatible candidate.
 */
export function resolveModelRoutes(
  context: OpenAIResolveModelRoutesContext,
): OpenAIModelRouteResolution {
  if (context.provider.trim().toLowerCase() !== "openai") {
    return {
      kind: "incompatible",
      code: "openai-route-provider-mismatch",
      message: `OpenAI route policy cannot resolve provider ${context.provider || "(empty)"}.`,
    };
  }
  const modelApi = normalizeOptionalRouteApi(context.configuredModel?.api);
  const providerApi = normalizeOptionalRouteApi(context.configuredProvider?.api);
  const modelBaseUrl = firstRouteBaseUrl(context.configuredModel?.baseUrl);
  const providerBaseUrl = firstRouteBaseUrl(context.configuredProvider?.baseUrl);
  const environmentBaseUrl = firstRouteBaseUrl(context.environment?.baseUrl);
  const observedApi = normalizeOptionalRouteApi(context.observed?.api);
  const observedBaseUrl = firstRouteBaseUrl(context.observed?.baseUrl);
  let effectiveApi: ModelApi | undefined;
  let effectiveBaseUrl: unknown;
  let configuredRoute = false;
  let customDefaultApi: ModelApi = OPENAI_COMPLETIONS_API;

  // Model facts override provider facts, which override the environment.
  // Observed rows are atomic fallback only; custom bases may inherit a lower
  // authored adapter without combining contradictory official transports.
  if (modelApi !== undefined || modelBaseUrl !== undefined) {
    configuredRoute = true;
    effectiveApi = modelApi;
    effectiveBaseUrl = modelBaseUrl;
    if (modelBaseUrl !== undefined && classifyOpenAIBaseUrl(modelBaseUrl) === "custom") {
      // Custom endpoint identity survives lower-level adapter inheritance.
      effectiveApi ??= providerApi;
    } else if (modelBaseUrl === undefined) {
      const lowerBaseUrl = providerBaseUrl ?? environmentBaseUrl;
      const lowerEndpointKind = classifyOpenAIBaseUrl(lowerBaseUrl);
      effectiveBaseUrl =
        lowerEndpointKind === "custom" || lowerEndpointKind === "invalid"
          ? lowerBaseUrl
          : undefined;
    }
  } else if (providerApi !== undefined || providerBaseUrl !== undefined) {
    configuredRoute = true;
    effectiveApi = providerApi;
    effectiveBaseUrl = providerBaseUrl;
    if (providerBaseUrl === undefined) {
      const environmentEndpointKind = classifyOpenAIBaseUrl(environmentBaseUrl);
      if (environmentEndpointKind === "custom" || environmentEndpointKind === "invalid") {
        effectiveBaseUrl = environmentBaseUrl;
      }
    }
  } else if (environmentBaseUrl !== undefined) {
    configuredRoute = true;
    effectiveBaseUrl = environmentBaseUrl;
    customDefaultApi = OPENAI_RESPONSES_API;
  } else {
    effectiveApi = observedApi;
    effectiveBaseUrl = observedBaseUrl;
  }
  const endpointKind = classifyOpenAIBaseUrl(effectiveBaseUrl);
  if (endpointKind === "invalid") {
    return {
      kind: "incompatible",
      code: "invalid-openai-base-url",
      message: "OpenAI model route baseUrl must be a non-empty URL string.",
    };
  }
  const chatGPTApi = effectiveApi?.toLowerCase() === OPENAI_CHATGPT_RESPONSES_API;
  const authoredChatGPTApi =
    modelApi?.toLowerCase() === OPENAI_CHATGPT_RESPONSES_API ||
    providerApi?.toLowerCase() === OPENAI_CHATGPT_RESPONSES_API;

  // A custom endpoint owns its protocol contract. Subscription egress always
  // requires authored ChatGPT intent; observed Platform adapters remain safe
  // API-key fallbacks for otherwise unspecified custom routes.
  if (endpointKind === "custom") {
    if (chatGPTApi && !authoredChatGPTApi) {
      return {
        kind: "incompatible",
        code: "custom-chatgpt-relay-requires-configuration",
        message: "Custom ChatGPT relays require an explicitly configured ChatGPT adapter.",
      };
    }
    // An independently authored custom endpoint may reuse only observed
    // Platform adapters. Requiring authored ChatGPT intent prevents a stale
    // catalog row from redirecting a subscription bearer to that endpoint.
    const observedPlatformApi =
      observedApi === OPENAI_RESPONSES_API || observedApi === OPENAI_COMPLETIONS_API
        ? observedApi
        : undefined;
    const customApi = effectiveApi ?? observedPlatformApi ?? customDefaultApi;
    if (
      customApi !== OPENAI_RESPONSES_API &&
      customApi !== OPENAI_COMPLETIONS_API &&
      customApi !== OPENAI_CHATGPT_RESPONSES_API
    ) {
      return {
        kind: "incompatible",
        code: "unsupported-custom-openai-api",
        message: `${customApi} is not an OpenAI-compatible model adapter.`,
      };
    }
    const customAuthRequirement =
      customApi.toLowerCase() === OPENAI_CHATGPT_RESPONSES_API ? "subscription" : "api-key";
    return route(
      {
        api: customApi,
        baseUrl: concreteBaseUrl(effectiveBaseUrl, OPENAI_API_BASE_URL),
        authRequirement: customAuthRequirement,
      },
      OPENAI_AGENT_RUNTIME_ID,
    );
  }

  if (
    (endpointKind === "platform" && chatGPTApi) ||
    (endpointKind === "chatgpt" && effectiveApi !== undefined && !chatGPTApi)
  ) {
    return {
      kind: "incompatible",
      code: "conflicting-official-openai-route",
      message: "OpenAI model API and baseUrl select different official transports.",
    };
  }

  if (
    effectiveApi !== undefined &&
    effectiveApi !== OPENAI_RESPONSES_API &&
    effectiveApi !== OPENAI_COMPLETIONS_API &&
    effectiveApi !== OPENAI_CHATGPT_RESPONSES_API
  ) {
    return {
      kind: "incompatible",
      code: "unsupported-official-openai-api",
      message: `${effectiveApi} is not an OpenAI Platform model adapter.`,
    };
  }

  const modelId = normalizeModelId(context.modelId);
  const platformRoute = {
    api: OPENAI_RESPONSES_API,
    baseUrl: OPENAI_API_BASE_URL,
    authRequirement: "api-key",
  } as const satisfies OpenAIModelRouteCandidate;
  const chatGPTRoute = {
    api: OPENAI_CHATGPT_RESPONSES_API,
    baseUrl: OPENAI_CODEX_RESPONSES_BASE_URL,
    authRequirement: "subscription",
  } as const satisfies OpenAIModelRouteCandidate;
  const platformOnly = OPENAI_PLATFORM_ONLY_MODEL_IDS.has(modelId);
  const subscriptionOnly = isOpenAISubscriptionOnlyModelId(modelId);
  const codexRoutable = isOpenAICodexRoutableModelId(modelId);

  // Observed catalog transport is not authored route intent. Known model
  // contracts stay stable regardless of which official sibling row was seen.
  if (!configuredRoute) {
    if (subscriptionOnly) {
      return route(chatGPTRoute, CODEX_AGENT_RUNTIME_ID);
    }
    if (platformOnly) {
      return route(platformRoute, OPENAI_AGENT_RUNTIME_ID);
    }
    if (codexRoutable) {
      return {
        kind: "routes",
        defaultRuntimeId: CODEX_AGENT_RUNTIME_ID,
        routes: [platformRoute, chatGPTRoute],
      };
    }
  }

  if (endpointKind === "chatgpt" || chatGPTApi) {
    if (platformOnly) {
      return {
        kind: "incompatible",
        code: "platform-only-model-on-chatgpt",
        message: `${modelId} is available only through OpenAI Platform API-key authentication.`,
      };
    }
    return route(chatGPTRoute, CODEX_AGENT_RUNTIME_ID);
  }

  if (subscriptionOnly) {
    return {
      kind: "incompatible",
      code: "subscription-only-model-on-platform",
      message: `${modelId} is available only through ChatGPT subscription authentication.`,
    };
  }

  return route(platformRoute, platformOnly ? OPENAI_AGENT_RUNTIME_ID : CODEX_AGENT_RUNTIME_ID);
}

export function normalizeConfig(params: { provider: string; providerConfig: ModelProviderConfig }) {
  return params.providerConfig;
}

export function resolveThinkingProfile(params: ProviderDefaultThinkingPolicyContext) {
  switch (params.provider.trim().toLowerCase()) {
    case "openai":
      return resolveUnifiedOpenAIThinkingProfile(
        params.modelId,
        params.agentRuntime,
        params.compat,
      );
    default:
      return null;
  }
}
