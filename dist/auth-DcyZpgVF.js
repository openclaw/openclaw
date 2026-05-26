import { c as normalizeOptionalString, d as normalizeStringifiedOptionalString } from "./string-coerce-DyL154ka.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { n as normalizeAgentModelRefForConfig } from "./model-input-ChW9XXsQ.js";
import "./agent-scope-CtLXGcWm.js";
import { n as resolveDefaultAgentWorkspaceDir } from "./workspace-default--mMaLHGD.js";
import { a as resolveAgentDir, c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { t as parseDurationMs } from "./parse-duration-CD4d_yk2.js";
import { a as resolvePluginSetupRegistry, i as resolvePluginSetupProvider } from "./setup-registry-DHllMAAd.js";
import { n as resolvePluginProviders } from "./providers.runtime-CsXUlav0.js";
import { s as loadAuthProfileStoreForRuntime } from "./store-BMQkMM4l.js";
import "./model-selection-normalize-CBfQo-Fd.js";
import { n as normalizeSecretInput } from "./normalize-secret-input-CsdRhsMj.js";
import "./workspace-DTx8zuCN.js";
import "./auth-profiles-D6NMnufG.js";
import { r as externalCliDiscoveryForProviderAuth } from "./external-cli-discovery-D0JQl8du.js";
import { n as listProfilesForProvider } from "./profile-list-C0HtPlut.js";
import { r as promoteAuthProfileInOrder, s as upsertAuthProfileWithLock } from "./profiles-9GB1thhi.js";
import { n as clearAuthProfileCooldown } from "./usage-DbhCKKrr.js";
import { n as validateAnthropicSetupToken } from "./provider-auth-token-ByHszczc.js";
import { t as applyAuthProfileConfig } from "./provider-auth-helpers-BZ5Z8RV6.js";
import { n as stylePromptMessage, t as stylePromptHint } from "./prompt-style-DH7LpiPN.js";
import { t as createClackPrompter } from "./clack-prompter-BZIQivnq.js";
import { r as logConfigUpdated } from "./logging-t-RUPR6R.js";
import { a as loadValidConfigOrThrow, s as resolveKnownAgentId, u as updateConfig } from "./shared-CXerptPG.js";
import { a as restorePriorAgentsDefaultsModelUnlessOptIn, i as resolveProviderMatch, n as applyProviderAuthConfigPatch, r as pickAuthMethod, t as applyDefaultModel } from "./provider-auth-choice-helpers-DA-F8Rp0.js";
import { t as createVpsAwareOAuthHandlers } from "./provider-oauth-flow-yFbEzcQS.js";
import { t as isRemoteEnvironment } from "./remote-env-CBc5PaHP.js";
import { r as repairCodexRuntimePluginInstallForModelSelection } from "./codex-runtime-plugin-install-B70xNAdC.js";
import { cancel, confirm, isCancel, password, select, text } from "@clack/prompts";
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
const password$1 = async (params) => guardCancel(await password({
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
async function readPipedStdin() {
	process.stdin.setEncoding("utf8");
	let input = "";
	for await (const chunk of process.stdin) input += String(chunk);
	return input;
}
async function readPastedSecret(params) {
	const promptParams = {
		message: params.message,
		validate: params.validate
	};
	const normalized = normalizeSecretInput(process.stdin.isTTY ? await (params.masked ? password$1(promptParams) : text$1(promptParams)) : await readPipedStdin());
	const validationMessage = params.validate?.(normalized);
	if (validationMessage) throw new Error(validationMessage);
	return normalized;
}
function resolveDefaultTokenProfileId(provider) {
	return `${normalizeProviderId(provider)}:manual`;
}
function isOpenAICodexProvider(provider) {
	return normalizeProviderId(provider) === "openai-codex";
}
function stripBearerPrefix(value) {
	return value.trim().replace(/^Bearer\s+/i, "").trim();
}
function looksLikeOpenAIApiKey(value) {
	return /^sk-[A-Za-z0-9_-]{8,}$/.test(value.trim());
}
function looksLikeJwtToken(value) {
	const parts = stripBearerPrefix(value).split(".");
	return parts.length === 3 && parts.every((part) => /^[A-Za-z0-9_-]{8,}$/.test(part));
}
function looksLikeStructuredCredential(value) {
	const trimmed = value.trim();
	return trimmed.startsWith("{") || trimmed.startsWith("[");
}
function validateOpenAICodexApiKeyInput(value) {
	const trimmed = value.trim();
	if (!trimmed) return "Required";
	if (looksLikeOpenAIApiKey(trimmed)) return;
	if (looksLikeJwtToken(trimmed) || looksLikeStructuredCredential(trimmed)) return `That looks like token or OAuth material, not an OpenAI API key. Use ${formatCliCommand("openclaw models auth paste-token --provider openai-codex")} for token auth material.`;
	return "That does not look like an OpenAI API key.";
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
function mergeSetupProviders(providers, setupProviders) {
	if (setupProviders.length === 0) return [...providers];
	const setupById = new Map(setupProviders.map((provider) => [normalizeProviderId(provider.id), provider]));
	const merged = providers.map((provider) => setupById.get(normalizeProviderId(provider.id)) ?? provider);
	const existing = new Set(merged.map((provider) => normalizeProviderId(provider.id)));
	for (const provider of setupProviders) if (!existing.has(normalizeProviderId(provider.id))) merged.push(provider);
	return merged;
}
function preferSetupAuthProviders(params) {
	const requestedProvider = params.requestedProvider?.trim();
	if (requestedProvider) {
		const setupProvider = resolvePluginSetupProvider({
			provider: requestedProvider,
			config: params.config,
			workspaceDir: params.workspaceDir
		});
		return setupProvider ? [setupProvider] : [...params.providers];
	}
	const setupProviders = resolvePluginSetupRegistry({
		config: params.config,
		workspaceDir: params.workspaceDir
	}).providers.map((entry) => entry.provider);
	return mergeSetupProviders(params.providers, setupProviders);
}
async function resolveModelsAuthContext(params) {
	const config = await loadValidConfigOrThrow();
	const agentId = resolveKnownAgentId({
		cfg: config,
		rawAgentId: params?.rawAgentId
	}) ?? resolveDefaultAgentId(config);
	const agentDir = resolveAgentDir(config, agentId);
	const workspaceDir = resolveAgentWorkspaceDir(config, agentId) ?? resolveDefaultAgentWorkspaceDir();
	return {
		config,
		agentDir,
		workspaceDir,
		providers: preferSetupAuthProviders({
			providers: resolvePluginProviders({
				config,
				workspaceDir,
				mode: "setup",
				includeUntrustedWorkspacePlugins: false,
				bundledProviderAllowlistCompat: true,
				bundledProviderVitestCompat: true,
				...params?.requestedProvider?.trim() ? {
					providerRefs: [params.requestedProvider],
					activate: true
				} : {}
			}),
			config,
			workspaceDir,
			requestedProvider: params?.requestedProvider
		})
	};
}
async function resolveModelsAuthAgentDir(rawAgentId) {
	const config = await loadValidConfigOrThrow();
	return resolveAgentDir(config, resolveKnownAgentId({
		cfg: config,
		rawAgentId
	}) ?? resolveDefaultAgentId(config));
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
	const rawRequestedMethod = params.requestedMethod?.trim();
	if (rawRequestedMethod) return pickAuthMethod(params.provider, rawRequestedMethod);
	const oauthMethod = params.provider.auth.find((method) => method.kind === "oauth");
	if (oauthMethod) return oauthMethod;
	if (params.provider.auth.length === 1) return params.provider.auth[0] ?? null;
	return await params.prompter.select({
		message: `Auth method for ${params.provider.label}`,
		options: params.provider.auth.map((method) => ({
			value: method.id,
			label: method.label,
			hint: method.hint
		}))
	}).then((id) => params.provider.auth.find((method) => method.id === id) ?? null);
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
	}).then((id) => tokenMethods.find((method) => method.id === id) ?? null);
}
async function persistProviderAuthResult(params) {
	const defaultModel = params.result.defaultModel ? normalizeAgentModelRefForConfig(params.result.defaultModel) : void 0;
	for (const profile of params.result.profiles) {
		await upsertAuthProfileWithLockOrThrow({
			profileId: profile.profileId,
			credential: profile.credential,
			agentDir: params.agentDir
		});
		await promoteAuthProfileInOrder({
			agentDir: params.agentDir,
			provider: profile.credential.provider,
			profileId: profile.profileId
		});
	}
	const updated = await updateConfig((cfg) => {
		const priorAgentsDefaultsModel = cfg.agents?.defaults?.model;
		let next = cfg;
		if (params.result.configPatch) next = applyProviderAuthConfigPatch(next, params.result.configPatch, { replaceDefaultModels: params.result.replaceDefaultModels });
		for (const profile of params.result.profiles) next = applyAuthProfileConfig(next, {
			profileId: profile.profileId,
			provider: profile.credential.provider,
			mode: credentialMode(profile.credential)
		});
		next = restorePriorAgentsDefaultsModelUnlessOptIn({
			cfg: next,
			priorAgentsDefaultsModel,
			setDefault: params.setDefault
		});
		if (params.setDefault && defaultModel) next = applyDefaultModel(next, defaultModel);
		return next;
	});
	if (defaultModel) {
		const repaired = await repairCodexRuntimePluginInstallForModelSelection({
			cfg: updated,
			model: defaultModel
		});
		for (const warning of repaired.warnings) params.runtime.error?.(warning);
	}
	logConfigUpdated(params.runtime);
	for (const profile of params.result.profiles) params.runtime.log(`Auth profile: ${profile.profileId} (${profile.credential.provider}/${credentialMode(profile.credential)})`);
	if (defaultModel) params.runtime.log(params.setDefault ? `Default model set to ${defaultModel}` : `Default model available: ${defaultModel} (use --set-default to apply)`);
	if (params.result.notes && params.result.notes.length > 0) await params.prompter.note(params.result.notes.join("\n"), "Provider notes");
}
async function runProviderAuthMethod(params) {
	const selectedProviderId = normalizeProviderId(params.provider.id);
	await clearStaleProfileLockouts(selectedProviderId, params.agentDir);
	const result = await params.method.run({
		config: params.config,
		env: process.env,
		agentDir: params.agentDir,
		workspaceDir: params.workspaceDir,
		prompter: params.prompter,
		runtime: params.runtime,
		allowSecretRefPrompt: false,
		isRemote: isRemoteEnvironment(),
		openUrl: async (url) => {
			const { openUrl } = await import("./onboard-helpers-D6Jh6IDD.js");
			await openUrl(url);
		},
		oauth: { createVpsAwareHandlers: (runtimeParams) => createVpsAwareOAuthHandlers(runtimeParams) }
	});
	const resultProviderIds = new Set(result.profiles.map((profile) => normalizeProviderId(profile.credential.provider)));
	for (const providerId of resultProviderIds) if (providerId && providerId !== selectedProviderId) await clearStaleProfileLockouts(providerId, params.agentDir);
	await persistProviderAuthResult({
		result,
		agentDir: params.agentDir,
		runtime: params.runtime,
		prompter: params.prompter,
		setDefault: params.setDefault
	});
}
async function modelsAuthSetupTokenCommand(opts, runtime) {
	if (!process.stdin.isTTY) throw new Error(`setup-token requires an interactive TTY. In automation, use ${formatCliCommand("openclaw models auth paste-token --provider <provider>")} instead.`);
	const { config, agentDir, workspaceDir, providers } = await resolveModelsAuthContext({
		requestedProvider: opts.provider,
		rawAgentId: opts.agent
	});
	const tokenProviders = listProvidersWithTokenMethods(providers);
	if (tokenProviders.length === 0) throw new Error(`No provider token-auth plugins found. Install one via \`${formatCliCommand("openclaw plugins install")}\`.`);
	const provider = resolveRequestedProviderOrThrow(tokenProviders, opts.provider) ?? tokenProviders[0] ?? null;
	if (!provider) throw new Error(`No token-capable provider is available. Run ${formatCliCommand("openclaw plugins list")} to verify provider plugins are installed.`);
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
	const agentDir = await resolveModelsAuthAgentDir(opts.agent);
	const rawProvider = normalizeOptionalString(opts.provider);
	if (!rawProvider) throw new Error(`Missing --provider. Run ${formatCliCommand("openclaw models status")} or ${formatCliCommand("openclaw plugins list")} to choose a provider.`);
	const provider = normalizeProviderId(rawProvider);
	const profileId = normalizeOptionalString(opts.profileId) || resolveDefaultTokenProfileId(provider);
	const tokenInput = await readPastedSecret({
		message: `Paste token for ${provider}`,
		masked: false,
		validate: (value) => {
			const trimmed = value?.trim();
			if (!trimmed) return "Required";
			if (provider === "anthropic") return validateAnthropicSetupToken(trimmed.replaceAll(/\s+/g, ""));
			if (isOpenAICodexProvider(provider) && looksLikeOpenAIApiKey(trimmed)) return `That looks like an OpenAI API key. Use ${formatCliCommand("openclaw models auth paste-api-key --provider openai-codex")} for API-key auth.`;
		}
	});
	const token = provider === "anthropic" ? tokenInput.replaceAll(/\s+/g, "").trim() : normalizeOptionalString(tokenInput) ?? "";
	const expires = normalizeStringifiedOptionalString(opts.expiresIn) ? Date.now() + parseDurationMs(normalizeStringifiedOptionalString(opts.expiresIn) ?? "", { defaultUnit: "d" }) : void 0;
	await upsertAuthProfileWithLockOrThrow({
		profileId,
		credential: {
			type: "token",
			provider,
			token,
			...expires ? { expires } : {}
		},
		agentDir
	});
	await updateConfig((cfg) => applyAuthProfileConfig(cfg, {
		profileId,
		provider,
		mode: "token"
	}));
	logConfigUpdated(runtime);
	runtime.log(`Auth profile: ${profileId} (${provider}/token)`);
	if (provider === "anthropic") {
		runtime.log("Anthropic setup-token auth is supported in OpenClaw.");
		runtime.log("OpenClaw prefers Claude CLI reuse when it is available on the host.");
		runtime.log("Anthropic staff told us this OpenClaw path is allowed again.");
	}
}
async function modelsAuthPasteApiKeyCommand(opts, runtime) {
	const agentDir = await resolveModelsAuthAgentDir(opts.agent);
	const rawProvider = normalizeOptionalString(opts.provider);
	if (!rawProvider) throw new Error(`Missing --provider. Run ${formatCliCommand("openclaw models status")} or ${formatCliCommand("openclaw plugins list")} to choose a provider.`);
	const provider = normalizeProviderId(rawProvider);
	const profileId = normalizeOptionalString(opts.profileId) || resolveDefaultTokenProfileId(provider);
	await upsertAuthProfileWithLockOrThrow({
		profileId,
		credential: {
			type: "api_key",
			provider,
			key: await readPastedSecret({
				message: `Paste API key for ${provider}`,
				masked: true,
				validate: (value) => {
					const trimmed = value?.trim();
					if (!trimmed) return "Required";
					if (isOpenAICodexProvider(provider)) return validateOpenAICodexApiKeyInput(trimmed);
				}
			})
		},
		agentDir
	});
	await updateConfig((cfg) => applyAuthProfileConfig(cfg, {
		profileId,
		provider,
		mode: "api_key"
	}));
	logConfigUpdated(runtime);
	runtime.log(`Auth profile: ${profileId} (${provider}/api_key)`);
}
async function upsertAuthProfileWithLockOrThrow(params) {
	if (!await upsertAuthProfileWithLock(params)) throw new Error("Failed to update auth profile store; the auth store lock may be busy. Wait a moment and retry.");
}
async function modelsAuthAddCommand(opts, runtime) {
	const { config, agentDir, workspaceDir, providers } = await resolveModelsAuthContext({ rawAgentId: opts.agent });
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
	const providerId = provider === "custom" ? normalizeProviderId(await text$1({
		message: "Provider id",
		validate: (value) => value?.trim() ? void 0 : "Required"
	})) : provider;
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
			if (!method) throw new Error(`Unknown token auth method "${methodId}". Run ${formatCliCommand("openclaw models auth login --provider " + providerPlugin.id)} to choose interactively.`);
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
	await modelsAuthPasteTokenCommand({
		provider: providerId,
		profileId: (await text$1({
			message: "Profile id",
			initialValue: resolveDefaultTokenProfileId(providerId),
			validate: (value) => value?.trim() ? void 0 : "Required"
		})).trim(),
		expiresIn: await confirm$1({
			message: "Does this token expire?",
			initialValue: false
		}) ? (await text$1({
			message: "Expires in (duration)",
			initialValue: "365d",
			validate: (value) => {
				try {
					parseDurationMs(value ?? "", { defaultUnit: "d" });
					return;
				} catch {
					return "Invalid duration (e.g. 365d, 12h, 30m)";
				}
			}
		})).trim() : void 0,
		agent: opts.agent
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
		const store = loadAuthProfileStoreForRuntime(agentDir, { externalCli: externalCliDiscoveryForProviderAuth({ provider }) });
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
function maybeLogOpenAICodexNativeSearchTip(runtime, providerId) {
	if (providerId !== "openai-codex") return;
	runtime.log("Tip: Codex-capable models can use native Codex web search. Enable it with openclaw configure --section web (recommended mode: cached). Docs: https://docs.openclaw.ai/tools/web");
}
async function modelsAuthLoginCommand(opts, runtime) {
	if (!process.stdin.isTTY) throw new Error(`models auth login requires an interactive TTY. In automation, use ${formatCliCommand("openclaw models auth paste-token --provider <provider>")} when token auth is available.`);
	const { config, agentDir, workspaceDir, providers } = await resolveModelsAuthContext({
		requestedProvider: opts.provider,
		rawAgentId: opts.agent
	});
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
	}).then((id) => resolveProviderMatch(authProviders, id));
	if (!selectedProvider) throw new Error(`Unknown provider. Run ${formatCliCommand("openclaw models status")} or ${formatCliCommand("openclaw plugins list")} to see available provider plugins.`);
	const chosenMethod = await pickProviderAuthMethod({
		provider: selectedProvider,
		requestedMethod: opts.method,
		prompter
	});
	if (!chosenMethod) throw new Error(`Unknown auth method. Run ${formatCliCommand("openclaw models auth login --provider " + selectedProvider.id)} without --method to choose interactively.`);
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
	maybeLogOpenAICodexNativeSearchTip(runtime, selectedProvider.id);
}
//#endregion
export { modelsAuthAddCommand, modelsAuthLoginCommand, modelsAuthPasteApiKeyCommand, modelsAuthPasteTokenCommand, modelsAuthSetupTokenCommand };
