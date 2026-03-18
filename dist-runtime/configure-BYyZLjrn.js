import { d as resolveGatewayPort, t as CONFIG_PATH } from "./paths-DqbqmTPe.js";
import { d as defaultRuntime, f as init_runtime } from "./subsystem-CZwunM2N.js";
import { C as shortenHomePath, b as resolveUserPath, d as init_utils } from "./utils-BiUV1eIQ.js";
import { Jb as writeConfigFile, Ku as DEFAULT_WORKSPACE, Qu as guardCancel, Ub as readConfigFileSnapshot, Xu as ensureWorkspaceAndSessions, Z as resolvePluginProviders, ad as randomToken, dd as waitForGatewayReachable, id as probeGatewayReachable, ld as summarizeExistingConfig, p as ensureAuthProfileStore, qu as applyWizardMetadata, rd as printWizardHeader, sd as resolveControlUiLinks, td as normalizeGatewayTokenInput, tn as withProgress, ud as validateGatewayPasswordInput, zb as loadConfig } from "./auth-profiles-DAOR1fRn.js";
import { dt as listChannelPlugins, lt as getChannelPlugin } from "./registry-ep1yQ6WN.js";
import { c as isValidEnvSecretRefId, o as init_types_secrets, s as isSecretRef } from "./types.secrets-Cu0Lz6pi.js";
import { Fn as resolveDefaultSecretProviderAlias } from "./method-scopes-CLHNYIU6.js";
import { t as formatCliCommand } from "./command-format-CS805JpF.js";
import { j as resolveDefaultAgentWorkspaceDir } from "./agent-scope-C0PckUtv.js";
import { I as findTailscaleBinary } from "./config-DZ3oWznn.js";
import { n as stylePromptMessage, r as stylePromptTitle, t as stylePromptHint } from "./prompt-style-CEH2A0QE.js";
import { n as buildGatewayInstallPlan, r as gatewayInstallErrorHint, t as resolveGatewayInstallToken } from "./gateway-install-token-TIg1tNFo.js";
import { n as GATEWAY_DAEMON_RUNTIME_OPTIONS, t as DEFAULT_GATEWAY_DAEMON_RUNTIME } from "./daemon-runtime-Tgt-ZRti.js";
import { n as resolveGatewayService, t as describeGatewayServiceRestart } from "./service-BRvD766e.js";
import { n as isNonFatalSystemdInstallProbeError } from "./systemd-Ca2xqSN-.js";
import { t as WizardCancelledError } from "./prompts-BfXKoCy4.js";
import { r as healthCommand } from "./health-BcAvG-SY.js";
import { t as ensureControlUiAssetsBuilt } from "./control-ui-assets-UkuykTLs.js";
import { t as resolveSetupSecretInputString } from "./setup.secret-input-D-o1vWQB.js";
import { n as logConfigUpdated } from "./logging-B8JmIRjO.js";
import { t as note$1 } from "./note-DNiLBVhx.js";
import { t as createClackPrompter } from "./clack-prompter-Dan3tMHD.js";
import { i as resolveProviderPluginChoice } from "./provider-wizard-YQJPi_ys.js";
import { t as promptAuthChoiceGrouped } from "./auth-choice-prompt-DJ04lPHz.js";
import { t as resolvePreferredProviderForAuthChoice } from "./auth-choice.preferred-provider-DdMPFsaS.js";
import { n as applyAuthChoice } from "./auth-choice-DXaG77hZ.js";
import { n as setupChannels, t as noteChannelStatus } from "./onboard-channels-Ajx8t7Mi.js";
import { t as ensureSystemdUserLingerInteractive } from "./systemd-linger-CjzZcHCj.js";
import { a as promptModelAllowlist, i as promptDefaultModel, n as applyModelFallbacksFromSelection, r as applyPrimaryModel, t as applyModelAllowlist } from "./model-picker-CrWwjdJy.js";
import { i as promptCustomApiConfig } from "./onboard-custom-GtmE6oqt.js";
import { a as maybeAddTailnetOriginToControlUiAllowedOrigins, i as TAILSCALE_MISSING_BIN_NOTE_LINES, n as TAILSCALE_DOCS_LINES, r as TAILSCALE_EXPOSURE_OPTIONS, t as validateIPv4AddressInput } from "./ipv4-BZ4r9244.js";
import { t as formatHealthCheckFailure } from "./health-format-JH8HNQtJ.js";
import { t as promptRemoteGatewayConfig } from "./onboard-remote-CuVZABDb.js";
import { t as setupSkills } from "./onboard-skills-CYZ4Bm9h.js";
import path from "node:path";
import fs from "node:fs/promises";
import { confirm, intro, outro, select, text } from "@clack/prompts";
//#region src/commands/configure.shared.ts
const CONFIGURE_WIZARD_SECTIONS = [
	"workspace",
	"model",
	"web",
	"gateway",
	"daemon",
	"channels",
	"skills",
	"health"
];
function parseConfigureWizardSections(raw) {
	const sectionsRaw = Array.isArray(raw) ? raw.map((value) => typeof value === "string" ? value.trim() : "").filter(Boolean) : [];
	if (sectionsRaw.length === 0) return {
		sections: [],
		invalid: []
	};
	const invalid = sectionsRaw.filter((s) => !CONFIGURE_WIZARD_SECTIONS.includes(s));
	return {
		sections: sectionsRaw.filter((s) => CONFIGURE_WIZARD_SECTIONS.includes(s)),
		invalid
	};
}
const CONFIGURE_SECTION_OPTIONS = [
	{
		value: "workspace",
		label: "Workspace",
		hint: "Set workspace + sessions"
	},
	{
		value: "model",
		label: "Model",
		hint: "Pick provider + credentials"
	},
	{
		value: "web",
		label: "Web tools",
		hint: "Configure web search (Perplexity/Brave) + fetch"
	},
	{
		value: "gateway",
		label: "Gateway",
		hint: "Port, bind, auth, tailscale"
	},
	{
		value: "daemon",
		label: "Daemon",
		hint: "Install/manage the background service"
	},
	{
		value: "channels",
		label: "Channels",
		hint: "Link WhatsApp/Telegram/etc and defaults"
	},
	{
		value: "skills",
		label: "Skills",
		hint: "Install/enable workspace skills"
	},
	{
		value: "health",
		label: "Health check",
		hint: "Run gateway + channel checks"
	}
];
const intro$1 = (message) => intro(stylePromptTitle(message) ?? message);
const outro$1 = (message) => outro(stylePromptTitle(message) ?? message);
const text$1 = (params) => text({
	...params,
	message: stylePromptMessage(params.message)
});
const confirm$1 = (params) => confirm({
	...params,
	message: stylePromptMessage(params.message)
});
const select$1 = (params) => select({
	...params,
	message: stylePromptMessage(params.message),
	options: params.options.map((opt) => opt.hint === void 0 ? opt : {
		...opt,
		hint: stylePromptHint(opt.hint)
	})
});
//#endregion
//#region src/commands/configure.channels.ts
init_utils();
async function removeChannelConfigWizard(cfg, runtime) {
	let next = { ...cfg };
	const listConfiguredChannels = () => listChannelPlugins().map((plugin) => plugin.meta).filter((meta) => next.channels?.[meta.id] !== void 0);
	while (true) {
		const configured = listConfiguredChannels();
		if (configured.length === 0) {
			note$1(["No channel config found in openclaw.json.", `Tip: \`${formatCliCommand("openclaw channels status")}\` shows what is configured and enabled.`].join("\n"), "Remove channel");
			return next;
		}
		const channel = guardCancel(await select$1({
			message: "Remove which channel config?",
			options: [...configured.map((meta) => ({
				value: meta.id,
				label: meta.label,
				hint: "Deletes tokens + settings from config (credentials stay on disk)"
			})), {
				value: "done",
				label: "Done"
			}]
		}), runtime);
		if (channel === "done") return next;
		const label = getChannelPlugin(channel)?.meta.label ?? channel;
		if (!guardCancel(await confirm$1({
			message: `Delete ${label} configuration from ${shortenHomePath(CONFIG_PATH)}?`,
			initialValue: false
		}), runtime)) continue;
		const nextChannels = { ...next.channels };
		delete nextChannels[channel];
		next = {
			...next,
			channels: Object.keys(nextChannels).length ? nextChannels : void 0
		};
		note$1([`${label} removed from config.`, "Note: credentials/sessions on disk are unchanged."].join("\n"), "Channel removed");
	}
}
//#endregion
//#region src/commands/configure.daemon.ts
async function maybeInstallDaemon(params) {
	const service = resolveGatewayService();
	let loaded = false;
	try {
		loaded = await service.isLoaded({ env: process.env });
	} catch (error) {
		if (!isNonFatalSystemdInstallProbeError(error)) throw error;
		loaded = false;
	}
	let shouldCheckLinger = false;
	let shouldInstall = true;
	let daemonRuntime = params.daemonRuntime ?? "node";
	if (loaded) {
		const action = guardCancel(await select$1({
			message: "Gateway service already installed",
			options: [
				{
					value: "restart",
					label: "Restart"
				},
				{
					value: "reinstall",
					label: "Reinstall"
				},
				{
					value: "skip",
					label: "Skip"
				}
			]
		}), params.runtime);
		if (action === "restart") {
			await withProgress({
				label: "Gateway service",
				indeterminate: true,
				delayMs: 0
			}, async (progress) => {
				progress.setLabel("Restarting Gateway service…");
				const restartResult = await service.restart({
					env: process.env,
					stdout: process.stdout
				});
				progress.setLabel(describeGatewayServiceRestart("Gateway", restartResult).progressMessage);
			});
			shouldCheckLinger = true;
			shouldInstall = false;
		}
		if (action === "skip") return;
		if (action === "reinstall") await withProgress({
			label: "Gateway service",
			indeterminate: true,
			delayMs: 0
		}, async (progress) => {
			progress.setLabel("Uninstalling Gateway service…");
			await service.uninstall({
				env: process.env,
				stdout: process.stdout
			});
			progress.setLabel("Gateway service uninstalled.");
		});
	}
	if (shouldInstall) {
		let installError = null;
		if (!params.daemonRuntime) if (GATEWAY_DAEMON_RUNTIME_OPTIONS.length === 1) daemonRuntime = GATEWAY_DAEMON_RUNTIME_OPTIONS[0]?.value ?? "node";
		else daemonRuntime = guardCancel(await select$1({
			message: "Gateway service runtime",
			options: GATEWAY_DAEMON_RUNTIME_OPTIONS,
			initialValue: DEFAULT_GATEWAY_DAEMON_RUNTIME
		}), params.runtime);
		await withProgress({
			label: "Gateway service",
			indeterminate: true,
			delayMs: 0
		}, async (progress) => {
			progress.setLabel("Preparing Gateway service…");
			const cfg = loadConfig();
			const tokenResolution = await resolveGatewayInstallToken({
				config: cfg,
				env: process.env
			});
			for (const warning of tokenResolution.warnings) note$1(warning, "Gateway");
			if (tokenResolution.unavailableReason) {
				installError = [
					"Gateway install blocked:",
					tokenResolution.unavailableReason,
					"Fix gateway auth config/token input and rerun configure."
				].join(" ");
				progress.setLabel("Gateway service install blocked.");
				return;
			}
			const { programArguments, workingDirectory, environment } = await buildGatewayInstallPlan({
				env: process.env,
				port: params.port,
				runtime: daemonRuntime,
				warn: (message, title) => note$1(message, title),
				config: cfg
			});
			progress.setLabel("Installing Gateway service…");
			try {
				await service.install({
					env: process.env,
					stdout: process.stdout,
					programArguments,
					workingDirectory,
					environment
				});
				progress.setLabel("Gateway service installed.");
			} catch (err) {
				installError = err instanceof Error ? err.message : String(err);
				progress.setLabel("Gateway service install failed.");
			}
		});
		if (installError) {
			note$1("Gateway service install failed: " + installError, "Gateway");
			note$1(gatewayInstallErrorHint(), "Gateway");
			return;
		}
		shouldCheckLinger = true;
	}
	if (shouldCheckLinger) await ensureSystemdUserLingerInteractive({
		runtime: params.runtime,
		prompter: {
			confirm: async (p) => guardCancel(await confirm$1(p), params.runtime),
			note: note$1
		},
		reason: "Linux installs use a systemd user service. Without lingering, systemd stops the user session on logout/idle and kills the Gateway.",
		requireConfirm: true
	});
}
//#endregion
//#region src/commands/configure.gateway-auth.ts
init_types_secrets();
/** Reject undefined, empty, and common JS string-coercion artifacts for token auth. */
function sanitizeTokenValue(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	if (!trimmed || trimmed === "undefined" || trimmed === "null") return;
	return trimmed;
}
function resolveProviderChoiceModelAllowlist(params) {
	return resolveProviderPluginChoice({
		providers: resolvePluginProviders({
			config: params.config,
			workspaceDir: params.workspaceDir,
			env: params.env,
			bundledProviderAllowlistCompat: true,
			bundledProviderVitestCompat: true
		}),
		choice: params.authChoice
	})?.wizard?.modelAllowlist;
}
function buildGatewayAuthConfig(params) {
	const allowTailscale = params.existing?.allowTailscale;
	const base = {};
	if (typeof allowTailscale === "boolean") base.allowTailscale = allowTailscale;
	if (params.mode === "token") {
		if (isSecretRef(params.token)) return {
			...base,
			mode: "token",
			token: params.token
		};
		const token = sanitizeTokenValue(params.token) ?? randomToken();
		return {
			...base,
			mode: "token",
			token
		};
	}
	if (params.mode === "password") {
		const password = params.password?.trim();
		return {
			...base,
			mode: "password",
			...password && { password }
		};
	}
	if (params.mode === "trusted-proxy") {
		if (!params.trustedProxy) throw new Error("trustedProxy config is required when mode is trusted-proxy");
		return {
			...base,
			mode: "trusted-proxy",
			trustedProxy: params.trustedProxy
		};
	}
	return base;
}
async function promptAuthConfig(cfg, runtime, prompter) {
	const authChoice = await promptAuthChoiceGrouped({
		prompter,
		store: ensureAuthProfileStore(void 0, { allowKeychainPrompt: false }),
		includeSkip: true,
		config: cfg
	});
	let next = cfg;
	if (authChoice === "custom-api-key") next = (await promptCustomApiConfig({
		prompter,
		runtime,
		config: next
	})).config;
	else if (authChoice !== "skip") next = (await applyAuthChoice({
		authChoice,
		config: next,
		prompter,
		runtime,
		setDefaultModel: true
	})).config;
	else {
		const modelSelection = await promptDefaultModel({
			config: next,
			prompter,
			allowKeep: true,
			ignoreAllowlist: true,
			includeProviderPluginSetups: true,
			preferredProvider: await resolvePreferredProviderForAuthChoice({
				choice: authChoice,
				config: next
			}),
			workspaceDir: resolveDefaultAgentWorkspaceDir(),
			runtime
		});
		if (modelSelection.config) next = modelSelection.config;
		if (modelSelection.model) next = applyPrimaryModel(next, modelSelection.model);
	}
	if (authChoice !== "custom-api-key") {
		const modelAllowlist = resolveProviderChoiceModelAllowlist({
			authChoice,
			config: next,
			workspaceDir: resolveDefaultAgentWorkspaceDir(),
			env: process.env
		});
		const allowlistSelection = await promptModelAllowlist({
			config: next,
			prompter,
			allowedKeys: modelAllowlist?.allowedKeys,
			initialSelections: modelAllowlist?.initialSelections,
			message: modelAllowlist?.message
		});
		if (allowlistSelection.models) {
			next = applyModelAllowlist(next, allowlistSelection.models);
			next = applyModelFallbacksFromSelection(next, allowlistSelection.models);
		}
	}
	return next;
}
//#endregion
//#region src/commands/configure.gateway.ts
init_types_secrets();
async function promptGatewayConfig(cfg, runtime) {
	const portRaw = guardCancel(await text$1({
		message: "Gateway port",
		initialValue: String(resolveGatewayPort(cfg)),
		validate: (value) => Number.isFinite(Number(value)) ? void 0 : "Invalid port"
	}), runtime);
	const port = Number.parseInt(String(portRaw), 10);
	let bind = guardCancel(await select$1({
		message: "Gateway bind mode",
		options: [
			{
				value: "loopback",
				label: "Loopback (Local only)",
				hint: "Bind to 127.0.0.1 - secure, local-only access"
			},
			{
				value: "tailnet",
				label: "Tailnet (Tailscale IP)",
				hint: "Bind to your Tailscale IP only (100.x.x.x)"
			},
			{
				value: "auto",
				label: "Auto (Loopback → LAN)",
				hint: "Prefer loopback; fall back to all interfaces if unavailable"
			},
			{
				value: "lan",
				label: "LAN (All interfaces)",
				hint: "Bind to 0.0.0.0 - accessible from anywhere on your network"
			},
			{
				value: "custom",
				label: "Custom IP",
				hint: "Specify a specific IP address, with 0.0.0.0 fallback if unavailable"
			}
		]
	}), runtime);
	let customBindHost;
	if (bind === "custom") {
		const input = guardCancel(await text$1({
			message: "Custom IP address",
			placeholder: "192.168.1.100",
			validate: validateIPv4AddressInput
		}), runtime);
		customBindHost = typeof input === "string" ? input : void 0;
	}
	let authMode = guardCancel(await select$1({
		message: "Gateway auth",
		options: [
			{
				value: "token",
				label: "Token",
				hint: "Recommended default"
			},
			{
				value: "password",
				label: "Password"
			},
			{
				value: "trusted-proxy",
				label: "Trusted Proxy",
				hint: "Behind reverse proxy (Pomerium, Caddy, Traefik, etc.)"
			}
		],
		initialValue: "token"
	}), runtime);
	let tailscaleMode = guardCancel(await select$1({
		message: "Tailscale exposure",
		options: [...TAILSCALE_EXPOSURE_OPTIONS]
	}), runtime);
	let tailscaleBin = null;
	if (tailscaleMode !== "off") {
		tailscaleBin = await findTailscaleBinary();
		if (!tailscaleBin) note$1(TAILSCALE_MISSING_BIN_NOTE_LINES.join("\n"), "Tailscale Warning");
	}
	let tailscaleResetOnExit = false;
	if (tailscaleMode !== "off") {
		note$1(TAILSCALE_DOCS_LINES.join("\n"), "Tailscale");
		tailscaleResetOnExit = Boolean(guardCancel(await confirm$1({
			message: "Reset Tailscale serve/funnel on exit?",
			initialValue: false
		}), runtime));
	}
	if (tailscaleMode !== "off" && bind !== "loopback") {
		note$1("Tailscale requires bind=loopback. Adjusting bind to loopback.", "Note");
		bind = "loopback";
	}
	if (tailscaleMode === "funnel" && authMode !== "password") {
		note$1("Tailscale funnel requires password auth.", "Note");
		authMode = "password";
	}
	if (authMode === "trusted-proxy" && tailscaleMode !== "off") {
		note$1("Trusted proxy auth is incompatible with Tailscale serve/funnel. Disabling Tailscale.", "Note");
		tailscaleMode = "off";
		tailscaleResetOnExit = false;
	}
	let gatewayToken;
	let gatewayTokenForCalls;
	let gatewayPassword;
	let trustedProxyConfig;
	let trustedProxies;
	let next = cfg;
	if (authMode === "token") if (guardCancel(await select$1({
		message: "Gateway token source",
		options: [{
			value: "plaintext",
			label: "Generate/store plaintext token",
			hint: "Default"
		}, {
			value: "ref",
			label: "Use SecretRef",
			hint: "Store an env-backed reference instead of plaintext"
		}],
		initialValue: "plaintext"
	}), runtime) === "ref") {
		const envVar = guardCancel(await text$1({
			message: "Gateway token env var",
			initialValue: "OPENCLAW_GATEWAY_TOKEN",
			placeholder: "OPENCLAW_GATEWAY_TOKEN",
			validate: (value) => {
				const candidate = String(value ?? "").trim();
				if (!isValidEnvSecretRefId(candidate)) return "Use an env var name like OPENCLAW_GATEWAY_TOKEN.";
				if (!process.env[candidate]?.trim()) return `Environment variable "${candidate}" is missing or empty in this session.`;
			}
		}), runtime);
		const envVarName = String(envVar ?? "").trim();
		gatewayToken = {
			source: "env",
			provider: resolveDefaultSecretProviderAlias(cfg, "env", { preferFirstProviderForSource: true }),
			id: envVarName
		};
		note$1(`Validated ${envVarName}. OpenClaw will store a token SecretRef.`, "Gateway token");
	} else {
		gatewayTokenForCalls = normalizeGatewayTokenInput(guardCancel(await text$1({
			message: "Gateway token (blank to generate)",
			initialValue: randomToken()
		}), runtime)) || randomToken();
		gatewayToken = gatewayTokenForCalls;
	}
	if (authMode === "password") {
		const password = guardCancel(await text$1({
			message: "Gateway password",
			validate: validateGatewayPasswordInput
		}), runtime);
		gatewayPassword = String(password ?? "").trim();
	}
	if (authMode === "trusted-proxy") {
		note$1([
			"Trusted proxy mode: OpenClaw trusts user identity from a reverse proxy.",
			"The proxy must authenticate users and pass identity via headers.",
			"Only requests from specified proxy IPs will be trusted.",
			"",
			"Common use cases: Pomerium, Caddy + OAuth, Traefik + forward auth",
			"Docs: https://docs.openclaw.ai/gateway/trusted-proxy-auth"
		].join("\n"), "Trusted Proxy Auth");
		const userHeader = guardCancel(await text$1({
			message: "Header containing user identity",
			placeholder: "x-forwarded-user",
			initialValue: "x-forwarded-user",
			validate: (value) => value?.trim() ? void 0 : "User header is required"
		}), runtime);
		const requiredHeadersRaw = guardCancel(await text$1({
			message: "Required headers (comma-separated, optional)",
			placeholder: "x-forwarded-proto,x-forwarded-host"
		}), runtime);
		const requiredHeaders = requiredHeadersRaw ? String(requiredHeadersRaw).split(",").map((h) => h.trim()).filter(Boolean) : [];
		const allowUsersRaw = guardCancel(await text$1({
			message: "Allowed users (comma-separated, blank = all authenticated users)",
			placeholder: "nick@example.com,admin@company.com"
		}), runtime);
		const allowUsers = allowUsersRaw ? String(allowUsersRaw).split(",").map((u) => u.trim()).filter(Boolean) : [];
		const trustedProxiesRaw = guardCancel(await text$1({
			message: "Trusted proxy IPs (comma-separated)",
			placeholder: "10.0.1.10,192.168.1.5",
			validate: (value) => {
				if (!value || String(value).trim() === "") return "At least one trusted proxy IP is required";
			}
		}), runtime);
		trustedProxies = String(trustedProxiesRaw).split(",").map((ip) => ip.trim()).filter(Boolean);
		trustedProxyConfig = {
			userHeader: String(userHeader).trim(),
			requiredHeaders: requiredHeaders.length > 0 ? requiredHeaders : void 0,
			allowUsers: allowUsers.length > 0 ? allowUsers : void 0
		};
	}
	const authConfig = buildGatewayAuthConfig({
		existing: next.gateway?.auth,
		mode: authMode,
		token: gatewayToken,
		password: gatewayPassword,
		trustedProxy: trustedProxyConfig
	});
	next = {
		...next,
		gateway: {
			...next.gateway,
			mode: "local",
			port,
			bind,
			auth: authConfig,
			...customBindHost && { customBindHost },
			...trustedProxies && { trustedProxies },
			tailscale: {
				...next.gateway?.tailscale,
				mode: tailscaleMode,
				resetOnExit: tailscaleResetOnExit
			}
		}
	};
	next = await maybeAddTailnetOriginToControlUiAllowedOrigins({
		config: next,
		tailscaleMode,
		tailscaleBin
	});
	return {
		config: next,
		port,
		token: gatewayTokenForCalls
	};
}
//#endregion
//#region src/commands/configure.wizard.ts
init_runtime();
init_utils();
async function resolveGatewaySecretInputForWizard(params) {
	try {
		return await resolveSetupSecretInputString({
			config: params.cfg,
			value: params.value,
			path: params.path,
			env: process.env
		});
	} catch {
		return;
	}
}
async function runGatewayHealthCheck(params) {
	const localLinks = resolveControlUiLinks({
		bind: params.cfg.gateway?.bind ?? "loopback",
		port: params.port,
		customBindHost: params.cfg.gateway?.customBindHost,
		basePath: void 0
	});
	const remoteUrl = params.cfg.gateway?.remote?.url?.trim();
	const wsUrl = params.cfg.gateway?.mode === "remote" && remoteUrl ? remoteUrl : localLinks.wsUrl;
	const configuredToken = await resolveGatewaySecretInputForWizard({
		cfg: params.cfg,
		value: params.cfg.gateway?.auth?.token,
		path: "gateway.auth.token"
	});
	const configuredPassword = await resolveGatewaySecretInputForWizard({
		cfg: params.cfg,
		value: params.cfg.gateway?.auth?.password,
		path: "gateway.auth.password"
	});
	await waitForGatewayReachable({
		url: wsUrl,
		token: process.env.OPENCLAW_GATEWAY_TOKEN ?? process.env.CLAWDBOT_GATEWAY_TOKEN ?? configuredToken,
		password: process.env.OPENCLAW_GATEWAY_PASSWORD ?? process.env.CLAWDBOT_GATEWAY_PASSWORD ?? configuredPassword,
		deadlineMs: 15e3
	});
	try {
		await healthCommand({
			json: false,
			timeoutMs: 1e4
		}, params.runtime);
	} catch (err) {
		params.runtime.error(formatHealthCheckFailure(err));
		note$1([
			"Docs:",
			"https://docs.openclaw.ai/gateway/health",
			"https://docs.openclaw.ai/gateway/troubleshooting"
		].join("\n"), "Health check help");
	}
}
async function promptConfigureSection(runtime, hasSelection) {
	return guardCancel(await select$1({
		message: "Select sections to configure",
		options: [...CONFIGURE_SECTION_OPTIONS, {
			value: "__continue",
			label: "Continue",
			hint: hasSelection ? "Done" : "Skip for now"
		}],
		initialValue: CONFIGURE_SECTION_OPTIONS[0]?.value
	}), runtime);
}
async function promptChannelMode(runtime) {
	return guardCancel(await select$1({
		message: "Channels",
		options: [{
			value: "configure",
			label: "Configure/link",
			hint: "Add/update channels; disable unselected accounts"
		}, {
			value: "remove",
			label: "Remove channel config",
			hint: "Delete channel tokens/settings from openclaw.json"
		}],
		initialValue: "configure"
	}), runtime);
}
async function promptWebToolsConfig(nextConfig, runtime) {
	const existingSearch = nextConfig.tools?.web?.search;
	const existingFetch = nextConfig.tools?.web?.fetch;
	const { SEARCH_PROVIDER_OPTIONS, resolveExistingKey, hasExistingKey, applySearchKey, hasKeyInEnv } = await import("./onboard-search-B0I4HMO0.js");
	const defaultProvider = SEARCH_PROVIDER_OPTIONS[0]?.value;
	if (!defaultProvider) throw new Error("No web search providers are registered.");
	const hasKeyForProvider = (provider) => {
		const entry = SEARCH_PROVIDER_OPTIONS.find((e) => e.value === provider);
		if (!entry) return false;
		return hasExistingKey(nextConfig, provider) || hasKeyInEnv(entry);
	};
	const existingProvider = (() => {
		const stored = existingSearch?.provider;
		if (stored && SEARCH_PROVIDER_OPTIONS.some((e) => e.value === stored)) return stored;
		return SEARCH_PROVIDER_OPTIONS.find((e) => hasKeyForProvider(e.value))?.value ?? defaultProvider;
	})();
	note$1([
		"Web search lets your agent look things up online using the `web_search` tool.",
		"Choose a provider and paste your API key.",
		"Docs: https://docs.openclaw.ai/tools/web"
	].join("\n"), "Web search");
	const enableSearch = guardCancel(await confirm$1({
		message: "Enable web_search?",
		initialValue: existingSearch?.enabled ?? SEARCH_PROVIDER_OPTIONS.some((e) => hasKeyForProvider(e.value))
	}), runtime);
	let nextSearch = {
		...existingSearch,
		enabled: enableSearch
	};
	if (enableSearch) {
		const providerChoice = guardCancel(await select$1({
			message: "Choose web search provider",
			options: SEARCH_PROVIDER_OPTIONS.map((entry) => {
				const configured = hasKeyForProvider(entry.value);
				return {
					value: entry.value,
					label: entry.label,
					hint: configured ? `${entry.hint} · configured` : entry.hint
				};
			}),
			initialValue: existingProvider
		}), runtime);
		nextSearch = {
			...nextSearch,
			provider: providerChoice
		};
		const entry = SEARCH_PROVIDER_OPTIONS.find((e) => e.value === providerChoice);
		const existingKey = resolveExistingKey(nextConfig, providerChoice);
		const keyConfigured = hasExistingKey(nextConfig, providerChoice);
		const envAvailable = entry.envKeys.some((k) => Boolean(process.env[k]?.trim()));
		const envVarNames = entry.envKeys.join(" / ");
		const keyInput = guardCancel(await text$1({
			message: keyConfigured ? envAvailable ? `${entry.label} API key (leave blank to keep current or use ${envVarNames})` : `${entry.label} API key (leave blank to keep current)` : envAvailable ? `${entry.label} API key (paste it here; leave blank to use ${envVarNames})` : `${entry.label} API key`,
			placeholder: keyConfigured ? "Leave blank to keep current" : entry.placeholder
		}), runtime);
		const key = String(keyInput ?? "").trim();
		if (key || existingKey) nextSearch = { ...applySearchKey(nextConfig, providerChoice, key || existingKey).tools?.web?.search };
		else if (keyConfigured || envAvailable) nextSearch = { ...nextSearch };
		else note$1([
			"No key stored yet — web_search won't work until a key is available.",
			`Store a key here or set ${envVarNames} in the Gateway environment.`,
			`Get your API key at: ${entry.signupUrl}`,
			"Docs: https://docs.openclaw.ai/tools/web"
		].join("\n"), "Web search");
	}
	const enableFetch = guardCancel(await confirm$1({
		message: "Enable web_fetch (keyless HTTP fetch)?",
		initialValue: existingFetch?.enabled ?? true
	}), runtime);
	const nextFetch = {
		...existingFetch,
		enabled: enableFetch
	};
	return {
		...nextConfig,
		tools: {
			...nextConfig.tools,
			web: {
				...nextConfig.tools?.web,
				search: nextSearch,
				fetch: nextFetch
			}
		}
	};
}
async function runConfigureWizard(opts, runtime = defaultRuntime) {
	try {
		printWizardHeader(runtime);
		intro$1(opts.command === "update" ? "OpenClaw update wizard" : "OpenClaw configure");
		const prompter = createClackPrompter();
		const snapshot = await readConfigFileSnapshot();
		const baseConfig = snapshot.valid ? snapshot.config : {};
		if (snapshot.exists) {
			const title = snapshot.valid ? "Existing config detected" : "Invalid config";
			note$1(summarizeExistingConfig(baseConfig), title);
			if (!snapshot.valid && snapshot.issues.length > 0) note$1([
				...snapshot.issues.map((iss) => `- ${iss.path}: ${iss.message}`),
				"",
				"Docs: https://docs.openclaw.ai/gateway/configuration"
			].join("\n"), "Config issues");
			if (!snapshot.valid) {
				outro$1(`Config invalid. Run \`${formatCliCommand("openclaw doctor")}\` to repair it, then re-run configure.`);
				runtime.exit(1);
				return;
			}
		}
		const localUrl = "ws://127.0.0.1:18789";
		const baseLocalProbeToken = await resolveGatewaySecretInputForWizard({
			cfg: baseConfig,
			value: baseConfig.gateway?.auth?.token,
			path: "gateway.auth.token"
		});
		const baseLocalProbePassword = await resolveGatewaySecretInputForWizard({
			cfg: baseConfig,
			value: baseConfig.gateway?.auth?.password,
			path: "gateway.auth.password"
		});
		const localProbe = await probeGatewayReachable({
			url: localUrl,
			token: process.env.OPENCLAW_GATEWAY_TOKEN ?? process.env.CLAWDBOT_GATEWAY_TOKEN ?? baseLocalProbeToken,
			password: process.env.OPENCLAW_GATEWAY_PASSWORD ?? process.env.CLAWDBOT_GATEWAY_PASSWORD ?? baseLocalProbePassword
		});
		const remoteUrl = baseConfig.gateway?.remote?.url?.trim() ?? "";
		const baseRemoteProbeToken = await resolveGatewaySecretInputForWizard({
			cfg: baseConfig,
			value: baseConfig.gateway?.remote?.token,
			path: "gateway.remote.token"
		});
		const remoteProbe = remoteUrl ? await probeGatewayReachable({
			url: remoteUrl,
			token: baseRemoteProbeToken
		}) : null;
		const mode = guardCancel(await select$1({
			message: "Where will the Gateway run?",
			options: [{
				value: "local",
				label: "Local (this machine)",
				hint: localProbe.ok ? `Gateway reachable (${localUrl})` : `No gateway detected (${localUrl})`
			}, {
				value: "remote",
				label: "Remote (info-only)",
				hint: !remoteUrl ? "No remote URL configured yet" : remoteProbe?.ok ? `Gateway reachable (${remoteUrl})` : `Configured but unreachable (${remoteUrl})`
			}]
		}), runtime);
		if (mode === "remote") {
			let remoteConfig = await promptRemoteGatewayConfig(baseConfig, prompter);
			remoteConfig = applyWizardMetadata(remoteConfig, {
				command: opts.command,
				mode
			});
			await writeConfigFile(remoteConfig);
			logConfigUpdated(runtime);
			outro$1("Remote gateway configured.");
			return;
		}
		let nextConfig = { ...baseConfig };
		let didSetGatewayMode = false;
		if (nextConfig.gateway?.mode !== "local") {
			nextConfig = {
				...nextConfig,
				gateway: {
					...nextConfig.gateway,
					mode: "local"
				}
			};
			didSetGatewayMode = true;
		}
		let workspaceDir = nextConfig.agents?.defaults?.workspace ?? baseConfig.agents?.defaults?.workspace ?? DEFAULT_WORKSPACE;
		let gatewayPort = resolveGatewayPort(baseConfig);
		const persistConfig = async () => {
			nextConfig = applyWizardMetadata(nextConfig, {
				command: opts.command,
				mode
			});
			await writeConfigFile(nextConfig);
			logConfigUpdated(runtime);
		};
		const configureWorkspace = async () => {
			const workspaceInput = guardCancel(await text$1({
				message: "Workspace directory",
				initialValue: workspaceDir
			}), runtime);
			workspaceDir = resolveUserPath(String(workspaceInput ?? "").trim() || DEFAULT_WORKSPACE);
			if (!snapshot.exists) {
				const indicators = [
					"MEMORY.md",
					"memory",
					".git"
				].map((name) => path.join(workspaceDir, name));
				if ((await Promise.all(indicators.map(async (candidate) => {
					try {
						await fs.access(candidate);
						return true;
					} catch {
						return false;
					}
				}))).some(Boolean)) note$1([`Existing workspace detected at ${workspaceDir}`, "Existing files are preserved. Missing templates may be created, never overwritten."].join("\n"), "Existing workspace");
			}
			nextConfig = {
				...nextConfig,
				agents: {
					...nextConfig.agents,
					defaults: {
						...nextConfig.agents?.defaults,
						workspace: workspaceDir
					}
				}
			};
			await ensureWorkspaceAndSessions(workspaceDir, runtime);
		};
		const configureChannelsSection = async () => {
			await noteChannelStatus({
				cfg: nextConfig,
				prompter
			});
			if (await promptChannelMode(runtime) === "configure") nextConfig = await setupChannels(nextConfig, runtime, prompter, {
				allowDisable: true,
				allowSignalInstall: true,
				skipConfirm: true,
				skipStatusNote: true
			});
			else nextConfig = await removeChannelConfigWizard(nextConfig, runtime);
		};
		const promptDaemonPort = async () => {
			const portInput = guardCancel(await text$1({
				message: "Gateway port for service install",
				initialValue: String(gatewayPort),
				validate: (value) => Number.isFinite(Number(value)) ? void 0 : "Invalid port"
			}), runtime);
			gatewayPort = Number.parseInt(String(portInput), 10);
		};
		if (opts.sections) {
			const selected = opts.sections;
			if (!selected || selected.length === 0) {
				outro$1("No changes selected.");
				return;
			}
			if (selected.includes("workspace")) await configureWorkspace();
			if (selected.includes("model")) nextConfig = await promptAuthConfig(nextConfig, runtime, prompter);
			if (selected.includes("web")) nextConfig = await promptWebToolsConfig(nextConfig, runtime);
			if (selected.includes("gateway")) {
				const gateway = await promptGatewayConfig(nextConfig, runtime);
				nextConfig = gateway.config;
				gatewayPort = gateway.port;
			}
			if (selected.includes("channels")) await configureChannelsSection();
			if (selected.includes("skills")) {
				const wsDir = resolveUserPath(workspaceDir);
				nextConfig = await setupSkills(nextConfig, wsDir, runtime, prompter);
			}
			await persistConfig();
			if (selected.includes("daemon")) {
				if (!selected.includes("gateway")) await promptDaemonPort();
				await maybeInstallDaemon({
					runtime,
					port: gatewayPort
				});
			}
			if (selected.includes("health")) await runGatewayHealthCheck({
				cfg: nextConfig,
				runtime,
				port: gatewayPort
			});
		} else {
			let ranSection = false;
			let didConfigureGateway = false;
			while (true) {
				const choice = await promptConfigureSection(runtime, ranSection);
				if (choice === "__continue") break;
				ranSection = true;
				if (choice === "workspace") {
					await configureWorkspace();
					await persistConfig();
				}
				if (choice === "model") {
					nextConfig = await promptAuthConfig(nextConfig, runtime, prompter);
					await persistConfig();
				}
				if (choice === "web") {
					nextConfig = await promptWebToolsConfig(nextConfig, runtime);
					await persistConfig();
				}
				if (choice === "gateway") {
					const gateway = await promptGatewayConfig(nextConfig, runtime);
					nextConfig = gateway.config;
					gatewayPort = gateway.port;
					didConfigureGateway = true;
					await persistConfig();
				}
				if (choice === "channels") {
					await configureChannelsSection();
					await persistConfig();
				}
				if (choice === "skills") {
					const wsDir = resolveUserPath(workspaceDir);
					nextConfig = await setupSkills(nextConfig, wsDir, runtime, prompter);
					await persistConfig();
				}
				if (choice === "daemon") {
					if (!didConfigureGateway) await promptDaemonPort();
					await maybeInstallDaemon({
						runtime,
						port: gatewayPort
					});
				}
				if (choice === "health") await runGatewayHealthCheck({
					cfg: nextConfig,
					runtime,
					port: gatewayPort
				});
			}
			if (!ranSection) {
				if (didSetGatewayMode) {
					await persistConfig();
					outro$1("Gateway mode set to local.");
					return;
				}
				outro$1("No changes selected.");
				return;
			}
		}
		const controlUiAssets = await ensureControlUiAssetsBuilt(runtime);
		if (!controlUiAssets.ok && controlUiAssets.message) runtime.error(controlUiAssets.message);
		const links = resolveControlUiLinks({
			bind: nextConfig.gateway?.bind ?? "loopback",
			port: gatewayPort,
			customBindHost: nextConfig.gateway?.customBindHost,
			basePath: nextConfig.gateway?.controlUi?.basePath
		});
		const newPassword = process.env.OPENCLAW_GATEWAY_PASSWORD ?? process.env.CLAWDBOT_GATEWAY_PASSWORD ?? await resolveGatewaySecretInputForWizard({
			cfg: nextConfig,
			value: nextConfig.gateway?.auth?.password,
			path: "gateway.auth.password"
		});
		const oldPassword = process.env.OPENCLAW_GATEWAY_PASSWORD ?? process.env.CLAWDBOT_GATEWAY_PASSWORD ?? await resolveGatewaySecretInputForWizard({
			cfg: baseConfig,
			value: baseConfig.gateway?.auth?.password,
			path: "gateway.auth.password"
		});
		const token = process.env.OPENCLAW_GATEWAY_TOKEN ?? process.env.CLAWDBOT_GATEWAY_TOKEN ?? await resolveGatewaySecretInputForWizard({
			cfg: nextConfig,
			value: nextConfig.gateway?.auth?.token,
			path: "gateway.auth.token"
		});
		let gatewayProbe = await probeGatewayReachable({
			url: links.wsUrl,
			token,
			password: newPassword
		});
		if (!gatewayProbe.ok && newPassword !== oldPassword && oldPassword) gatewayProbe = await probeGatewayReachable({
			url: links.wsUrl,
			token,
			password: oldPassword
		});
		const gatewayStatusLine = gatewayProbe.ok ? "Gateway: reachable" : `Gateway: not detected${gatewayProbe.detail ? ` (${gatewayProbe.detail})` : ""}`;
		note$1([
			`Web UI: ${links.httpUrl}`,
			`Gateway WS: ${links.wsUrl}`,
			gatewayStatusLine,
			"Docs: https://docs.openclaw.ai/web/control-ui"
		].join("\n"), "Control UI");
		outro$1("Configure complete.");
	} catch (err) {
		if (err instanceof WizardCancelledError) {
			runtime.exit(1);
			return;
		}
		throw err;
	}
}
//#endregion
//#region src/commands/configure.commands.ts
init_runtime();
async function configureCommand(runtime = defaultRuntime) {
	await runConfigureWizard({ command: "configure" }, runtime);
}
async function configureCommandWithSections(sections, runtime = defaultRuntime) {
	await runConfigureWizard({
		command: "configure",
		sections
	}, runtime);
}
async function configureCommandFromSectionsArg(rawSections, runtime = defaultRuntime) {
	const { sections, invalid } = parseConfigureWizardSections(rawSections);
	if (sections.length === 0) {
		await configureCommand(runtime);
		return;
	}
	if (invalid.length > 0) {
		runtime.error(`Invalid --section: ${invalid.join(", ")}. Expected one of: ${CONFIGURE_WIZARD_SECTIONS.join(", ")}.`);
		runtime.exit(1);
		return;
	}
	await configureCommandWithSections(sections, runtime);
}
//#endregion
export { buildGatewayAuthConfig as a, runConfigureWizard as i, configureCommandFromSectionsArg as n, CONFIGURE_WIZARD_SECTIONS as o, configureCommandWithSections as r, parseConfigureWizardSections as s, configureCommand as t };
