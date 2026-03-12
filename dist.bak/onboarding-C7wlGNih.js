import { qt as resolveGatewayPort, st as resolveUserPath, v as defaultRuntime, zt as DEFAULT_GATEWAY_PORT } from "./entry.js";
import { L as writeConfigFile, N as readConfigFileSnapshot } from "./auth-profiles-D6H-HVV8.js";
import { t as formatCliCommand } from "./command-format-CDHXQh1_.js";
import { t as WizardCancelledError } from "./prompts-CfOu9uZi.js";

//#region src/wizard/onboarding.ts
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
async function runOnboardingWizard(opts, runtime = defaultRuntime, prompter) {
	const onboardHelpers = await import("./onboard-helpers-CijgoJ1t.js").then((n) => n.d);
	onboardHelpers.printWizardHeader(runtime);
	await prompter.intro("OpenClaw onboarding");
	await requireRiskAcknowledgement({
		opts,
		prompter
	});
	const snapshot = await readConfigFileSnapshot();
	let baseConfig = snapshot.valid ? snapshot.config : {};
	if (snapshot.exists && !snapshot.valid) {
		await prompter.note(onboardHelpers.summarizeExistingConfig(baseConfig), "Invalid config");
		if (snapshot.issues.length > 0) await prompter.note([
			...snapshot.issues.map((iss) => `- ${iss.path}: ${iss.message}`),
			"",
			"Docs: https://docs.openclaw.ai/gateway/configuration"
		].join("\n"), "Config issues");
		await prompter.outro(`Config invalid. Run \`${formatCliCommand("openclaw doctor")}\` to repair it, then re-run onboarding.`);
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
		message: "Onboarding mode",
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
	const localProbe = await onboardHelpers.probeGatewayReachable({
		url: localUrl,
		token: baseConfig.gateway?.auth?.token ?? process.env.OPENCLAW_GATEWAY_TOKEN,
		password: baseConfig.gateway?.auth?.password ?? process.env.OPENCLAW_GATEWAY_PASSWORD
	});
	const remoteUrl = baseConfig.gateway?.remote?.url?.trim() ?? "";
	const remoteProbe = remoteUrl ? await onboardHelpers.probeGatewayReachable({
		url: remoteUrl,
		token: baseConfig.gateway?.remote?.token
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
		const { promptRemoteGatewayConfig } = await import("./onboard-remote-B-mMmYEU.js").then((n) => n.t);
		const { logConfigUpdated } = await import("./logging-Bi2fXy2a.js").then((n) => n.r);
		let nextConfig = await promptRemoteGatewayConfig(baseConfig, prompter);
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
	const { applyOnboardingLocalWorkspaceConfig } = await import("./onboard-config-BFyV_anJ.js").then((n) => n.n);
	let nextConfig = applyOnboardingLocalWorkspaceConfig(baseConfig, workspaceDir);
	const { ensureAuthProfileStore } = await import("./auth-profiles-D6H-HVV8.js").then((n) => n.t);
	const { promptAuthChoiceGrouped } = await import("./auth-choice-prompt-BzWmwJJZ.js").then((n) => n.t);
	const { promptCustomApiConfig } = await import("./onboard-custom-B7ZaZ7ch.js").then((n) => n.r);
	const { applyAuthChoice, resolvePreferredProviderForAuthChoice, warnIfModelConfigLooksOff } = await import("./auth-choice-dacQpDUl.js").then((n) => n.t);
	const { applyPrimaryModel, promptDefaultModel } = await import("./model-picker-Bj_Lb5H7.js").then((n) => n.i);
	const authStore = ensureAuthProfileStore(void 0, { allowKeychainPrompt: false });
	const authChoiceFromPrompt = opts.authChoice === void 0;
	const authChoice = opts.authChoice ?? await promptAuthChoiceGrouped({
		prompter,
		store: authStore,
		includeSkip: true
	});
	if (authChoice === "custom-api-key") nextConfig = (await promptCustomApiConfig({
		prompter,
		runtime,
		config: nextConfig,
		secretInputMode: opts.secretInputMode
	})).config;
	else nextConfig = (await applyAuthChoice({
		authChoice,
		config: nextConfig,
		prompter,
		runtime,
		setDefaultModel: true,
		opts: {
			tokenProvider: opts.tokenProvider,
			token: opts.authChoice === "apiKey" && opts.token ? opts.token : void 0
		}
	})).config;
	if (authChoiceFromPrompt && authChoice !== "custom-api-key") {
		const modelSelection = await promptDefaultModel({
			config: nextConfig,
			prompter,
			allowKeep: true,
			ignoreAllowlist: true,
			includeVllm: true,
			preferredProvider: resolvePreferredProviderForAuthChoice(authChoice)
		});
		if (modelSelection.config) nextConfig = modelSelection.config;
		if (modelSelection.model) nextConfig = applyPrimaryModel(nextConfig, modelSelection.model);
	}
	await warnIfModelConfigLooksOff(nextConfig, prompter);
	const { configureGatewayForOnboarding } = await import("./onboarding.gateway-config-Cx_hRHXi.js");
	const gateway = await configureGatewayForOnboarding({
		flow,
		baseConfig,
		nextConfig,
		localPort,
		quickstartGateway,
		prompter,
		runtime
	});
	nextConfig = gateway.nextConfig;
	const settings = gateway.settings;
	if (opts.skipChannels ?? opts.skipProviders) await prompter.note("Skipping channel setup.", "Channels");
	else {
		const { listChannelPlugins } = await import("./plugins-BOmV0yTv.js").then((n) => n.i);
		const { setupChannels } = await import("./onboard-channels-DQa_TW-E.js").then((n) => n.n);
		const quickstartAllowFromChannels = flow === "quickstart" ? listChannelPlugins().filter((plugin) => plugin.meta.quickstartAllowFrom).map((plugin) => plugin.id) : [];
		nextConfig = await setupChannels(nextConfig, runtime, prompter, {
			allowSignalInstall: true,
			forceAllowFromChannels: quickstartAllowFromChannels,
			skipDmPolicyPrompt: flow === "quickstart",
			skipConfirm: flow === "quickstart",
			quickstartDefaults: flow === "quickstart"
		});
	}
	await writeConfigFile(nextConfig);
	const { logConfigUpdated } = await import("./logging-Bi2fXy2a.js").then((n) => n.r);
	logConfigUpdated(runtime);
	await onboardHelpers.ensureWorkspaceAndSessions(workspaceDir, runtime, { skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap) });
	if (opts.skipSkills) await prompter.note("Skipping skills setup.", "Skills");
	else {
		const { setupSkills } = await import("./onboard-skills-DQ43HnHV.js").then((n) => n.t);
		nextConfig = await setupSkills(nextConfig, workspaceDir, runtime, prompter);
	}
	const { setupInternalHooks } = await import("./onboard-hooks-BMdthQxJ.js");
	nextConfig = await setupInternalHooks(nextConfig, runtime, prompter);
	nextConfig = onboardHelpers.applyWizardMetadata(nextConfig, {
		command: "onboard",
		mode
	});
	await writeConfigFile(nextConfig);
	const { finalizeOnboardingWizard } = await import("./onboarding.finalize-BCVwHtgu.js");
	const { launchedTui } = await finalizeOnboardingWizard({
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
export { runOnboardingWizard as t };