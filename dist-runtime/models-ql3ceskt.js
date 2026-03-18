import { i as theme, n as init_theme, r as isRich$1, t as colorize } from "./theme-CL08MjAq.js";
import { C as shortenHomePath, d as init_utils } from "./utils-BiUV1eIQ.js";
import { $S as normalizeProviderId, $x as shouldEnableShellEnvFallback, Ap as loadModelCatalog, F as resolveDefaultModelForAgent, Gi as loadProviderUsageSummary, Gt as maskApiKey, Ib as createConfigIO, Ji as formatUsageWindowSummary, Jt as formatRemainingShort, Kb as setRuntimeConfigSnapshot, Kt as DEFAULT_OAUTH_WARN_MS, L as resolveModelRefFromString, M as parseModelRef, P as resolveConfiguredModelRef, QS as findNormalizedProviderValue, Qx as getShellEnvAppliedKeys, T as buildModelAliasIndex, Va as resolveCommandSecretRefsViaGateway, Wb as readConfigFileSnapshotForWrite, Xx as DEFAULT_MODEL, Yi as resolveUsageProviderId, Z as resolvePluginProviders, Zx as DEFAULT_PROVIDER, _b as resolveApiKeyForProvider, bb as resolveUsableCustomProviderApiKey, d as setAuthProfileOrder, di as runEmbeddedPiAgent, eb as resolveSecretRefString, f as upsertAuthProfile, gb as hasUsableCustomProviderApiKey, h as loadAuthProfileStoreForRuntime, hb as getCustomProviderApiKey, hc as shouldSuppressBuiltInModel, k as modelKey, lC as resolveAuthProfileDisplayLabel, mb as resolveOpenClawAgentDir, mc as discoverModels, n as resolveAuthProfileOrder, nd as openUrl, nn as withProgressTotals, o as resolveProfileUnusableUntilForDisplay, p as ensureAuthProfileStore, pc as discoverAuthStorage, qa as describeFailoverError, qt as buildAuthHealthSummary, r as clearAuthProfileCooldown, t as resolveAuthProfileEligibility, u as listProfilesForProvider, uc as resolveModelWithRegistry, vb as resolveAwsSdkEnvVarName, xb as isNonSecretApiKeyMarker, y as resolveAuthStorePathForDisplay, yb as resolveEnvApiKey, zb as loadConfig } from "./auth-profiles-DAOR1fRn.js";
import { i as coerceSecretRef, o as init_types_secrets, u as normalizeSecretInputString } from "./types.secrets-Cu0Lz6pi.js";
import { t as formatCliCommand } from "./command-format-CS805JpF.js";
import { r as normalizeStringEntries } from "./string-normalization-CJJOCyGw.js";
import { F as toAgentModelListLike, N as resolveAgentModelFallbackValues, P as resolveAgentModelPrimaryValue, a as resolveAgentDir, d as resolveAgentWorkspaceDir, f as resolveDefaultAgentId, j as resolveDefaultAgentWorkspaceDir, l as resolveAgentModelFallbacksOverride, s as resolveAgentExplicitModelPrimary } from "./agent-scope-C0PckUtv.js";
import { i as parseDurationMs } from "./search-manager-CVctuSlw.js";
import { i as getModelsCommandSecretTargetIds } from "./command-secret-targets-7sQA1Mwd.js";
import { a as resolveSessionTranscriptPath, c as resolveSessionTranscriptsDirForAgent } from "./paths-55bRPK_d.js";
import { n as stylePromptMessage, r as stylePromptTitle, t as stylePromptHint } from "./prompt-style-CEH2A0QE.js";
import { r as applyAuthProfileConfig } from "./onboard-auth.config-shared-B0GfsgVQ.js";
import { t as isRemoteEnvironment } from "./oauth-env-Brcv-iKF.js";
import { n as renderTable, t as getTerminalTableWidth } from "./table-BGZZcqHp.js";
import { n as redactSecrets } from "./format-D2nAG4Q5.js";
import { a as isLocalBaseUrl, c as normalizeAlias, d as resolveModelTarget, f as updateConfig, i as formatTokenK, l as resolveKnownAgentId, n as ensureFlagCompatibility, o as loadValidConfigOrThrow, p as upsertCanonicalModelConfigEntry, r as formatMs, s as mergePrimaryFallbackConfig, t as applyDefaultModelPrimaryUpdate, u as resolveModelKeysFromEntries } from "./shared-GdtNjdoh.js";
import { n as logConfigUpdated } from "./logging-B8JmIRjO.js";
import { t as createClackPrompter } from "./clack-prompter-Dan3tMHD.js";
import { a as createVpsAwareOAuthHandlers, i as resolveProviderMatch, n as mergeConfigPatch, r as pickAuthMethod, t as applyDefaultModel } from "./provider-auth-helpers-DXrJNO6A.js";
import { t as buildProviderAuthRecoveryHint } from "./provider-auth-guidance-DE73Iui7.js";
import { t as inferParamBFromIdOrName } from "./model-param-b-CUOnj0YJ.js";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { complete, getEnvApiKey, getModel } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { cancel, confirm, isCancel, multiselect, select, text } from "@clack/prompts";
//#region src/commands/models/load-config.ts
async function loadSourceConfigSnapshot(fallback) {
	try {
		const { snapshot } = await readConfigFileSnapshotForWrite();
		if (snapshot.valid) return snapshot.resolved;
	} catch {}
	return fallback;
}
async function loadModelsConfigWithSource(params) {
	const runtimeConfig = loadConfig();
	const sourceConfig = await loadSourceConfigSnapshot(runtimeConfig);
	const { resolvedConfig, diagnostics } = await resolveCommandSecretRefsViaGateway({
		config: runtimeConfig,
		commandName: params.commandName,
		targetIds: getModelsCommandSecretTargetIds()
	});
	if (params.runtime) for (const entry of diagnostics) params.runtime.log(`[secrets] ${entry}`);
	setRuntimeConfigSnapshot(resolvedConfig, sourceConfig);
	return {
		sourceConfig,
		resolvedConfig,
		diagnostics
	};
}
async function loadModelsConfig(params) {
	return (await loadModelsConfigWithSource(params)).resolvedConfig;
}
//#endregion
//#region src/commands/models/aliases.ts
async function modelsAliasesListCommand(opts, runtime) {
	ensureFlagCompatibility(opts);
	const models = (await loadModelsConfig({
		commandName: "models aliases list",
		runtime
	})).agents?.defaults?.models ?? {};
	const aliases = Object.entries(models).reduce((acc, [modelKey, entry]) => {
		const alias = entry?.alias?.trim();
		if (alias) acc[alias] = modelKey;
		return acc;
	}, {});
	if (opts.json) {
		runtime.log(JSON.stringify({ aliases }, null, 2));
		return;
	}
	if (opts.plain) {
		for (const [alias, target] of Object.entries(aliases)) runtime.log(`${alias} ${target}`);
		return;
	}
	runtime.log(`Aliases (${Object.keys(aliases).length}):`);
	if (Object.keys(aliases).length === 0) {
		runtime.log("- none");
		return;
	}
	for (const [alias, target] of Object.entries(aliases)) runtime.log(`- ${alias} -> ${target}`);
}
async function modelsAliasesAddCommand(aliasRaw, modelRaw, runtime) {
	const alias = normalizeAlias(aliasRaw);
	const resolved = resolveModelTarget({
		raw: modelRaw,
		cfg: await loadModelsConfig({
			commandName: "models aliases add",
			runtime
		})
	});
	await updateConfig((cfg) => {
		const modelKey = `${resolved.provider}/${resolved.model}`;
		const nextModels = { ...cfg.agents?.defaults?.models };
		for (const [key, entry] of Object.entries(nextModels)) {
			const existing = entry?.alias?.trim();
			if (existing && existing === alias && key !== modelKey) throw new Error(`Alias ${alias} already points to ${key}.`);
		}
		nextModels[modelKey] = {
			...nextModels[modelKey] ?? {},
			alias
		};
		return {
			...cfg,
			agents: {
				...cfg.agents,
				defaults: {
					...cfg.agents?.defaults,
					models: nextModels
				}
			}
		};
	});
	logConfigUpdated(runtime);
	runtime.log(`Alias ${alias} -> ${resolved.provider}/${resolved.model}`);
}
async function modelsAliasesRemoveCommand(aliasRaw, runtime) {
	const alias = normalizeAlias(aliasRaw);
	const updated = await updateConfig((cfg) => {
		const nextModels = { ...cfg.agents?.defaults?.models };
		let found = false;
		for (const [key, entry] of Object.entries(nextModels)) if (entry?.alias?.trim() === alias) {
			nextModels[key] = {
				...entry,
				alias: void 0
			};
			found = true;
			break;
		}
		if (!found) throw new Error(`Alias not found: ${alias}`);
		return {
			...cfg,
			agents: {
				...cfg.agents,
				defaults: {
					...cfg.agents?.defaults,
					models: nextModels
				}
			}
		};
	});
	logConfigUpdated(runtime);
	if (!updated.agents?.defaults?.models || Object.values(updated.agents.defaults.models).every((entry) => !entry?.alias?.trim())) runtime.log("No aliases configured.");
}
//#endregion
//#region src/commands/models/auth.ts
function guardCancel(value) {
	if (typeof value === "symbol" || isCancel(value)) {
		cancel("Cancelled.");
		process.exit(0);
	}
	return value;
}
const confirm$1 = async (params) => guardCancel(await confirm({
	...params,
	message: stylePromptMessage(params.message)
}));
const text$1 = async (params) => guardCancel(await text({
	...params,
	message: stylePromptMessage(params.message)
}));
const select$1 = async (params) => guardCancel(await select({
	...params,
	message: stylePromptMessage(params.message),
	options: params.options.map((opt) => opt.hint === void 0 ? opt : {
		...opt,
		hint: stylePromptHint(opt.hint)
	})
}));
function resolveDefaultTokenProfileId(provider) {
	return `${normalizeProviderId(provider)}:manual`;
}
function listProvidersWithAuthMethods(providers) {
	return providers.filter((provider) => provider.auth.length > 0);
}
function listTokenAuthMethods(provider) {
	return provider.auth.filter((method) => method.kind === "token");
}
function listProvidersWithTokenMethods(providers) {
	return providers.filter((provider) => listTokenAuthMethods(provider).length > 0);
}
async function resolveModelsAuthContext() {
	const config = await loadValidConfigOrThrow();
	const defaultAgentId = resolveDefaultAgentId(config);
	const agentDir = resolveAgentDir(config, defaultAgentId);
	const workspaceDir = resolveAgentWorkspaceDir(config, defaultAgentId) ?? resolveDefaultAgentWorkspaceDir();
	return {
		config,
		agentDir,
		workspaceDir,
		providers: resolvePluginProviders({
			config,
			workspaceDir,
			bundledProviderAllowlistCompat: true,
			bundledProviderVitestCompat: true
		})
	};
}
function resolveRequestedProviderOrThrow(providers, rawProvider) {
	const requested = rawProvider?.trim();
	if (!requested) return null;
	const matched = resolveProviderMatch(providers, requested);
	if (matched) return matched;
	const available = providers.map((provider) => provider.id).filter(Boolean).toSorted((a, b) => a.localeCompare(b));
	const availableText = available.length > 0 ? available.join(", ") : "(none)";
	throw new Error(`Unknown provider "${requested}". Loaded providers: ${availableText}. Verify plugins via \`${formatCliCommand("openclaw plugins list --json")}\`.`);
}
function resolveTokenMethodOrThrow(provider, rawMethod) {
	const tokenMethods = listTokenAuthMethods(provider);
	if (rawMethod?.trim()) {
		const matched = pickAuthMethod(provider, rawMethod);
		if (matched && matched.kind === "token") return matched;
		const available = tokenMethods.map((method) => method.id).join(", ") || "(none)";
		throw new Error(`Unknown token auth method "${rawMethod}" for provider "${provider.id}". Available token methods: ${available}.`);
	}
	return null;
}
async function pickProviderAuthMethod(params) {
	const requestedMethod = pickAuthMethod(params.provider, params.requestedMethod);
	if (requestedMethod) return requestedMethod;
	if (params.provider.auth.length === 1) return params.provider.auth[0] ?? null;
	return await params.prompter.select({
		message: `Auth method for ${params.provider.label}`,
		options: params.provider.auth.map((method) => ({
			value: method.id,
			label: method.label,
			hint: method.hint
		}))
	}).then((id) => params.provider.auth.find((method) => method.id === String(id)) ?? null);
}
async function pickProviderTokenMethod(params) {
	const explicitTokenMethod = resolveTokenMethodOrThrow(params.provider, params.requestedMethod);
	if (explicitTokenMethod) return explicitTokenMethod;
	const tokenMethods = listTokenAuthMethods(params.provider);
	if (tokenMethods.length === 0) return null;
	const setupTokenMethod = tokenMethods.find((method) => method.id === "setup-token");
	if (setupTokenMethod) return setupTokenMethod;
	if (tokenMethods.length === 1) return tokenMethods[0] ?? null;
	return await params.prompter.select({
		message: `Token method for ${params.provider.label}`,
		options: tokenMethods.map((method) => ({
			value: method.id,
			label: method.label,
			hint: method.hint
		}))
	}).then((id) => tokenMethods.find((method) => method.id === String(id)) ?? null);
}
async function persistProviderAuthResult(params) {
	for (const profile of params.result.profiles) upsertAuthProfile({
		profileId: profile.profileId,
		credential: profile.credential,
		agentDir: params.agentDir
	});
	await updateConfig((cfg) => {
		let next = cfg;
		if (params.result.configPatch) next = mergeConfigPatch(next, params.result.configPatch);
		for (const profile of params.result.profiles) next = applyAuthProfileConfig(next, {
			profileId: profile.profileId,
			provider: profile.credential.provider,
			mode: credentialMode(profile.credential)
		});
		if (params.setDefault && params.result.defaultModel) next = applyDefaultModel(next, params.result.defaultModel);
		return next;
	});
	logConfigUpdated(params.runtime);
	for (const profile of params.result.profiles) params.runtime.log(`Auth profile: ${profile.profileId} (${profile.credential.provider}/${credentialMode(profile.credential)})`);
	if (params.result.defaultModel) params.runtime.log(params.setDefault ? `Default model set to ${params.result.defaultModel}` : `Default model available: ${params.result.defaultModel} (use --set-default to apply)`);
	if (params.result.notes && params.result.notes.length > 0) await params.prompter.note(params.result.notes.join("\n"), "Provider notes");
}
async function runProviderAuthMethod(params) {
	await clearStaleProfileLockouts(params.provider.id, params.agentDir);
	await persistProviderAuthResult({
		result: await params.method.run({
			config: params.config,
			agentDir: params.agentDir,
			workspaceDir: params.workspaceDir,
			prompter: params.prompter,
			runtime: params.runtime,
			allowSecretRefPrompt: false,
			isRemote: isRemoteEnvironment(),
			openUrl: async (url) => {
				await openUrl(url);
			},
			oauth: { createVpsAwareHandlers: (runtimeParams) => createVpsAwareOAuthHandlers(runtimeParams) }
		}),
		agentDir: params.agentDir,
		runtime: params.runtime,
		prompter: params.prompter,
		setDefault: params.setDefault
	});
}
async function modelsAuthSetupTokenCommand(opts, runtime) {
	if (!process.stdin.isTTY) throw new Error("setup-token requires an interactive TTY.");
	const { config, agentDir, workspaceDir, providers } = await resolveModelsAuthContext();
	const tokenProviders = listProvidersWithTokenMethods(providers);
	if (tokenProviders.length === 0) throw new Error(`No provider token-auth plugins found. Install one via \`${formatCliCommand("openclaw plugins install")}\`.`);
	const provider = resolveRequestedProviderOrThrow(tokenProviders, opts.provider ?? "anthropic") ?? tokenProviders.find((candidate) => normalizeProviderId(candidate.id) === "anthropic") ?? tokenProviders[0] ?? null;
	if (!provider) throw new Error("No token-capable provider is available.");
	if (!opts.yes) {
		if (!await confirm$1({
			message: `Continue with ${provider.label} token auth?`,
			initialValue: true
		})) return;
	}
	const prompter = createClackPrompter();
	const method = await pickProviderTokenMethod({
		provider,
		prompter
	});
	if (!method) throw new Error(`Provider "${provider.id}" does not expose a token auth method.`);
	await runProviderAuthMethod({
		config,
		agentDir,
		workspaceDir,
		provider,
		method,
		runtime,
		prompter
	});
}
async function modelsAuthPasteTokenCommand(opts, runtime) {
	const rawProvider = opts.provider?.trim();
	if (!rawProvider) throw new Error("Missing --provider.");
	const provider = normalizeProviderId(rawProvider);
	const profileId = opts.profileId?.trim() || resolveDefaultTokenProfileId(provider);
	const tokenInput = await text$1({
		message: `Paste token for ${provider}`,
		validate: (value) => value?.trim() ? void 0 : "Required"
	});
	const token = String(tokenInput ?? "").trim();
	const expires = opts.expiresIn?.trim() && opts.expiresIn.trim().length > 0 ? Date.now() + parseDurationMs(String(opts.expiresIn ?? "").trim(), { defaultUnit: "d" }) : void 0;
	upsertAuthProfile({
		profileId,
		credential: {
			type: "token",
			provider,
			token,
			...expires ? { expires } : {}
		}
	});
	await updateConfig((cfg) => applyAuthProfileConfig(cfg, {
		profileId,
		provider,
		mode: "token"
	}));
	logConfigUpdated(runtime);
	runtime.log(`Auth profile: ${profileId} (${provider}/token)`);
}
async function modelsAuthAddCommand(_opts, runtime) {
	const { config, agentDir, workspaceDir, providers } = await resolveModelsAuthContext();
	const tokenProviders = listProvidersWithTokenMethods(providers);
	const provider = await select$1({
		message: "Token provider",
		options: [...tokenProviders.map((providerPlugin) => ({
			value: providerPlugin.id,
			label: providerPlugin.id,
			hint: providerPlugin.docsPath ? `Docs: ${providerPlugin.docsPath}` : void 0
		})), {
			value: "custom",
			label: "custom (type provider id)"
		}]
	});
	const providerId = provider === "custom" ? normalizeProviderId(String(await text$1({
		message: "Provider id",
		validate: (value) => value?.trim() ? void 0 : "Required"
	}))) : provider;
	const providerPlugin = provider === "custom" ? null : resolveRequestedProviderOrThrow(tokenProviders, providerId);
	if (providerPlugin) {
		const tokenMethods = listTokenAuthMethods(providerPlugin);
		const methodId = tokenMethods.length > 0 ? await select$1({
			message: "Token method",
			options: [...tokenMethods.map((method) => ({
				value: method.id,
				label: method.label,
				hint: method.hint
			})), {
				value: "paste",
				label: "paste token"
			}]
		}) : "paste";
		if (methodId !== "paste") {
			const prompter = createClackPrompter();
			const method = tokenMethods.find((candidate) => candidate.id === methodId);
			if (!method) throw new Error(`Unknown token auth method "${String(methodId)}".`);
			await runProviderAuthMethod({
				config,
				agentDir,
				workspaceDir,
				provider: providerPlugin,
				method,
				runtime,
				prompter
			});
			return;
		}
	}
	const profileIdDefault = resolveDefaultTokenProfileId(providerId);
	await modelsAuthPasteTokenCommand({
		provider: providerId,
		profileId: String(await text$1({
			message: "Profile id",
			initialValue: profileIdDefault,
			validate: (value) => value?.trim() ? void 0 : "Required"
		})).trim(),
		expiresIn: await confirm$1({
			message: "Does this token expire?",
			initialValue: false
		}) ? String(await text$1({
			message: "Expires in (duration)",
			initialValue: "365d",
			validate: (value) => {
				try {
					parseDurationMs(String(value ?? ""), { defaultUnit: "d" });
					return;
				} catch {
					return "Invalid duration (e.g. 365d, 12h, 30m)";
				}
			}
		})).trim() : void 0
	}, runtime);
}
/**
* Clear stale cooldown/disabled state for all profiles matching a provider.
* When a user explicitly runs `models auth login`, they intend to fix auth —
* stale `auth_permanent` / `billing` lockouts should not persist across
* a deliberate re-authentication attempt.
*/
async function clearStaleProfileLockouts(provider, agentDir) {
	try {
		const store = loadAuthProfileStoreForRuntime(agentDir);
		const profileIds = listProfilesForProvider(store, provider);
		for (const profileId of profileIds) await clearAuthProfileCooldown({
			store,
			profileId,
			agentDir
		});
	} catch {}
}
function resolveRequestedLoginProviderOrThrow(providers, rawProvider) {
	return resolveRequestedProviderOrThrow(providers, rawProvider);
}
function credentialMode(credential) {
	if (credential.type === "api_key") return "api_key";
	if (credential.type === "token") return "token";
	return "oauth";
}
async function modelsAuthLoginCommand(opts, runtime) {
	if (!process.stdin.isTTY) throw new Error("models auth login requires an interactive TTY.");
	const { config, agentDir, workspaceDir, providers } = await resolveModelsAuthContext();
	const prompter = createClackPrompter();
	const authProviders = listProvidersWithAuthMethods(providers);
	if (authProviders.length === 0) throw new Error(`No provider plugins found. Install one via \`${formatCliCommand("openclaw plugins install")}\`.`);
	const selectedProvider = resolveRequestedLoginProviderOrThrow(authProviders, opts.provider) ?? await prompter.select({
		message: "Select a provider",
		options: authProviders.map((provider) => ({
			value: provider.id,
			label: provider.label,
			hint: provider.docsPath ? `Docs: ${provider.docsPath}` : void 0
		}))
	}).then((id) => resolveProviderMatch(authProviders, String(id)));
	if (!selectedProvider) throw new Error("Unknown provider. Use --provider <id> to pick a provider plugin.");
	const chosenMethod = await pickProviderAuthMethod({
		provider: selectedProvider,
		requestedMethod: opts.method,
		prompter
	});
	if (!chosenMethod) throw new Error("Unknown auth method. Use --method <id> to select one.");
	await runProviderAuthMethod({
		config,
		agentDir,
		workspaceDir,
		provider: selectedProvider,
		method: chosenMethod,
		runtime,
		prompter,
		setDefault: opts.setDefault
	});
}
//#endregion
//#region src/commands/models/auth-order.ts
init_utils();
function resolveTargetAgent(cfg, raw) {
	const agentId = resolveKnownAgentId({
		cfg,
		rawAgentId: raw
	}) ?? resolveDefaultAgentId(cfg);
	return {
		agentId,
		agentDir: resolveAgentDir(cfg, agentId)
	};
}
function describeOrder(store, provider) {
	const providerKey = normalizeProviderId(provider);
	const order = store.order?.[providerKey];
	return Array.isArray(order) ? order : [];
}
async function resolveAuthOrderContext(opts, runtime) {
	const rawProvider = opts.provider?.trim();
	if (!rawProvider) throw new Error("Missing --provider.");
	const provider = normalizeProviderId(rawProvider);
	const cfg = await loadModelsConfig({
		commandName: "models auth-order",
		runtime
	});
	const { agentId, agentDir } = resolveTargetAgent(cfg, opts.agent);
	return {
		cfg,
		agentId,
		agentDir,
		provider
	};
}
async function modelsAuthOrderGetCommand(opts, runtime) {
	const { agentId, agentDir, provider } = await resolveAuthOrderContext(opts, runtime);
	const order = describeOrder(ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false }), provider);
	if (opts.json) {
		runtime.log(JSON.stringify({
			agentId,
			agentDir,
			provider,
			authStorePath: shortenHomePath(`${agentDir}/auth-profiles.json`),
			order: order.length > 0 ? order : null
		}, null, 2));
		return;
	}
	runtime.log(`Agent: ${agentId}`);
	runtime.log(`Provider: ${provider}`);
	runtime.log(`Auth file: ${shortenHomePath(`${agentDir}/auth-profiles.json`)}`);
	runtime.log(order.length > 0 ? `Order override: ${order.join(", ")}` : "Order override: (none)");
}
async function modelsAuthOrderClearCommand(opts, runtime) {
	const { agentId, agentDir, provider } = await resolveAuthOrderContext(opts, runtime);
	if (!await setAuthProfileOrder({
		agentDir,
		provider,
		order: null
	})) throw new Error("Failed to update auth-profiles.json (lock busy?).");
	runtime.log(`Agent: ${agentId}`);
	runtime.log(`Provider: ${provider}`);
	runtime.log("Cleared per-agent order override.");
}
async function modelsAuthOrderSetCommand(opts, runtime) {
	const { agentId, agentDir, provider } = await resolveAuthOrderContext(opts, runtime);
	const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
	const providerKey = provider;
	const requested = normalizeStringEntries(opts.order ?? []);
	if (requested.length === 0) throw new Error("Missing profile ids. Provide one or more profile ids.");
	for (const profileId of requested) {
		const cred = store.profiles[profileId];
		if (!cred) throw new Error(`Auth profile "${profileId}" not found in ${agentDir}.`);
		if (normalizeProviderId(cred.provider) !== providerKey) throw new Error(`Auth profile "${profileId}" is for ${cred.provider}, not ${provider}.`);
	}
	const updated = await setAuthProfileOrder({
		agentDir,
		provider,
		order: requested
	});
	if (!updated) throw new Error("Failed to update auth-profiles.json (lock busy?).");
	runtime.log(`Agent: ${agentId}`);
	runtime.log(`Provider: ${provider}`);
	runtime.log(`Order override: ${describeOrder(updated, provider).join(", ")}`);
}
//#endregion
//#region src/commands/models/fallbacks-shared.ts
function getFallbacks(cfg, key) {
	return resolveAgentModelFallbackValues(cfg.agents?.defaults?.[key]);
}
function patchDefaultsFallbacks(cfg, params) {
	const existing = toAgentModelListLike(cfg.agents?.defaults?.[params.key]);
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...cfg.agents?.defaults,
				[params.key]: mergePrimaryFallbackConfig(existing, { fallbacks: params.fallbacks }),
				...params.models ? { models: params.models } : void 0
			}
		}
	};
}
async function listFallbacksCommand(params, opts, runtime) {
	ensureFlagCompatibility(opts);
	const fallbacks = getFallbacks(await loadModelsConfig({
		commandName: `models ${params.key} list`,
		runtime
	}), params.key);
	if (opts.json) {
		runtime.log(JSON.stringify({ fallbacks }, null, 2));
		return;
	}
	if (opts.plain) {
		for (const entry of fallbacks) runtime.log(entry);
		return;
	}
	runtime.log(`${params.label} (${fallbacks.length}):`);
	if (fallbacks.length === 0) {
		runtime.log("- none");
		return;
	}
	for (const entry of fallbacks) runtime.log(`- ${entry}`);
}
async function addFallbackCommand(params, modelRaw, runtime) {
	const updated = await updateConfig((cfg) => {
		const resolved = resolveModelTarget({
			raw: modelRaw,
			cfg
		});
		const nextModels = { ...cfg.agents?.defaults?.models };
		const targetKey = upsertCanonicalModelConfigEntry(nextModels, resolved);
		const existing = getFallbacks(cfg, params.key);
		if (resolveModelKeysFromEntries({
			cfg,
			entries: existing
		}).includes(targetKey)) return cfg;
		return patchDefaultsFallbacks(cfg, {
			key: params.key,
			fallbacks: [...existing, targetKey],
			models: nextModels
		});
	});
	logConfigUpdated(runtime);
	runtime.log(`${params.logPrefix}: ${getFallbacks(updated, params.key).join(", ")}`);
}
async function removeFallbackCommand(params, modelRaw, runtime) {
	const updated = await updateConfig((cfg) => {
		const resolved = resolveModelTarget({
			raw: modelRaw,
			cfg
		});
		const targetKey = modelKey(resolved.provider, resolved.model);
		const aliasIndex = buildModelAliasIndex({
			cfg,
			defaultProvider: DEFAULT_PROVIDER
		});
		const existing = getFallbacks(cfg, params.key);
		const filtered = existing.filter((entry) => {
			const resolvedEntry = resolveModelRefFromString({
				raw: String(entry ?? ""),
				defaultProvider: DEFAULT_PROVIDER,
				aliasIndex
			});
			if (!resolvedEntry) return true;
			return modelKey(resolvedEntry.ref.provider, resolvedEntry.ref.model) !== targetKey;
		});
		if (filtered.length === existing.length) throw new Error(`${params.notFoundLabel} not found: ${targetKey}`);
		return patchDefaultsFallbacks(cfg, {
			key: params.key,
			fallbacks: filtered
		});
	});
	logConfigUpdated(runtime);
	runtime.log(`${params.logPrefix}: ${getFallbacks(updated, params.key).join(", ")}`);
}
async function clearFallbacksCommand(params, runtime) {
	await updateConfig((cfg) => {
		return patchDefaultsFallbacks(cfg, {
			key: params.key,
			fallbacks: []
		});
	});
	logConfigUpdated(runtime);
	runtime.log(params.clearedMessage);
}
//#endregion
//#region src/commands/models/fallbacks.ts
async function modelsFallbacksListCommand(opts, runtime) {
	return await listFallbacksCommand({
		label: "Fallbacks",
		key: "model"
	}, opts, runtime);
}
async function modelsFallbacksAddCommand(modelRaw, runtime) {
	return await addFallbackCommand({
		label: "Fallbacks",
		key: "model",
		logPrefix: "Fallbacks"
	}, modelRaw, runtime);
}
async function modelsFallbacksRemoveCommand(modelRaw, runtime) {
	return await removeFallbackCommand({
		label: "Fallbacks",
		key: "model",
		notFoundLabel: "Fallback",
		logPrefix: "Fallbacks"
	}, modelRaw, runtime);
}
async function modelsFallbacksClearCommand(runtime) {
	return await clearFallbacksCommand({
		key: "model",
		clearedMessage: "Fallback list cleared."
	}, runtime);
}
//#endregion
//#region src/commands/models/image-fallbacks.ts
async function modelsImageFallbacksListCommand(opts, runtime) {
	return await listFallbacksCommand({
		label: "Image fallbacks",
		key: "imageModel"
	}, opts, runtime);
}
async function modelsImageFallbacksAddCommand(modelRaw, runtime) {
	return await addFallbackCommand({
		label: "Image fallbacks",
		key: "imageModel",
		logPrefix: "Image fallbacks"
	}, modelRaw, runtime);
}
async function modelsImageFallbacksRemoveCommand(modelRaw, runtime) {
	return await removeFallbackCommand({
		label: "Image fallbacks",
		key: "imageModel",
		notFoundLabel: "Image fallback",
		logPrefix: "Image fallbacks"
	}, modelRaw, runtime);
}
async function modelsImageFallbacksClearCommand(runtime) {
	return await clearFallbacksCommand({
		key: "imageModel",
		clearedMessage: "Image fallback list cleared."
	}, runtime);
}
//#endregion
//#region src/commands/models/list.configured.ts
function resolveConfiguredEntries(cfg) {
	const resolvedDefault = resolveConfiguredModelRef({
		cfg,
		defaultProvider: DEFAULT_PROVIDER,
		defaultModel: DEFAULT_MODEL
	});
	const aliasIndex = buildModelAliasIndex({
		cfg,
		defaultProvider: DEFAULT_PROVIDER
	});
	const order = [];
	const tagsByKey = /* @__PURE__ */ new Map();
	const aliasesByKey = /* @__PURE__ */ new Map();
	for (const [key, aliases] of aliasIndex.byKey.entries()) aliasesByKey.set(key, aliases);
	const addEntry = (ref, tag) => {
		const key = modelKey(ref.provider, ref.model);
		if (!tagsByKey.has(key)) {
			tagsByKey.set(key, /* @__PURE__ */ new Set());
			order.push(key);
		}
		tagsByKey.get(key)?.add(tag);
	};
	const addResolvedModelRef = (raw, tag) => {
		const resolved = resolveModelRefFromString({
			raw,
			defaultProvider: DEFAULT_PROVIDER,
			aliasIndex
		});
		if (resolved) addEntry(resolved.ref, tag);
	};
	addEntry(resolvedDefault, "default");
	const modelFallbacks = resolveAgentModelFallbackValues(cfg.agents?.defaults?.model);
	const imageFallbacks = resolveAgentModelFallbackValues(cfg.agents?.defaults?.imageModel);
	const imagePrimary = resolveAgentModelPrimaryValue(cfg.agents?.defaults?.imageModel) ?? "";
	modelFallbacks.forEach((raw, idx) => {
		addResolvedModelRef(String(raw ?? ""), `fallback#${idx + 1}`);
	});
	if (imagePrimary) addResolvedModelRef(imagePrimary, "image");
	imageFallbacks.forEach((raw, idx) => {
		addResolvedModelRef(String(raw ?? ""), `img-fallback#${idx + 1}`);
	});
	for (const key of Object.keys(cfg.agents?.defaults?.models ?? {})) {
		const parsed = parseModelRef(String(key ?? ""), DEFAULT_PROVIDER);
		if (!parsed) continue;
		addEntry(parsed, "configured");
	}
	return { entries: order.map((key) => {
		const slash = key.indexOf("/");
		return {
			key,
			ref: {
				provider: slash === -1 ? key : key.slice(0, slash),
				model: slash === -1 ? "" : key.slice(slash + 1)
			},
			tags: tagsByKey.get(key) ?? /* @__PURE__ */ new Set(),
			aliases: aliasesByKey.get(key) ?? []
		};
	}) };
}
//#endregion
//#region src/commands/models/list.errors.ts
const MODEL_AVAILABILITY_UNAVAILABLE_CODE = "MODEL_AVAILABILITY_UNAVAILABLE";
function formatErrorWithStack(err) {
	if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
	return String(err);
}
function shouldFallbackToAuthHeuristics(err) {
	if (!(err instanceof Error)) return false;
	return err.code === MODEL_AVAILABILITY_UNAVAILABLE_CODE;
}
//#endregion
//#region src/commands/models/list.registry.ts
const hasAuthForProvider = (provider, cfg, authStore) => {
	if (!cfg || !authStore) return false;
	if (listProfilesForProvider(authStore, provider).length > 0) return true;
	if (provider === "amazon-bedrock" && resolveAwsSdkEnvVarName()) return true;
	if (resolveEnvApiKey(provider)) return true;
	if (hasUsableCustomProviderApiKey(cfg, provider)) return true;
	return false;
};
function createAvailabilityUnavailableError(message) {
	const err = new Error(message);
	err.code = MODEL_AVAILABILITY_UNAVAILABLE_CODE;
	return err;
}
function normalizeAvailabilityError(err) {
	if (shouldFallbackToAuthHeuristics(err) && err instanceof Error) return err;
	return createAvailabilityUnavailableError(`Model availability unavailable: getAvailable() failed.\n${formatErrorWithStack(err)}`);
}
function validateAvailableModels(availableModels) {
	if (!Array.isArray(availableModels)) throw createAvailabilityUnavailableError("Model availability unavailable: getAvailable() returned a non-array value.");
	for (const model of availableModels) if (!model || typeof model !== "object" || typeof model.provider !== "string" || typeof model.id !== "string") throw createAvailabilityUnavailableError("Model availability unavailable: getAvailable() returned invalid model entries.");
	return availableModels;
}
function loadAvailableModels(registry) {
	let availableModels;
	try {
		availableModels = registry.getAvailable();
	} catch (err) {
		throw normalizeAvailabilityError(err);
	}
	try {
		return validateAvailableModels(availableModels).filter((model) => !shouldSuppressBuiltInModel({
			provider: model.provider,
			id: model.id
		}));
	} catch (err) {
		throw normalizeAvailabilityError(err);
	}
}
async function loadModelRegistry(_cfg, _opts) {
	const agentDir = resolveOpenClawAgentDir();
	const registry = discoverModels(discoverAuthStorage(agentDir), agentDir);
	const models = registry.getAll().filter((model) => !shouldSuppressBuiltInModel({
		provider: model.provider,
		id: model.id
	}));
	let availableKeys;
	let availabilityErrorMessage;
	try {
		const availableModels = loadAvailableModels(registry);
		availableKeys = new Set(availableModels.map((model) => modelKey(model.provider, model.id)));
	} catch (err) {
		if (!shouldFallbackToAuthHeuristics(err)) throw err;
		availableKeys = void 0;
		if (!availabilityErrorMessage) availabilityErrorMessage = formatErrorWithStack(err);
	}
	return {
		registry,
		models,
		availableKeys,
		availabilityErrorMessage
	};
}
function toModelRow(params) {
	const { model, key, tags, aliases = [], availableKeys, cfg, authStore, allowProviderAvailabilityFallback = false } = params;
	if (!model) return {
		key,
		name: key,
		input: "-",
		contextWindow: null,
		local: null,
		available: null,
		tags: [...tags, "missing"],
		missing: true
	};
	const input = model.input.join("+") || "text";
	const local = isLocalBaseUrl(model.baseUrl);
	const modelIsAvailable = availableKeys?.has(modelKey(model.provider, model.id)) ?? false;
	const available = availableKeys !== void 0 && !allowProviderAvailabilityFallback ? modelIsAvailable : modelIsAvailable || (cfg && authStore ? hasAuthForProvider(model.provider, cfg, authStore) : false);
	const aliasTags = aliases.length > 0 ? [`alias:${aliases.join(",")}`] : [];
	const mergedTags = new Set(tags);
	if (aliasTags.length > 0) {
		for (const tag of mergedTags) if (tag === "alias" || tag.startsWith("alias:")) mergedTags.delete(tag);
		for (const tag of aliasTags) mergedTags.add(tag);
	}
	return {
		key,
		name: model.name || model.id,
		input,
		contextWindow: model.contextWindow ?? null,
		local,
		available,
		tags: Array.from(mergedTags),
		missing: false
	};
}
//#endregion
//#region src/commands/models/list.rows.ts
function matchesRowFilter(filter, model) {
	if (filter.provider && model.provider.toLowerCase() !== filter.provider) return false;
	if (filter.local && !isLocalBaseUrl(model.baseUrl ?? "")) return false;
	return true;
}
function buildRow(params) {
	const configured = params.context.configuredByKey.get(params.key);
	return toModelRow({
		model: params.model,
		key: params.key,
		tags: configured ? Array.from(configured.tags) : [],
		aliases: configured?.aliases ?? [],
		availableKeys: params.context.availableKeys,
		cfg: params.context.cfg,
		authStore: params.context.authStore,
		allowProviderAvailabilityFallback: params.allowProviderAvailabilityFallback ?? false
	});
}
async function loadListModelRegistry(cfg, opts) {
	const loaded = await loadModelRegistry(cfg, opts);
	return {
		...loaded,
		discoveredKeys: new Set(loaded.models.map((model) => modelKey(model.provider, model.id)))
	};
}
function appendDiscoveredRows(params) {
	const seenKeys = /* @__PURE__ */ new Set();
	const sorted = [...params.models].toSorted((a, b) => {
		const providerCompare = a.provider.localeCompare(b.provider);
		if (providerCompare !== 0) return providerCompare;
		return a.id.localeCompare(b.id);
	});
	for (const model of sorted) {
		if (shouldSuppressBuiltInModel({
			provider: model.provider,
			id: model.id
		})) continue;
		if (!matchesRowFilter(params.context.filter, model)) continue;
		const key = modelKey(model.provider, model.id);
		params.rows.push(buildRow({
			model,
			key,
			context: params.context
		}));
		seenKeys.add(key);
	}
	return seenKeys;
}
async function appendCatalogSupplementRows(params) {
	const catalog = await loadModelCatalog({ config: params.context.cfg });
	for (const entry of catalog) {
		if (params.context.filter.provider && entry.provider.toLowerCase() !== params.context.filter.provider) continue;
		const key = modelKey(entry.provider, entry.id);
		if (params.seenKeys.has(key)) continue;
		const model = resolveModelWithRegistry({
			provider: entry.provider,
			modelId: entry.id,
			modelRegistry: params.modelRegistry,
			cfg: params.context.cfg
		});
		if (!model || !matchesRowFilter(params.context.filter, model)) continue;
		params.rows.push(buildRow({
			model,
			key,
			context: params.context,
			allowProviderAvailabilityFallback: !params.context.discoveredKeys.has(key)
		}));
		params.seenKeys.add(key);
	}
}
function appendConfiguredRows(params) {
	for (const entry of params.entries) {
		if (params.context.filter.provider && entry.ref.provider.toLowerCase() !== params.context.filter.provider) continue;
		const model = resolveModelWithRegistry({
			provider: entry.ref.provider,
			modelId: entry.ref.model,
			modelRegistry: params.modelRegistry,
			cfg: params.context.cfg
		});
		if (params.context.filter.local && model && !isLocalBaseUrl(model.baseUrl ?? "")) continue;
		if (params.context.filter.local && !model) continue;
		params.rows.push(toModelRow({
			model,
			key: entry.key,
			tags: Array.from(entry.tags),
			aliases: entry.aliases,
			availableKeys: params.context.availableKeys,
			cfg: params.context.cfg,
			authStore: params.context.authStore,
			allowProviderAvailabilityFallback: model ? !params.context.discoveredKeys.has(modelKey(model.provider, model.id)) : false
		}));
	}
}
//#endregion
//#region src/commands/models/list.format.ts
init_theme();
const isRich = (opts) => Boolean(isRich$1() && !opts?.json && !opts?.plain);
const pad = (value, size) => value.padEnd(size);
const formatTag = (tag, rich) => {
	if (!rich) return tag;
	if (tag === "default") return theme.success(tag);
	if (tag === "image") return theme.accentBright(tag);
	if (tag === "configured") return theme.accent(tag);
	if (tag === "missing") return theme.error(tag);
	if (tag.startsWith("fallback#")) return theme.warn(tag);
	if (tag.startsWith("img-fallback#")) return theme.warn(tag);
	if (tag.startsWith("alias:")) return theme.accentDim(tag);
	return theme.muted(tag);
};
const truncate = (value, max) => {
	if (value.length <= max) return value;
	if (max <= 3) return value.slice(0, max);
	return `${value.slice(0, max - 3)}...`;
};
//#endregion
//#region src/commands/models/list.table.ts
init_theme();
const MODEL_PAD$1 = 42;
const INPUT_PAD = 10;
const CTX_PAD$1 = 8;
const LOCAL_PAD = 5;
const AUTH_PAD = 5;
function printModelTable(rows, runtime, opts = {}) {
	if (opts.json) {
		runtime.log(JSON.stringify({
			count: rows.length,
			models: rows
		}, null, 2));
		return;
	}
	if (opts.plain) {
		for (const row of rows) runtime.log(row.key);
		return;
	}
	const rich = isRich(opts);
	const header = [
		pad("Model", MODEL_PAD$1),
		pad("Input", INPUT_PAD),
		pad("Ctx", CTX_PAD$1),
		pad("Local", LOCAL_PAD),
		pad("Auth", AUTH_PAD),
		"Tags"
	].join(" ");
	runtime.log(rich ? theme.heading(header) : header);
	for (const row of rows) {
		const keyLabel = pad(truncate(row.key, MODEL_PAD$1), MODEL_PAD$1);
		const inputLabel = pad(row.input || "-", INPUT_PAD);
		const ctxLabel = pad(formatTokenK(row.contextWindow), CTX_PAD$1);
		const localLabel = pad(row.local === null ? "-" : row.local ? "yes" : "no", LOCAL_PAD);
		const authLabel = pad(row.available === null ? "-" : row.available ? "yes" : "no", AUTH_PAD);
		const tagsLabel = row.tags.length > 0 ? rich ? row.tags.map((tag) => formatTag(tag, rich)).join(",") : row.tags.join(",") : "";
		const coloredInput = colorize(rich, row.input.includes("image") ? theme.accentBright : theme.info, inputLabel);
		const coloredLocal = colorize(rich, row.local === null ? theme.muted : row.local ? theme.success : theme.muted, localLabel);
		const coloredAuth = colorize(rich, row.available === null ? theme.muted : row.available ? theme.success : theme.error, authLabel);
		const line = [
			rich ? theme.accent(keyLabel) : keyLabel,
			coloredInput,
			ctxLabel,
			coloredLocal,
			coloredAuth,
			tagsLabel
		].join(" ");
		runtime.log(line);
	}
}
//#endregion
//#region src/commands/models/list.list-command.ts
async function modelsListCommand(opts, runtime) {
	ensureFlagCompatibility(opts);
	const { ensureAuthProfileStore } = await import("./auth-profiles.runtime-Dsq48sF5.js");
	const { ensureOpenClawModelsJson } = await import("./models-config-Co0bLOzE.js");
	const { sourceConfig, resolvedConfig: cfg } = await loadModelsConfigWithSource({
		commandName: "models list",
		runtime
	});
	const authStore = ensureAuthProfileStore();
	const providerFilter = (() => {
		const raw = opts.provider?.trim();
		if (!raw) return;
		return parseModelRef(`${raw}/_`, "anthropic")?.provider ?? raw.toLowerCase();
	})();
	let modelRegistry;
	let discoveredKeys = /* @__PURE__ */ new Set();
	let availableKeys;
	let availabilityErrorMessage;
	try {
		await ensureOpenClawModelsJson(sourceConfig ?? cfg);
		const loaded = await loadListModelRegistry(cfg, { sourceConfig });
		modelRegistry = loaded.registry;
		discoveredKeys = loaded.discoveredKeys;
		availableKeys = loaded.availableKeys;
		availabilityErrorMessage = loaded.availabilityErrorMessage;
	} catch (err) {
		runtime.error(`Model registry unavailable:\n${formatErrorWithStack(err)}`);
		process.exitCode = 1;
		return;
	}
	if (availabilityErrorMessage !== void 0) runtime.error(`Model availability lookup failed; falling back to auth heuristics for discovered models: ${availabilityErrorMessage}`);
	const { entries } = resolveConfiguredEntries(cfg);
	const configuredByKey = new Map(entries.map((entry) => [entry.key, entry]));
	const rows = [];
	const rowContext = {
		cfg,
		authStore,
		availableKeys,
		configuredByKey,
		discoveredKeys,
		filter: {
			provider: providerFilter,
			local: opts.local
		}
	};
	if (opts.all) {
		const seenKeys = appendDiscoveredRows({
			rows,
			models: modelRegistry?.getAll() ?? [],
			context: rowContext
		});
		if (modelRegistry) await appendCatalogSupplementRows({
			rows,
			modelRegistry,
			context: rowContext,
			seenKeys
		});
	} else {
		const registry = modelRegistry;
		if (!registry) {
			runtime.error("Model registry unavailable.");
			process.exitCode = 1;
			return;
		}
		appendConfiguredRows({
			rows,
			entries,
			modelRegistry: registry,
			context: rowContext
		});
	}
	if (rows.length === 0) {
		runtime.log("No models found.");
		return;
	}
	printModelTable(rows, runtime, opts);
}
//#endregion
//#region src/commands/models/list.auth-overview.ts
init_utils();
function formatMarkerOrSecret(value) {
	return isNonSecretApiKeyMarker(value, { includeEnvVarName: false }) ? `marker(${value.trim()})` : maskApiKey(value);
}
function formatProfileSecretLabel(params) {
	const value = typeof params.value === "string" ? params.value.trim() : "";
	if (value) {
		const display = formatMarkerOrSecret(value);
		return params.kind === "token" ? `token:${display}` : display;
	}
	if (params.ref) {
		const refLabel = `ref(${params.ref.source}:${params.ref.id})`;
		return params.kind === "token" ? `token:${refLabel}` : refLabel;
	}
	return params.kind === "token" ? "token:missing" : "missing";
}
function resolveProviderAuthOverview(params) {
	const { provider, cfg, store } = params;
	const now = Date.now();
	const profiles = listProfilesForProvider(store, provider);
	const withUnusableSuffix = (base, profileId) => {
		const unusableUntil = resolveProfileUnusableUntilForDisplay(store, profileId);
		if (!unusableUntil || now >= unusableUntil) return base;
		const stats = store.usageStats?.[profileId];
		return `${base} [${typeof stats?.disabledUntil === "number" && now < stats.disabledUntil ? `disabled${stats.disabledReason ? `:${stats.disabledReason}` : ""}` : "cooldown"} ${formatRemainingShort(unusableUntil - now)}]`;
	};
	const labels = profiles.map((profileId) => {
		const profile = store.profiles[profileId];
		if (!profile) return `${profileId}=missing`;
		if (profile.type === "api_key") return withUnusableSuffix(`${profileId}=${formatProfileSecretLabel({
			value: profile.key,
			ref: profile.keyRef,
			kind: "api-key"
		})}`, profileId);
		if (profile.type === "token") return withUnusableSuffix(`${profileId}=${formatProfileSecretLabel({
			value: profile.token,
			ref: profile.tokenRef,
			kind: "token"
		})}`, profileId);
		const display = resolveAuthProfileDisplayLabel({
			cfg,
			store,
			profileId
		});
		const suffix = display === profileId ? "" : display.startsWith(profileId) ? display.slice(profileId.length).trim() : `(${display})`;
		return withUnusableSuffix(`${profileId}=OAuth${suffix ? ` ${suffix}` : ""}`, profileId);
	});
	const oauthCount = profiles.filter((id) => store.profiles[id]?.type === "oauth").length;
	const tokenCount = profiles.filter((id) => store.profiles[id]?.type === "token").length;
	const apiKeyCount = profiles.filter((id) => store.profiles[id]?.type === "api_key").length;
	const envKey = resolveEnvApiKey(provider);
	const customKey = getCustomProviderApiKey(cfg, provider);
	const usableCustomKey = resolveUsableCustomProviderApiKey({
		cfg,
		provider
	});
	return {
		provider,
		effective: (() => {
			if (profiles.length > 0) return {
				kind: "profiles",
				detail: shortenHomePath(resolveAuthStorePathForDisplay())
			};
			if (envKey) return {
				kind: "env",
				detail: envKey.source.includes("OAUTH_TOKEN") || envKey.source.toLowerCase().includes("oauth") ? "OAuth (env)" : maskApiKey(envKey.apiKey)
			};
			if (usableCustomKey) return {
				kind: "models.json",
				detail: formatMarkerOrSecret(usableCustomKey.apiKey)
			};
			return {
				kind: "missing",
				detail: "missing"
			};
		})(),
		profiles: {
			count: profiles.length,
			oauth: oauthCount,
			token: tokenCount,
			apiKey: apiKeyCount,
			labels
		},
		...envKey ? { env: {
			value: envKey.source.includes("OAUTH_TOKEN") || envKey.source.toLowerCase().includes("oauth") ? "OAuth (env)" : maskApiKey(envKey.apiKey),
			source: envKey.source
		} } : {},
		...customKey ? { modelsJson: {
			value: formatMarkerOrSecret(customKey),
			source: `models.json: ${shortenHomePath(params.modelsPath)}`
		} } : {}
	};
}
//#endregion
//#region src/commands/models/list.probe.ts
init_types_secrets();
const PROBE_PROMPT = "Reply with OK. Do not use tools.";
function mapFailoverReasonToProbeStatus(reason) {
	if (!reason) return "unknown";
	if (reason === "auth" || reason === "auth_permanent") return "auth";
	if (reason === "rate_limit" || reason === "overloaded") return "rate_limit";
	if (reason === "billing") return "billing";
	if (reason === "timeout") return "timeout";
	if (reason === "format") return "format";
	return "unknown";
}
function buildCandidateMap(modelCandidates) {
	const map = /* @__PURE__ */ new Map();
	for (const raw of modelCandidates) {
		const parsed = parseModelRef(String(raw ?? ""), DEFAULT_PROVIDER);
		if (!parsed) continue;
		const list = map.get(parsed.provider) ?? [];
		if (!list.includes(parsed.model)) list.push(parsed.model);
		map.set(parsed.provider, list);
	}
	return map;
}
function selectProbeModel(params) {
	const { provider, candidates, catalog } = params;
	const direct = candidates.get(provider);
	if (direct && direct.length > 0) return {
		provider,
		model: direct[0]
	};
	const fromCatalog = catalog.find((entry) => entry.provider === provider);
	if (fromCatalog) return {
		provider: fromCatalog.provider,
		model: fromCatalog.id
	};
	return null;
}
function mapEligibilityReasonToProbeReasonCode(reasonCode) {
	if (reasonCode === "missing_credential") return "missing_credential";
	if (reasonCode === "expired") return "expired";
	if (reasonCode === "invalid_expires") return "invalid_expires";
	if (reasonCode === "unresolved_ref") return "unresolved_ref";
	return "ineligible_profile";
}
function formatMissingCredentialProbeError(reasonCode) {
	const legacyLine = "Auth profile credentials are missing or expired.";
	if (reasonCode === "expired") return `${legacyLine}\n↳ Auth reason [expired]: token credentials are expired.`;
	if (reasonCode === "invalid_expires") return `${legacyLine}\n↳ Auth reason [invalid_expires]: token expires must be a positive Unix ms timestamp.`;
	if (reasonCode === "missing_credential") return `${legacyLine}\n↳ Auth reason [missing_credential]: no inline credential or SecretRef is configured.`;
	if (reasonCode === "unresolved_ref") return `${legacyLine}\n↳ Auth reason [unresolved_ref]: configured SecretRef could not be resolved.`;
	return `${legacyLine}\n↳ Auth reason [ineligible_profile]: profile is incompatible with provider config.`;
}
function resolveProbeSecretRef(profile, cfg) {
	const defaults = cfg.secrets?.defaults;
	if (profile.type === "api_key") {
		if (normalizeSecretInputString(profile.key) !== void 0) return null;
		return coerceSecretRef(profile.keyRef, defaults);
	}
	if (profile.type === "token") {
		if (normalizeSecretInputString(profile.token) !== void 0) return null;
		return coerceSecretRef(profile.tokenRef, defaults);
	}
	return null;
}
function formatUnresolvedRefProbeError(refLabel) {
	return `Auth profile credentials are missing or expired.\n↳ Auth reason [unresolved_ref]: could not resolve SecretRef "${refLabel}".`;
}
async function maybeResolveUnresolvedRefIssue(params) {
	if (!params.profile) return null;
	const ref = resolveProbeSecretRef(params.profile, params.cfg);
	if (!ref) return null;
	try {
		await resolveSecretRefString(ref, {
			config: params.cfg,
			env: process.env,
			cache: params.cache
		});
		return null;
	} catch {
		return {
			reasonCode: "unresolved_ref",
			error: formatUnresolvedRefProbeError(`${ref.source}:${ref.provider}:${ref.id}`)
		};
	}
}
async function buildProbeTargets(params) {
	const { cfg, providers, modelCandidates, options } = params;
	const store = ensureAuthProfileStore();
	const providerFilter = options.provider?.trim();
	const providerFilterKey = providerFilter ? normalizeProviderId(providerFilter) : null;
	const profileFilter = new Set((options.profileIds ?? []).map((id) => id.trim()).filter(Boolean));
	const refResolveCache = {};
	const catalog = await loadModelCatalog({ config: cfg });
	const candidates = buildCandidateMap(modelCandidates);
	const targets = [];
	const results = [];
	for (const provider of providers) {
		const providerKey = normalizeProviderId(provider);
		if (providerFilterKey && providerKey !== providerFilterKey) continue;
		const model = selectProbeModel({
			provider: providerKey,
			candidates,
			catalog
		});
		const profileIds = listProfilesForProvider(store, providerKey);
		const explicitOrder = findNormalizedProviderValue(store.order, providerKey) ?? findNormalizedProviderValue(cfg?.auth?.order, providerKey);
		const allowedProfiles = explicitOrder && explicitOrder.length > 0 ? new Set(resolveAuthProfileOrder({
			cfg,
			store,
			provider: providerKey
		})) : null;
		const filteredProfiles = profileFilter.size ? profileIds.filter((id) => profileFilter.has(id)) : profileIds;
		if (filteredProfiles.length > 0) {
			for (const profileId of filteredProfiles) {
				const profile = store.profiles[profileId];
				const mode = profile?.type;
				const label = resolveAuthProfileDisplayLabel({
					cfg,
					store,
					profileId
				});
				if (explicitOrder && !explicitOrder.includes(profileId)) {
					results.push({
						provider: providerKey,
						profileId,
						model: model ? `${model.provider}/${model.model}` : void 0,
						label,
						source: "profile",
						mode,
						status: "unknown",
						reasonCode: "excluded_by_auth_order",
						error: "Excluded by auth.order for this provider."
					});
					continue;
				}
				if (allowedProfiles && !allowedProfiles.has(profileId)) {
					const reasonCode = mapEligibilityReasonToProbeReasonCode(resolveAuthProfileEligibility({
						cfg,
						store,
						provider: providerKey,
						profileId
					}).reasonCode);
					results.push({
						provider: providerKey,
						model: model ? `${model.provider}/${model.model}` : void 0,
						profileId,
						label,
						source: "profile",
						mode,
						status: "unknown",
						reasonCode,
						error: formatMissingCredentialProbeError(reasonCode)
					});
					continue;
				}
				const unresolvedRefIssue = await maybeResolveUnresolvedRefIssue({
					cfg,
					profile,
					cache: refResolveCache
				});
				if (unresolvedRefIssue) {
					results.push({
						provider: providerKey,
						model: model ? `${model.provider}/${model.model}` : void 0,
						profileId,
						label,
						source: "profile",
						mode,
						status: "unknown",
						reasonCode: unresolvedRefIssue.reasonCode,
						error: unresolvedRefIssue.error
					});
					continue;
				}
				if (!model) {
					results.push({
						provider: providerKey,
						model: void 0,
						profileId,
						label,
						source: "profile",
						mode,
						status: "no_model",
						reasonCode: "no_model",
						error: "No model available for probe"
					});
					continue;
				}
				targets.push({
					provider: providerKey,
					model,
					profileId,
					label,
					source: "profile",
					mode
				});
			}
			continue;
		}
		if (profileFilter.size > 0) continue;
		const envKey = resolveEnvApiKey(providerKey);
		const hasUsableModelsJsonKey = hasUsableCustomProviderApiKey(cfg, providerKey);
		if (!envKey && !hasUsableModelsJsonKey) continue;
		const label = envKey ? "env" : "models.json";
		const source = envKey ? "env" : "models.json";
		const mode = envKey?.source.includes("OAUTH_TOKEN") ? "oauth" : "api_key";
		if (!model) {
			results.push({
				provider: providerKey,
				model: void 0,
				label,
				source,
				mode,
				status: "no_model",
				reasonCode: "no_model",
				error: "No model available for probe"
			});
			continue;
		}
		targets.push({
			provider: providerKey,
			model,
			label,
			source,
			mode
		});
	}
	return {
		targets,
		results
	};
}
async function probeTarget(params) {
	const { cfg, agentId, agentDir, workspaceDir, sessionDir, target, timeoutMs, maxTokens } = params;
	if (!target.model) return {
		provider: target.provider,
		model: void 0,
		profileId: target.profileId,
		label: target.label,
		source: target.source,
		mode: target.mode,
		status: "no_model",
		reasonCode: "no_model",
		error: "No model available for probe"
	};
	const model = target.model;
	const sessionId = `probe-${target.provider}-${crypto.randomUUID()}`;
	const sessionFile = resolveSessionTranscriptPath(sessionId, agentId);
	await fs.mkdir(sessionDir, { recursive: true });
	const start = Date.now();
	const buildResult = (status, error) => ({
		provider: target.provider,
		model: `${model.provider}/${model.model}`,
		profileId: target.profileId,
		label: target.label,
		source: target.source,
		mode: target.mode,
		status,
		...error ? { error } : {},
		latencyMs: Date.now() - start
	});
	try {
		await runEmbeddedPiAgent({
			sessionId,
			sessionFile,
			agentId,
			workspaceDir,
			agentDir,
			config: cfg,
			prompt: PROBE_PROMPT,
			provider: target.model.provider,
			model: target.model.model,
			authProfileId: target.profileId,
			authProfileIdSource: target.profileId ? "user" : void 0,
			timeoutMs,
			runId: `probe-${crypto.randomUUID()}`,
			lane: `auth-probe:${target.provider}:${target.profileId ?? target.source}`,
			thinkLevel: "off",
			reasoningLevel: "off",
			verboseLevel: "off",
			streamParams: { maxTokens }
		});
		return buildResult("ok");
	} catch (err) {
		const described = describeFailoverError(err);
		return buildResult(mapFailoverReasonToProbeStatus(described.reason), redactSecrets(described.message));
	}
}
async function runTargetsWithConcurrency(params) {
	const { cfg, targets, timeoutMs, maxTokens, onProgress } = params;
	const concurrency = Math.max(1, Math.min(targets.length || 1, params.concurrency));
	const agentId = resolveDefaultAgentId(cfg);
	const agentDir = resolveOpenClawAgentDir();
	const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId) ?? resolveDefaultAgentWorkspaceDir();
	const sessionDir = resolveSessionTranscriptsDirForAgent(agentId);
	await fs.mkdir(workspaceDir, { recursive: true });
	let completed = 0;
	const results = Array.from({ length: targets.length });
	let cursor = 0;
	const worker = async () => {
		while (true) {
			const index = cursor;
			cursor += 1;
			if (index >= targets.length) return;
			const target = targets[index];
			onProgress?.({
				completed,
				total: targets.length,
				label: `Probing ${target.provider}${target.profileId ? ` (${target.label})` : ""}`
			});
			results[index] = await probeTarget({
				cfg,
				agentId,
				agentDir,
				workspaceDir,
				sessionDir,
				target,
				timeoutMs,
				maxTokens
			});
			completed += 1;
			onProgress?.({
				completed,
				total: targets.length
			});
		}
	};
	await Promise.all(Array.from({ length: concurrency }, () => worker()));
	return results.filter((entry) => Boolean(entry));
}
async function runAuthProbes(params) {
	const startedAt = Date.now();
	const plan = await buildProbeTargets({
		cfg: params.cfg,
		providers: params.providers,
		modelCandidates: params.modelCandidates,
		options: params.options
	});
	const totalTargets = plan.targets.length;
	params.onProgress?.({
		completed: 0,
		total: totalTargets
	});
	const results = totalTargets ? await runTargetsWithConcurrency({
		cfg: params.cfg,
		targets: plan.targets,
		timeoutMs: params.options.timeoutMs,
		maxTokens: params.options.maxTokens,
		concurrency: params.options.concurrency,
		onProgress: params.onProgress
	}) : [];
	const finishedAt = Date.now();
	return {
		startedAt,
		finishedAt,
		durationMs: finishedAt - startedAt,
		totalTargets,
		options: params.options,
		results: [...plan.results, ...results]
	};
}
function formatProbeLatency(latencyMs) {
	if (!latencyMs && latencyMs !== 0) return "-";
	return formatMs(latencyMs);
}
function sortProbeResults(results) {
	return results.slice().toSorted((a, b) => {
		const provider = a.provider.localeCompare(b.provider);
		if (provider !== 0) return provider;
		const aLabel = a.label || a.profileId || "";
		const bLabel = b.label || b.profileId || "";
		return aLabel.localeCompare(bLabel);
	});
}
function describeProbeSummary(summary) {
	if (summary.totalTargets === 0) return "No probe targets.";
	return `Probed ${summary.totalTargets} target${summary.totalTargets === 1 ? "" : "s"} in ${formatMs(summary.durationMs)}`;
}
//#endregion
//#region src/commands/models/list.status-command.ts
init_theme();
init_utils();
async function modelsStatusCommand(opts, runtime) {
	ensureFlagCompatibility(opts);
	if (opts.plain && opts.probe) throw new Error("--probe cannot be used with --plain output.");
	const configPath = createConfigIO().configPath;
	const cfg = await loadModelsConfig({
		commandName: "models status",
		runtime
	});
	const agentId = resolveKnownAgentId({
		cfg,
		rawAgentId: opts.agent
	});
	const agentDir = agentId ? resolveAgentDir(cfg, agentId) : resolveOpenClawAgentDir();
	const agentModelPrimary = agentId ? resolveAgentExplicitModelPrimary(cfg, agentId) : void 0;
	const agentFallbacksOverride = agentId ? resolveAgentModelFallbacksOverride(cfg, agentId) : void 0;
	const resolved = agentId ? resolveDefaultModelForAgent({
		cfg,
		agentId
	}) : resolveConfiguredModelRef({
		cfg,
		defaultProvider: DEFAULT_PROVIDER,
		defaultModel: DEFAULT_MODEL
	});
	const rawDefaultsModel = resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model) ?? "";
	const rawModel = agentModelPrimary ?? rawDefaultsModel;
	const resolvedLabel = `${resolved.provider}/${resolved.model}`;
	const defaultLabel = rawModel || resolvedLabel;
	const defaultsFallbacks = resolveAgentModelFallbackValues(cfg.agents?.defaults?.model);
	const fallbacks = agentFallbacksOverride ?? defaultsFallbacks;
	const imageModel = resolveAgentModelPrimaryValue(cfg.agents?.defaults?.imageModel) ?? "";
	const imageFallbacks = resolveAgentModelFallbackValues(cfg.agents?.defaults?.imageModel);
	const aliases = Object.entries(cfg.agents?.defaults?.models ?? {}).reduce((acc, [key, entry]) => {
		const alias = typeof entry?.alias === "string" ? entry.alias.trim() : void 0;
		if (alias) acc[alias] = key;
		return acc;
	}, {});
	const allowed = Object.keys(cfg.agents?.defaults?.models ?? {});
	const store = ensureAuthProfileStore(agentDir);
	const modelsPath = path.join(agentDir, "models.json");
	const providersFromStore = new Set(Object.values(store.profiles).map((profile) => profile.provider).filter((p) => Boolean(p)));
	const providersFromConfig = new Set(Object.keys(cfg.models?.providers ?? {}).map((p) => typeof p === "string" ? p.trim() : "").filter(Boolean));
	const providersFromModels = /* @__PURE__ */ new Set();
	const providersInUse = /* @__PURE__ */ new Set();
	for (const raw of [
		defaultLabel,
		...fallbacks,
		imageModel,
		...imageFallbacks,
		...allowed
	]) {
		const parsed = parseModelRef(String(raw ?? ""), DEFAULT_PROVIDER);
		if (parsed?.provider) providersFromModels.add(parsed.provider);
	}
	for (const raw of [
		defaultLabel,
		...fallbacks,
		imageModel,
		...imageFallbacks
	]) {
		const parsed = parseModelRef(String(raw ?? ""), DEFAULT_PROVIDER);
		if (parsed?.provider) providersInUse.add(parsed.provider);
	}
	const providersFromEnv = /* @__PURE__ */ new Set();
	for (const provider of [
		"anthropic",
		"github-copilot",
		"google-vertex",
		"openai",
		"google",
		"groq",
		"cerebras",
		"xai",
		"openrouter",
		"zai",
		"mistral",
		"synthetic"
	]) if (resolveEnvApiKey(provider)) providersFromEnv.add(provider);
	const providers = Array.from(new Set([
		...providersFromStore,
		...providersFromConfig,
		...providersFromModels,
		...providersFromEnv
	])).map((p) => typeof p === "string" ? p.trim() : "").filter(Boolean).toSorted((a, b) => a.localeCompare(b));
	const applied = getShellEnvAppliedKeys();
	const shellFallbackEnabled = shouldEnableShellEnvFallback(process.env) || cfg.env?.shellEnv?.enabled === true;
	const providerAuth = providers.map((provider) => resolveProviderAuthOverview({
		provider,
		cfg,
		store,
		modelsPath
	})).filter((entry) => {
		return entry.profiles.count > 0 || Boolean(entry.env) || Boolean(entry.modelsJson);
	});
	const providerAuthMap = new Map(providerAuth.map((entry) => [entry.provider, entry]));
	const missingProvidersInUse = Array.from(providersInUse).filter((provider) => !providerAuthMap.has(provider)).toSorted((a, b) => a.localeCompare(b));
	const probeProfileIds = (() => {
		if (!opts.probeProfile) return [];
		return (Array.isArray(opts.probeProfile) ? opts.probeProfile : [opts.probeProfile]).flatMap((value) => String(value ?? "").split(",")).map((value) => value.trim()).filter(Boolean);
	})();
	const probeTimeoutMs = opts.probeTimeout ? Number(opts.probeTimeout) : 8e3;
	if (!Number.isFinite(probeTimeoutMs) || probeTimeoutMs <= 0) throw new Error("--probe-timeout must be a positive number (ms).");
	const probeConcurrency = opts.probeConcurrency ? Number(opts.probeConcurrency) : 2;
	if (!Number.isFinite(probeConcurrency) || probeConcurrency <= 0) throw new Error("--probe-concurrency must be > 0.");
	const probeMaxTokens = opts.probeMaxTokens ? Number(opts.probeMaxTokens) : 8;
	if (!Number.isFinite(probeMaxTokens) || probeMaxTokens <= 0) throw new Error("--probe-max-tokens must be > 0.");
	const aliasIndex = buildModelAliasIndex({
		cfg,
		defaultProvider: DEFAULT_PROVIDER
	});
	const modelCandidates = [
		rawModel || resolvedLabel,
		...fallbacks,
		imageModel,
		...imageFallbacks,
		...allowed
	].filter(Boolean).map((raw) => resolveModelRefFromString({
		raw: String(raw ?? ""),
		defaultProvider: DEFAULT_PROVIDER,
		aliasIndex
	})?.ref).filter((ref) => Boolean(ref)).map((ref) => `${ref.provider}/${ref.model}`);
	let probeSummary;
	if (opts.probe) probeSummary = await withProgressTotals({
		label: "Probing auth profiles…",
		total: 1
	}, async (update) => {
		return await runAuthProbes({
			cfg,
			providers,
			modelCandidates,
			options: {
				provider: opts.probeProvider,
				profileIds: probeProfileIds,
				timeoutMs: probeTimeoutMs,
				concurrency: probeConcurrency,
				maxTokens: probeMaxTokens
			},
			onProgress: update
		});
	});
	const providersWithOauth = providerAuth.filter((entry) => entry.profiles.oauth > 0 || entry.profiles.token > 0 || entry.env?.value === "OAuth (env)").map((entry) => {
		const count = entry.profiles.oauth + entry.profiles.token + (entry.env?.value === "OAuth (env)" ? 1 : 0);
		return `${entry.provider} (${count})`;
	});
	const authHealth = buildAuthHealthSummary({
		store,
		cfg,
		warnAfterMs: DEFAULT_OAUTH_WARN_MS,
		providers
	});
	const oauthProfiles = authHealth.profiles.filter((profile) => profile.type === "oauth" || profile.type === "token");
	const unusableProfiles = (() => {
		const now = Date.now();
		const out = [];
		for (const profileId of Object.keys(store.usageStats ?? {})) {
			const unusableUntil = resolveProfileUnusableUntilForDisplay(store, profileId);
			if (!unusableUntil || now >= unusableUntil) continue;
			const stats = store.usageStats?.[profileId];
			const kind = typeof stats?.disabledUntil === "number" && now < stats.disabledUntil ? "disabled" : "cooldown";
			out.push({
				profileId,
				provider: store.profiles[profileId]?.provider,
				kind,
				reason: stats?.disabledReason,
				until: unusableUntil,
				remainingMs: unusableUntil - now
			});
		}
		return out.toSorted((a, b) => a.remainingMs - b.remainingMs);
	})();
	const checkStatus = (() => {
		const hasExpiredOrMissing = oauthProfiles.some((profile) => ["expired", "missing"].includes(profile.status)) || missingProvidersInUse.length > 0;
		const hasExpiring = oauthProfiles.some((profile) => profile.status === "expiring");
		if (hasExpiredOrMissing) return 1;
		if (hasExpiring) return 2;
		return 0;
	})();
	if (opts.json) {
		runtime.log(JSON.stringify({
			configPath,
			...agentId ? { agentId } : {},
			agentDir,
			defaultModel: defaultLabel,
			resolvedDefault: resolvedLabel,
			fallbacks,
			imageModel: imageModel || null,
			imageFallbacks,
			...agentId ? { modelConfig: {
				defaultSource: agentModelPrimary ? "agent" : "defaults",
				fallbacksSource: agentFallbacksOverride !== void 0 ? "agent" : "defaults"
			} } : {},
			aliases,
			allowed,
			auth: {
				storePath: resolveAuthStorePathForDisplay(agentDir),
				shellEnvFallback: {
					enabled: shellFallbackEnabled,
					appliedKeys: applied
				},
				providersWithOAuth: providersWithOauth,
				missingProvidersInUse,
				providers: providerAuth,
				unusableProfiles,
				oauth: {
					warnAfterMs: authHealth.warnAfterMs,
					profiles: authHealth.profiles,
					providers: authHealth.providers
				},
				probes: probeSummary
			}
		}, null, 2));
		if (opts.check) runtime.exit(checkStatus);
		return;
	}
	if (opts.plain) {
		runtime.log(resolvedLabel);
		if (opts.check) runtime.exit(checkStatus);
		return;
	}
	const rich = isRich(opts);
	const label = (value) => colorize(rich, theme.accent, value.padEnd(14));
	const labelWithSource = (value, source) => label(source ? `${value} (${source})` : value);
	const displayDefault = rawModel && rawModel !== resolvedLabel ? `${resolvedLabel} (from ${rawModel})` : resolvedLabel;
	runtime.log(`${label("Config")}${colorize(rich, theme.muted, ":")} ${colorize(rich, theme.info, shortenHomePath(configPath))}`);
	runtime.log(`${label("Agent dir")}${colorize(rich, theme.muted, ":")} ${colorize(rich, theme.info, shortenHomePath(agentDir))}`);
	runtime.log(`${labelWithSource("Default", agentId ? agentModelPrimary ? "agent" : "defaults" : void 0)}${colorize(rich, theme.muted, ":")} ${colorize(rich, theme.success, displayDefault)}`);
	runtime.log(`${labelWithSource(`Fallbacks (${fallbacks.length || 0})`, agentId ? agentFallbacksOverride !== void 0 ? "agent" : "defaults" : void 0)}${colorize(rich, theme.muted, ":")} ${colorize(rich, fallbacks.length ? theme.warn : theme.muted, fallbacks.length ? fallbacks.join(", ") : "-")}`);
	runtime.log(`${labelWithSource("Image model", agentId ? "defaults" : void 0)}${colorize(rich, theme.muted, ":")} ${colorize(rich, imageModel ? theme.accentBright : theme.muted, imageModel || "-")}`);
	runtime.log(`${labelWithSource(`Image fallbacks (${imageFallbacks.length || 0})`, agentId ? "defaults" : void 0)}${colorize(rich, theme.muted, ":")} ${colorize(rich, imageFallbacks.length ? theme.accentBright : theme.muted, imageFallbacks.length ? imageFallbacks.join(", ") : "-")}`);
	runtime.log(`${label(`Aliases (${Object.keys(aliases).length || 0})`)}${colorize(rich, theme.muted, ":")} ${colorize(rich, Object.keys(aliases).length ? theme.accent : theme.muted, Object.keys(aliases).length ? Object.entries(aliases).map(([alias, target]) => rich ? `${theme.accentDim(alias)} ${theme.muted("->")} ${theme.info(target)}` : `${alias} -> ${target}`).join(", ") : "-")}`);
	runtime.log(`${label(`Configured models (${allowed.length || 0})`)}${colorize(rich, theme.muted, ":")} ${colorize(rich, allowed.length ? theme.info : theme.muted, allowed.length ? allowed.join(", ") : "all")}`);
	runtime.log("");
	runtime.log(colorize(rich, theme.heading, "Auth overview"));
	runtime.log(`${label("Auth store")}${colorize(rich, theme.muted, ":")} ${colorize(rich, theme.info, shortenHomePath(resolveAuthStorePathForDisplay(agentDir)))}`);
	runtime.log(`${label("Shell env")}${colorize(rich, theme.muted, ":")} ${colorize(rich, shellFallbackEnabled ? theme.success : theme.muted, shellFallbackEnabled ? "on" : "off")}${applied.length ? colorize(rich, theme.muted, ` (applied: ${applied.join(", ")})`) : ""}`);
	runtime.log(`${label(`Providers w/ OAuth/tokens (${providersWithOauth.length || 0})`)}${colorize(rich, theme.muted, ":")} ${colorize(rich, providersWithOauth.length ? theme.info : theme.muted, providersWithOauth.length ? providersWithOauth.join(", ") : "-")}`);
	const formatKey = (key) => colorize(rich, theme.warn, key);
	const formatKeyValue = (key, value) => `${formatKey(key)}=${colorize(rich, theme.info, value)}`;
	const formatSeparator = () => colorize(rich, theme.muted, " | ");
	for (const entry of providerAuth) {
		const separator = formatSeparator();
		const bits = [];
		bits.push(formatKeyValue("effective", `${colorize(rich, theme.accentBright, entry.effective.kind)}:${colorize(rich, theme.muted, entry.effective.detail)}`));
		if (entry.profiles.count > 0) {
			bits.push(formatKeyValue("profiles", `${entry.profiles.count} (oauth=${entry.profiles.oauth}, token=${entry.profiles.token}, api_key=${entry.profiles.apiKey})`));
			if (entry.profiles.labels.length > 0) bits.push(colorize(rich, theme.info, entry.profiles.labels.join(", ")));
		}
		if (entry.env) bits.push(formatKeyValue("env", `${entry.env.value}${separator}${formatKeyValue("source", entry.env.source)}`));
		if (entry.modelsJson) bits.push(formatKeyValue("models.json", `${entry.modelsJson.value}${separator}${formatKeyValue("source", entry.modelsJson.source)}`));
		runtime.log(`- ${theme.heading(entry.provider)} ${bits.join(separator)}`);
	}
	if (missingProvidersInUse.length > 0) {
		runtime.log("");
		runtime.log(colorize(rich, theme.heading, "Missing auth"));
		for (const provider of missingProvidersInUse) {
			const hint = buildProviderAuthRecoveryHint({
				provider,
				config: cfg,
				includeEnvVar: true
			});
			runtime.log(`- ${theme.heading(provider)} ${hint}`);
		}
	}
	runtime.log("");
	runtime.log(colorize(rich, theme.heading, "OAuth/token status"));
	if (oauthProfiles.length === 0) runtime.log(colorize(rich, theme.muted, "- none"));
	else {
		const usageByProvider = /* @__PURE__ */ new Map();
		const usageProviders = Array.from(new Set(oauthProfiles.map((profile) => resolveUsageProviderId(profile.provider)).filter((provider) => Boolean(provider))));
		if (usageProviders.length > 0) try {
			const usageSummary = await loadProviderUsageSummary({
				providers: usageProviders,
				agentDir,
				timeoutMs: 3500
			});
			for (const snapshot of usageSummary.providers) {
				const formatted = formatUsageWindowSummary(snapshot, {
					now: Date.now(),
					maxWindows: 2,
					includeResets: true
				});
				if (formatted) usageByProvider.set(snapshot.provider, formatted);
			}
		} catch {}
		const formatStatus = (status) => {
			if (status === "ok") return colorize(rich, theme.success, "ok");
			if (status === "static") return colorize(rich, theme.muted, "static");
			if (status === "expiring") return colorize(rich, theme.warn, "expiring");
			if (status === "missing") return colorize(rich, theme.warn, "unknown");
			return colorize(rich, theme.error, "expired");
		};
		const profilesByProvider = /* @__PURE__ */ new Map();
		for (const profile of oauthProfiles) {
			const current = profilesByProvider.get(profile.provider);
			if (current) current.push(profile);
			else profilesByProvider.set(profile.provider, [profile]);
		}
		for (const [provider, profiles] of profilesByProvider) {
			const usageKey = resolveUsageProviderId(provider);
			const usage = usageKey ? usageByProvider.get(usageKey) : void 0;
			const usageSuffix = usage ? colorize(rich, theme.muted, ` usage: ${usage}`) : "";
			runtime.log(`- ${colorize(rich, theme.heading, provider)}${usageSuffix}`);
			for (const profile of profiles) {
				const labelText = profile.label || profile.profileId;
				const label = colorize(rich, theme.accent, labelText);
				const status = formatStatus(profile.status);
				const expiry = profile.status === "static" ? "" : profile.expiresAt ? ` expires in ${formatRemainingShort(profile.remainingMs)}` : " expires unknown";
				runtime.log(`  - ${label} ${status}${expiry}`);
			}
		}
	}
	if (probeSummary) {
		runtime.log("");
		runtime.log(colorize(rich, theme.heading, "Auth probes"));
		if (probeSummary.results.length === 0) runtime.log(colorize(rich, theme.muted, "- none"));
		else {
			const tableWidth = getTerminalTableWidth();
			const sorted = sortProbeResults(probeSummary.results);
			const statusColor = (status) => {
				if (status === "ok") return theme.success;
				if (status === "rate_limit") return theme.warn;
				if (status === "timeout" || status === "billing") return theme.warn;
				if (status === "auth" || status === "format") return theme.error;
				if (status === "no_model") return theme.muted;
				return theme.muted;
			};
			const rows = sorted.map((result) => {
				const status = colorize(rich, statusColor(result.status), result.status);
				const latency = formatProbeLatency(result.latencyMs);
				const modelLabel = result.model ?? `${result.provider}/-`;
				const modeLabel = result.mode ? ` ${colorize(rich, theme.muted, `(${result.mode})`)}` : "";
				const profile = `${colorize(rich, theme.accent, result.label)}${modeLabel}`;
				const detail = result.error?.trim();
				const detailLabel = detail ? `\n${colorize(rich, theme.muted, `↳ ${detail}`)}` : "";
				const statusLabel = `${status}${colorize(rich, theme.muted, ` · ${latency}`)}${detailLabel}`;
				return {
					Model: colorize(rich, theme.heading, modelLabel),
					Profile: profile,
					Status: statusLabel
				};
			});
			runtime.log(renderTable({
				width: tableWidth,
				columns: [
					{
						key: "Model",
						header: "Model",
						minWidth: 18
					},
					{
						key: "Profile",
						header: "Profile",
						minWidth: 24
					},
					{
						key: "Status",
						header: "Status",
						minWidth: 12
					}
				],
				rows
			}).trimEnd());
			runtime.log(colorize(rich, theme.muted, describeProbeSummary(probeSummary)));
		}
	}
	if (opts.check) runtime.exit(checkStatus);
}
//#endregion
//#region src/agents/model-scan.ts
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const DEFAULT_TIMEOUT_MS = 12e3;
const DEFAULT_CONCURRENCY = 3;
const BASE_IMAGE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X3mIAAAAASUVORK5CYII=";
const TOOL_PING = {
	name: "ping",
	description: "Return OK.",
	parameters: Type.Object({})
};
function normalizeCreatedAtMs(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	if (value <= 0) return null;
	if (value > 0xe8d4a51000) return Math.round(value);
	return Math.round(value * 1e3);
}
function parseModality(modality) {
	if (!modality) return ["text"];
	return modality.toLowerCase().split(/[^a-z]+/).filter(Boolean).includes("image") ? ["text", "image"] : ["text"];
}
function parseNumberString(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const num = Number(trimmed);
	if (!Number.isFinite(num)) return null;
	return num;
}
function parseOpenRouterPricing(value) {
	if (!value || typeof value !== "object") return null;
	const obj = value;
	const prompt = parseNumberString(obj.prompt);
	const completion = parseNumberString(obj.completion);
	const request = parseNumberString(obj.request) ?? 0;
	const image = parseNumberString(obj.image) ?? 0;
	const webSearch = parseNumberString(obj.web_search) ?? 0;
	const internalReasoning = parseNumberString(obj.internal_reasoning) ?? 0;
	if (prompt === null || completion === null) return null;
	return {
		prompt,
		completion,
		request,
		image,
		webSearch,
		internalReasoning
	};
}
function isFreeOpenRouterModel(entry) {
	if (entry.id.endsWith(":free")) return true;
	if (!entry.pricing) return false;
	return entry.pricing.prompt === 0 && entry.pricing.completion === 0;
}
async function withTimeout(timeoutMs, fn) {
	const controller = new AbortController();
	const timer = setTimeout(controller.abort.bind(controller), timeoutMs);
	try {
		return await fn(controller.signal);
	} finally {
		clearTimeout(timer);
	}
}
async function fetchOpenRouterModels(fetchImpl) {
	const res = await fetchImpl(OPENROUTER_MODELS_URL, { headers: { Accept: "application/json" } });
	if (!res.ok) throw new Error(`OpenRouter /models failed: HTTP ${res.status}`);
	const payload = await res.json();
	return (Array.isArray(payload.data) ? payload.data : []).map((entry) => {
		if (!entry || typeof entry !== "object") return null;
		const obj = entry;
		const id = typeof obj.id === "string" ? obj.id.trim() : "";
		if (!id) return null;
		const name = typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : id;
		const contextLength = typeof obj.context_length === "number" && Number.isFinite(obj.context_length) ? obj.context_length : null;
		const maxCompletionTokens = typeof obj.max_completion_tokens === "number" && Number.isFinite(obj.max_completion_tokens) ? obj.max_completion_tokens : typeof obj.max_output_tokens === "number" && Number.isFinite(obj.max_output_tokens) ? obj.max_output_tokens : null;
		const supportedParameters = Array.isArray(obj.supported_parameters) ? obj.supported_parameters.filter((value) => typeof value === "string").map((value) => value.trim()).filter(Boolean) : [];
		return {
			id,
			name,
			contextLength,
			maxCompletionTokens,
			supportedParameters,
			supportedParametersCount: supportedParameters.length,
			supportsToolsMeta: supportedParameters.includes("tools"),
			modality: typeof obj.modality === "string" && obj.modality.trim() ? obj.modality.trim() : null,
			inferredParamB: inferParamBFromIdOrName(`${id} ${name}`),
			createdAtMs: normalizeCreatedAtMs(obj.created_at),
			pricing: parseOpenRouterPricing(obj.pricing)
		};
	}).filter((entry) => Boolean(entry));
}
async function probeTool(model, apiKey, timeoutMs) {
	const context = {
		messages: [{
			role: "user",
			content: "Call the ping tool with {} and nothing else.",
			timestamp: Date.now()
		}],
		tools: [TOOL_PING]
	};
	const startedAt = Date.now();
	try {
		if (!(await withTimeout(timeoutMs, (signal) => complete(model, context, {
			apiKey,
			maxTokens: 256,
			temperature: 0,
			toolChoice: "required",
			signal
		}))).content.some((block) => block.type === "toolCall")) return {
			ok: false,
			latencyMs: Date.now() - startedAt,
			error: "No tool call returned"
		};
		return {
			ok: true,
			latencyMs: Date.now() - startedAt
		};
	} catch (err) {
		return {
			ok: false,
			latencyMs: Date.now() - startedAt,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}
async function probeImage(model, apiKey, timeoutMs) {
	const context = { messages: [{
		role: "user",
		content: [{
			type: "text",
			text: "Reply with OK."
		}, {
			type: "image",
			data: BASE_IMAGE_PNG,
			mimeType: "image/png"
		}],
		timestamp: Date.now()
	}] };
	const startedAt = Date.now();
	try {
		await withTimeout(timeoutMs, (signal) => complete(model, context, {
			apiKey,
			maxTokens: 16,
			temperature: 0,
			signal
		}));
		return {
			ok: true,
			latencyMs: Date.now() - startedAt
		};
	} catch (err) {
		return {
			ok: false,
			latencyMs: Date.now() - startedAt,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}
function ensureImageInput(model) {
	if (model.input?.includes("image")) return model;
	return {
		...model,
		input: Array.from(new Set([...model.input ?? [], "image"]))
	};
}
function buildOpenRouterScanResult(params) {
	const { entry, isFree } = params;
	return {
		id: entry.id,
		name: entry.name,
		provider: "openrouter",
		modelRef: `openrouter/${entry.id}`,
		contextLength: entry.contextLength,
		maxCompletionTokens: entry.maxCompletionTokens,
		supportedParametersCount: entry.supportedParametersCount,
		supportsToolsMeta: entry.supportsToolsMeta,
		modality: entry.modality,
		inferredParamB: entry.inferredParamB,
		createdAtMs: entry.createdAtMs,
		pricing: entry.pricing,
		isFree,
		tool: params.tool,
		image: params.image
	};
}
async function mapWithConcurrency(items, concurrency, fn, opts) {
	const limit = Math.max(1, Math.floor(concurrency));
	const results = Array.from({ length: items.length }, () => void 0);
	let nextIndex = 0;
	let completed = 0;
	const worker = async () => {
		while (true) {
			const current = nextIndex;
			nextIndex += 1;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
			completed += 1;
			opts?.onProgress?.(completed, items.length);
		}
	};
	if (items.length === 0) {
		opts?.onProgress?.(0, 0);
		return results;
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
	return results;
}
async function scanOpenRouterModels(options = {}) {
	const fetchImpl = options.fetchImpl ?? fetch;
	const probe = options.probe ?? true;
	const apiKey = options.apiKey?.trim() || getEnvApiKey("openrouter") || "";
	if (probe && !apiKey) throw new Error("Missing OpenRouter API key. Set OPENROUTER_API_KEY to run models scan.");
	const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
	const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY));
	const minParamB = Math.max(0, Math.floor(options.minParamB ?? 0));
	const maxAgeDays = Math.max(0, Math.floor(options.maxAgeDays ?? 0));
	const providerFilter = options.providerFilter?.trim().toLowerCase() ?? "";
	const catalog = await fetchOpenRouterModels(fetchImpl);
	const now = Date.now();
	const filtered = catalog.filter((entry) => {
		if (!isFreeOpenRouterModel(entry)) return false;
		if (providerFilter) {
			if ((entry.id.split("/")[0]?.toLowerCase() ?? "") !== providerFilter) return false;
		}
		if (minParamB > 0) {
			if ((entry.inferredParamB ?? 0) < minParamB) return false;
		}
		if (maxAgeDays > 0 && entry.createdAtMs) {
			if ((now - entry.createdAtMs) / (1440 * 60 * 1e3) > maxAgeDays) return false;
		}
		return true;
	});
	const baseModel = getModel("openrouter", "openrouter/auto");
	options.onProgress?.({
		phase: "probe",
		completed: 0,
		total: filtered.length
	});
	return mapWithConcurrency(filtered, concurrency, async (entry) => {
		const isFree = isFreeOpenRouterModel(entry);
		if (!probe) return buildOpenRouterScanResult({
			entry,
			isFree,
			tool: {
				ok: false,
				latencyMs: null,
				skipped: true
			},
			image: {
				ok: false,
				latencyMs: null,
				skipped: true
			}
		});
		const model = {
			...baseModel,
			id: entry.id,
			name: entry.name || entry.id,
			contextWindow: entry.contextLength ?? baseModel.contextWindow,
			maxTokens: entry.maxCompletionTokens ?? baseModel.maxTokens,
			input: parseModality(entry.modality),
			reasoning: baseModel.reasoning
		};
		return buildOpenRouterScanResult({
			entry,
			isFree,
			tool: await probeTool(model, apiKey, timeoutMs),
			image: model.input?.includes("image") ? await probeImage(ensureImageInput(model), apiKey, timeoutMs) : {
				ok: false,
				latencyMs: null,
				skipped: true
			}
		});
	}, { onProgress: (completed, total) => options.onProgress?.({
		phase: "probe",
		completed,
		total
	}) });
}
//#endregion
//#region src/commands/models/scan.ts
const MODEL_PAD = 42;
const CTX_PAD = 8;
const multiselect$1 = (params) => multiselect({
	...params,
	message: stylePromptMessage(params.message),
	options: params.options.map((opt) => opt.hint === void 0 ? opt : {
		...opt,
		hint: stylePromptHint(opt.hint)
	})
});
function guardPromptCancel(value, runtime) {
	if (isCancel(value)) {
		cancel(stylePromptTitle("Model scan cancelled.") ?? "Model scan cancelled.");
		runtime.exit(0);
		throw new Error("unreachable");
	}
	return value;
}
function sortScanResults(results) {
	return results.slice().toSorted((a, b) => {
		const aImage = a.image.ok ? 1 : 0;
		const bImage = b.image.ok ? 1 : 0;
		if (aImage !== bImage) return bImage - aImage;
		const aToolLatency = a.tool.latencyMs ?? Number.POSITIVE_INFINITY;
		const bToolLatency = b.tool.latencyMs ?? Number.POSITIVE_INFINITY;
		if (aToolLatency !== bToolLatency) return aToolLatency - bToolLatency;
		return compareScanMetadata(a, b);
	});
}
function sortImageResults(results) {
	return results.slice().toSorted((a, b) => {
		const aLatency = a.image.latencyMs ?? Number.POSITIVE_INFINITY;
		const bLatency = b.image.latencyMs ?? Number.POSITIVE_INFINITY;
		if (aLatency !== bLatency) return aLatency - bLatency;
		return compareScanMetadata(a, b);
	});
}
function compareScanMetadata(a, b) {
	const aCtx = a.contextLength ?? 0;
	const bCtx = b.contextLength ?? 0;
	if (aCtx !== bCtx) return bCtx - aCtx;
	const aParams = a.inferredParamB ?? 0;
	const bParams = b.inferredParamB ?? 0;
	if (aParams !== bParams) return bParams - aParams;
	return a.modelRef.localeCompare(b.modelRef);
}
function buildScanHint(result) {
	return [
		result.tool.ok ? `tool ${formatMs(result.tool.latencyMs)}` : "tool fail",
		result.image.skipped ? "img skip" : result.image.ok ? `img ${formatMs(result.image.latencyMs)}` : "img fail",
		result.contextLength ? `ctx ${formatTokenK(result.contextLength)}` : "ctx ?",
		result.inferredParamB ? `${result.inferredParamB}b` : null
	].filter(Boolean).join(" | ");
}
function printScanSummary(results, runtime) {
	const toolOk = results.filter((r) => r.tool.ok);
	const imageOk = results.filter((r) => r.image.ok);
	const toolImageOk = results.filter((r) => r.tool.ok && r.image.ok);
	const imageOnly = imageOk.filter((r) => !r.tool.ok);
	runtime.log(`Scan results: tested ${results.length}, tool ok ${toolOk.length}, image ok ${imageOk.length}, tool+image ok ${toolImageOk.length}, image only ${imageOnly.length}`);
}
function printScanTable(results, runtime) {
	const header = [
		pad("Model", MODEL_PAD),
		pad("Tool", 10),
		pad("Image", 10),
		pad("Ctx", CTX_PAD),
		pad("Params", 8),
		"Notes"
	].join(" ");
	runtime.log(header);
	for (const entry of results) {
		const modelLabel = pad(truncate(entry.modelRef, MODEL_PAD), MODEL_PAD);
		const toolLabel = pad(entry.tool.ok ? formatMs(entry.tool.latencyMs) : "fail", 10);
		const imageLabel = pad(entry.image.ok ? formatMs(entry.image.latencyMs) : entry.image.skipped ? "skip" : "fail", 10);
		const ctxLabel = pad(formatTokenK(entry.contextLength), CTX_PAD);
		const paramsLabel = pad(entry.inferredParamB ? `${entry.inferredParamB}b` : "-", 8);
		const notes = entry.modality ? `modality:${entry.modality}` : "";
		runtime.log([
			modelLabel,
			toolLabel,
			imageLabel,
			ctxLabel,
			paramsLabel,
			notes
		].join(" "));
	}
}
async function modelsScanCommand(opts, runtime) {
	const minParams = opts.minParams ? Number(opts.minParams) : void 0;
	if (minParams !== void 0 && (!Number.isFinite(minParams) || minParams < 0)) throw new Error("--min-params must be >= 0");
	const maxAgeDays = opts.maxAgeDays ? Number(opts.maxAgeDays) : void 0;
	if (maxAgeDays !== void 0 && (!Number.isFinite(maxAgeDays) || maxAgeDays < 0)) throw new Error("--max-age-days must be >= 0");
	const maxCandidates = opts.maxCandidates ? Number(opts.maxCandidates) : 6;
	if (!Number.isFinite(maxCandidates) || maxCandidates <= 0) throw new Error("--max-candidates must be > 0");
	const timeout = opts.timeout ? Number(opts.timeout) : void 0;
	if (timeout !== void 0 && (!Number.isFinite(timeout) || timeout <= 0)) throw new Error("--timeout must be > 0");
	const concurrency = opts.concurrency ? Number(opts.concurrency) : void 0;
	if (concurrency !== void 0 && (!Number.isFinite(concurrency) || concurrency <= 0)) throw new Error("--concurrency must be > 0");
	const cfg = await loadModelsConfig({
		commandName: "models scan",
		runtime
	});
	const probe = opts.probe ?? true;
	let storedKey;
	if (probe) try {
		storedKey = (await resolveApiKeyForProvider({
			provider: "openrouter",
			cfg
		})).apiKey;
	} catch {
		storedKey = void 0;
	}
	const results = await withProgressTotals({
		label: "Scanning OpenRouter models...",
		indeterminate: false,
		enabled: opts.json !== true
	}, async (update) => await scanOpenRouterModels({
		apiKey: storedKey ?? void 0,
		minParamB: minParams,
		maxAgeDays,
		providerFilter: opts.provider,
		timeoutMs: timeout,
		concurrency,
		probe,
		onProgress: ({ phase, completed, total }) => {
			if (phase !== "probe") return;
			update({
				completed,
				total,
				label: `${probe ? "Probing models" : "Scanning models"} (${completed}/${total})`
			});
		}
	}));
	if (!probe) {
		if (!opts.json) {
			runtime.log(`Found ${results.length} OpenRouter free models (metadata only; pass --probe to test tools/images).`);
			printScanTable(sortScanResults(results), runtime);
		} else runtime.log(JSON.stringify(results, null, 2));
		return;
	}
	const toolOk = results.filter((entry) => entry.tool.ok);
	if (toolOk.length === 0) throw new Error("No tool-capable OpenRouter free models found.");
	const sorted = sortScanResults(results);
	const toolSorted = sortScanResults(toolOk);
	const imageSorted = sortImageResults(results.filter((entry) => entry.image.ok));
	const imagePreferred = toolSorted.filter((entry) => entry.image.ok);
	const preselected = (imagePreferred.length > 0 ? imagePreferred : toolSorted).slice(0, Math.floor(maxCandidates)).map((entry) => entry.modelRef);
	const imagePreselected = imageSorted.slice(0, Math.floor(maxCandidates)).map((entry) => entry.modelRef);
	if (!opts.json) {
		printScanSummary(results, runtime);
		printScanTable(sorted, runtime);
	}
	const noInput = opts.input === false;
	const canPrompt = process.stdin.isTTY && !opts.yes && !noInput && !opts.json;
	let selected = preselected;
	let selectedImages = imagePreselected;
	if (canPrompt) {
		selected = guardPromptCancel(await multiselect$1({
			message: "Select fallback models (ordered)",
			options: toolSorted.map((entry) => ({
				value: entry.modelRef,
				label: entry.modelRef,
				hint: buildScanHint(entry)
			})),
			initialValues: preselected
		}), runtime);
		if (imageSorted.length > 0) selectedImages = guardPromptCancel(await multiselect$1({
			message: "Select image fallback models (ordered)",
			options: imageSorted.map((entry) => ({
				value: entry.modelRef,
				label: entry.modelRef,
				hint: buildScanHint(entry)
			})),
			initialValues: imagePreselected
		}), runtime);
	} else if (!process.stdin.isTTY && !opts.yes && !noInput && !opts.json) throw new Error("Non-interactive scan: pass --yes to apply defaults.");
	if (selected.length === 0) throw new Error("No models selected for fallbacks.");
	if (opts.setImage && selectedImages.length === 0) throw new Error("No image-capable models selected for image model.");
	await updateConfig((cfg) => {
		const nextModels = { ...cfg.agents?.defaults?.models };
		for (const entry of selected) if (!nextModels[entry]) nextModels[entry] = {};
		for (const entry of selectedImages) if (!nextModels[entry]) nextModels[entry] = {};
		const existingImageModel = toAgentModelListLike(cfg.agents?.defaults?.imageModel);
		const nextImageModel = selectedImages.length > 0 ? {
			...existingImageModel?.primary ? { primary: existingImageModel.primary } : void 0,
			fallbacks: selectedImages,
			...opts.setImage ? { primary: selectedImages[0] } : {}
		} : cfg.agents?.defaults?.imageModel;
		const existingModel = toAgentModelListLike(cfg.agents?.defaults?.model);
		const defaults = {
			...cfg.agents?.defaults,
			model: {
				...existingModel?.primary ? { primary: existingModel.primary } : void 0,
				fallbacks: selected,
				...opts.setDefault ? { primary: selected[0] } : {}
			},
			...nextImageModel ? { imageModel: nextImageModel } : {},
			models: nextModels
		};
		return {
			...cfg,
			agents: {
				...cfg.agents,
				defaults
			}
		};
	});
	if (opts.json) {
		runtime.log(JSON.stringify({
			selected,
			selectedImages,
			setDefault: Boolean(opts.setDefault),
			setImage: Boolean(opts.setImage),
			results,
			warnings: []
		}, null, 2));
		return;
	}
	logConfigUpdated(runtime);
	runtime.log(`Fallbacks: ${selected.join(", ")}`);
	if (selectedImages.length > 0) runtime.log(`Image fallbacks: ${selectedImages.join(", ")}`);
	if (opts.setDefault) runtime.log(`Default model: ${selected[0]}`);
	if (opts.setImage && selectedImages.length > 0) runtime.log(`Image model: ${selectedImages[0]}`);
}
//#endregion
//#region src/commands/models/set.ts
async function modelsSetCommand(modelRaw, runtime) {
	const updated = await updateConfig((cfg) => {
		return applyDefaultModelPrimaryUpdate({
			cfg,
			modelRaw,
			field: "model"
		});
	});
	logConfigUpdated(runtime);
	runtime.log(`Default model: ${resolveAgentModelPrimaryValue(updated.agents?.defaults?.model) ?? modelRaw}`);
}
//#endregion
//#region src/commands/models/set-image.ts
async function modelsSetImageCommand(modelRaw, runtime) {
	const updated = await updateConfig((cfg) => {
		return applyDefaultModelPrimaryUpdate({
			cfg,
			modelRaw,
			field: "imageModel"
		});
	});
	logConfigUpdated(runtime);
	runtime.log(`Image model: ${resolveAgentModelPrimaryValue(updated.agents?.defaults?.imageModel) ?? modelRaw}`);
}
//#endregion
export { modelsAliasesRemoveCommand as C, modelsAliasesListCommand as S, modelsAuthAddCommand as _, modelsListCommand as a, modelsAuthSetupTokenCommand as b, modelsImageFallbacksListCommand as c, modelsFallbacksClearCommand as d, modelsFallbacksListCommand as f, modelsAuthOrderSetCommand as g, modelsAuthOrderGetCommand as h, modelsStatusCommand as i, modelsImageFallbacksRemoveCommand as l, modelsAuthOrderClearCommand as m, modelsSetCommand as n, modelsImageFallbacksAddCommand as o, modelsFallbacksRemoveCommand as p, modelsScanCommand as r, modelsImageFallbacksClearCommand as s, modelsSetImageCommand as t, modelsFallbacksAddCommand as u, modelsAuthLoginCommand as v, modelsAliasesAddCommand as x, modelsAuthPasteTokenCommand as y };
