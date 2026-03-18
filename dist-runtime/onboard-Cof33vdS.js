import { d as resolveGatewayPort } from "./paths-DqbqmTPe.js";
import { d as defaultRuntime, f as init_runtime, m as restoreTerminalState, p as init_restore } from "./subsystem-CZwunM2N.js";
import { b as resolveUserPath, d as init_utils } from "./utils-BiUV1eIQ.js";
import { $u as handleReset, Jb as writeConfigFile, Ku as DEFAULT_WORKSPACE, Ub as readConfigFileSnapshot, Xu as ensureWorkspaceAndSessions, ad as randomToken, dd as waitForGatewayReachable, qu as applyWizardMetadata, sd as resolveControlUiLinks, td as normalizeGatewayTokenInput } from "./auth-profiles-DAOR1fRn.js";
import { c as isValidEnvSecretRefId, o as init_types_secrets } from "./types.secrets-Cu0Lz6pi.js";
import { Fn as resolveDefaultSecretProviderAlias } from "./method-scopes-CLHNYIU6.js";
import { t as formatCliCommand } from "./command-format-CS805JpF.js";
import { t as assertSupportedRuntime } from "./runtime-guard-BeaHeRr7.js";
import "./daemon-runtime-Tgt-ZRti.js";
import { t as WizardCancelledError } from "./prompts-BfXKoCy4.js";
import { t as runSetupWizard } from "./setup-CYm1oiSQ.js";
import { n as logConfigUpdated } from "./logging-B8JmIRjO.js";
import { t as createClackPrompter } from "./clack-prompter-Dan3tMHD.js";
import { n as isDeprecatedAuthChoice, r as normalizeLegacyOnboardAuthChoice, s as resolveManifestProviderOnboardAuthFlags } from "./auth-choice-legacy-DTPPkr0E.js";
import { r as applyLocalSetupWorkspaceConfig } from "./onboard-config-qH53adPo.js";
//#region src/commands/onboard-core-auth-flags.ts
const CORE_ONBOARD_AUTH_FLAGS = [{
	optionKey: "litellmApiKey",
	authChoice: "litellm-api-key",
	cliFlag: "--litellm-api-key",
	cliOption: "--litellm-api-key <key>",
	description: "LiteLLM API key"
}];
//#endregion
//#region src/commands/onboard-interactive.ts
init_runtime();
init_restore();
async function runInteractiveSetup(opts, runtime = defaultRuntime) {
	const prompter = createClackPrompter();
	let exitCode = null;
	try {
		await runSetupWizard(opts, runtime, prompter);
	} catch (err) {
		if (err instanceof WizardCancelledError) {
			exitCode = 1;
			return;
		}
		throw err;
	} finally {
		restoreTerminalState("setup finish", { resumeStdinIfPaused: false });
		if (exitCode !== null) runtime.exit(exitCode);
	}
}
//#endregion
//#region src/commands/onboard-non-interactive/local/auth-choice-inference.ts
function hasStringValue(value) {
	return typeof value === "string" ? value.trim().length > 0 : Boolean(value);
}
function inferAuthChoiceFromFlags(opts) {
	const matches = [...CORE_ONBOARD_AUTH_FLAGS, ...resolveManifestProviderOnboardAuthFlags()].filter(({ optionKey }) => hasStringValue(opts[optionKey])).map((flag) => ({
		optionKey: flag.optionKey,
		authChoice: flag.authChoice,
		label: flag.cliFlag
	}));
	if (hasStringValue(opts.customBaseUrl) || hasStringValue(opts.customModelId) || hasStringValue(opts.customApiKey)) matches.push({
		optionKey: "customBaseUrl",
		authChoice: "custom-api-key",
		label: "--custom-base-url/--custom-model-id/--custom-api-key"
	});
	return {
		choice: matches[0]?.authChoice,
		matches
	};
}
//#endregion
//#region src/commands/onboard-non-interactive/local/gateway-config.ts
init_types_secrets();
function applyNonInteractiveGatewayConfig(params) {
	const { opts, runtime } = params;
	const hasGatewayPort = opts.gatewayPort !== void 0;
	if (hasGatewayPort && (!Number.isFinite(opts.gatewayPort) || (opts.gatewayPort ?? 0) <= 0)) {
		runtime.error("Invalid --gateway-port");
		runtime.exit(1);
		return null;
	}
	const port = hasGatewayPort ? opts.gatewayPort : params.defaultPort;
	let bind = opts.gatewayBind ?? "loopback";
	const authModeRaw = opts.gatewayAuth ?? "token";
	if (authModeRaw !== "token" && authModeRaw !== "password") {
		runtime.error("Invalid --gateway-auth (use token|password).");
		runtime.exit(1);
		return null;
	}
	let authMode = authModeRaw;
	const tailscaleMode = opts.tailscale ?? "off";
	const tailscaleResetOnExit = Boolean(opts.tailscaleResetOnExit);
	if (tailscaleMode !== "off" && bind !== "loopback") bind = "loopback";
	if (tailscaleMode === "funnel" && authMode !== "password") authMode = "password";
	let nextConfig = params.nextConfig;
	const explicitGatewayToken = normalizeGatewayTokenInput(opts.gatewayToken);
	const envGatewayToken = normalizeGatewayTokenInput(process.env.OPENCLAW_GATEWAY_TOKEN);
	let gatewayToken = explicitGatewayToken || envGatewayToken || void 0;
	const gatewayTokenRefEnv = String(opts.gatewayTokenRefEnv ?? "").trim();
	if (authMode === "token") if (gatewayTokenRefEnv) {
		if (!isValidEnvSecretRefId(gatewayTokenRefEnv)) {
			runtime.error("Invalid --gateway-token-ref-env (use env var name like OPENCLAW_GATEWAY_TOKEN).");
			runtime.exit(1);
			return null;
		}
		if (explicitGatewayToken) {
			runtime.error("Use either --gateway-token or --gateway-token-ref-env, not both.");
			runtime.exit(1);
			return null;
		}
		const resolvedFromEnv = process.env[gatewayTokenRefEnv]?.trim();
		if (!resolvedFromEnv) {
			runtime.error(`Environment variable "${gatewayTokenRefEnv}" is missing or empty.`);
			runtime.exit(1);
			return null;
		}
		gatewayToken = resolvedFromEnv;
		nextConfig = {
			...nextConfig,
			gateway: {
				...nextConfig.gateway,
				auth: {
					...nextConfig.gateway?.auth,
					mode: "token",
					token: {
						source: "env",
						provider: resolveDefaultSecretProviderAlias(nextConfig, "env", { preferFirstProviderForSource: true }),
						id: gatewayTokenRefEnv
					}
				}
			}
		};
	} else {
		if (!gatewayToken) gatewayToken = randomToken();
		nextConfig = {
			...nextConfig,
			gateway: {
				...nextConfig.gateway,
				auth: {
					...nextConfig.gateway?.auth,
					mode: "token",
					token: gatewayToken
				}
			}
		};
	}
	if (authMode === "password") {
		const password = opts.gatewayPassword?.trim();
		if (!password) {
			runtime.error("Missing --gateway-password for password auth.");
			runtime.exit(1);
			return null;
		}
		nextConfig = {
			...nextConfig,
			gateway: {
				...nextConfig.gateway,
				auth: {
					...nextConfig.gateway?.auth,
					mode: "password",
					password
				}
			}
		};
	}
	nextConfig = {
		...nextConfig,
		gateway: {
			...nextConfig.gateway,
			port,
			bind,
			tailscale: {
				...nextConfig.gateway?.tailscale,
				mode: tailscaleMode,
				resetOnExit: tailscaleResetOnExit
			}
		}
	};
	return {
		nextConfig,
		port,
		bind,
		authMode,
		tailscaleMode,
		tailscaleResetOnExit,
		gatewayToken
	};
}
//#endregion
//#region src/commands/onboard-non-interactive/local/output.ts
function logNonInteractiveOnboardingJson(params) {
	if (!params.opts.json) return;
	params.runtime.log(JSON.stringify({
		ok: true,
		mode: params.mode,
		workspace: params.workspaceDir,
		authChoice: params.authChoice,
		gateway: params.gateway,
		installDaemon: Boolean(params.installDaemon),
		daemonInstall: params.daemonInstall,
		daemonRuntime: params.daemonRuntime,
		skipSkills: Boolean(params.skipSkills),
		skipHealth: Boolean(params.skipHealth)
	}, null, 2));
}
function formatGatewayRuntimeSummary(diagnostics) {
	const service = diagnostics?.service;
	if (!service?.runtimeStatus) return;
	const parts = [service.runtimeStatus];
	if (typeof service.pid === "number") parts.push(`pid ${service.pid}`);
	if (service.state) parts.push(`state ${service.state}`);
	if (typeof service.lastExitStatus === "number") parts.push(`last exit ${service.lastExitStatus}`);
	if (service.lastExitReason) parts.push(`reason ${service.lastExitReason}`);
	return parts.join(", ");
}
function logNonInteractiveOnboardingFailure(params) {
	const hints = params.hints?.filter(Boolean) ?? [];
	const gatewayRuntime = formatGatewayRuntimeSummary(params.diagnostics);
	if (params.opts.json) {
		params.runtime.error(JSON.stringify({
			ok: false,
			mode: params.mode,
			phase: params.phase,
			message: params.message,
			detail: params.detail,
			gateway: params.gateway,
			installDaemon: Boolean(params.installDaemon),
			daemonInstall: params.daemonInstall,
			daemonRuntime: params.daemonRuntime,
			diagnostics: params.diagnostics,
			hints: hints.length > 0 ? hints : void 0
		}, null, 2));
		return;
	}
	const lines = [
		params.message,
		params.detail ? `Last probe: ${params.detail}` : void 0,
		params.diagnostics?.service ? `Service: ${params.diagnostics.service.label} (${params.diagnostics.service.loaded ? params.diagnostics.service.loadedText : "not loaded"})` : void 0,
		gatewayRuntime ? `Runtime: ${gatewayRuntime}` : void 0,
		params.diagnostics?.lastGatewayError ? `Last gateway error: ${params.diagnostics.lastGatewayError}` : void 0,
		params.diagnostics?.inspectError ? `Diagnostics warning: ${params.diagnostics.inspectError}` : void 0,
		hints.length > 0 ? hints.join("\n") : void 0
	].filter(Boolean).join("\n");
	params.runtime.error(lines);
}
//#endregion
//#region src/commands/onboard-non-interactive/local/skills-config.ts
function applyNonInteractiveSkillsConfig(params) {
	const { nextConfig, opts, runtime } = params;
	if (opts.skipSkills) return nextConfig;
	const nodeManager = opts.nodeManager ?? "npm";
	if (![
		"npm",
		"pnpm",
		"bun"
	].includes(nodeManager)) {
		runtime.error("Invalid --node-manager (use npm, pnpm, or bun)");
		runtime.exit(1);
		return nextConfig;
	}
	return {
		...nextConfig,
		skills: {
			...nextConfig.skills,
			install: {
				...nextConfig.skills?.install,
				nodeManager
			}
		}
	};
}
//#endregion
//#region src/commands/onboard-non-interactive/local/workspace.ts
init_utils();
function resolveNonInteractiveWorkspaceDir(params) {
	return resolveUserPath((params.opts.workspace ?? params.baseConfig.agents?.defaults?.workspace ?? params.defaultWorkspaceDir).trim());
}
//#endregion
//#region src/commands/onboard-non-interactive/local.ts
const INSTALL_DAEMON_HEALTH_DEADLINE_MS = 45e3;
const ATTACH_EXISTING_GATEWAY_HEALTH_DEADLINE_MS = 15e3;
async function collectGatewayHealthFailureDiagnostics() {
	const diagnostics = {};
	try {
		const { resolveGatewayService } = await import("./service-uGms_kzx.js");
		const service = resolveGatewayService();
		const env = process.env;
		const [loaded, runtime] = await Promise.all([service.isLoaded({ env }).catch(() => false), service.readRuntime(env).catch(() => void 0)]);
		diagnostics.service = {
			label: service.label,
			loaded,
			loadedText: service.loadedText,
			runtimeStatus: runtime?.status,
			state: runtime?.state,
			pid: runtime?.pid,
			lastExitStatus: runtime?.lastExitStatus,
			lastExitReason: runtime?.lastExitReason
		};
	} catch (err) {
		diagnostics.inspectError = `service diagnostics failed: ${String(err)}`;
	}
	try {
		const { readLastGatewayErrorLine } = await import("./diagnostics-Bz-rpUfQ.js");
		diagnostics.lastGatewayError = await readLastGatewayErrorLine(process.env) ?? void 0;
	} catch (err) {
		diagnostics.inspectError = diagnostics.inspectError ? `${diagnostics.inspectError}; log diagnostics failed: ${String(err)}` : `log diagnostics failed: ${String(err)}`;
	}
	return diagnostics.service || diagnostics.lastGatewayError || diagnostics.inspectError ? diagnostics : void 0;
}
async function runNonInteractiveLocalSetup(params) {
	const { opts, runtime, baseConfig } = params;
	const mode = "local";
	const workspaceDir = resolveNonInteractiveWorkspaceDir({
		opts,
		baseConfig,
		defaultWorkspaceDir: DEFAULT_WORKSPACE
	});
	let nextConfig = applyLocalSetupWorkspaceConfig(baseConfig, workspaceDir);
	const inferredAuthChoice = inferAuthChoiceFromFlags(opts);
	if (!opts.authChoice && inferredAuthChoice.matches.length > 1) {
		runtime.error([
			"Multiple API key flags were provided for non-interactive setup.",
			"Use a single provider flag or pass --auth-choice explicitly.",
			`Flags: ${inferredAuthChoice.matches.map((match) => match.label).join(", ")}`
		].join("\n"));
		runtime.exit(1);
		return;
	}
	const authChoice = opts.authChoice ?? inferredAuthChoice.choice ?? "skip";
	if (authChoice !== "skip") {
		const { applyNonInteractiveAuthChoice } = await import("./auth-choice-Bs7cE0o_.js");
		const nextConfigAfterAuth = await applyNonInteractiveAuthChoice({
			nextConfig,
			authChoice,
			opts,
			runtime,
			baseConfig
		});
		if (!nextConfigAfterAuth) return;
		nextConfig = nextConfigAfterAuth;
	}
	const gatewayBasePort = resolveGatewayPort(baseConfig);
	const gatewayResult = applyNonInteractiveGatewayConfig({
		nextConfig,
		opts,
		runtime,
		defaultPort: gatewayBasePort
	});
	if (!gatewayResult) return;
	nextConfig = gatewayResult.nextConfig;
	nextConfig = applyNonInteractiveSkillsConfig({
		nextConfig,
		opts,
		runtime
	});
	nextConfig = applyWizardMetadata(nextConfig, {
		command: "onboard",
		mode
	});
	await writeConfigFile(nextConfig);
	logConfigUpdated(runtime);
	await ensureWorkspaceAndSessions(workspaceDir, runtime, { skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap) });
	const daemonRuntimeRaw = opts.daemonRuntime ?? "node";
	let daemonInstallStatus;
	if (opts.installDaemon) {
		const { installGatewayDaemonNonInteractive } = await import("./daemon-install-D1-3UxjV.js");
		const daemonInstall = await installGatewayDaemonNonInteractive({
			nextConfig,
			opts,
			runtime,
			port: gatewayResult.port
		});
		daemonInstallStatus = daemonInstall.installed ? {
			requested: true,
			installed: true
		} : {
			requested: true,
			installed: false,
			skippedReason: daemonInstall.skippedReason
		};
		if (!daemonInstall.installed && !opts.skipHealth) {
			logNonInteractiveOnboardingFailure({
				opts,
				runtime,
				mode,
				phase: "daemon-install",
				message: daemonInstall.skippedReason === "systemd-user-unavailable" ? "Gateway service install is unavailable because systemd user services are not reachable in this Linux session." : "Gateway service install did not complete successfully.",
				installDaemon: true,
				daemonInstall: {
					requested: true,
					installed: false,
					skippedReason: daemonInstall.skippedReason
				},
				daemonRuntime: daemonRuntimeRaw,
				hints: daemonInstall.skippedReason === "systemd-user-unavailable" ? ["Fix: rerun without `--install-daemon` for one-shot setup, or enable a working user-systemd session and retry.", "If your auth profile uses env-backed refs, keep those env vars set in the shell that runs `openclaw gateway run` or `openclaw agent --local`."] : [`Run \`${formatCliCommand("openclaw gateway status --deep")}\` for more detail.`]
			});
			runtime.exit(1);
			return;
		}
	}
	if (!opts.skipHealth) {
		const { healthCommand } = await import("./health-_RdC8Bt2.js");
		const links = resolveControlUiLinks({
			bind: gatewayResult.bind,
			port: gatewayResult.port,
			customBindHost: nextConfig.gateway?.customBindHost,
			basePath: void 0
		});
		const probe = await waitForGatewayReachable({
			url: links.wsUrl,
			token: gatewayResult.gatewayToken,
			deadlineMs: opts.installDaemon ? INSTALL_DAEMON_HEALTH_DEADLINE_MS : ATTACH_EXISTING_GATEWAY_HEALTH_DEADLINE_MS
		});
		if (!probe.ok) {
			const diagnostics = opts.installDaemon ? await collectGatewayHealthFailureDiagnostics() : void 0;
			logNonInteractiveOnboardingFailure({
				opts,
				runtime,
				mode,
				phase: "gateway-health",
				message: `Gateway did not become reachable at ${links.wsUrl}.`,
				detail: probe.detail,
				gateway: {
					wsUrl: links.wsUrl,
					httpUrl: links.httpUrl
				},
				installDaemon: Boolean(opts.installDaemon),
				daemonInstall: daemonInstallStatus,
				daemonRuntime: opts.installDaemon ? daemonRuntimeRaw : void 0,
				diagnostics,
				hints: !opts.installDaemon ? [
					"Non-interactive local setup only waits for an already-running gateway unless you pass --install-daemon.",
					`Fix: start \`${formatCliCommand("openclaw gateway run")}\`, re-run with \`--install-daemon\`, or use \`--skip-health\`.`,
					process.platform === "win32" ? "Native Windows managed gateway install tries Scheduled Tasks first and falls back to a per-user Startup-folder login item when task creation is denied." : void 0
				].filter((value) => Boolean(value)) : [`Run \`${formatCliCommand("openclaw gateway status --deep")}\` for more detail.`]
			});
			runtime.exit(1);
			return;
		}
		await healthCommand({
			json: false,
			timeoutMs: 1e4
		}, runtime);
	}
	logNonInteractiveOnboardingJson({
		opts,
		runtime,
		mode,
		workspaceDir,
		authChoice,
		gateway: {
			port: gatewayResult.port,
			bind: gatewayResult.bind,
			authMode: gatewayResult.authMode,
			tailscaleMode: gatewayResult.tailscaleMode
		},
		installDaemon: Boolean(opts.installDaemon),
		daemonInstall: daemonInstallStatus,
		daemonRuntime: opts.installDaemon ? daemonRuntimeRaw : void 0,
		skipSkills: Boolean(opts.skipSkills),
		skipHealth: Boolean(opts.skipHealth)
	});
	if (!opts.json) runtime.log(`Tip: run \`${formatCliCommand("openclaw configure --section web")}\` to store your Brave API key for web_search. Docs: https://docs.openclaw.ai/tools/web`);
}
//#endregion
//#region src/commands/onboard-non-interactive/remote.ts
async function runNonInteractiveRemoteSetup(params) {
	const { opts, runtime, baseConfig } = params;
	const mode = "remote";
	const remoteUrl = opts.remoteUrl?.trim();
	if (!remoteUrl) {
		runtime.error("Missing --remote-url for remote mode.");
		runtime.exit(1);
		return;
	}
	let nextConfig = {
		...baseConfig,
		gateway: {
			...baseConfig.gateway,
			mode: "remote",
			remote: {
				url: remoteUrl,
				token: opts.remoteToken?.trim() || void 0
			}
		}
	};
	nextConfig = applyWizardMetadata(nextConfig, {
		command: "onboard",
		mode
	});
	await writeConfigFile(nextConfig);
	logConfigUpdated(runtime);
	const payload = {
		mode,
		remoteUrl,
		auth: opts.remoteToken ? "token" : "none"
	};
	if (opts.json) runtime.log(JSON.stringify(payload, null, 2));
	else {
		runtime.log(`Remote gateway: ${remoteUrl}`);
		runtime.log(`Auth: ${payload.auth}`);
		runtime.log(`Tip: run \`${formatCliCommand("openclaw configure --section web")}\` to store your Brave API key for web_search. Docs: https://docs.openclaw.ai/tools/web`);
	}
}
//#endregion
//#region src/commands/onboard-non-interactive.ts
init_runtime();
async function runNonInteractiveSetup(opts, runtime = defaultRuntime) {
	const snapshot = await readConfigFileSnapshot();
	if (snapshot.exists && !snapshot.valid) {
		runtime.error(`Config invalid. Run \`${formatCliCommand("openclaw doctor")}\` to repair it, then re-run setup.`);
		runtime.exit(1);
		return;
	}
	const baseConfig = snapshot.valid ? snapshot.exists ? snapshot.config : {} : {};
	const mode = opts.mode ?? "local";
	if (mode !== "local" && mode !== "remote") {
		runtime.error(`Invalid --mode "${String(mode)}" (use local|remote).`);
		runtime.exit(1);
		return;
	}
	if (mode === "remote") {
		await runNonInteractiveRemoteSetup({
			opts,
			runtime,
			baseConfig
		});
		return;
	}
	await runNonInteractiveLocalSetup({
		opts,
		runtime,
		baseConfig
	});
}
//#endregion
//#region src/commands/onboard.ts
init_runtime();
init_utils();
const VALID_RESET_SCOPES = new Set([
	"config",
	"config+creds+sessions",
	"full"
]);
async function setupWizardCommand(opts, runtime = defaultRuntime) {
	assertSupportedRuntime(runtime);
	const originalAuthChoice = opts.authChoice;
	const normalizedAuthChoice = normalizeLegacyOnboardAuthChoice(originalAuthChoice);
	if (opts.nonInteractive && isDeprecatedAuthChoice(originalAuthChoice)) {
		runtime.error([`Auth choice "${String(originalAuthChoice)}" is deprecated.`, "Use \"--auth-choice token\" (Anthropic setup-token) or \"--auth-choice openai-codex\"."].join("\n"));
		runtime.exit(1);
		return;
	}
	if (originalAuthChoice === "claude-cli") runtime.log("Auth choice \"claude-cli\" is deprecated; using setup-token flow instead.");
	if (originalAuthChoice === "codex-cli") runtime.log("Auth choice \"codex-cli\" is deprecated; using OpenAI Codex OAuth instead.");
	const flow = opts.flow === "manual" ? "advanced" : opts.flow;
	const normalizedOpts = normalizedAuthChoice === opts.authChoice && flow === opts.flow ? opts : {
		...opts,
		authChoice: normalizedAuthChoice,
		flow
	};
	if (normalizedOpts.secretInputMode && normalizedOpts.secretInputMode !== "plaintext" && normalizedOpts.secretInputMode !== "ref") {
		runtime.error("Invalid --secret-input-mode. Use \"plaintext\" or \"ref\".");
		runtime.exit(1);
		return;
	}
	if (normalizedOpts.resetScope && !VALID_RESET_SCOPES.has(normalizedOpts.resetScope)) {
		runtime.error("Invalid --reset-scope. Use \"config\", \"config+creds+sessions\", or \"full\".");
		runtime.exit(1);
		return;
	}
	if (normalizedOpts.nonInteractive && normalizedOpts.acceptRisk !== true) {
		runtime.error([
			"Non-interactive setup requires explicit risk acknowledgement.",
			"Read: https://docs.openclaw.ai/security",
			`Re-run with: ${formatCliCommand("openclaw onboard --non-interactive --accept-risk ...")}`
		].join("\n"));
		runtime.exit(1);
		return;
	}
	if (normalizedOpts.reset) {
		const snapshot = await readConfigFileSnapshot();
		const baseConfig = snapshot.valid ? snapshot.config : {};
		const workspaceDefault = normalizedOpts.workspace ?? baseConfig.agents?.defaults?.workspace ?? DEFAULT_WORKSPACE;
		await handleReset(normalizedOpts.resetScope ?? "config+creds+sessions", resolveUserPath(workspaceDefault), runtime);
	}
	if (process.platform === "win32") runtime.log([
		"Windows detected - OpenClaw runs great on WSL2!",
		"Native Windows might be trickier.",
		"Quick setup: wsl --install (one command, one reboot)",
		"Guide: https://docs.openclaw.ai/windows"
	].join("\n"));
	if (normalizedOpts.nonInteractive) {
		await runNonInteractiveSetup(normalizedOpts, runtime);
		return;
	}
	await runInteractiveSetup(normalizedOpts, runtime);
}
//#endregion
export { CORE_ONBOARD_AUTH_FLAGS as n, setupWizardCommand as t };
