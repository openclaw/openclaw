import { c as normalizeOptionalString, d as normalizeStringifiedOptionalString } from "./string-coerce-Bje8XVt9.js";
import { t as formatCliCommand } from "./command-format-DXo6xcsW.js";
import { r as normalizeProviderId } from "./provider-id-dd60CFPS.js";
import { n as resolveDefaultAgentWorkspaceDir } from "./workspace-default-D4pXK3zL.js";
import { S as resolveDefaultAgentId, b as resolveAgentDir, x as resolveAgentWorkspaceDir } from "./agent-scope-CzfWAE9r.js";
import { t as parseDurationMs } from "./parse-duration-BN0AM1mL.js";
import { s as loadAuthProfileStoreForRuntime } from "./store-kA9k3QAn.js";
import { n as resolvePluginProviders } from "./providers.runtime-CDdiO1sH.js";
import "./model-selection-shared-HUsqLCFt.js";
import "./auth-profiles-CTRxy_8C.js";
import { n as externalCliDiscoveryForProviderAuth } from "./external-cli-discovery-yomk1YD5.js";
import { n as listProfilesForProvider } from "./profile-list-XGxWKi66.js";
import { i as upsertAuthProfile } from "./profiles-DIU0hInF.js";
import { n as clearAuthProfileCooldown } from "./usage-BkwuGyqy.js";
import "./workspace-CE_ex45Q.js";
import { n as validateAnthropicSetupToken } from "./provider-auth-token-BfOi3Rdv.js";
import { t as applyAuthProfileConfig } from "./provider-auth-helpers-B4kz9l2L.js";
import { n as stylePromptMessage, t as stylePromptHint } from "./prompt-style-CAViFBt9.js";
import { t as createClackPrompter } from "./clack-prompter-CuVjoFs3.js";
import { n as logConfigUpdated } from "./logging-Cds-1VVS.js";
import { a as loadValidConfigOrThrow, s as resolveKnownAgentId, u as updateConfig } from "./shared-CDB1vyks.js";
import { i as resolveProviderMatch, n as applyProviderAuthConfigPatch, r as pickAuthMethod, t as applyDefaultModel } from "./provider-auth-choice-helpers-BI3XkRiU.js";
import { t as createVpsAwareOAuthHandlers } from "./provider-oauth-flow-CoE6NutF.js";
import { t as isRemoteEnvironment } from "./remote-env-hafZlIxC.js";
import { cancel, confirm, isCancel, select, text } from "@clack/prompts";
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
	for (const profile of params.result.profiles) upsertAuthProfile({
		profileId: profile.profileId,
		credential: profile.credential,
		agentDir: params.agentDir
	});
	await updateConfig((cfg) => {
		let next = cfg;
		if (params.result.configPatch) next = applyProviderAuthConfigPatch(next, params.result.configPatch, { replaceDefaultModels: params.result.replaceDefaultModels });
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
			env: process.env,
			agentDir: params.agentDir,
			workspaceDir: params.workspaceDir,
			prompter: params.prompter,
			runtime: params.runtime,
			allowSecretRefPrompt: false,
			isRemote: isRemoteEnvironment(),
			openUrl: async (url) => {
				const { openUrl } = await import("./onboard-helpers-BpUxRph_.js");
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
	const { config, agentDir, workspaceDir, providers } = await resolveModelsAuthContext({
		requestedProvider: opts.provider,
		rawAgentId: opts.agent
	});
	const tokenProviders = listProvidersWithTokenMethods(providers);
	if (tokenProviders.length === 0) throw new Error(`No provider token-auth plugins found. Install one via \`${formatCliCommand("openclaw plugins install")}\`.`);
	const provider = resolveRequestedProviderOrThrow(tokenProviders, opts.provider) ?? tokenProviders[0] ?? null;
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
	const agentDir = await resolveModelsAuthAgentDir(opts.agent);
	const rawProvider = normalizeOptionalString(opts.provider);
	if (!rawProvider) throw new Error("Missing --provider.");
	const provider = normalizeProviderId(rawProvider);
	const profileId = normalizeOptionalString(opts.profileId) || resolveDefaultTokenProfileId(provider);
	const tokenInput = await text$1({
		message: `Paste token for ${provider}`,
		validate: (value) => {
			const trimmed = value?.trim();
			if (!trimmed) return "Required";
			if (provider === "anthropic") return validateAnthropicSetupToken(trimmed.replaceAll(/\s+/g, ""));
		}
	});
	const token = provider === "anthropic" ? tokenInput.replaceAll(/\s+/g, "").trim() : normalizeOptionalString(tokenInput) ?? "";
	const expires = normalizeStringifiedOptionalString(opts.expiresIn) ? Date.now() + parseDurationMs(normalizeStringifiedOptionalString(opts.expiresIn) ?? "", { defaultUnit: "d" }) : void 0;
	upsertAuthProfile({
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
			if (!method) throw new Error(`Unknown token auth method "${methodId}".`);
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
	if (!process.stdin.isTTY) throw new Error("models auth login requires an interactive TTY.");
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
	maybeLogOpenAICodexNativeSearchTip(runtime, selectedProvider.id);
}
//#endregion
export { modelsAuthAddCommand, modelsAuthLoginCommand, modelsAuthPasteTokenCommand, modelsAuthSetupTokenCommand };
