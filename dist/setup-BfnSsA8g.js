import { d as resolveGatewayPort } from "./paths-Cw7f9XhU.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { p as resolveUserPath } from "./utils-sBTEdeml.js";
import { d as normalizeSecretInputString } from "./types.secrets-DwPik3M8.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { r as createConfigIO } from "./io-DoswVvYe.js";
import { i as replaceConfigFile } from "./mutate-DLC8bveh.js";
import "./config-B6Oplu5W.js";
import { t as WizardCancelledError } from "./prompts-E0FayNjJ.js";
import { n as t } from "./i18n-CWNhN747.js";
import { l as formatPluginCompatibilityNotice, r as buildPluginCompatibilitySnapshotNotices } from "./status-BvY0BMpM.js";
import { n as commitConfigWriteWithPendingPluginInstalls } from "./plugins-install-record-commit-Cwrnavi6.js";
import { t as resolveSetupSecretInputString } from "./setup.secret-input-CDzkHBam.js";
import { r as runSetupMigrationImport, t as detectSetupMigrationSources } from "./setup.migration-import-Cs2ey5cd.js";
import chalk from "chalk";
//#region src/wizard/setup.security-note.ts
const heading = (text) => chalk.bold(text);
function getSecurityNoteTitle() {
	return t("wizard.security.title");
}
function getSecurityConfirmMessage() {
	return t("wizard.security.confirm");
}
function getSecurityNoteMessage() {
	return [
		t("wizard.security.beta"),
		t("wizard.security.personalAgent"),
		t("wizard.security.toolAccess"),
		t("wizard.security.promptRisk"),
		"",
		t("wizard.security.notMultitenant"),
		t("wizard.security.sharedAuthority"),
		"",
		t("wizard.security.hardeningRequired"),
		t("wizard.security.askForHelp"),
		"",
		heading(t("wizard.security.recommendedBaseline")),
		`- ${t("wizard.security.baselinePairing")}`,
		`- ${t("wizard.security.baselineSharedInbox")}`,
		`- ${t("wizard.security.baselineSandbox")}`,
		`- ${t("wizard.security.baselineDmSessions")}`,
		`- ${t("wizard.security.baselineSecrets")}`,
		`- ${t("wizard.security.baselineStrongModel")}`,
		"",
		heading(t("wizard.security.runRegularly")),
		formatCliCommand("openclaw security audit --deep"),
		formatCliCommand("openclaw security audit --fix"),
		"",
		heading(t("wizard.security.learnMore")),
		"- https://docs.openclaw.ai/gateway/security"
	].join("\n");
}
//#endregion
//#region src/wizard/setup.ts
let authChoiceModulePromise;
let configLoggingModulePromise;
let modelPickerModulePromise;
function loadAuthChoiceModule() {
	authChoiceModulePromise ??= import("./auth-choice-CetVgbsx.js");
	return authChoiceModulePromise;
}
function loadConfigLoggingModule() {
	configLoggingModulePromise ??= import("./logging-CIueBFy7.js");
	return configLoggingModulePromise;
}
function loadModelPickerModule() {
	modelPickerModulePromise ??= import("./model-picker-w5TglaRO.js");
	return modelPickerModulePromise;
}
async function writeWizardConfigFile(config) {
	return (await commitConfigWriteWithPendingPluginInstalls({
		nextConfig: config,
		commit: async (nextConfig, writeOptions) => {
			return await replaceConfigFile({
				nextConfig,
				writeOptions: {
					...writeOptions,
					allowConfigSizeDrop: true
				},
				afterWrite: { mode: "auto" }
			});
		}
	})).config;
}
async function readSetupConfigFileSnapshot() {
	return await createConfigIO({ pluginValidation: "skip" }).readConfigFileSnapshot();
}
async function resolveAuthChoiceModelSelectionPolicy(params) {
	const preferredProvider = await params.resolvePreferredProviderForAuthChoice({
		choice: params.authChoice,
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env
	});
	const [{ resolveManifestProviderAuthChoice }, { resolvePluginSetupProvider }] = await Promise.all([import("./provider-auth-choices-BzMzxU47.js"), import("./setup-registry-XuAj8i8r.js")]);
	const manifestChoice = resolveManifestProviderAuthChoice(params.authChoice, {
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		includeUntrustedWorkspacePlugins: false
	});
	if (manifestChoice) {
		const setupProvider = resolvePluginSetupProvider({
			provider: manifestChoice.providerId,
			config: params.config,
			workspaceDir: params.workspaceDir,
			env: params.env,
			pluginIds: [manifestChoice.pluginId]
		});
		const setupPolicy = (setupProvider?.auth.find((method) => normalizeProviderId(method.id) === normalizeProviderId(manifestChoice.methodId)))?.wizard?.modelSelection ?? setupProvider?.wizard?.setup?.modelSelection;
		return {
			preferredProvider,
			promptWhenAuthChoiceProvided: setupPolicy?.promptWhenAuthChoiceProvided === true,
			allowKeepCurrent: setupPolicy?.allowKeepCurrent ?? true
		};
	}
	const { resolvePluginProviders, resolveProviderPluginChoice } = await import("./provider-auth-choice.runtime-Bl0CDGQM.js");
	const providers = resolvePluginProviders({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		mode: "setup"
	});
	const resolvedChoice = resolveProviderPluginChoice({
		providers,
		choice: params.authChoice
	});
	const matchedProvider = resolvedChoice?.provider ?? (() => {
		const preferredId = preferredProvider?.trim();
		if (!preferredId) return;
		return providers.find((provider) => typeof provider.id === "string" && provider.id.trim() === preferredId);
	})();
	const setupPolicy = resolvedChoice?.wizard?.modelSelection ?? matchedProvider?.wizard?.setup?.modelSelection;
	return {
		preferredProvider,
		promptWhenAuthChoiceProvided: setupPolicy?.promptWhenAuthChoiceProvided === true,
		allowKeepCurrent: setupPolicy?.allowKeepCurrent ?? true
	};
}
async function requireRiskAcknowledgement(params) {
	if (params.opts.acceptRisk === true) return;
	await params.prompter.note(getSecurityNoteMessage(), getSecurityNoteTitle());
	if (!await params.prompter.confirm({
		message: getSecurityConfirmMessage(),
		initialValue: false
	})) throw new WizardCancelledError(t("wizard.setup.riskNotAccepted"));
}
async function runSetupWizard(opts, runtime, prompter) {
	runtime ??= defaultRuntime;
	const onboardHelpers = await import("./onboard-helpers-D6Jh6IDD.js");
	onboardHelpers.printWizardHeader(runtime);
	await prompter.intro(t("wizard.setup.intro"));
	await requireRiskAcknowledgement({
		opts,
		prompter
	});
	const snapshot = await readSetupConfigFileSnapshot();
	let baseConfig = snapshot.valid ? snapshot.exists ? snapshot.sourceConfig ?? snapshot.config : {} : {};
	if (snapshot.exists && !snapshot.valid) {
		await prompter.note(onboardHelpers.summarizeExistingConfig(baseConfig), t("wizard.setup.invalidConfigTitle"));
		if (snapshot.issues.length > 0) await prompter.note([
			...snapshot.issues.map((iss) => `- ${iss.path}: ${iss.message}`),
			"",
			"Docs: https://docs.openclaw.ai/gateway/configuration"
		].join("\n"), "Config issues");
		await prompter.outro(`Config invalid. Run \`${formatCliCommand("openclaw doctor")}\` to repair it, then re-run setup.`);
		runtime.exit(1);
		return;
	}
	const compatibilityNotices = snapshot.valid ? buildPluginCompatibilitySnapshotNotices({ config: baseConfig }) : [];
	if (compatibilityNotices.length > 0) await prompter.note([
		`Detected ${compatibilityNotices.length} plugin compatibility notice${compatibilityNotices.length === 1 ? "" : "s"} in the current config.`,
		...compatibilityNotices.slice(0, 4).map((notice) => `- ${formatPluginCompatibilityNotice(notice)}`),
		...compatibilityNotices.length > 4 ? [`- ... +${compatibilityNotices.length - 4} more`] : [],
		"",
		`Review: ${formatCliCommand("openclaw doctor")}`,
		`Inspect: ${formatCliCommand("openclaw plugins inspect --all")}`
	].join("\n"), t("wizard.setup.pluginCompatibilityTitle"));
	const quickstartHint = t("wizard.setup.flowQuickstartHint", { command: formatCliCommand("openclaw configure") });
	const manualHint = t("wizard.setup.flowAdvancedHint");
	const migrationDetections = await detectSetupMigrationSources({
		config: baseConfig,
		runtime
	});
	const firstMigrationDetection = migrationDetections[0];
	const importOption = firstMigrationDetection ? {
		value: "import",
		label: `Import from ${firstMigrationDetection.label}`,
		...firstMigrationDetection.source ? { hint: firstMigrationDetection.source } : {}
	} : void 0;
	const explicitFlowRaw = opts.flow?.trim();
	const normalizedExplicitFlow = explicitFlowRaw === "manual" ? "advanced" : explicitFlowRaw;
	if (normalizedExplicitFlow && normalizedExplicitFlow !== "quickstart" && normalizedExplicitFlow !== "advanced" && normalizedExplicitFlow !== "import") {
		runtime.error("Invalid --flow. Use quickstart, manual, advanced, or import. Example: openclaw onboard --flow quickstart");
		runtime.exit(1);
		return;
	}
	let flow = (normalizedExplicitFlow === "quickstart" || normalizedExplicitFlow === "advanced" || normalizedExplicitFlow === "import" ? normalizedExplicitFlow : void 0) ?? await prompter.select({
		message: t("wizard.setup.setupMode"),
		options: [
			{
				value: "quickstart",
				label: t("wizard.setup.flowQuickstart"),
				hint: quickstartHint
			},
			{
				value: "advanced",
				label: t("wizard.setup.flowAdvanced"),
				hint: manualHint
			},
			...importOption ? [importOption] : []
		],
		initialValue: "quickstart"
	});
	if (opts.mode === "remote" && flow === "quickstart") {
		await prompter.note(t("wizard.setup.quickstartOnlyLocal"), t("wizard.setup.quickstartTitle"));
		flow = "advanced";
	}
	if (snapshot.exists) {
		await prompter.note(onboardHelpers.summarizeExistingConfig(baseConfig), t("wizard.setup.existingConfigTitle"));
		if (await prompter.select({
			message: t("wizard.setup.configHandling"),
			options: [
				{
					value: "keep",
					label: t("wizard.setup.keepCurrent")
				},
				{
					value: "modify",
					label: t("wizard.setup.modifyCurrent")
				},
				{
					value: "reset",
					label: t("wizard.setup.resetBefore")
				}
			]
		}) === "reset") {
			const workspaceDefault = baseConfig.agents?.defaults?.workspace ?? onboardHelpers.DEFAULT_WORKSPACE;
			const resetScope = await prompter.select({
				message: t("wizard.setup.resetScope"),
				options: [
					{
						value: "config",
						label: t("wizard.setup.resetConfig")
					},
					{
						value: "config+creds+sessions",
						label: t("wizard.setup.resetConfigCredsSessions")
					},
					{
						value: "full",
						label: t("wizard.setup.resetFull")
					}
				]
			});
			await onboardHelpers.handleReset(resetScope, resolveUserPath(workspaceDefault), runtime);
			baseConfig = {};
		}
	}
	if (opts.importFrom || flow === "import") {
		await runSetupMigrationImport({
			opts,
			baseConfig,
			detections: migrationDetections,
			prompter,
			runtime,
			commitConfigFile: writeWizardConfigFile
		});
		return;
	}
	const wizardFlow = flow;
	const quickstartGateway = (() => {
		const hasExisting = typeof baseConfig.gateway?.port === "number" || baseConfig.gateway?.bind !== void 0 || baseConfig.gateway?.auth?.mode !== void 0 || baseConfig.gateway?.auth?.token !== void 0 || baseConfig.gateway?.auth?.password !== void 0 || baseConfig.gateway?.customBindHost !== void 0 || baseConfig.gateway?.tailscale?.mode !== void 0;
		const bindRaw = baseConfig.gateway?.bind;
		const bind = bindRaw === "loopback" || bindRaw === "lan" || bindRaw === "auto" || bindRaw === "custom" || bindRaw === "tailnet" ? bindRaw : "loopback";
		let authMode = "token";
		if (baseConfig.gateway?.auth?.mode === "token" || baseConfig.gateway?.auth?.mode === "password") authMode = baseConfig.gateway.auth.mode;
		else if (baseConfig.gateway?.auth?.token) authMode = "token";
		else if (baseConfig.gateway?.auth?.password) authMode = "password";
		const tailscaleRaw = baseConfig.gateway?.tailscale?.mode;
		const tailscaleMode = tailscaleRaw === "off" || tailscaleRaw === "serve" || tailscaleRaw === "funnel" ? tailscaleRaw : "off";
		return {
			hasExisting,
			port: resolveGatewayPort(baseConfig),
			bind,
			authMode,
			tailscaleMode,
			token: baseConfig.gateway?.auth?.token,
			password: baseConfig.gateway?.auth?.password,
			customBindHost: baseConfig.gateway?.customBindHost,
			tailscaleResetOnExit: baseConfig.gateway?.tailscale?.resetOnExit ?? false
		};
	})();
	if (flow === "quickstart") {
		const formatBind = (value) => {
			if (value === "loopback") return t("wizard.gateway.bindLoopback");
			if (value === "lan") return t("wizard.gateway.bindLan");
			if (value === "custom") return t("wizard.gateway.bindCustom");
			if (value === "tailnet") return t("wizard.gateway.bindTailnet");
			return t("wizard.gateway.bindAuto");
		};
		const formatAuth = (value) => {
			if (value === "token") return t("wizard.setup.quickstartAuthTokenDefault");
			return t("common.password");
		};
		const formatTailscale = (value) => {
			return t(`wizard.gatewayTailscale.${value}`);
		};
		const quickstartLines = quickstartGateway.hasExisting ? [
			t("wizard.setup.quickstartKeepSettings"),
			t("wizard.setup.quickstartGatewayPort", { port: quickstartGateway.port }),
			t("wizard.setup.quickstartGatewayBind", { bind: formatBind(quickstartGateway.bind) }),
			...quickstartGateway.bind === "custom" && quickstartGateway.customBindHost ? [t("wizard.setup.quickstartGatewayCustomIp", { host: quickstartGateway.customBindHost })] : [],
			t("wizard.setup.quickstartGatewayAuth", { auth: formatAuth(quickstartGateway.authMode) }),
			t("wizard.setup.quickstartTailscaleExposure", { exposure: formatTailscale(quickstartGateway.tailscaleMode) }),
			t("wizard.setup.quickstartDirectChannels")
		] : [
			t("wizard.setup.quickstartGatewayPort", { port: quickstartGateway.port }),
			t("wizard.setup.quickstartGatewayBind", { bind: t("wizard.gateway.bindLoopback") }),
			t("wizard.setup.quickstartGatewayAuth", { auth: t("wizard.setup.quickstartAuthTokenDefault") }),
			t("wizard.setup.quickstartTailscaleExposure", { exposure: t("wizard.gatewayTailscale.off") }),
			t("wizard.setup.quickstartDirectChannels")
		];
		await prompter.note(quickstartLines.join("\n"), "QuickStart");
	}
	const localPort = resolveGatewayPort(baseConfig);
	const localUrl = `ws://127.0.0.1:${localPort}`;
	let localGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
	try {
		const resolvedGatewayToken = await resolveSetupSecretInputString({
			config: baseConfig,
			value: baseConfig.gateway?.auth?.token,
			path: "gateway.auth.token",
			env: process.env
		});
		if (resolvedGatewayToken) localGatewayToken = resolvedGatewayToken;
	} catch (error) {
		await prompter.note([t("wizard.setup.secretRefProbeFailed", { field: "gateway.auth.token" }), formatErrorMessage(error)].join("\n"), t("wizard.gateway.auth"));
	}
	let localGatewayPassword = process.env.OPENCLAW_GATEWAY_PASSWORD;
	try {
		const resolvedGatewayPassword = await resolveSetupSecretInputString({
			config: baseConfig,
			value: baseConfig.gateway?.auth?.password,
			path: "gateway.auth.password",
			env: process.env
		});
		if (resolvedGatewayPassword) localGatewayPassword = resolvedGatewayPassword;
	} catch (error) {
		await prompter.note([t("wizard.setup.secretRefProbeFailed", { field: "gateway.auth.password" }), formatErrorMessage(error)].join("\n"), t("wizard.gateway.auth"));
	}
	const localProbe = await onboardHelpers.probeGatewayReachable({
		url: localUrl,
		token: localGatewayToken,
		password: localGatewayPassword
	});
	const remoteUrl = baseConfig.gateway?.remote?.url?.trim() ?? "";
	let remoteGatewayToken = normalizeSecretInputString(baseConfig.gateway?.remote?.token);
	try {
		const resolvedRemoteGatewayToken = await resolveSetupSecretInputString({
			config: baseConfig,
			value: baseConfig.gateway?.remote?.token,
			path: "gateway.remote.token",
			env: process.env
		});
		if (resolvedRemoteGatewayToken) remoteGatewayToken = resolvedRemoteGatewayToken;
	} catch (error) {
		await prompter.note(["Could not resolve gateway.remote.token SecretRef for setup probe.", formatErrorMessage(error)].join("\n"), "Gateway auth");
	}
	const remoteProbe = remoteUrl ? await onboardHelpers.probeGatewayReachable({
		url: remoteUrl,
		token: remoteGatewayToken
	}) : null;
	const mode = opts.mode ?? (flow === "quickstart" ? "local" : await prompter.select({
		message: t("wizard.setup.whatSetup"),
		options: [{
			value: "local",
			label: t("wizard.setup.localGateway"),
			hint: localProbe.ok ? t("wizard.setup.localGatewayReachable", { url: localUrl }) : t("wizard.setup.localGatewayMissing", { url: localUrl })
		}, {
			value: "remote",
			label: t("wizard.setup.remoteGateway"),
			hint: !remoteUrl ? t("wizard.setup.remoteGatewayMissing") : remoteProbe?.ok ? t("wizard.setup.remoteGatewayReachable", { url: remoteUrl }) : t("wizard.setup.remoteGatewayUnreachable", { url: remoteUrl })
		}]
	}));
	if (mode === "remote") {
		const { promptRemoteGatewayConfig } = await import("./onboard-remote-Bz6hiwpG.js");
		const { applySkipBootstrapConfig } = await import("./onboard-config-CsmbnuFE.js");
		const { logConfigUpdated } = await loadConfigLoggingModule();
		let nextConfig = await promptRemoteGatewayConfig(baseConfig, prompter, { secretInputMode: opts.secretInputMode });
		if (opts.skipBootstrap) nextConfig = applySkipBootstrapConfig(nextConfig);
		nextConfig = onboardHelpers.applyWizardMetadata(nextConfig, {
			command: "onboard",
			mode
		});
		nextConfig = await writeWizardConfigFile(nextConfig);
		logConfigUpdated(runtime);
		await prompter.outro(t("wizard.setup.remoteConfigured"));
		return;
	}
	const workspaceDir = resolveUserPath((opts.workspace ?? (flow === "quickstart" ? baseConfig.agents?.defaults?.workspace ?? onboardHelpers.DEFAULT_WORKSPACE : await prompter.text({
		message: t("wizard.setup.workspaceDirectory"),
		initialValue: baseConfig.agents?.defaults?.workspace ?? onboardHelpers.DEFAULT_WORKSPACE
	}))).trim() || onboardHelpers.DEFAULT_WORKSPACE);
	const { applyLocalSetupWorkspaceConfig, applySkipBootstrapConfig } = await import("./onboard-config-CsmbnuFE.js");
	let nextConfig = applyLocalSetupWorkspaceConfig(baseConfig, workspaceDir);
	if (opts.skipBootstrap) nextConfig = applySkipBootstrapConfig(nextConfig);
	const authChoiceFromPrompt = opts.authChoice === void 0;
	let authChoice = opts.authChoice;
	let authStore;
	let promptAuthChoiceGrouped;
	if (authChoiceFromPrompt) {
		const { ensureAuthProfileStore } = await import("./agents/auth-profiles.runtime.js");
		({promptAuthChoiceGrouped} = await import("./auth-choice-prompt-DefJLvsX.js"));
		authStore = ensureAuthProfileStore(void 0, { allowKeychainPrompt: false });
	}
	while (true) {
		if (authChoiceFromPrompt) authChoice = await promptAuthChoiceGrouped({
			prompter,
			store: authStore,
			includeSkip: true,
			config: nextConfig,
			workspaceDir
		});
		if (authChoice === void 0) throw new WizardCancelledError(t("wizard.setup.authChoiceRequired"));
		if (authChoice === "custom-api-key") {
			const { promptCustomApiConfig } = await import("./onboard-custom-BcY-LHZa.js");
			nextConfig = (await promptCustomApiConfig({
				prompter,
				runtime,
				config: nextConfig,
				secretInputMode: opts.secretInputMode
			})).config;
			break;
		}
		if (authChoice === "skip") {
			if (authChoiceFromPrompt) {
				const { applyPrimaryModel, promptDefaultModel } = await loadModelPickerModule();
				const modelSelection = await promptDefaultModel({
					config: nextConfig,
					prompter,
					allowKeep: true,
					ignoreAllowlist: true,
					includeProviderPluginSetups: false,
					loadCatalog: false,
					workspaceDir,
					runtime
				});
				if (modelSelection.config) nextConfig = modelSelection.config;
				if (modelSelection.model) nextConfig = applyPrimaryModel(nextConfig, modelSelection.model);
				const { warnIfModelConfigLooksOff } = await loadAuthChoiceModule();
				await warnIfModelConfigLooksOff(nextConfig, prompter, { validateCatalog: false });
			}
			break;
		}
		const [{ applyAuthChoice, resolvePreferredProviderForAuthChoice, warnIfModelConfigLooksOff }, { applyPrimaryModel, promptDefaultModel }] = await Promise.all([loadAuthChoiceModule(), loadModelPickerModule()]);
		const authResult = await applyAuthChoice({
			authChoice,
			config: nextConfig,
			prompter,
			runtime,
			setDefaultModel: true,
			opts: {
				...opts,
				token: opts.authChoice === "apiKey" && opts.token ? opts.token : void 0
			}
		});
		nextConfig = authResult.config;
		if (authResult.retrySelection) {
			if (authChoiceFromPrompt) continue;
			break;
		}
		if (authResult.agentModelOverride) nextConfig = applyPrimaryModel(nextConfig, authResult.agentModelOverride);
		const authChoiceModelSelectionPolicy = await resolveAuthChoiceModelSelectionPolicy({
			authChoice,
			config: nextConfig,
			workspaceDir,
			resolvePreferredProviderForAuthChoice
		});
		if (authChoiceFromPrompt || authChoiceModelSelectionPolicy?.promptWhenAuthChoiceProvided) {
			const modelSelection = await promptDefaultModel({
				config: nextConfig,
				prompter,
				allowKeep: authChoiceModelSelectionPolicy?.allowKeepCurrent ?? true,
				ignoreAllowlist: true,
				includeProviderPluginSetups: true,
				preferredProvider: authChoiceModelSelectionPolicy?.preferredProvider,
				browseCatalogOnDemand: true,
				workspaceDir,
				runtime
			});
			if (modelSelection.config) nextConfig = modelSelection.config;
			if (modelSelection.model) nextConfig = applyPrimaryModel(nextConfig, modelSelection.model);
		}
		await warnIfModelConfigLooksOff(nextConfig, prompter, { validateCatalog: false });
		break;
	}
	const { configureGatewayForSetup } = await import("./setup.gateway-config-C9DQMbQq.js");
	const gateway = await configureGatewayForSetup({
		flow: wizardFlow,
		baseConfig,
		nextConfig,
		localPort,
		quickstartGateway,
		secretInputMode: opts.secretInputMode,
		prompter,
		runtime
	});
	nextConfig = gateway.nextConfig;
	const settings = gateway.settings;
	if (opts.skipChannels ?? opts.skipProviders) await prompter.note(t("wizard.setup.skipChannels"), t("wizard.setup.channelsTitle"));
	else {
		const { listChannelPlugins } = await import("./plugins-C54ejDC8.js");
		const { setupChannels } = await import("./onboard-channels-CPUzO4u4.js");
		const quickstartAllowFromChannels = flow === "quickstart" ? listChannelPlugins().filter((plugin) => plugin.meta.quickstartAllowFrom).map((plugin) => plugin.id) : [];
		nextConfig = await setupChannels(nextConfig, runtime, prompter, {
			allowSignalInstall: true,
			deferStatusUntilSelection: flow === "quickstart",
			forceAllowFromChannels: quickstartAllowFromChannels,
			skipDmPolicyPrompt: flow === "quickstart",
			skipConfirm: flow === "quickstart",
			quickstartDefaults: flow === "quickstart",
			secretInputMode: opts.secretInputMode
		});
	}
	nextConfig = await writeWizardConfigFile(nextConfig);
	const { logConfigUpdated } = await loadConfigLoggingModule();
	logConfigUpdated(runtime);
	await onboardHelpers.ensureWorkspaceAndSessions(workspaceDir, runtime, {
		skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
		skipOptionalBootstrapFiles: nextConfig.agents?.defaults?.skipOptionalBootstrapFiles
	});
	if (opts.skipSearch) await prompter.note(t("wizard.setup.skipSearch"), t("wizard.setup.searchTitle"));
	else {
		const { setupSearch } = await import("./onboard-search-DQdjHj2S.js");
		nextConfig = await setupSearch(nextConfig, runtime, prompter, {
			quickstartDefaults: flow === "quickstart",
			secretInputMode: opts.secretInputMode
		});
	}
	if (opts.skipSkills) await prompter.note(t("wizard.setup.skipSkills"), t("wizard.setup.skillsTitle"));
	else {
		const { setupSkills } = await import("./onboard-skills-BFrVpL5k.js");
		nextConfig = await setupSkills(nextConfig, workspaceDir, runtime, prompter);
	}
	if (flow !== "quickstart") {
		const { setupOfficialPluginInstalls } = await import("./setup.official-plugins-CVD13Urf.js");
		nextConfig = await setupOfficialPluginInstalls({
			config: nextConfig,
			prompter,
			runtime,
			workspaceDir
		});
		const { setupPluginConfig } = await import("./setup.plugin-config-D5efkKaF.js");
		nextConfig = await setupPluginConfig({
			config: nextConfig,
			prompter,
			workspaceDir
		});
	}
	if (!opts.skipHooks) {
		const { setupInternalHooks } = await import("./onboard-hooks-Dwa3p4gN.js");
		nextConfig = await setupInternalHooks(nextConfig, runtime, prompter);
	}
	nextConfig = onboardHelpers.applyWizardMetadata(nextConfig, {
		command: "onboard",
		mode
	});
	nextConfig = await writeWizardConfigFile(nextConfig);
	const { finalizeSetupWizard } = await import("./setup.finalize-DFLv5__Q.js");
	const { launchedTui } = await finalizeSetupWizard({
		flow: wizardFlow,
		opts,
		baseConfig,
		nextConfig,
		workspaceDir,
		settings,
		prompter,
		runtime
	});
	if (launchedTui) return;
}
//#endregion
export { runSetupWizard as t };
