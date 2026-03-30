import {
	applyProviderNativeStreamingUsageCompatWithPlugin,
	normalizeProviderConfigWithPlugin,
	resolveProviderConfigApiKeyWithPlugin,
	resolveProviderRuntimePlugin,
} from "../plugins/provider-runtime.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

export function applyNativeStreamingUsageCompat(
	providers: Record<string, ProviderConfig>,
): Record<string, ProviderConfig> {
	let changed = false;
	const nextProviders: Record<string, ProviderConfig> = {};

	for (const [providerKey, provider] of Object.entries(providers)) {
		const nextProvider =
			applyProviderNativeStreamingUsageCompatWithPlugin({
				provider: providerKey,
				context: {
					provider: providerKey,
					providerConfig: provider,
				},
			}) ?? provider;
		nextProviders[providerKey] = nextProvider;
		changed ||= nextProvider !== provider;
	}

	return changed ? nextProviders : providers;
}

export function normalizeProviderSpecificConfig(
	providerKey: string,
	provider: ProviderConfig,
): ProviderConfig {
	return (
		normalizeProviderConfigWithPlugin({
			provider: providerKey,
			context: {
				provider: providerKey,
				providerConfig: provider,
			},
		}) ?? provider
	);
}

export function resolveProviderConfigApiKeyResolver(
	providerKey: string,
): ((env: NodeJS.ProcessEnv) => string | undefined) | undefined {
	if (
		!resolveProviderRuntimePlugin({ provider: providerKey })
			?.resolveConfigApiKey
	) {
		return undefined;
	}
	return (env) => {
		const resolved = resolveProviderConfigApiKeyWithPlugin({
			provider: providerKey,
			env,
			context: {
				provider: providerKey,
				env,
			},
		});
		return resolved?.trim() || undefined;
	};
}
