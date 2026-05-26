import { n as normalizeAgentModelRefForConfig } from "./model-input-ChW9XXsQ.js";
import "./agent-scope-CtLXGcWm.js";
import { n as resolveDefaultAgentWorkspaceDir } from "./workspace-default--mMaLHGD.js";
import { a as resolveAgentDir, c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { t as sanitizeTerminalText } from "./safe-text-J_0sTthZ.js";
import { t as formatLiteralProviderPrefixedModelRef } from "./model-ref-shared-BkjJfDrJ.js";
import { t as enablePluginInConfig } from "./enable-DL58ncJE.js";
import "./workspace-DTx8zuCN.js";
import "./auth-profiles-D6NMnufG.js";
import { s as upsertAuthProfileWithLock } from "./profiles-9GB1thhi.js";
import { t as applyAuthProfileConfig } from "./provider-auth-helpers-BZ5Z8RV6.js";
import { n as t } from "./i18n-CWNhN747.js";
import { n as openUrl } from "./browser-open-BTGCmG6r.js";
import { r as resolveManifestProviderAuthChoice } from "./provider-auth-choices-BFWeF5vS.js";
import { n as resolveProviderInstallCatalogEntry } from "./provider-install-catalog-BboFtl6M.js";
import { n as applyProviderAuthConfigPatch, t as applyDefaultModel } from "./provider-auth-choice-helpers-DA-F8Rp0.js";
import { t as createVpsAwareOAuthHandlers } from "./provider-oauth-flow-yFbEzcQS.js";
import { t as isRemoteEnvironment } from "./remote-env-CBc5PaHP.js";
//#region src/plugins/provider-auth-choice.ts
function formatModelRefForDisplay(modelRef, provider) {
	if (!provider.preserveLiteralProviderPrefix) return modelRef;
	return formatLiteralProviderPrefixedModelRef(provider.id, modelRef);
}
function restoreConfiguredPrimaryModel(nextConfig, originalConfig) {
	const originalModel = originalConfig.agents?.defaults?.model;
	const nextAgents = nextConfig.agents;
	const nextDefaults = nextAgents?.defaults;
	if (!nextDefaults) return nextConfig;
	if (originalModel !== void 0) return {
		...nextConfig,
		agents: {
			...nextAgents,
			defaults: {
				...nextDefaults,
				model: originalModel
			}
		}
	};
	const { model: _model, ...restDefaults } = nextDefaults;
	return {
		...nextConfig,
		agents: {
			...nextAgents,
			defaults: restDefaults
		}
	};
}
function resolveConfiguredDefaultModelPrimary(cfg) {
	const model = cfg.agents?.defaults?.model;
	if (typeof model === "string") return model;
	if (model && typeof model === "object" && typeof model.primary === "string") return model.primary;
}
async function noteDefaultModelResult(params) {
	const selectedModelDisplay = params.selectedModelDisplay ?? params.selectedModel;
	if (params.preserveExistingDefaultModel === true && params.previousPrimary && params.previousPrimary !== params.selectedModel) {
		await params.prompter.note(t("wizard.model.keptExistingDefault", {
			current: params.previousPrimary,
			selected: selectedModelDisplay
		}), t("wizard.model.configuredTitle"));
		return;
	}
	await params.prompter.note(t("wizard.model.defaultSet", { model: selectedModelDisplay }), t("wizard.model.configuredTitle"));
}
async function applyDefaultModelFromAuthChoice(params) {
	const defaultModelBaseConfig = params.configBeforeProviderAuth ?? params.config;
	const previousPrimary = resolveConfiguredDefaultModelPrimary(defaultModelBaseConfig);
	const preservesDifferentPrimary = params.preserveExistingDefaultModel === true && previousPrimary !== void 0 && previousPrimary !== params.selectedModel;
	let nextConfig = applyDefaultModel(params.preserveExistingDefaultModel === true ? restoreConfiguredPrimaryModel(params.config, defaultModelBaseConfig) : params.config, params.selectedModel, { preserveExistingPrimary: params.preserveExistingDefaultModel === true });
	if (!preservesDifferentPrimary) {
		const { CODEX_RUNTIME_PLUGIN_ID, ensureCodexRuntimePluginForModelSelection } = await import("./codex-runtime-plugin-install-DXOl35hX.js");
		const codexInstall = await ensureCodexRuntimePluginForModelSelection({
			cfg: nextConfig,
			model: params.selectedModel,
			prompter: params.prompter,
			runtime: params.runtime,
			...params.workspaceDir !== void 0 ? { workspaceDir: params.workspaceDir } : {}
		});
		nextConfig = codexInstall.cfg;
		await params.runSelectedModelHook(nextConfig);
		if (codexInstall.installed) {
			const { offerPostInstallMigrations } = await import("./setup.post-install-migration-CLdb6xxv.js");
			nextConfig = (await offerPostInstallMigrations({
				config: nextConfig,
				runtime: params.runtime,
				prompter: params.prompter,
				installedPluginIds: [CODEX_RUNTIME_PLUGIN_ID]
			})).config;
		}
	}
	await noteDefaultModelResult({
		previousPrimary,
		selectedModel: params.selectedModel,
		selectedModelDisplay: params.selectedModelDisplay,
		preserveExistingDefaultModel: params.preserveExistingDefaultModel,
		prompter: params.prompter
	});
	return nextConfig;
}
let providerAuthChoiceDeps = { loadPluginProviderRuntime: async () => import("./provider-auth-choice.runtime-Bl0CDGQM.js") };
async function loadPluginProviderRuntime() {
	return await providerAuthChoiceDeps.loadPluginProviderRuntime();
}
function resolveManifestAuthChoiceScope(params) {
	return resolveManifestProviderAuthChoice(params.authChoice, {
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		includeUntrustedWorkspacePlugins: false
	});
}
function withProviderPluginId(provider, pluginId) {
	return provider.pluginId === pluginId ? provider : {
		...provider,
		pluginId
	};
}
async function runProviderPluginAuthMethod(params) {
	const agentId = params.agentId ?? resolveDefaultAgentId(params.config);
	const agentDir = params.agentDir ?? resolveAgentDir(params.config, agentId);
	const workspaceDir = params.workspaceDir ?? resolveAgentWorkspaceDir(params.config, agentId) ?? resolveDefaultAgentWorkspaceDir();
	const result = await params.method.run({
		config: params.config,
		env: params.env,
		agentDir,
		workspaceDir,
		prompter: params.prompter,
		runtime: params.runtime,
		opts: params.opts,
		secretInputMode: params.secretInputMode,
		allowSecretRefPrompt: params.allowSecretRefPrompt,
		isRemote: isRemoteEnvironment(),
		openUrl: async (url) => {
			await openUrl(url);
		},
		oauth: { createVpsAwareHandlers: (opts) => createVpsAwareOAuthHandlers(opts) }
	});
	let nextConfig = params.config;
	if (result.configPatch) nextConfig = applyProviderAuthConfigPatch(nextConfig, result.configPatch, { replaceDefaultModels: result.replaceDefaultModels });
	for (const profile of result.profiles) {
		await upsertAuthProfileWithLockOrThrow({
			profileId: profile.profileId,
			credential: profile.credential,
			agentDir
		});
		nextConfig = applyAuthProfileConfig(nextConfig, {
			profileId: profile.profileId,
			provider: profile.credential.provider,
			mode: profile.credential.type === "token" ? "token" : profile.credential.type,
			..."email" in profile.credential && profile.credential.email ? { email: profile.credential.email } : {},
			..."displayName" in profile.credential && profile.credential.displayName ? { displayName: profile.credential.displayName } : {}
		});
	}
	if (params.emitNotes !== false && result.notes && result.notes.length > 0) await params.prompter.note(result.notes.join("\n"), "Provider notes");
	const defaultModel = result.defaultModel ? normalizeAgentModelRefForConfig(result.defaultModel) : void 0;
	return {
		config: nextConfig,
		...defaultModel ? { defaultModel } : {}
	};
}
async function applyAuthChoiceLoadedPluginProvider(params) {
	const agentId = params.agentId ?? resolveDefaultAgentId(params.config);
	const workspaceDir = resolveAgentWorkspaceDir(params.config, agentId) ?? resolveDefaultAgentWorkspaceDir();
	let nextConfig = params.config;
	let enabledConfig = params.config;
	const { resolvePluginProviders, resolvePluginSetupProvider, resolveProviderPluginChoice, runProviderModelSelectedHook } = await loadPluginProviderRuntime();
	const manifestAuthChoice = resolveManifestAuthChoiceScope({
		authChoice: params.authChoice,
		config: nextConfig,
		workspaceDir,
		env: params.env
	});
	const installCatalogEntry = resolveProviderInstallCatalogEntry(params.authChoice, {
		config: nextConfig,
		workspaceDir,
		env: params.env,
		includeUntrustedWorkspacePlugins: false
	});
	const choicePlugin = manifestAuthChoice ? {
		pluginId: manifestAuthChoice.pluginId,
		label: manifestAuthChoice.choiceLabel
	} : installCatalogEntry ? {
		pluginId: installCatalogEntry.pluginId,
		label: installCatalogEntry.label
	} : void 0;
	if (choicePlugin) {
		const enableResult = enablePluginInConfig(nextConfig, choicePlugin.pluginId);
		if (!enableResult.enabled) {
			const safeLabel = sanitizeTerminalText(choicePlugin.label);
			await params.prompter.note(`${safeLabel} plugin is disabled (${enableResult.reason ?? "blocked"}).`, safeLabel);
			return { config: nextConfig };
		}
		enabledConfig = enableResult.config;
	}
	const resolveScopedRuntimeProviders = (config) => resolvePluginProviders({
		config,
		workspaceDir,
		env: params.env,
		mode: "setup",
		...manifestAuthChoice ? {
			onlyPluginIds: [manifestAuthChoice.pluginId],
			providerRefs: [manifestAuthChoice.providerId]
		} : {}
	});
	const setupProvider = manifestAuthChoice ? resolvePluginSetupProvider({
		provider: manifestAuthChoice.providerId,
		config: enabledConfig,
		workspaceDir,
		env: params.env,
		pluginIds: [manifestAuthChoice.pluginId]
	}) : void 0;
	let providers = setupProvider ? [withProviderPluginId(setupProvider, manifestAuthChoice.pluginId)] : resolveScopedRuntimeProviders(enabledConfig);
	let resolved = resolveProviderPluginChoice({
		providers,
		choice: params.authChoice
	});
	if (!resolved && setupProvider) {
		providers = resolveScopedRuntimeProviders(enabledConfig);
		resolved = resolveProviderPluginChoice({
			providers,
			choice: params.authChoice
		});
	}
	if (!resolved && installCatalogEntry) {
		const { ensureOnboardingPluginInstalled } = await import("./onboarding-plugin-install-DCfg_Pro.js");
		const installResult = await ensureOnboardingPluginInstalled({
			cfg: nextConfig,
			entry: {
				pluginId: installCatalogEntry.pluginId,
				label: installCatalogEntry.label,
				install: installCatalogEntry.install,
				...installCatalogEntry.origin === "bundled" ? { trustedSourceLinkedOfficialInstall: true } : {}
			},
			prompter: params.prompter,
			runtime: params.runtime,
			workspaceDir
		});
		if (!installResult.installed) return {
			config: installResult.cfg,
			retrySelection: true
		};
		nextConfig = installResult.cfg;
		providers = resolveScopedRuntimeProviders(nextConfig);
		resolved = resolveProviderPluginChoice({
			providers,
			choice: params.authChoice
		});
	}
	if (!resolved) return nextConfig === params.config ? null : {
		config: nextConfig,
		retrySelection: true
	};
	if (nextConfig === params.config && enabledConfig !== params.config) nextConfig = enabledConfig;
	const configBeforeProviderAuth = nextConfig;
	const applied = await runProviderPluginAuthMethod({
		config: nextConfig,
		env: params.env,
		runtime: params.runtime,
		prompter: params.prompter,
		method: resolved.method,
		agentDir: params.agentDir,
		agentId: params.agentId,
		workspaceDir,
		secretInputMode: params.opts?.secretInputMode,
		allowSecretRefPrompt: false,
		opts: params.opts
	});
	nextConfig = applied.config;
	let agentModelOverride;
	if (applied.defaultModel) {
		const selectedModel = applied.defaultModel;
		const selectedModelDisplay = formatModelRefForDisplay(selectedModel, resolved.provider);
		if (params.setDefaultModel) {
			nextConfig = await applyDefaultModelFromAuthChoice({
				config: nextConfig,
				configBeforeProviderAuth,
				selectedModel,
				selectedModelDisplay,
				preserveExistingDefaultModel: params.preserveExistingDefaultModel,
				prompter: params.prompter,
				runtime: params.runtime,
				workspaceDir,
				runSelectedModelHook: async (config) => {
					await runProviderModelSelectedHook({
						config,
						model: selectedModel,
						prompter: params.prompter,
						agentDir: params.agentDir,
						workspaceDir
					});
				}
			});
			return { config: nextConfig };
		}
		nextConfig = restoreConfiguredPrimaryModel(nextConfig, params.config);
		agentModelOverride = selectedModel;
	}
	return {
		config: nextConfig,
		agentModelOverride
	};
}
async function upsertAuthProfileWithLockOrThrow(params) {
	if (!await upsertAuthProfileWithLock(params)) throw new Error("Failed to update auth profile store; the auth store lock may be busy. Wait a moment and retry.");
}
//#endregion
export { runProviderPluginAuthMethod as n, applyAuthChoiceLoadedPluginProvider as t };
