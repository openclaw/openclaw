import { u as resolveGatewayPort } from "./paths-Cnwfh6dH.js";
import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import { t as formatCliCommand } from "./command-format-OwPqnbXG.js";
import { p as resolveUserPath } from "./utils-CKsuXgDI.js";
import { d as normalizeSecretInputString } from "./types.secrets-BxqheYvy.js";
import { r as normalizeProviderId } from "./provider-id-Cz7K6wgK.js";
import { n as defaultRuntime } from "./runtime-DDH_zqCr.js";
import { r as createConfigIO } from "./io-5xE1dPMK.js";
import { r as replaceConfigFile } from "./mutate-FhI2HIyp.js";
import "./config-CzeRK-GW.js";
import { t as WizardCancelledError } from "./prompts-w_QiqAiL.js";
import { l as formatPluginCompatibilityNotice, r as buildPluginCompatibilitySnapshotNotices } from "./status-C8NghErI.js";
import { n as commitConfigWriteWithPendingPluginInstalls } from "./plugins-install-record-commit-ChzTDi9U.js";
import { t as resolveSetupSecretInputString } from "./setup.secret-input-BE7C__Z7.js";
import { r as runSetupMigrationImport, t as detectSetupMigrationSources } from "./setup.migration-import-CyHsg-O-.js";
import chalk from "chalk";
//#region src/wizard/setup.security-note.ts
const SECURITY_NOTE_TITLE = "Security disclaimer";
const heading = (text) => chalk.bold(text);
const SECURITY_NOTE_MESSAGE = [
	"OpenClaw is a hobby project and still in beta. Expect sharp edges.",
	"By default, OpenClaw is a personal agent: one trusted operator boundary.",
	"This bot can read files and run actions if tools are enabled.",
	"A bad prompt can trick it into doing unsafe things.",
	"",
	"OpenClaw is not a hostile multi-tenant boundary by default.",
	"If multiple users can message one tool-enabled agent, they share that delegated tool authority.",
	"",
	"If you’re not comfortable with security hardening and access control, don’t run OpenClaw.",
	"Ask someone experienced to help before enabling tools or exposing it to the internet.",
	"",
	heading("Recommended baseline"),
	"- Pairing/allowlists + mention gating.",
	"- Multi-user/shared inbox: split trust boundaries (separate gateway/credentials, ideally separate OS users/hosts).",
	"- Sandbox + least-privilege tools.",
	"- Shared inboxes: isolate DM sessions (session.dmScope: per-channel-peer) and keep tool access minimal.",
	"- Keep secrets out of the agent’s reachable filesystem.",
	"- Use the strongest available model for any bot with tools or untrusted inboxes.",
	"",
	heading("Run regularly"),
	formatCliCommand("openclaw security audit --deep"),
	formatCliCommand("openclaw security audit --fix"),
	"",
	heading("Learn more"),
	"- https://docs.openclaw.ai/gateway/security"
].join("\n");
//#endregion
//#region src/wizard/setup.ts
let authChoiceModulePromise;
let configLoggingModulePromise;
let modelPickerModulePromise;
function loadAuthChoiceModule() {
	authChoiceModulePromise ??= import("./auth-choice-BynC3VMH.js");
	return authChoiceModulePromise;
}
function loadConfigLoggingModule() {
	configLoggingModulePromise ??= import("./logging-Dsi2ZWYP.js");
	return configLoggingModulePromise;
}
function loadModelPickerModule() {
	modelPickerModulePromise ??= import("./model-picker-BMR4XnIt.js");
	return modelPickerModulePromise;
}
async function writeWizardConfigFile(config) {
	return (await commitConfigWriteWithPendingPluginInstalls({
		nextConfig: config,
		commit: async (nextConfig, writeOptions) => {
			await replaceConfigFile({
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
	const [{ resolveManifestProviderAuthChoice }, { resolvePluginSetupProvider }] = await Promise.all([import("./provider-auth-choices-DXERCHGj.js"), import("./setup-registry-CnDLaP5H.js")]);
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
	const { resolvePluginProviders, resolveProviderPluginChoice } = await import("./provider-auth-choice.runtime-yC6AH84G.js");
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
	await params.prompter.note(SECURITY_NOTE_MESSAGE, SECURITY_NOTE_TITLE);
	if (!await params.prompter.confirm({
		message: "I understand this is personal-by-default and shared/multi-user use requires lock-down. Continue?",
		initialValue: false
	})) throw new WizardCancelledError("risk not accepted");
}
async function runSetupWizard(opts, runtime, prompter) {
	runtime ??= defaultRuntime;
	const onboardHelpers = await import("./onboard-helpers-BvAA6Q5p.js");
	onboardHelpers.printWizardHeader(runtime);
	await prompter.intro("OpenClaw setup");
	await requireRiskAcknowledgement({
		opts,
		prompter
	});
	const snapshot = await readSetupConfigFileSnapshot();
	let baseConfig = snapshot.valid ? snapshot.exists ? snapshot.sourceConfig ?? snapshot.config : {} : {};
	if (snapshot.exists && !snapshot.valid) {
		await prompter.note(onboardHelpers.summarizeExistingConfig(baseConfig), "Invalid config");
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
	].join("\n"), "Plugin compatibility");
	const quickstartHint = `Recommended local setup. Change details later with ${formatCliCommand("openclaw configure")}.`;
	const manualHint = "Choose Gateway port, network exposure, Tailscale, and auth.";
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
		message: "Setup mode",
		options: [
			{
				value: "quickstart",
				label: "QuickStart (recommended)",
				hint: quickstartHint
			},
			{
				value: "advanced",
				label: "Manual setup",
				hint: manualHint
			},
			...importOption ? [importOption] : []
		],
		initialValue: "quickstart"
	});
	if (opts.mode === "remote" && flow === "quickstart") {
		await prompter.note("QuickStart only supports local gateways. Switching to Manual mode.", "QuickStart");
		flow = "advanced";
	}
	if (snapshot.exists) {
		await prompter.note(onboardHelpers.summarizeExistingConfig(baseConfig), "Existing config detected");
		if (await prompter.select({
			message: "Config handling",
			options: [
				{
					value: "keep",
					label: "Keep current values"
				},
				{
					value: "modify",
					label: "Review and update"
				},
				{
					value: "reset",
					label: "Reset before setup"
				}
			]
		}) === "reset") {
			const workspaceDefault = baseConfig.agents?.defaults?.workspace ?? onboardHelpers.DEFAULT_WORKSPACE;
			const resetScope = await prompter.select({
				message: "Reset scope",
				options: [
					{
						value: "config",
						label: "Config only"
					},
					{
						value: "config+creds+sessions",
						label: "Config + creds + sessions"
					},
					{
						value: "full",
						label: "Full reset (config + creds + sessions + workspace)"
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
			if (value === "loopback") return "Loopback (127.0.0.1)";
			if (value === "lan") return "LAN";
			if (value === "custom") return "Custom IP";
			if (value === "tailnet") return "Tailnet (Tailscale IP)";
			return "Auto";
		};
		const formatAuth = (value) => {
			if (value === "token") return "Token (default)";
			return "Password";
		};
		const formatTailscale = (value) => {
			if (value === "off") return "Off";
			if (value === "serve") return "Serve";
			return "Funnel";
		};
		const quickstartLines = quickstartGateway.hasExisting ? [
			"Keeping your current gateway settings:",
			`Gateway port: ${quickstartGateway.port}`,
			`Gateway bind: ${formatBind(quickstartGateway.bind)}`,
			...quickstartGateway.bind === "custom" && quickstartGateway.customBindHost ? [`Gateway custom IP: ${quickstartGateway.customBindHost}`] : [],
			`Gateway auth: ${formatAuth(quickstartGateway.authMode)}`,
			`Tailscale exposure: ${formatTailscale(quickstartGateway.tailscaleMode)}`,
			"Direct to chat channels."
		] : [
			`Gateway port: ${quickstartGateway.port}`,
			"Gateway bind: Loopback (127.0.0.1)",
			"Gateway auth: Token (default)",
			"Tailscale exposure: Off",
			"Direct to chat channels."
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
		await prompter.note(["Could not resolve gateway.auth.token SecretRef for setup probe.", formatErrorMessage(error)].join("\n"), "Gateway auth");
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
		await prompter.note(["Could not resolve gateway.auth.password SecretRef for setup probe.", formatErrorMessage(error)].join("\n"), "Gateway auth");
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
		message: "What do you want to set up?",
		options: [{
			value: "local",
			label: "Local gateway (this machine)",
			hint: localProbe.ok ? `Gateway reachable (${localUrl})` : `No gateway detected (${localUrl})`
		}, {
			value: "remote",
			label: "Remote gateway (info-only)",
			hint: !remoteUrl ? "No remote URL configured yet" : remoteProbe?.ok ? `Gateway reachable (${remoteUrl})` : `Configured but unreachable (${remoteUrl})`
		}]
	}));
	if (mode === "remote") {
		const { promptRemoteGatewayConfig } = await import("./onboard-remote-BXZv866L.js");
		const { applySkipBootstrapConfig } = await import("./onboard-config-Db7AGekx.js");
		const { logConfigUpdated } = await loadConfigLoggingModule();
		let nextConfig = await promptRemoteGatewayConfig(baseConfig, prompter, { secretInputMode: opts.secretInputMode });
		if (opts.skipBootstrap) nextConfig = applySkipBootstrapConfig(nextConfig);
		nextConfig = onboardHelpers.applyWizardMetadata(nextConfig, {
			command: "onboard",
			mode
		});
		nextConfig = await writeWizardConfigFile(nextConfig);
		logConfigUpdated(runtime);
		await prompter.outro("Remote gateway configured.");
		return;
	}
	const workspaceDir = resolveUserPath((opts.workspace ?? (flow === "quickstart" ? baseConfig.agents?.defaults?.workspace ?? onboardHelpers.DEFAULT_WORKSPACE : await prompter.text({
		message: "Workspace directory",
		initialValue: baseConfig.agents?.defaults?.workspace ?? onboardHelpers.DEFAULT_WORKSPACE
	}))).trim() || onboardHelpers.DEFAULT_WORKSPACE);
	const { applyLocalSetupWorkspaceConfig, applySkipBootstrapConfig } = await import("./onboard-config-Db7AGekx.js");
	let nextConfig = applyLocalSetupWorkspaceConfig(baseConfig, workspaceDir);
	if (opts.skipBootstrap) nextConfig = applySkipBootstrapConfig(nextConfig);
	const authChoiceFromPrompt = opts.authChoice === void 0;
	let authChoice = opts.authChoice;
	let authStore;
	let promptAuthChoiceGrouped;
	if (authChoiceFromPrompt) {
		const { ensureAuthProfileStore } = await import("./agents/auth-profiles.runtime.js");
		({promptAuthChoiceGrouped} = await import("./auth-choice-prompt-ipLPja3p.js"));
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
		if (authChoice === void 0) throw new WizardCancelledError("auth choice is required");
		if (authChoice === "custom-api-key") {
			const { promptCustomApiConfig } = await import("./onboard-custom-TGL2bjhM.js");
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
	const { configureGatewayForSetup } = await import("./setup.gateway-config-boO4VjNH.js");
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
	if (opts.skipChannels ?? opts.skipProviders) await prompter.note("Skipping channel setup.", "Channels");
	else {
		const { listChannelPlugins } = await import("./plugins-DJit8KgP.js");
		const { setupChannels } = await import("./onboard-channels-CMwYflXV.js");
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
	if (opts.skipSearch) await prompter.note("Skipping search setup.", "Search");
	else {
		const { setupSearch } = await import("./onboard-search-Co6_AoKn.js");
		nextConfig = await setupSearch(nextConfig, runtime, prompter, {
			quickstartDefaults: flow === "quickstart",
			secretInputMode: opts.secretInputMode
		});
	}
	if (opts.skipSkills) await prompter.note("Skipping skills setup.", "Skills");
	else {
		const { setupSkills } = await import("./onboard-skills-B4jTPkqj.js");
		nextConfig = await setupSkills(nextConfig, workspaceDir, runtime, prompter);
	}
	if (flow !== "quickstart") {
		const { setupOfficialPluginInstalls } = await import("./setup.official-plugins-CuaPdlsX.js");
		nextConfig = await setupOfficialPluginInstalls({
			config: nextConfig,
			prompter,
			runtime,
			workspaceDir
		});
		const { setupPluginConfig } = await import("./setup.plugin-config-aOeETxHN.js");
		nextConfig = await setupPluginConfig({
			config: nextConfig,
			prompter,
			workspaceDir
		});
	}
	if (!opts.skipHooks) {
		const { setupInternalHooks } = await import("./onboard-hooks-CwEnQlbX.js");
		nextConfig = await setupInternalHooks(nextConfig, runtime, prompter);
	}
	nextConfig = onboardHelpers.applyWizardMetadata(nextConfig, {
		command: "onboard",
		mode
	});
	nextConfig = await writeWizardConfigFile(nextConfig);
	const { finalizeSetupWizard } = await import("./setup.finalize-D_6DSppg.js");
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
