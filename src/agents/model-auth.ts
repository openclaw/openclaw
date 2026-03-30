import path from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import { formatCliCommand } from "../cli/command-format.js";
import {
	getRuntimeConfigSnapshot,
	type OpenClawConfig,
} from "../config/config.js";
import type {
	ModelProviderAuthMode,
	ModelProviderConfig,
} from "../config/types.js";
import { coerceSecretRef } from "../config/types.secrets.js";
import { getShellEnvAppliedKeys } from "../infra/shell-env.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
	buildProviderMissingAuthMessageWithPlugin,
	resolveProviderSyntheticAuthWithPlugin,
} from "../plugins/provider-runtime.js";
import { resolveOwningPluginIdsForProvider } from "../plugins/providers.js";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
import {
	type AuthProfileStore,
	ensureAuthProfileStore,
	listProfilesForProvider,
	resolveApiKeyForProfile,
	resolveAuthProfileOrder,
	resolveAuthStorePathForDisplay,
} from "./auth-profiles.js";
import { resolveEnvApiKey } from "./model-auth-env.js";
import {
	CUSTOM_LOCAL_AUTH_MARKER,
	isKnownEnvApiKeyMarker,
	isNonSecretApiKeyMarker,
	NON_ENV_SECRETREF_MARKER,
} from "./model-auth-markers.js";
import type { ResolvedProviderAuth } from "./model-auth-runtime-shared.js";
import { normalizeProviderId } from "./model-selection.js";

export {
	ensureAuthProfileStore,
	resolveAuthProfileOrder,
} from "./auth-profiles.js";
export type { ResolvedProviderAuth } from "./model-auth-runtime-shared.js";
export {
	requireApiKey,
	resolveAwsSdkEnvVarName,
} from "./model-auth-runtime-shared.js";

const log = createSubsystemLogger("model-auth");
function resolveProviderConfig(
	cfg: OpenClawConfig | undefined,
	provider: string,
): ModelProviderConfig | undefined {
	const providers = cfg?.models?.providers ?? {};
	const direct = providers[provider] as ModelProviderConfig | undefined;
	if (direct) {
		return direct;
	}
	const normalized = normalizeProviderId(provider);
	if (normalized === provider) {
		const matched = Object.entries(providers).find(
			([key]) => normalizeProviderId(key) === normalized,
		);
		return matched?.[1];
	}
	return (
		(providers[normalized] as ModelProviderConfig | undefined) ??
		Object.entries(providers).find(
			([key]) => normalizeProviderId(key) === normalized,
		)?.[1]
	);
}

export function getCustomProviderApiKey(
	cfg: OpenClawConfig | undefined,
	provider: string,
): string | undefined {
	const entry = resolveProviderConfig(cfg, provider);
	return normalizeOptionalSecretInput(entry?.apiKey);
}

type ResolvedCustomProviderApiKey = {
	apiKey: string;
	source: string;
};

export function resolveUsableCustomProviderApiKey(params: {
	cfg: OpenClawConfig | undefined;
	provider: string;
	env?: NodeJS.ProcessEnv;
}): ResolvedCustomProviderApiKey | null {
	const customKey = getCustomProviderApiKey(params.cfg, params.provider);
	if (!customKey) {
		return null;
	}
	if (!isNonSecretApiKeyMarker(customKey)) {
		return { apiKey: customKey, source: "models.json" };
	}
	if (!isKnownEnvApiKeyMarker(customKey)) {
		return null;
	}
	const envValue = normalizeOptionalSecretInput(
		(params.env ?? process.env)[customKey],
	);
	if (!envValue) {
		return null;
	}
	const applied = new Set(getShellEnvAppliedKeys());
	return {
		apiKey: envValue,
		source: resolveEnvSourceLabel({
			applied,
			envVars: [customKey],
			label: `${customKey} (models.json marker)`,
		}),
	};
}

export function hasUsableCustomProviderApiKey(
	cfg: OpenClawConfig | undefined,
	provider: string,
	env?: NodeJS.ProcessEnv,
): boolean {
	return Boolean(resolveUsableCustomProviderApiKey({ cfg, provider, env }));
}

function resolveProviderAuthOverride(
	cfg: OpenClawConfig | undefined,
	provider: string,
): ModelProviderAuthMode | undefined {
	const entry = resolveProviderConfig(cfg, provider);
	const auth = entry?.auth;
	if (
		auth === "api-key" ||
		auth === "aws-sdk" ||
		auth === "oauth" ||
		auth === "token"
	) {
		return auth;
	}
	return undefined;
}

function isLocalBaseUrl(baseUrl: string): boolean {
	try {
		const host = new URL(baseUrl).hostname.toLowerCase();
		return (
			host === "localhost" ||
			host === "127.0.0.1" ||
			host === "0.0.0.0" ||
			host === "[::1]" ||
			host === "[::ffff:7f00:1]" ||
			host === "[::ffff:127.0.0.1]"
		);
	} catch {
		return false;
	}
}

function hasExplicitProviderApiKeyConfig(
	providerConfig: ModelProviderConfig,
): boolean {
	return (
		normalizeOptionalSecretInput(providerConfig.apiKey) !== undefined ||
		coerceSecretRef(providerConfig.apiKey) !== null
	);
}

function isCustomLocalProviderConfig(
	providerConfig: ModelProviderConfig,
): boolean {
	return (
		typeof providerConfig.baseUrl === "string" &&
		providerConfig.baseUrl.trim().length > 0 &&
		typeof providerConfig.api === "string" &&
		providerConfig.api.trim().length > 0 &&
		Array.isArray(providerConfig.models) &&
		providerConfig.models.length > 0
	);
}

function isManagedSecretRefApiKeyMarker(apiKey: string | undefined): boolean {
	return apiKey?.trim() === NON_ENV_SECRETREF_MARKER;
}

type SyntheticProviderAuthResolution = {
	auth?: ResolvedProviderAuth;
	blockedOnManagedSecretRef?: boolean;
};

function resolveProviderSyntheticRuntimeAuth(params: {
	cfg: OpenClawConfig | undefined;
	provider: string;
}): SyntheticProviderAuthResolution {
	const resolveFromConfig = (
		config: OpenClawConfig | undefined,
	): ResolvedProviderAuth | undefined => {
		const providerConfig = resolveProviderConfig(config, params.provider);
		return resolveProviderSyntheticAuthWithPlugin({
			provider: params.provider,
			config,
			context: {
				config,
				provider: params.provider,
				providerConfig,
			},
		});
	};

	const directAuth = resolveFromConfig(params.cfg);
	if (!directAuth) {
		return {};
	}
	if (!isManagedSecretRefApiKeyMarker(directAuth.apiKey)) {
		return { auth: directAuth };
	}

	const runtimeConfig = getRuntimeConfigSnapshot();
	if (!runtimeConfig || runtimeConfig === params.cfg) {
		return { blockedOnManagedSecretRef: true };
	}

	const runtimeAuth = resolveFromConfig(runtimeConfig);
	const runtimeApiKey = runtimeAuth?.apiKey;
	if (
		!runtimeAuth ||
		!runtimeApiKey ||
		isNonSecretApiKeyMarker(runtimeApiKey)
	) {
		return { blockedOnManagedSecretRef: true };
	}
	return {
		auth: runtimeAuth,
	};
}

function resolveSyntheticLocalProviderAuth(params: {
	cfg: OpenClawConfig | undefined;
	provider: string;
}): ResolvedProviderAuth | null {
	const syntheticProviderAuth = resolveProviderSyntheticRuntimeAuth(params);
	if (syntheticProviderAuth.auth) {
		return syntheticProviderAuth.auth;
	}
	if (syntheticProviderAuth.blockedOnManagedSecretRef) {
		return null;
	}

	const providerConfig = resolveProviderConfig(params.cfg, params.provider);
	if (!providerConfig) {
		return null;
	}

	const hasApiConfig =
		Boolean(providerConfig.api?.trim()) ||
		Boolean(providerConfig.baseUrl?.trim()) ||
		(Array.isArray(providerConfig.models) && providerConfig.models.length > 0);
	if (!hasApiConfig) {
		return null;
	}

	const authOverride = resolveProviderAuthOverride(params.cfg, params.provider);
	if (authOverride && authOverride !== "api-key") {
		return null;
	}
	if (!isCustomLocalProviderConfig(providerConfig)) {
		return null;
	}
	if (hasExplicitProviderApiKeyConfig(providerConfig)) {
		return null;
	}

	// Custom providers pointing at a local server (e.g. llama.cpp, vLLM, LocalAI)
	// typically don't require auth. Synthesize a local key so the auth resolver
	// doesn't reject them when the user left the API key blank during setup.
	if (providerConfig.baseUrl && isLocalBaseUrl(providerConfig.baseUrl)) {
		return {
			apiKey: CUSTOM_LOCAL_AUTH_MARKER,
			source: `models.providers.${params.provider} (synthetic local key)`,
			mode: "api-key",
		};
	}

	return null;
}

function resolveEnvSourceLabel(params: {
	applied: Set<string>;
	envVars: string[];
	label: string;
}): string {
	const shellApplied = params.envVars.some((envVar) =>
		params.applied.has(envVar),
	);
	const prefix = shellApplied ? "shell env: " : "env: ";
	return `${prefix}${params.label}`;
}

function resolveAwsSdkAuthInfo(): { mode: "aws-sdk"; source: string } {
	const applied = new Set(getShellEnvAppliedKeys());
	if (process.env.AWS_BEARER_TOKEN_BEDROCK?.trim()) {
		return {
			mode: "aws-sdk",
			source: resolveEnvSourceLabel({
				applied,
				envVars: ["AWS_BEARER_TOKEN_BEDROCK"],
				label: "AWS_BEARER_TOKEN_BEDROCK",
			}),
		};
	}
	if (
		process.env.AWS_ACCESS_KEY_ID?.trim() &&
		process.env.AWS_SECRET_ACCESS_KEY?.trim()
	) {
		return {
			mode: "aws-sdk",
			source: resolveEnvSourceLabel({
				applied,
				envVars: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
				label: "AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY",
			}),
		};
	}
	if (process.env.AWS_PROFILE?.trim()) {
		return {
			mode: "aws-sdk",
			source: resolveEnvSourceLabel({
				applied,
				envVars: ["AWS_PROFILE"],
				label: "AWS_PROFILE",
			}),
		};
	}
	return { mode: "aws-sdk", source: "aws-sdk default chain" };
}

export async function resolveApiKeyForProvider(params: {
	provider: string;
	cfg?: OpenClawConfig;
	profileId?: string;
	preferredProfile?: string;
	store?: AuthProfileStore;
	agentDir?: string;
}): Promise<ResolvedProviderAuth> {
	const { provider, cfg, profileId, preferredProfile } = params;
	const store = params.store ?? ensureAuthProfileStore(params.agentDir);

	if (profileId) {
		const resolved = await resolveApiKeyForProfile({
			cfg,
			store,
			profileId,
			agentDir: params.agentDir,
		});
		if (!resolved) {
			throw new Error(`No credentials found for profile "${profileId}".`);
		}
		const mode = store.profiles[profileId]?.type;
		return {
			apiKey: resolved.apiKey,
			profileId,
			source: `profile:${profileId}`,
			mode: mode === "oauth" ? "oauth" : mode === "token" ? "token" : "api-key",
		};
	}

	const authOverride = resolveProviderAuthOverride(cfg, provider);
	if (authOverride === "aws-sdk") {
		return resolveAwsSdkAuthInfo();
	}

	const order = resolveAuthProfileOrder({
		cfg,
		store,
		provider,
		preferredProfile,
	});
	for (const candidate of order) {
		try {
			const resolved = await resolveApiKeyForProfile({
				cfg,
				store,
				profileId: candidate,
				agentDir: params.agentDir,
			});
			if (resolved) {
				const mode = store.profiles[candidate]?.type;
				const resolvedMode: ResolvedProviderAuth["mode"] =
					mode === "oauth" ? "oauth" : mode === "token" ? "token" : "api-key";
				const result: ResolvedProviderAuth = {
					apiKey: resolved.apiKey,
					profileId: candidate,
					source: `profile:${candidate}`,
					mode: resolvedMode,
				};
				return result;
			}
		} catch (err) {
			log.debug?.(
				`auth profile "${candidate}" failed for provider "${provider}": ${String(err)}`,
			);
		}
	}

	const envResolved = resolveEnvApiKey(provider);
	if (envResolved) {
		const resolvedMode: ResolvedProviderAuth["mode"] =
			envResolved.source.includes("OAUTH_TOKEN") ? "oauth" : "api-key";
		const result: ResolvedProviderAuth = {
			apiKey: envResolved.apiKey,
			source: envResolved.source,
			mode: resolvedMode,
		};
		return result;
	}

	const customKey = resolveUsableCustomProviderApiKey({ cfg, provider });
	if (customKey) {
		const result = {
			apiKey: customKey.apiKey,
			source: customKey.source,
			mode: "api-key" as const,
		};
		return result;
	}

	const syntheticLocalAuth = resolveSyntheticLocalProviderAuth({
		cfg,
		provider,
	});
	if (syntheticLocalAuth) {
		return syntheticLocalAuth;
	}

	const normalized = normalizeProviderId(provider);
	if (authOverride === undefined && normalized === "amazon-bedrock") {
		return resolveAwsSdkAuthInfo();
	}

	const providerConfig = resolveProviderConfig(cfg, provider);
	const hasInlineConfiguredModels =
		Array.isArray(providerConfig?.models) && providerConfig.models.length > 0;
	const owningPluginIds = !hasInlineConfiguredModels
		? resolveOwningPluginIdsForProvider({
				provider,
				config: cfg,
			})
		: undefined;
	if (owningPluginIds?.length) {
		const pluginMissingAuthMessage = buildProviderMissingAuthMessageWithPlugin({
			provider,
			config: cfg,
			context: {
				config: cfg,
				agentDir: params.agentDir,
				env: process.env,
				provider,
				listProfileIds: (providerId) =>
					listProfilesForProvider(store, providerId),
			},
		});
		if (pluginMissingAuthMessage) {
			throw new Error(pluginMissingAuthMessage);
		}
	}

	const authStorePath = resolveAuthStorePathForDisplay(params.agentDir);
	const resolvedAgentDir = path.dirname(authStorePath);
	throw new Error(
		[
			`No API key found for provider "${provider}".`,
			`Auth store: ${authStorePath} (agentDir: ${resolvedAgentDir}).`,
			`Configure auth for this agent (${formatCliCommand("openclaw agents add <id>")}) or copy auth-profiles.json from the main agentDir.`,
		].join(" "),
	);
}

export type ModelAuthMode =
	| "api-key"
	| "oauth"
	| "token"
	| "mixed"
	| "aws-sdk"
	| "unknown";

export type { EnvApiKeyResult } from "./model-auth-env.js";
export { resolveEnvApiKey } from "./model-auth-env.js";

export function resolveModelAuthMode(
	provider?: string,
	cfg?: OpenClawConfig,
	store?: AuthProfileStore,
): ModelAuthMode | undefined {
	const resolved = provider?.trim();
	if (!resolved) {
		return undefined;
	}

	const authOverride = resolveProviderAuthOverride(cfg, resolved);
	if (authOverride === "aws-sdk") {
		return "aws-sdk";
	}

	const authStore = store ?? ensureAuthProfileStore();
	const profiles = listProfilesForProvider(authStore, resolved);
	if (profiles.length > 0) {
		const modes = new Set(
			profiles
				.map((id) => authStore.profiles[id]?.type)
				.filter((mode): mode is "api_key" | "oauth" | "token" => Boolean(mode)),
		);
		const distinct = ["oauth", "token", "api_key"].filter((k) =>
			modes.has(k as "oauth" | "token" | "api_key"),
		);
		if (distinct.length >= 2) {
			return "mixed";
		}
		if (modes.has("oauth")) {
			return "oauth";
		}
		if (modes.has("token")) {
			return "token";
		}
		if (modes.has("api_key")) {
			return "api-key";
		}
	}

	if (
		authOverride === undefined &&
		normalizeProviderId(resolved) === "amazon-bedrock"
	) {
		return "aws-sdk";
	}

	const envKey = resolveEnvApiKey(resolved);
	if (envKey?.apiKey) {
		return envKey.source.includes("OAUTH_TOKEN") ? "oauth" : "api-key";
	}

	if (hasUsableCustomProviderApiKey(cfg, resolved)) {
		return "api-key";
	}

	return "unknown";
}

export async function hasAvailableAuthForProvider(params: {
	provider: string;
	cfg?: OpenClawConfig;
	preferredProfile?: string;
	store?: AuthProfileStore;
	agentDir?: string;
}): Promise<boolean> {
	const { provider, cfg, preferredProfile } = params;
	const store = params.store ?? ensureAuthProfileStore(params.agentDir);

	const authOverride = resolveProviderAuthOverride(cfg, provider);
	if (authOverride === "aws-sdk") {
		return true;
	}

	const order = resolveAuthProfileOrder({
		cfg,
		store,
		provider,
		preferredProfile,
	});
	for (const candidate of order) {
		try {
			const resolved = await resolveApiKeyForProfile({
				cfg,
				store,
				profileId: candidate,
				agentDir: params.agentDir,
			});
			if (resolved) {
				return true;
			}
		} catch (err) {
			log.debug?.(
				`auth profile "${candidate}" failed for provider "${provider}": ${String(err)}`,
			);
		}
	}

	if (resolveEnvApiKey(provider)) {
		return true;
	}
	if (resolveUsableCustomProviderApiKey({ cfg, provider })) {
		return true;
	}
	if (resolveSyntheticLocalProviderAuth({ cfg, provider })) {
		return true;
	}

	return (
		authOverride === undefined &&
		normalizeProviderId(provider) === "amazon-bedrock"
	);
}

export async function getApiKeyForModel(params: {
	model: Model<Api>;
	cfg?: OpenClawConfig;
	profileId?: string;
	preferredProfile?: string;
	store?: AuthProfileStore;
	agentDir?: string;
}): Promise<ResolvedProviderAuth> {
	return resolveApiKeyForProvider({
		provider: params.model.provider,
		cfg: params.cfg,
		profileId: params.profileId,
		preferredProfile: params.preferredProfile,
		store: params.store,
		agentDir: params.agentDir,
	});
}

export function applyLocalNoAuthHeaderOverride<T extends Model<Api>>(
	model: T,
	auth: ResolvedProviderAuth | null | undefined,
): T {
	if (
		auth?.apiKey !== CUSTOM_LOCAL_AUTH_MARKER ||
		model.api !== "openai-completions"
	) {
		return model;
	}

	// OpenAI's SDK always generates Authorization from apiKey. Keep the non-secret
	// placeholder so construction succeeds, then clear the header at request build
	// time for local servers that intentionally do not require auth.
	const headers = {
		...model.headers,
		Authorization: null,
	} as unknown as Record<string, string>;

	return {
		...model,
		headers,
	};
}
