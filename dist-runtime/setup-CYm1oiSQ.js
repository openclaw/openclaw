import { d as resolveGatewayPort, n as DEFAULT_GATEWAY_PORT } from "./paths-DqbqmTPe.js";
import { d as defaultRuntime, f as init_runtime } from "./subsystem-CZwunM2N.js";
import { b as resolveUserPath, d as init_utils } from "./utils-BiUV1eIQ.js";
import { Jb as writeConfigFile, Ub as readConfigFileSnapshot } from "./auth-profiles-DAOR1fRn.js";
import { o as init_types_secrets, u as normalizeSecretInputString } from "./types.secrets-Cu0Lz6pi.js";
import { t as formatCliCommand } from "./command-format-CS805JpF.js";
import { t as WizardCancelledError } from "./prompts-BfXKoCy4.js";
import { t as resolveSetupSecretInputString } from "./setup.secret-input-D-o1vWQB.js";
//#region src/wizard/setup.ts
init_types_secrets();
init_runtime();
init_utils();
async function requireRiskAcknowledgement(params) {
	if (params.opts.acceptRisk === true) return;
	await params.prompter.note([
		"Security warning — please read.",
		"",
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
		"Recommended baseline:",
		"- Pairing/allowlists + mention gating.",
		"- Multi-user/shared inbox: split trust boundaries (separate gateway/credentials, ideally separate OS users/hosts).",
		"- Sandbox + least-privilege tools.",
		"- Shared inboxes: isolate DM sessions (`session.dmScope: per-channel-peer`) and keep tool access minimal.",
		"- Keep secrets out of the agent’s reachable filesystem.",
		"- Use the strongest available model for any bot with tools or untrusted inboxes.",
		"",
		"Run regularly:",
		"openclaw security audit --deep",
		"openclaw security audit --fix",
		"",
		"Must read: https://docs.openclaw.ai/gateway/security"
	].join("\n"), "Security");
	if (!await params.prompter.confirm({
		message: "I understand this is personal-by-default and shared/multi-user use requires lock-down. Continue?",
		initialValue: false
	})) throw new WizardCancelledError("risk not accepted");
}
async function runSetupWizard(opts, runtime = defaultRuntime, prompter) {
	const onboardHelpers = await import("./onboard-helpers-BtkPxCDo.js");
	onboardHelpers.printWizardHeader(runtime);
	await prompter.intro("OpenClaw setup");
	await requireRiskAcknowledgement({
		opts,
		prompter
	});
	const snapshot = await readConfigFileSnapshot();
	let baseConfig = snapshot.valid ? snapshot.exists ? snapshot.config : {} : {};
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
	const quickstartHint = `Configure details later via ${formatCliCommand("openclaw configure")}.`;
	const manualHint = "Configure port, network, Tailscale, and auth options.";
	const explicitFlowRaw = opts.flow?.trim();
	const normalizedExplicitFlow = explicitFlowRaw === "manual" ? "advanced" : explicitFlowRaw;
	if (normalizedExplicitFlow && normalizedExplicitFlow !== "quickstart" && normalizedExplicitFlow !== "advanced") {
		runtime.error("Invalid --flow (use quickstart, manual, or advanced).");
		runtime.exit(1);
		return;
	}
	let flow = (normalizedExplicitFlow === "quickstart" || normalizedExplicitFlow === "advanced" ? normalizedExplicitFlow : void 0) ?? await prompter.select({
		message: "Setup mode",
		options: [{
			value: "quickstart",
			label: "QuickStart",
			hint: quickstartHint
		}, {
			value: "advanced",
			label: "Manual",
			hint: manualHint
		}],
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
					label: "Use existing values"
				},
				{
					value: "modify",
					label: "Update values"
				},
				{
					value: "reset",
					label: "Reset"
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
			`Gateway port: ${DEFAULT_GATEWAY_PORT}`,
			"Gateway bind: Loopback (127.0.0.1)",
			"Gateway auth: Token (default)",
			"Tailscale exposure: Off",
			"Direct to chat channels."
		];
		await prompter.note(quickstartLines.join("\n"), "QuickStart");
	}
	const localPort = resolveGatewayPort(baseConfig);
	const localUrl = `ws://127.0.0.1:${localPort}`;
	let localGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN ?? process.env.CLAWDBOT_GATEWAY_TOKEN;
	try {
		const resolvedGatewayToken = await resolveSetupSecretInputString({
			config: baseConfig,
			value: baseConfig.gateway?.auth?.token,
			path: "gateway.auth.token",
			env: process.env
		});
		if (resolvedGatewayToken) localGatewayToken = resolvedGatewayToken;
	} catch (error) {
		await prompter.note(["Could not resolve gateway.auth.token SecretRef for setup probe.", error instanceof Error ? error.message : String(error)].join("\n"), "Gateway auth");
	}
	let localGatewayPassword = process.env.OPENCLAW_GATEWAY_PASSWORD ?? process.env.CLAWDBOT_GATEWAY_PASSWORD;
	try {
		const resolvedGatewayPassword = await resolveSetupSecretInputString({
			config: baseConfig,
			value: baseConfig.gateway?.auth?.password,
			path: "gateway.auth.password",
			env: process.env
		});
		if (resolvedGatewayPassword) localGatewayPassword = resolvedGatewayPassword;
	} catch (error) {
		await prompter.note(["Could not resolve gateway.auth.password SecretRef for setup probe.", error instanceof Error ? error.message : String(error)].join("\n"), "Gateway auth");
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
		await prompter.note(["Could not resolve gateway.remote.token SecretRef for setup probe.", error instanceof Error ? error.message : String(error)].join("\n"), "Gateway auth");
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
		const { promptRemoteGatewayConfig } = await import("./onboard-remote-DB_P1KmQ.js");
		const { logConfigUpdated } = await import("./logging-is838P9C.js");
		let nextConfig = await promptRemoteGatewayConfig(baseConfig, prompter, { secretInputMode: opts.secretInputMode });
		nextConfig = onboardHelpers.applyWizardMetadata(nextConfig, {
			command: "onboard",
			mode
		});
		await writeConfigFile(nextConfig);
		logConfigUpdated(runtime);
		await prompter.outro("Remote gateway configured.");
		return;
	}
	const workspaceDir = resolveUserPath((opts.workspace ?? (flow === "quickstart" ? baseConfig.agents?.defaults?.workspace ?? onboardHelpers.DEFAULT_WORKSPACE : await prompter.text({
		message: "Workspace directory",
		initialValue: baseConfig.agents?.defaults?.workspace ?? onboardHelpers.DEFAULT_WORKSPACE
	}))).trim() || onboardHelpers.DEFAULT_WORKSPACE);
	const { applyLocalSetupWorkspaceConfig } = await import("./onboard-config-DCChv4fj.js");
	let nextConfig = applyLocalSetupWorkspaceConfig(baseConfig, workspaceDir);
	const { ensureAuthProfileStore } = await import("./auth-profiles.runtime-Dsq48sF5.js");
	const { promptAuthChoiceGrouped } = await import("./auth-choice-prompt-BOANJ94S.js");
	const { promptCustomApiConfig } = await import("./onboard-custom-DC9vTXjk.js");
	const { applyAuthChoice, resolvePreferredProviderForAuthChoice, warnIfModelConfigLooksOff } = await import("./auth-choice-Cz5fH5Vg.js");
	const { applyPrimaryModel, promptDefaultModel } = await import("./model-picker-BqYQAfHF.js");
	const authStore = ensureAuthProfileStore(void 0, { allowKeychainPrompt: false });
	const authChoiceFromPrompt = opts.authChoice === void 0;
	const authChoice = opts.authChoice ?? await promptAuthChoiceGrouped({
		prompter,
		store: authStore,
		includeSkip: true,
		config: nextConfig,
		workspaceDir
	});
	if (authChoice === "custom-api-key") nextConfig = (await promptCustomApiConfig({
		prompter,
		runtime,
		config: nextConfig,
		secretInputMode: opts.secretInputMode
	})).config;
	else {
		const authResult = await applyAuthChoice({
			authChoice,
			config: nextConfig,
			prompter,
			runtime,
			setDefaultModel: true,
			opts: {
				tokenProvider: opts.tokenProvider,
				token: opts.authChoice === "apiKey" && opts.token ? opts.token : void 0
			}
		});
		nextConfig = authResult.config;
		if (authResult.agentModelOverride) nextConfig = applyPrimaryModel(nextConfig, authResult.agentModelOverride);
	}
	if (authChoiceFromPrompt && authChoice !== "custom-api-key") {
		const modelSelection = await promptDefaultModel({
			config: nextConfig,
			prompter,
			allowKeep: true,
			ignoreAllowlist: true,
			includeProviderPluginSetups: true,
			preferredProvider: await resolvePreferredProviderForAuthChoice({
				choice: authChoice,
				config: nextConfig,
				workspaceDir
			}),
			workspaceDir,
			runtime
		});
		if (modelSelection.config) nextConfig = modelSelection.config;
		if (modelSelection.model) nextConfig = applyPrimaryModel(nextConfig, modelSelection.model);
	}
	await warnIfModelConfigLooksOff(nextConfig, prompter);
	const { configureGatewayForSetup } = await import("./setup.gateway-config-B6IEJgNs.js");
	const gateway = await configureGatewayForSetup({
		flow,
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
		const { listChannelPlugins } = await import("./plugins-CFkQe_IR.js");
		const { setupChannels } = await import("./onboard-channels-CXAJ56xu.js");
		const quickstartAllowFromChannels = flow === "quickstart" ? listChannelPlugins().filter((plugin) => plugin.meta.quickstartAllowFrom).map((plugin) => plugin.id) : [];
		nextConfig = await setupChannels(nextConfig, runtime, prompter, {
			allowSignalInstall: true,
			forceAllowFromChannels: quickstartAllowFromChannels,
			skipDmPolicyPrompt: flow === "quickstart",
			skipConfirm: flow === "quickstart",
			quickstartDefaults: flow === "quickstart",
			secretInputMode: opts.secretInputMode
		});
	}
	await writeConfigFile(nextConfig);
	const { logConfigUpdated } = await import("./logging-is838P9C.js");
	logConfigUpdated(runtime);
	await onboardHelpers.ensureWorkspaceAndSessions(workspaceDir, runtime, { skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap) });
	if (opts.skipSearch) await prompter.note("Skipping search setup.", "Search");
	else {
		const { setupSearch } = await import("./onboard-search-B0I4HMO0.js");
		nextConfig = await setupSearch(nextConfig, runtime, prompter, {
			quickstartDefaults: flow === "quickstart",
			secretInputMode: opts.secretInputMode
		});
	}
	if (opts.skipSkills) await prompter.note("Skipping skills setup.", "Skills");
	else {
		const { setupSkills } = await import("./onboard-skills-owRNdQ0c.js");
		nextConfig = await setupSkills(nextConfig, workspaceDir, runtime, prompter);
	}
	const { setupInternalHooks } = await import("./onboard-hooks-i3TKlP6z.js");
	nextConfig = await setupInternalHooks(nextConfig, runtime, prompter);
	nextConfig = onboardHelpers.applyWizardMetadata(nextConfig, {
		command: "onboard",
		mode
	});
	await writeConfigFile(nextConfig);
	const { finalizeSetupWizard } = await import("./setup.finalize-qEgrfaUL.js");
	const { launchedTui } = await finalizeSetupWizard({
		flow,
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
