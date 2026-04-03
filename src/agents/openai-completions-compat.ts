import type { ProviderEndpointClass, ProviderRequestCapabilities } from "./provider-attribution.js";

type OpenAICompletionsCompatDefaultsInput = {
  provider?: string;
  endpointClass: ProviderEndpointClass;
  knownProviderFamily: string;
  usesExplicitProxyLikeEndpoint?: boolean;
};

export type OpenAICompletionsCompatDefaults = {
  supportsStore: boolean;
  supportsDeveloperRole: boolean;
  supportsReasoningEffort: boolean;
  supportsUsageInStreaming: boolean;
  supportsStrictMode: boolean;
};

function isDefaultRouteProvider(provider: string | undefined, ...ids: string[]) {
  return provider !== undefined && ids.includes(provider);
}

export function resolveOpenAICompletionsCompatDefaults(
  input: OpenAICompletionsCompatDefaultsInput,
): OpenAICompletionsCompatDefaults {
  const { endpointClass, knownProviderFamily, usesExplicitProxyLikeEndpoint = false } = input;
  const isDefaultRoute = endpointClass === "default";
  const usesConfiguredNonOpenAIEndpoint =
    endpointClass !== "default" && endpointClass !== "openai-public";
  const isMoonshotLike =
    knownProviderFamily === "moonshot" ||
    knownProviderFamily === "modelstudio" ||
    endpointClass === "moonshot-native" ||
    endpointClass === "modelstudio-native";
  const isZai =
    endpointClass === "zai-native" ||
    (isDefaultRoute && isDefaultRouteProvider(input.provider, "zai"));
  const isNonStandard =
    endpointClass === "cerebras-native" ||
    endpointClass === "chutes-native" ||
    endpointClass === "deepseek-native" ||
    endpointClass === "mistral-public" ||
    endpointClass === "opencode-native" ||
    endpointClass === "xai-native" ||
    isZai ||
    (isDefaultRoute &&
      isDefaultRouteProvider(input.provider, "cerebras", "chutes", "deepseek", "opencode", "xai"));

  return {
    supportsStore:
      !isNonStandard && knownProviderFamily !== "mistral" && !usesExplicitProxyLikeEndpoint,
    supportsDeveloperRole: !isNonStandard && !isMoonshotLike && !usesConfiguredNonOpenAIEndpoint,
    supportsReasoningEffort:
      !isZai &&
      knownProviderFamily !== "mistral" &&
      endpointClass !== "xai-native" &&
      !usesExplicitProxyLikeEndpoint,
    supportsUsageInStreaming: !isNonStandard && !usesConfiguredNonOpenAIEndpoint,
    supportsStrictMode: !isZai && !usesConfiguredNonOpenAIEndpoint,
  };
}

export function resolveOpenAICompletionsCompatDefaultsFromCapabilities(
  input: Pick<
    ProviderRequestCapabilities,
    "endpointClass" | "knownProviderFamily" | "usesExplicitProxyLikeEndpoint"
  > & {
    provider?: string;
  },
): OpenAICompletionsCompatDefaults {
  return resolveOpenAICompletionsCompatDefaults(input);
}
