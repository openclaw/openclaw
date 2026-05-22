import type { ModelProviderConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type PluginManifestRegistry } from "./manifest-registry.js";
import type { ProviderApplyConfigDefaultsContext, ProviderNormalizeConfigContext, ProviderResolveConfigApiKeyContext } from "./provider-config-context.types.js";
import type { ProviderDefaultThinkingPolicyContext, ProviderThinkingProfile } from "./provider-thinking.types.js";
export type BundledProviderPolicySurface = {
    normalizeConfig?: (ctx: ProviderNormalizeConfigContext) => ModelProviderConfig | null | undefined;
    applyConfigDefaults?: (ctx: ProviderApplyConfigDefaultsContext) => OpenClawConfig | null | undefined;
    resolveConfigApiKey?: (ctx: ProviderResolveConfigApiKeyContext) => string | null | undefined;
    resolveThinkingProfile?: (ctx: ProviderDefaultThinkingPolicyContext) => ProviderThinkingProfile | null | undefined;
};
export declare function resolveBundledProviderPolicySurface(providerId: string, options?: {
    manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
}): BundledProviderPolicySurface | null;
