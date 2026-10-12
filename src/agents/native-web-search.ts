import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { resolveProviderPolicySurface } from "../plugins/provider-public-artifacts.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { resolveCodexNativeSearchActivation } from "./codex-native-web-search-core.js";
import {
  resolveWebSearchToolPolicy,
  type WebSearchToolPolicyParams,
} from "./web-search-tool-policy.js";

export type NativeWebSearchRoute =
  | { kind: "native"; provider: string; transport: string }
  | { kind: "managed" }
  | { kind: "disabled"; reason: "globally_disabled" | "tool_policy_denied" };

/** Resolves embedded hosted search before tools enter discovery or Code Mode. */
export function resolveNativeWebSearchRoute(
  params: WebSearchToolPolicyParams & {
    modelApi?: string;
    modelBaseUrl?: string;
    agentDir?: string;
    authStore?: AuthProfileStore;
    pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "manifestRegistry">;
  },
): NativeWebSearchRoute {
  if (params.webSearchEnabled === false || params.config?.tools?.web?.search?.enabled === false) {
    return { kind: "disabled", reason: "globally_disabled" };
  }
  if (!resolveWebSearchToolPolicy(params).allowed) {
    return { kind: "disabled", reason: "tool_policy_denied" };
  }
  const provider = params.modelProvider;
  if (
    provider &&
    params.modelApi &&
    resolveProviderPolicySurface(provider, {
      config: params.config,
      manifestRegistry: params.pluginMetadataSnapshot?.manifestRegistry,
    })?.resolveNativeWebSearch?.({
      config: params.config,
      provider,
      modelId: params.modelId,
      api: params.modelApi,
      baseUrl: params.modelBaseUrl ?? params.config?.models?.providers?.[provider]?.baseUrl,
    })
  ) {
    return { kind: "native", provider, transport: params.modelApi };
  }
  if (resolveCodexNativeSearchActivation(params).state === "native_active") {
    return { kind: "native", provider: "openai", transport: "openai-chatgpt-responses" };
  }
  return { kind: "managed" };
}
