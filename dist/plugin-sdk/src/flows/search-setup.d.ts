import type { SecretInputMode } from "../commands/onboard-types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type SecretInput } from "../config/types.secrets.js";
import type { PluginWebSearchProviderEntry } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
export type SearchProvider = NonNullable<NonNullable<NonNullable<NonNullable<OpenClawConfig["tools"]>["web"]>["search"]>["provider"]>;
export declare function listSearchProviderOptions(config?: OpenClawConfig): readonly PluginWebSearchProviderEntry[];
export declare function resolveSearchProviderOptions(config?: OpenClawConfig): readonly PluginWebSearchProviderEntry[];
export declare function hasKeyInEnv(entry: Pick<PluginWebSearchProviderEntry, "envVars">): boolean;
export declare function resolveExistingKey(config: OpenClawConfig, provider: SearchProvider): string | undefined;
export declare function hasExistingKey(config: OpenClawConfig, provider: SearchProvider): boolean;
export declare function applySearchKey(config: OpenClawConfig, provider: SearchProvider, key: SecretInput): OpenClawConfig;
export declare function applySearchProviderSelection(config: OpenClawConfig, provider: SearchProvider): OpenClawConfig;
export type SetupSearchOptions = {
    quickstartDefaults?: boolean;
    secretInputMode?: SecretInputMode;
};
export declare function runSearchSetupFlow(config: OpenClawConfig, runtime: RuntimeEnv, prompter: WizardPrompter, opts?: SetupSearchOptions): Promise<OpenClawConfig>;
