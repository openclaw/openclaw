import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { s as normalizePluginsConfig } from "./config-state-CjJBf8PG.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { a as resolveProviderAuthEnvVarCandidates } from "./provider-env-vars-HpAfBQBJ.js";
import "./config-B6Oplu5W.js";
import { s as loadManifestMetadataSnapshot } from "./manifest-contract-eligibility-LkT7g78Y.js";
import { i as passesManifestOwnerBasePolicy, n as isActivatedManifestOwner } from "./manifest-owner-policy-DqV-lgQl.js";
import { L as resolveProviderUsageAuthWithPlugin, R as resolveProviderUsageSnapshotWithPlugin } from "./provider-runtime-D8jQEgmu.js";
import { i as ensureAuthProfileStoreWithoutExternalProfiles, n as ensureAuthProfileStore } from "./store-BMQkMM4l.js";
import { t as hasAnyAuthProfileStoreSource } from "./source-check-BMw3fGLx.js";
import { u as isNonSecretApiKeyMarker } from "./model-auth-markers-Cf78z2Zm.js";
import "./model-selection-P-81eBKx.js";
import { n as normalizeSecretInput } from "./normalize-secret-input-CsdRhsMj.js";
import { t as resolveEnvApiKey } from "./model-auth-env-CZ-LXyVa.js";
import "./auth-profiles-D6NMnufG.js";
import { n as resolveApiKeyForProfile } from "./oauth--yqMDDjF.js";
import { n as listProfilesForProvider, t as dedupeProfileIds } from "./profile-list-C0HtPlut.js";
import { i as resolveAuthProfileOrder } from "./order-DJrj83KE.js";
import { f as resolveUsableCustomProviderApiKey } from "./model-auth-Db-JGIrg.js";
import { t as resolveFetch } from "./fetch-CN0jBepr.js";
import { a as resolveLegacyPiAgentAccessToken, c as withTimeout, i as ignoredErrors, n as PROVIDER_LABELS, r as clampPercent, s as usageProviders } from "./provider-usage.shared-Dk5t9Xpy.js";
//#region src/infra/provider-usage.format.ts
function formatResetRemaining(targetMs, now) {
	if (!targetMs) return null;
	const diffMs = targetMs - (now ?? Date.now());
	if (diffMs <= 0) return "now";
	const diffMins = Math.floor(diffMs / 6e4);
	if (diffMins < 60) return `${diffMins}m`;
	const hours = Math.floor(diffMins / 60);
	const mins = diffMins % 60;
	if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d ${hours % 24}h`;
	return new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "numeric"
	}).format(new Date(targetMs));
}
function formatWindowShort(window, now) {
	const remaining = clampPercent(100 - window.usedPercent);
	const reset = formatResetRemaining(window.resetAt, now);
	const resetSuffix = reset ? ` ⏱${reset}` : "";
	return `${remaining.toFixed(0)}% left (${window.label}${resetSuffix})`;
}
function formatUsageWindowSummary(snapshot, opts) {
	if (snapshot.error) return null;
	if (snapshot.windows.length === 0) return null;
	const now = opts?.now ?? Date.now();
	const maxWindows = typeof opts?.maxWindows === "number" && opts.maxWindows > 0 ? Math.min(opts.maxWindows, snapshot.windows.length) : snapshot.windows.length;
	const includeResets = opts?.includeResets ?? false;
	return snapshot.windows.slice(0, maxWindows).map((window) => {
		const remaining = clampPercent(100 - window.usedPercent);
		const reset = includeResets ? formatResetRemaining(window.resetAt, now) : null;
		const resetSuffix = reset ? ` ⏱${reset}` : "";
		return `${window.label} ${remaining.toFixed(0)}% left${resetSuffix}`;
	}).join(" · ");
}
function formatUsageSummaryLine(summary, opts) {
	const providers = summary.providers.filter((entry) => entry.windows.length > 0 && !entry.error).slice(0, opts?.maxProviders ?? summary.providers.length);
	if (providers.length === 0) return null;
	return `📊 Usage: ${providers.map((entry) => {
		const window = entry.windows.reduce((best, next) => next.usedPercent > best.usedPercent ? next : best);
		return `${entry.displayName} ${formatWindowShort(window, opts?.now)}`;
	}).join(" · ")}`;
}
function formatUsageReportLines(summary, opts) {
	if (summary.providers.length === 0) return ["Usage: no provider usage available."];
	const lines = ["Usage:"];
	for (const entry of summary.providers) {
		const planSuffix = entry.plan ? ` (${entry.plan})` : "";
		if (entry.error) {
			lines.push(`  ${entry.displayName}${planSuffix}: ${entry.error}`);
			continue;
		}
		if (entry.windows.length === 0) {
			lines.push(`  ${entry.displayName}${planSuffix}: no data`);
			continue;
		}
		lines.push(`  ${entry.displayName}${planSuffix}`);
		for (const window of entry.windows) {
			const remaining = clampPercent(100 - window.usedPercent);
			const reset = formatResetRemaining(window.resetAt, opts?.now);
			const resetSuffix = reset ? ` · resets ${reset}` : "";
			lines.push(`    ${window.label}: ${remaining.toFixed(0)}% left${resetSuffix}`);
		}
	}
	return lines;
}
//#endregion
//#region src/infra/provider-usage.auth.ts
function resolveUsageAuthStore(state) {
	state.store ??= ensureAuthProfileStore(state.agentDir, { allowKeychainPrompt: false });
	return state.store;
}
function resolveProviderApiKeyFromConfig(params) {
	const envDirect = params.envDirect?.map(normalizeSecretInput).find(Boolean);
	if (envDirect) return envDirect;
	for (const providerId of params.providerIds) {
		const envKey = resolveEnvApiKey(providerId, params.state.env)?.apiKey;
		if (envKey) return envKey;
		const key = resolveUsableCustomProviderApiKey({
			cfg: params.state.cfg,
			provider: providerId,
			env: params.state.env
		})?.apiKey;
		if (key) return key;
	}
}
function hasProviderAuthEnvCredentialSource(params) {
	const candidates = resolveProviderAuthEnvVarCandidates({
		config: params.state.cfg,
		env: {
			...process.env.VITEST ? process.env : {},
			...params.state.env
		}
	});
	for (const providerId of normalizeProviderIds(params.providerIds)) {
		const envVars = Object.hasOwn(candidates, providerId) ? candidates[providerId] : void 0;
		if (!envVars) continue;
		if (envVars.some((envVar) => Boolean(normalizeSecretInput(params.state.env[envVar])))) return true;
	}
	return false;
}
function resolveProviderApiKeyFromConfigAndStore(params) {
	const configKey = resolveProviderApiKeyFromConfig(params);
	if (configKey || !params.state.allowAuthProfileStore) return configKey;
	const cred = [...new Set(params.providerIds.map((providerId) => normalizeProviderId(providerId)).filter(Boolean))].flatMap((providerId) => listProfilesForProvider(resolveUsageAuthStore(params.state), providerId)).map((id) => resolveUsageAuthStore(params.state).profiles[id]).find((profile) => profile?.type === "api_key" || profile?.type === "token");
	if (!cred) return;
	if (cred.type === "api_key") {
		const key = normalizeSecretInput(cred.key);
		if (key && !isNonSecretApiKeyMarker(key)) return key;
		return;
	}
	const token = normalizeSecretInput(cred.token);
	if (token && !isNonSecretApiKeyMarker(token)) return token;
}
function normalizeProviderIds(providerIds) {
	return [...new Set([...providerIds].map((providerId) => providerId ? normalizeProviderId(providerId) : void 0).filter((providerId) => Boolean(providerId)))];
}
function isUsageProviderManifestEligible(params) {
	const normalizedConfig = normalizePluginsConfig(params.state.cfg.plugins);
	if (!passesManifestOwnerBasePolicy({
		plugin: params.plugin,
		normalizedConfig
	})) return false;
	if (params.plugin.origin !== "workspace") return true;
	return isActivatedManifestOwner({
		plugin: params.plugin,
		normalizedConfig,
		rootConfig: params.state.cfg
	});
}
function resolveUsageCredentialProviderIds(params) {
	const providerIds = new Set(normalizeProviderIds([params.provider]));
	const providerIdSet = new Set(providerIds);
	try {
		const snapshot = loadManifestMetadataSnapshot({
			config: params.state.cfg,
			env: params.state.env
		});
		for (const plugin of snapshot.plugins) {
			const pluginProviderIds = normalizeProviderIds(plugin.providers);
			if (!pluginProviderIds.some((providerId) => providerIdSet.has(providerId))) continue;
			if (!isUsageProviderManifestEligible({
				plugin,
				state: params.state
			})) continue;
			for (const providerId of pluginProviderIds) providerIds.add(providerId);
		}
	} catch {}
	return [...providerIds];
}
async function resolveOAuthToken(params) {
	if (!params.state.allowAuthProfileStore) return null;
	const store = resolveUsageAuthStore(params.state);
	const deduped = dedupeProfileIds(resolveAuthProfileOrder({
		cfg: params.state.cfg,
		store,
		provider: params.provider
	}));
	for (const profileId of deduped) {
		const cred = store.profiles[profileId];
		if (!cred || cred.type !== "oauth" && cred.type !== "token") continue;
		try {
			const resolved = await resolveApiKeyForProfile({
				cfg: params.state.cfg,
				store,
				profileId,
				agentDir: params.state.agentDir
			});
			if (!resolved) continue;
			return {
				provider: params.provider,
				token: resolved.apiKey,
				accountId: cred.type === "oauth" && "accountId" in cred ? cred.accountId : void 0
			};
		} catch {}
	}
	return null;
}
async function resolveProviderUsageAuthViaPlugin(params) {
	const resolved = await resolveProviderUsageAuthWithPlugin({
		provider: params.provider,
		config: params.state.cfg,
		env: params.state.env,
		context: {
			config: params.state.cfg,
			agentDir: params.state.agentDir,
			env: params.state.env,
			provider: params.provider,
			resolveApiKeyFromConfigAndStore: (options) => resolveProviderApiKeyFromConfigAndStore({
				state: params.state,
				providerIds: options?.providerIds ?? [params.provider],
				envDirect: options?.envDirect
			}),
			resolveOAuthToken: async (options) => {
				const auth = await resolveOAuthToken({
					state: params.state,
					provider: options?.provider ?? params.provider
				});
				return auth ? {
					token: auth.token,
					...auth.accountId ? { accountId: auth.accountId } : {}
				} : null;
			}
		}
	});
	if (!resolved?.token) return null;
	return {
		provider: params.provider,
		token: resolved.token,
		...resolved.accountId ? { accountId: resolved.accountId } : {}
	};
}
async function resolveProviderUsageAuthFallback(params) {
	const oauthToken = await resolveOAuthToken({
		state: params.state,
		provider: params.provider
	});
	if (oauthToken) return oauthToken;
	const apiKey = resolveProviderApiKeyFromConfigAndStore({
		state: params.state,
		providerIds: [params.provider]
	});
	if (apiKey) return {
		provider: params.provider,
		token: apiKey
	};
	return null;
}
function hasAuthProfileCredentialSource(params) {
	const store = ensureAuthProfileStoreWithoutExternalProfiles(params.state.agentDir, { allowKeychainPrompt: false });
	for (const provider of params.providerIds) if (dedupeProfileIds(resolveAuthProfileOrder({
		cfg: params.state.cfg,
		store,
		provider
	})).some((profileId) => {
		const cred = store.profiles[profileId];
		return cred?.type === "api_key" || cred?.type === "oauth" || cred?.type === "token";
	})) return true;
	return false;
}
function resolveLegacyPiAgentProviderIds(provider) {
	return provider === "zai" ? ["z-ai", "zai"] : [provider];
}
async function resolveProviderAuths(params) {
	if (params.auth) return params.auth;
	const stateBase = {
		cfg: params.config ?? getRuntimeConfig(),
		env: params.env ?? process.env,
		agentDir: params.agentDir
	};
	const authProfileSourceState = {
		...stateBase,
		allowAuthProfileStore: true
	};
	const hasAuthProfileStoreSource = params.skipPluginAuthWithoutCredentialSource ? hasAnyAuthProfileStoreSource(params.agentDir) : false;
	const auths = [];
	for (const provider of params.providers) {
		if (!params.skipPluginAuthWithoutCredentialSource) {
			const pluginAuth = await resolveProviderUsageAuthViaPlugin({
				state: authProfileSourceState,
				provider
			});
			if (pluginAuth) {
				auths.push(pluginAuth);
				continue;
			}
			const fallbackAuth = await resolveProviderUsageAuthFallback({
				state: authProfileSourceState,
				provider
			});
			if (fallbackAuth) auths.push(fallbackAuth);
			continue;
		}
		const directCredentialState = {
			...stateBase,
			allowAuthProfileStore: false
		};
		const credentialProviderIds = resolveUsageCredentialProviderIds({
			state: directCredentialState,
			provider
		});
		const hasDirectCredentialSource = Boolean(resolveProviderApiKeyFromConfig({
			state: directCredentialState,
			providerIds: credentialProviderIds
		})) || hasProviderAuthEnvCredentialSource({
			state: directCredentialState,
			providerIds: credentialProviderIds
		});
		const allowAuthProfileStore = hasDirectCredentialSource || hasAuthProfileStoreSource && hasAuthProfileCredentialSource({
			state: authProfileSourceState,
			providerIds: credentialProviderIds
		});
		const state = {
			...stateBase,
			allowAuthProfileStore
		};
		const hasLegacyPiAgentCredentialSource = Boolean(resolveLegacyPiAgentAccessToken(stateBase.env, resolveLegacyPiAgentProviderIds(provider)));
		if (hasDirectCredentialSource || allowAuthProfileStore || hasLegacyPiAgentCredentialSource) {
			const pluginAuth = await resolveProviderUsageAuthViaPlugin({
				state,
				provider
			});
			if (pluginAuth) {
				auths.push(pluginAuth);
				continue;
			}
		}
		const fallbackAuth = await resolveProviderUsageAuthFallback({
			state,
			provider
		});
		if (fallbackAuth) auths.push(fallbackAuth);
	}
	return auths;
}
//#endregion
//#region src/infra/provider-usage.load.ts
async function fetchProviderUsageSnapshotFallback(params) {
	params.timeoutMs;
	params.fetchFn;
	return {
		provider: params.auth.provider,
		displayName: PROVIDER_LABELS[params.auth.provider] ?? params.auth.provider,
		windows: [],
		error: "Unsupported provider"
	};
}
async function fetchProviderUsageSnapshot(params) {
	const pluginSnapshot = await resolveProviderUsageSnapshotWithPlugin({
		provider: params.auth.provider,
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		context: {
			config: params.config,
			agentDir: params.agentDir,
			workspaceDir: params.workspaceDir,
			env: params.env,
			provider: params.auth.provider,
			token: params.auth.token,
			accountId: params.auth.accountId,
			timeoutMs: params.timeoutMs,
			fetchFn: params.fetchFn
		}
	});
	if (pluginSnapshot) return pluginSnapshot;
	return await fetchProviderUsageSnapshotFallback({
		auth: params.auth,
		timeoutMs: params.timeoutMs,
		fetchFn: params.fetchFn
	});
}
async function loadProviderUsageSummary(opts = {}) {
	const now = opts.now ?? Date.now();
	const timeoutMs = opts.timeoutMs ?? 5e3;
	const config = opts.config ?? getRuntimeConfig();
	const env = opts.env ?? process.env;
	const fetchFn = resolveFetch(opts.fetch);
	if (!fetchFn) throw new Error("fetch is not available");
	const auths = await resolveProviderAuths({
		providers: opts.providers ?? usageProviders,
		auth: opts.auth,
		agentDir: opts.agentDir,
		config,
		env,
		skipPluginAuthWithoutCredentialSource: opts.skipPluginAuthWithoutCredentialSource
	});
	if (auths.length === 0) return {
		updatedAt: now,
		providers: []
	};
	const tasks = auths.map((auth) => {
		const failureSnapshot = (error) => ({
			provider: auth.provider,
			displayName: PROVIDER_LABELS[auth.provider] ?? auth.provider,
			windows: [],
			error
		});
		return withTimeout(fetchProviderUsageSnapshot({
			auth,
			config,
			env,
			agentDir: opts.agentDir,
			workspaceDir: opts.workspaceDir,
			timeoutMs,
			fetchFn
		}), timeoutMs + 1e3, {
			provider: auth.provider,
			displayName: PROVIDER_LABELS[auth.provider],
			windows: [],
			error: "Timeout"
		}).catch((error) => {
			return failureSnapshot((error instanceof Error ? error.message : String(error)).trim() || "Fetch failed");
		});
	});
	return {
		updatedAt: now,
		providers: (await Promise.all(tasks)).filter((entry) => {
			if (entry.windows.length > 0) return true;
			if (!entry.error) return true;
			return !ignoredErrors.has(entry.error);
		})
	};
}
//#endregion
export { formatUsageWindowSummary as i, formatUsageReportLines as n, formatUsageSummaryLine as r, loadProviderUsageSummary as t };
