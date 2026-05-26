import { a as normalizeLowercaseStringOrEmpty, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { o as coerceSecretRef } from "./types.secrets-DwPik3M8.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { s as resolveDefaultAgentDir } from "./agent-scope-config-CMp71_27.js";
import { l as resolveDefaultSecretProviderAlias } from "./ref-contract-D_h_G00C.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { J as getShellEnvAppliedKeys } from "./io-DoswVvYe.js";
import { i as getRuntimeConfigSnapshot } from "./runtime-snapshot-DgdkBEdP.js";
import { n as resolveProviderAuthAliasMap } from "./provider-auth-aliases-4jqi6Djx.js";
import "./config-B6Oplu5W.js";
import { i as resolveAuthStorePathForDisplay } from "./path-resolve-C6Vj5eOM.js";
import { h as resolveOwningPluginIdsForProvider } from "./plugin-auto-enable-CuCUT4Z1.js";
import { M as resolveProviderSyntheticAuthWithPlugin, U as shouldDeferProviderSyntheticProfileAuthWithPlugin, s as buildProviderMissingAuthMessageWithPlugin } from "./provider-runtime-D8jQEgmu.js";
import { I as readCodexCliCredentialsCached, n as ensureAuthProfileStore } from "./store-BMQkMM4l.js";
import { b as resolveProviderEnvAuthEvidence, i as NON_ENV_SECRETREF_MARKER, l as isKnownEnvApiKeyMarker, t as CUSTOM_LOCAL_AUTH_MARKER, u as isNonSecretApiKeyMarker, y as resolveProviderEnvApiKeyCandidates } from "./model-auth-markers-Cf78z2Zm.js";
import "./model-selection-P-81eBKx.js";
import { t as normalizeOptionalSecretInput } from "./normalize-secret-input-CsdRhsMj.js";
import { t as resolveEnvApiKey } from "./model-auth-env-CZ-LXyVa.js";
import { n as resolveRuntimeSyntheticAuthProviderRefState } from "./synthetic-auth.runtime.js";
import "./auth-profiles-D6NMnufG.js";
import { n as resolveApiKeyForProfile } from "./oauth--yqMDDjF.js";
import { r as externalCliDiscoveryForProviderAuth } from "./external-cli-discovery-D0JQl8du.js";
import { n as listProfilesForProvider } from "./profile-list-C0HtPlut.js";
import { i as resolveAuthProfileOrder, t as isConfiguredAwsSdkAuthProfileForProvider } from "./order-DJrj83KE.js";
import path from "node:path";
//#region src/agents/model-auth.ts
const log = createSubsystemLogger("model-auth");
function resolveConfigAwareEnvApiKey(cfg, provider, workspaceDir) {
	return resolveEnvApiKey(provider, process.env, {
		config: cfg,
		workspaceDir
	});
}
function resolveProviderConfig(cfg, provider) {
	const providers = cfg?.models?.providers ?? {};
	const direct = providers[provider];
	if (direct) return direct;
	const normalized = normalizeProviderId(provider);
	if (normalized === provider) return Object.entries(providers).find(([key]) => normalizeProviderId(key) === normalized)?.[1];
	return providers[normalized] ?? Object.entries(providers).find(([key]) => normalizeProviderId(key) === normalized)?.[1];
}
function createRuntimeProviderAuthLookup(params) {
	const env = params.env ?? process.env;
	const lookupParams = {
		config: params.cfg,
		workspaceDir: params.workspaceDir,
		env
	};
	const syntheticAuthProviderRefs = resolveRuntimeSyntheticAuthProviderRefState(lookupParams);
	return {
		envApiKey: {
			aliasMap: resolveProviderAuthAliasMap(lookupParams),
			candidateMap: resolveProviderEnvApiKeyCandidates(lookupParams),
			authEvidenceMap: resolveProviderEnvAuthEvidence(lookupParams)
		},
		syntheticAuthProviderRefs: syntheticAuthProviderRefs.complete ? syntheticAuthProviderRefs.refs : void 0
	};
}
function getCustomProviderApiKey(cfg, provider) {
	const entry = resolveProviderConfig(cfg, provider);
	const literal = normalizeOptionalSecretInput(entry?.apiKey);
	if (literal) return literal;
	const ref = coerceSecretRef(entry?.apiKey);
	if (!ref) return;
	if (ref.source === "env") return ref.id.trim() || "secretref-managed";
	return NON_ENV_SECRETREF_MARKER;
}
function canResolveEnvSecretRefInReadOnlyPath(params) {
	const providerConfig = params.cfg?.secrets?.providers?.[params.provider];
	if (!providerConfig) return params.provider === resolveDefaultSecretProviderAlias(params.cfg ?? {}, "env");
	if (providerConfig.source !== "env") return false;
	const allowlist = providerConfig.allowlist;
	return !allowlist || allowlist.includes(params.id);
}
function resolveUsableCustomProviderApiKey(params) {
	const customProviderConfig = resolveProviderConfig(params.cfg, params.provider);
	const apiKeyRef = coerceSecretRef(customProviderConfig?.apiKey);
	if (apiKeyRef) {
		if (apiKeyRef.source !== "env") return null;
		const envVarName = apiKeyRef.id.trim();
		if (!envVarName) return null;
		if (!canResolveEnvSecretRefInReadOnlyPath({
			cfg: params.cfg,
			provider: apiKeyRef.provider,
			id: envVarName
		})) return null;
		const envValue = normalizeOptionalSecretInput((params.env ?? process.env)[envVarName]);
		if (!envValue) return null;
		return {
			apiKey: envValue,
			source: resolveEnvSourceLabel({
				applied: new Set(getShellEnvAppliedKeys()),
				envVars: [envVarName],
				label: `${envVarName} (models.json secretref)`
			})
		};
	}
	const customKey = getCustomProviderApiKey(params.cfg, params.provider);
	if (!customKey) return null;
	if (!isNonSecretApiKeyMarker(customKey)) return {
		apiKey: customKey,
		source: "models.json"
	};
	if (isKnownEnvApiKeyMarker(customKey)) {
		const envValue = normalizeOptionalSecretInput((params.env ?? process.env)[customKey]);
		if (!envValue) return null;
		return {
			apiKey: envValue,
			source: resolveEnvSourceLabel({
				applied: new Set(getShellEnvAppliedKeys()),
				envVars: [customKey],
				label: `${customKey} (models.json marker)`
			})
		};
	}
	if (customProviderConfig && isCustomLocalProviderConfig(customProviderConfig) && (customProviderConfig.api === "openai-completions" || customProviderConfig.api === "ollama") && customProviderConfig.baseUrl && isLocalBaseUrl(customProviderConfig.baseUrl)) return {
		apiKey: customProviderConfig.api === "ollama" ? customKey : CUSTOM_LOCAL_AUTH_MARKER,
		source: "models.json (local marker)"
	};
	return null;
}
function hasUsableCustomProviderApiKey(cfg, provider, env) {
	return Boolean(resolveUsableCustomProviderApiKey({
		cfg,
		provider,
		env
	}));
}
function shouldPreferExplicitConfigApiKeyAuth(cfg, provider) {
	const providerConfig = resolveProviderConfig(cfg, provider);
	return resolveProviderAuthOverride(cfg, provider) === "api-key" && providerConfig !== void 0 && hasExplicitProviderApiKeyConfig(providerConfig);
}
function resolveProviderAuthOverride(cfg, provider) {
	const auth = resolveProviderConfig(cfg, provider)?.auth;
	if (auth === "api-key" || auth === "aws-sdk" || auth === "oauth" || auth === "token") return auth;
}
function profileTypeToAuthMode(type) {
	return type === "oauth" ? "oauth" : type === "token" ? "token" : "api-key";
}
function resolveConfiguredAwsSdkProfileAuth(params) {
	if (!isConfiguredAwsSdkAuthProfileForProvider(params)) return null;
	return {
		...resolveAwsSdkAuthInfo(),
		profileId: params.profileId,
		source: `profile:${params.profileId}`
	};
}
function isLocalBaseUrl(baseUrl) {
	try {
		let host = normalizeLowercaseStringOrEmpty(new URL(baseUrl).hostname);
		if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
		return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || host === "::ffff:7f00:1" || host === "::ffff:127.0.0.1" || host === "docker.orb.internal" || host === "host.docker.internal" || host === "host.orb.internal" || host.endsWith(".local") || isPrivateIpv4Host(host);
	} catch {
		return false;
	}
}
function isPrivateIpv4Host(host) {
	if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
	const octets = host.split(".").map((part) => Number.parseInt(part, 10));
	if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
	const [a, b] = octets;
	return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168;
}
function hasExplicitProviderApiKeyConfig(providerConfig) {
	return normalizeOptionalSecretInput(providerConfig.apiKey) !== void 0 || coerceSecretRef(providerConfig.apiKey) !== null;
}
function isCustomLocalProviderConfig(providerConfig) {
	return typeof providerConfig.baseUrl === "string" && providerConfig.baseUrl.trim().length > 0 && typeof providerConfig.api === "string" && providerConfig.api.trim().length > 0 && Array.isArray(providerConfig.models) && providerConfig.models.length > 0;
}
function isManagedSecretRefApiKeyMarker(apiKey) {
	return apiKey?.trim() === NON_ENV_SECRETREF_MARKER;
}
function hasSyntheticLocalProviderAuthConfig(params) {
	const providerConfig = resolveProviderConfig(params.cfg, params.provider);
	if (!providerConfig) return false;
	if (!(Boolean(providerConfig.api?.trim()) || Boolean(providerConfig.baseUrl?.trim()) || Array.isArray(providerConfig.models) && providerConfig.models.length > 0)) return false;
	const authOverride = resolveProviderAuthOverride(params.cfg, params.provider);
	if (authOverride && authOverride !== "api-key") return false;
	if (!isCustomLocalProviderConfig(providerConfig)) return false;
	if (hasExplicitProviderApiKeyConfig(providerConfig)) return false;
	return Boolean(providerConfig.baseUrl && isLocalBaseUrl(providerConfig.baseUrl));
}
function listProviderSyntheticAuthRefs(params) {
	const refs = [params.provider];
	const providerConfig = resolveProviderConfig(params.cfg, params.provider);
	if (params.modelApi) refs.push(params.modelApi);
	if (providerConfig?.api) refs.push(providerConfig.api);
	return [...new Set(refs.map((ref) => normalizeProviderId(ref)).filter(Boolean))];
}
function shouldResolvePluginSyntheticAuth(params) {
	const syntheticAuthProviderRefs = params.runtimeLookup?.syntheticAuthProviderRefs;
	if (!syntheticAuthProviderRefs) return true;
	if (resolveProviderConfig(params.cfg, params.provider)) return true;
	const eligibleRefs = new Set(syntheticAuthProviderRefs.map((ref) => normalizeProviderId(ref)).filter(Boolean));
	if (eligibleRefs.size === 0) return false;
	return listProviderSyntheticAuthRefs(params).some((ref) => eligibleRefs.has(ref));
}
function hasRuntimeAvailableProviderAuth(params) {
	const provider = normalizeProviderId(params.provider);
	const authOverride = resolveProviderAuthOverride(params.cfg, provider);
	if (authOverride === "aws-sdk") return true;
	if (authOverride === void 0 && provider === "amazon-bedrock") return true;
	if (resolveEnvApiKey(provider, params.env, {
		config: params.cfg,
		workspaceDir: params.workspaceDir,
		...params.runtimeLookup?.envApiKey
	})) return true;
	if (resolveUsableCustomProviderApiKey({
		cfg: params.cfg,
		provider,
		env: params.env
	})) return true;
	if (hasSyntheticLocalProviderAuthConfig({
		cfg: params.cfg,
		provider
	})) return true;
	if (params.allowPluginSyntheticAuth !== false && shouldResolvePluginSyntheticAuth({
		cfg: params.cfg,
		provider,
		runtimeLookup: params.runtimeLookup
	}) && resolveSyntheticLocalProviderAuth({
		cfg: params.cfg,
		provider
	})) return true;
	return false;
}
function resolveProviderSyntheticRuntimeAuth(params) {
	const resolveFromConfig = (config) => {
		const providerConfig = resolveProviderConfig(config, params.provider);
		return resolveProviderSyntheticAuthWithPlugin({
			provider: params.provider,
			config,
			context: {
				config,
				provider: params.provider,
				providerConfig
			},
			modelApi: params.modelApi
		}) ?? void 0;
	};
	const directAuth = resolveFromConfig(params.cfg);
	if (!directAuth) return {};
	if (!isManagedSecretRefApiKeyMarker(directAuth.apiKey)) return { auth: directAuth };
	const runtimeConfig = getRuntimeConfigSnapshot();
	if (!runtimeConfig || runtimeConfig === params.cfg) return { blockedOnManagedSecretRef: true };
	const runtimeAuth = resolveFromConfig(runtimeConfig);
	const runtimeApiKey = runtimeAuth?.apiKey;
	if (!runtimeAuth || !runtimeApiKey || isNonSecretApiKeyMarker(runtimeApiKey)) return { blockedOnManagedSecretRef: true };
	return { auth: runtimeAuth };
}
function resolveSyntheticLocalProviderAuth(params) {
	const syntheticProviderAuth = resolveProviderSyntheticRuntimeAuth(params);
	if (syntheticProviderAuth.auth) return syntheticProviderAuth.auth;
	if (syntheticProviderAuth.blockedOnManagedSecretRef) return null;
	if (!resolveProviderConfig(params.cfg, params.provider)) return null;
	if (hasSyntheticLocalProviderAuthConfig(params)) return {
		apiKey: CUSTOM_LOCAL_AUTH_MARKER,
		source: `models.providers.${params.provider} (synthetic local key)`,
		mode: "api-key"
	};
	return null;
}
function resolveEnvSourceLabel(params) {
	return `${params.envVars.some((envVar) => params.applied.has(envVar)) ? "shell env: " : "env: "}${params.label}`;
}
function resolveAwsSdkAuthInfo() {
	const applied = new Set(getShellEnvAppliedKeys());
	if (process.env.AWS_BEARER_TOKEN_BEDROCK?.trim()) return {
		mode: "aws-sdk",
		source: resolveEnvSourceLabel({
			applied,
			envVars: ["AWS_BEARER_TOKEN_BEDROCK"],
			label: "AWS_BEARER_TOKEN_BEDROCK"
		})
	};
	if (process.env.AWS_ACCESS_KEY_ID?.trim() && process.env.AWS_SECRET_ACCESS_KEY?.trim()) return {
		mode: "aws-sdk",
		source: resolveEnvSourceLabel({
			applied,
			envVars: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
			label: "AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY"
		})
	};
	if (process.env.AWS_PROFILE?.trim()) return {
		mode: "aws-sdk",
		source: resolveEnvSourceLabel({
			applied,
			envVars: ["AWS_PROFILE"],
			label: "AWS_PROFILE"
		})
	};
	return {
		mode: "aws-sdk",
		source: "aws-sdk default chain"
	};
}
function shouldDeferSyntheticProfileAuth(params) {
	const providerConfig = resolveProviderConfig(params.cfg, params.provider);
	return shouldDeferProviderSyntheticProfileAuthWithPlugin({
		provider: params.provider,
		config: params.cfg,
		modelApi: params.modelApi,
		context: {
			config: params.cfg,
			provider: params.provider,
			providerConfig,
			resolvedApiKey: params.resolvedApiKey
		}
	}) === true;
}
function resolveScopedAuthProfileStore(params) {
	return ensureAuthProfileStore(params.agentDir, { externalCli: externalCliDiscoveryForProviderAuth(params) });
}
async function resolveApiKeyForProvider(params) {
	const { provider, cfg, profileId, preferredProfile } = params;
	const agentDir = params.agentDir?.trim() || (cfg ? resolveDefaultAgentDir(cfg) : void 0);
	let scopedStore = params.store;
	if (profileId) {
		const awsSdkProfileAuth = resolveConfiguredAwsSdkProfileAuth({
			cfg,
			provider,
			profileId
		});
		if (awsSdkProfileAuth) return awsSdkProfileAuth;
		const store = params.store ?? resolveScopedAuthProfileStore({
			agentDir,
			cfg,
			provider,
			profileId,
			preferredProfile
		});
		const resolved = await resolveApiKeyForProfile({
			cfg,
			store,
			profileId,
			agentDir,
			forceRefresh: params.forceRefresh
		});
		if (!resolved) throw new Error(`No credentials found for profile "${profileId}".`);
		const resolvedProfileId = resolved.profileId ?? profileId;
		const mode = resolved.profileType ?? store.profiles[resolvedProfileId]?.type;
		const result = {
			apiKey: resolved.apiKey,
			profileId: resolvedProfileId,
			source: `profile:${resolvedProfileId}`,
			mode: mode ? profileTypeToAuthMode(mode) : "api-key"
		};
		if (!params.lockedProfile && shouldDeferSyntheticProfileAuth({
			cfg,
			provider,
			resolvedApiKey: resolved.apiKey,
			modelApi: params.modelApi
		})) return resolveApiKeyForProvider({
			...params,
			profileId: void 0,
			lockedProfile: true
		}).catch(() => result);
		return result;
	}
	if (cfg?.auth?.profiles || cfg?.auth?.order) {
		scopedStore ??= resolveScopedAuthProfileStore({
			agentDir,
			cfg,
			provider,
			preferredProfile
		});
		const configuredProfileOrder = resolveAuthProfileOrder({
			cfg,
			store: scopedStore,
			provider,
			preferredProfile
		});
		for (const candidate of configuredProfileOrder) {
			const awsSdkProfileAuth = resolveConfiguredAwsSdkProfileAuth({
				cfg,
				provider,
				profileId: candidate
			});
			if (awsSdkProfileAuth) return awsSdkProfileAuth;
		}
	}
	const authOverride = resolveProviderAuthOverride(cfg, provider);
	if (authOverride === "aws-sdk") return resolveAwsSdkAuthInfo();
	if (shouldPreferExplicitConfigApiKeyAuth(cfg, provider)) {
		const customKey = resolveUsableCustomProviderApiKey({
			cfg,
			provider
		});
		if (customKey) return {
			apiKey: customKey.apiKey,
			source: customKey.source,
			mode: "api-key"
		};
	}
	const normalized = normalizeProviderId(provider);
	if (authOverride === void 0 && normalized === "amazon-bedrock") return resolveAwsSdkAuthInfo();
	if (params.credentialPrecedence === "env-first") {
		const envResolved = resolveConfigAwareEnvApiKey(cfg, provider, params.workspaceDir);
		if (envResolved) {
			const resolvedMode = envResolved.source.includes("OAUTH_TOKEN") ? "oauth" : "api-key";
			return {
				apiKey: envResolved.apiKey,
				source: envResolved.source,
				mode: resolvedMode
			};
		}
	}
	const providerConfig = resolveProviderConfig(cfg, provider);
	const configuredLocalKey = resolveUsableCustomProviderApiKey({
		cfg,
		provider
	});
	if (configuredLocalKey && isNonSecretApiKeyMarker(configuredLocalKey.apiKey)) return {
		apiKey: configuredLocalKey.apiKey,
		source: configuredLocalKey.source,
		mode: "api-key"
	};
	const localMarkerEnv = resolveConfigAwareEnvApiKey(cfg, provider, params.workspaceDir);
	if (localMarkerEnv && isNonSecretApiKeyMarker(localMarkerEnv.apiKey)) return {
		apiKey: localMarkerEnv.apiKey,
		source: localMarkerEnv.source,
		mode: "api-key"
	};
	const store = scopedStore ?? resolveScopedAuthProfileStore({
		agentDir,
		cfg,
		provider,
		preferredProfile
	});
	const order = resolveAuthProfileOrder({
		cfg,
		store,
		provider,
		preferredProfile
	});
	let deferredAuthProfileResult = null;
	for (const candidate of order) try {
		const awsSdkProfileAuth = resolveConfiguredAwsSdkProfileAuth({
			cfg,
			provider,
			profileId: candidate
		});
		if (awsSdkProfileAuth) return awsSdkProfileAuth;
		const resolved = await resolveApiKeyForProfile({
			cfg,
			store,
			profileId: candidate,
			agentDir,
			forceRefresh: params.forceRefresh
		});
		if (resolved) {
			const resolvedProfileId = resolved.profileId ?? candidate;
			const mode = resolved.profileType ?? store.profiles[resolvedProfileId]?.type;
			const resolvedMode = mode ? profileTypeToAuthMode(mode) : "api-key";
			const result = {
				apiKey: resolved.apiKey,
				profileId: resolvedProfileId,
				source: `profile:${resolvedProfileId}`,
				mode: resolvedMode
			};
			if (shouldDeferSyntheticProfileAuth({
				cfg,
				provider,
				resolvedApiKey: resolved.apiKey,
				modelApi: params.modelApi
			})) {
				deferredAuthProfileResult ??= result;
				continue;
			}
			return result;
		}
	} catch (err) {
		log.debug?.(`auth profile "${candidate}" failed for provider "${provider}": ${String(err)}`);
	}
	const envResolved = resolveConfigAwareEnvApiKey(cfg, provider, params.workspaceDir);
	if (envResolved) {
		const resolvedMode = envResolved.source.includes("OAUTH_TOKEN") ? "oauth" : "api-key";
		return {
			apiKey: envResolved.apiKey,
			source: envResolved.source,
			mode: resolvedMode
		};
	}
	const customKey = resolveUsableCustomProviderApiKey({
		cfg,
		provider
	});
	if (customKey) return {
		apiKey: customKey.apiKey,
		source: customKey.source,
		mode: "api-key"
	};
	if (deferredAuthProfileResult) return deferredAuthProfileResult;
	const syntheticLocalAuth = resolveSyntheticLocalProviderAuth({
		cfg,
		provider,
		modelApi: params.modelApi
	});
	if (syntheticLocalAuth) return syntheticLocalAuth;
	if ((!(Array.isArray(providerConfig?.models) && providerConfig.models.length > 0) ? resolveOwningPluginIdsForProvider({
		provider,
		config: cfg
	}) : void 0)?.length) {
		const pluginMissingAuthMessage = buildProviderMissingAuthMessageWithPlugin({
			provider,
			config: cfg,
			context: {
				config: cfg,
				agentDir,
				env: process.env,
				provider,
				listProfileIds: (providerId) => listProfilesForProvider(store, providerId)
			}
		});
		if (pluginMissingAuthMessage) throw new Error(pluginMissingAuthMessage);
	}
	const authStorePath = resolveAuthStorePathForDisplay(agentDir);
	const resolvedAgentDir = path.dirname(authStorePath);
	throw new Error([
		`No API key found for provider "${provider}".`,
		`Auth store: ${authStorePath} (agentDir: ${resolvedAgentDir}).`,
		`Configure auth for this agent (${formatCliCommand("openclaw agents add <id>")}) or copy only portable static auth profiles from the main agentDir.`
	].join(" "));
}
function resolveModelAuthMode(provider, cfg, store, options) {
	const resolved = provider?.trim();
	if (!resolved) return;
	const authOverride = resolveProviderAuthOverride(cfg, resolved);
	if (authOverride === "aws-sdk") return "aws-sdk";
	const authStore = store ?? resolveScopedAuthProfileStore({
		cfg,
		provider: resolved
	});
	const profiles = listProfilesForProvider(authStore, resolved);
	if (profiles.length > 0) {
		const modes = new Set(profiles.map((id) => authStore.profiles[id]?.type).filter((mode) => Boolean(mode)));
		if ([
			"oauth",
			"token",
			"api_key"
		].filter((k) => modes.has(k)).length >= 2) return "mixed";
		if (modes.has("oauth")) return "oauth";
		if (modes.has("token")) return "token";
		if (modes.has("api_key")) return "api-key";
	}
	if (authOverride === void 0 && normalizeProviderId(resolved) === "amazon-bedrock") return "aws-sdk";
	const envKey = resolveConfigAwareEnvApiKey(cfg, resolved, options?.workspaceDir);
	if (envKey?.apiKey) return envKey.source.includes("OAUTH_TOKEN") ? "oauth" : "api-key";
	if (normalizeProviderId(resolved) === "codex" && readCodexCliCredentialsCached({
		ttlMs: 5e3,
		allowKeychainPrompt: false
	})) return "oauth";
	if (hasUsableCustomProviderApiKey(cfg, resolved)) return "api-key";
	return "unknown";
}
async function hasAvailableAuthForProvider(params) {
	const { provider, cfg, preferredProfile } = params;
	const authOverride = resolveProviderAuthOverride(cfg, provider);
	if (authOverride === "aws-sdk") return true;
	if (resolveConfigAwareEnvApiKey(cfg, provider, params.workspaceDir)) return true;
	if (resolveUsableCustomProviderApiKey({
		cfg,
		provider
	})) return true;
	if (resolveSyntheticLocalProviderAuth({
		cfg,
		provider
	})) return true;
	if (authOverride === void 0 && normalizeProviderId(provider) === "amazon-bedrock") return true;
	const store = params.store ?? resolveScopedAuthProfileStore({
		agentDir: params.agentDir,
		cfg,
		provider,
		preferredProfile
	});
	const order = resolveAuthProfileOrder({
		cfg,
		store,
		provider,
		preferredProfile
	});
	for (const candidate of order) try {
		if (resolveConfiguredAwsSdkProfileAuth({
			cfg,
			provider,
			profileId: candidate
		})) return true;
		if (await resolveApiKeyForProfile({
			cfg,
			store,
			profileId: candidate,
			agentDir: params.agentDir
		})) return true;
	} catch (err) {
		log.debug?.(`auth profile "${candidate}" failed for provider "${provider}": ${String(err)}`);
	}
	return false;
}
async function getApiKeyForModel(params) {
	return resolveApiKeyForProvider({
		provider: params.model.provider,
		cfg: params.cfg,
		profileId: params.profileId,
		preferredProfile: params.preferredProfile,
		store: params.store,
		agentDir: params.agentDir,
		workspaceDir: params.workspaceDir,
		lockedProfile: params.lockedProfile,
		credentialPrecedence: params.credentialPrecedence,
		modelApi: params.model.api
	});
}
function applyLocalNoAuthHeaderOverride(model, auth) {
	if (auth?.apiKey !== "custom-local" || model.api !== "openai-completions") return model;
	const headers = {
		...model.headers,
		Authorization: null
	};
	return {
		...model,
		headers
	};
}
/**
* When the provider config sets `authHeader: true`, inject an explicit
* `Authorization: Bearer <apiKey>` header into the model so downstream SDKs
* (e.g. `@google/genai`) send credentials via the standard HTTP Authorization
* header instead of vendor-specific headers like `x-goog-api-key`.
*
* This is a no-op when `authHeader` is not `true`, when no API key is
* available, or when the API key is a synthetic marker (e.g. local-server
* placeholders) rather than a real credential.
*/
function applyAuthHeaderOverride(model, auth, cfg) {
	if (!auth?.apiKey) return model;
	if (isNonSecretApiKeyMarker(auth.apiKey)) return model;
	if (!resolveProviderConfig(cfg, model.provider)?.authHeader) return model;
	const headers = {};
	if (model.headers) {
		for (const [key, value] of Object.entries(model.headers)) if (normalizeOptionalLowercaseString(key) !== "authorization") headers[key] = value;
	}
	headers.Authorization = `Bearer ${auth.apiKey}`;
	return {
		...model,
		headers
	};
}
//#endregion
export { getCustomProviderApiKey as a, hasSyntheticLocalProviderAuthConfig as c, resolveModelAuthMode as d, resolveUsableCustomProviderApiKey as f, getApiKeyForModel as i, hasUsableCustomProviderApiKey as l, applyLocalNoAuthHeaderOverride as n, hasAvailableAuthForProvider as o, shouldPreferExplicitConfigApiKeyAuth as p, createRuntimeProviderAuthLookup as r, hasRuntimeAvailableProviderAuth as s, applyAuthHeaderOverride as t, resolveApiKeyForProvider as u };
