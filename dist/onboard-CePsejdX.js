import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { d as resolveGatewayPort } from "./paths-Cw7f9XhU.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { t as restoreTerminalState } from "./restore-D60-WDR7.js";
import { p as resolveUserPath } from "./utils-sBTEdeml.js";
import { l as isValidEnvSecretRefId, m as resolveSecretInputRef } from "./types.secrets-DwPik3M8.js";
import { n as defaultRuntime, r as writeRuntimeJson } from "./runtime-yzlkhCoS.js";
import { t as assertSupportedRuntime } from "./runtime-guard-DLdnBLFm.js";
import "./daemon-runtime-C5rLdYLT.js";
import { l as resolveDefaultSecretProviderAlias } from "./ref-contract-D_h_G00C.js";
import { t as resolveConfiguredSecretInputString } from "./resolve-configured-secret-input-string-DuewGZmy.js";
import { t as resolveGatewayAuthToken } from "./auth-token-resolution-BXDTKdSY.js";
import { u as readConfigFileSnapshot } from "./io-DoswVvYe.js";
import { i as replaceConfigFile } from "./mutate-DLC8bveh.js";
import { t as randomToken } from "./random-token-hQenuzDT.js";
import "./config-B6Oplu5W.js";
import { r as formatInvalidPortOption } from "./error-format-BfFDdqsq.js";
import { t as resolveControlUiLinks } from "./control-ui-links-BSo6xNaU.js";
import { t as WizardCancelledError } from "./prompts-E0FayNjJ.js";
import { t as createClackPrompter } from "./clack-prompter-BZIQivnq.js";
import { r as logConfigUpdated } from "./logging-t-RUPR6R.js";
import { c as normalizeGatewayTokenInput, m as waitForGatewayReachable, n as applyWizardMetadata, o as handleReset, r as ensureWorkspaceAndSessions, t as DEFAULT_WORKSPACE } from "./onboard-helpers-BaLdeEkj.js";
import { i as resolveDeprecatedAuthChoiceReplacement, n as isDeprecatedAuthChoice, r as normalizeLegacyOnboardAuthChoice, t as formatDeprecatedNonInteractiveAuthChoiceError } from "./auth-choice-legacy-CQCT2gkW.js";
import { i as applySkipBootstrapConfig, r as applyLocalSetupWorkspaceConfig } from "./onboard-config-DWtpjliF.js";
import { t as createNonInteractiveLoggingPrompter } from "./non-interactive-prompter-CGPDOJMx.js";
import { t as runSetupWizard } from "./setup-BfnSsA8g.js";
//#region src/commands/onboard-interactive.ts
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
//#region src/commands/onboard-non-interactive/local/gateway-config.ts
function applyNonInteractiveGatewayConfig(params) {
	const { opts, runtime } = params;
	const gatewayPort = opts.gatewayPort;
	if (gatewayPort !== void 0 && (!Number.isFinite(gatewayPort) || gatewayPort <= 0 || gatewayPort > 65535)) {
		runtime.error(formatInvalidPortOption("--gateway-port"));
		runtime.exit(1);
		return null;
	}
	const port = gatewayPort ?? params.defaultPort;
	let bind = opts.gatewayBind ?? "loopback";
	const authModeRaw = opts.gatewayAuth ?? "token";
	if (authModeRaw !== "token" && authModeRaw !== "password") {
		runtime.error("Invalid --gateway-auth. Use \"token\" or \"password\".");
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
	const existingTokenInput = nextConfig.gateway?.auth?.token;
	const existingTokenRef = resolveSecretInputRef({
		value: existingTokenInput,
		defaults: nextConfig.secrets?.defaults
	}).ref;
	const existingPlaintextToken = normalizeGatewayTokenInput(existingTokenInput);
	let gatewayToken = explicitGatewayToken || existingPlaintextToken || envGatewayToken || void 0;
	const gatewayTokenRefEnv = normalizeOptionalString(opts.gatewayTokenRefEnv ?? "") ?? "";
	if (authMode === "token") if (gatewayTokenRefEnv) {
		if (!isValidEnvSecretRefId(gatewayTokenRefEnv)) {
			runtime.error("Invalid --gateway-token-ref-env. Use an environment variable name like OPENCLAW_GATEWAY_TOKEN.");
			runtime.exit(1);
			return null;
		}
		if (explicitGatewayToken) {
			runtime.error("Use either --gateway-token or --gateway-token-ref-env, not both. Prefer --gateway-token-ref-env to avoid writing plaintext tokens.");
			runtime.exit(1);
			return null;
		}
		const resolvedFromEnv = process.env[gatewayTokenRefEnv]?.trim();
		if (!resolvedFromEnv) {
			runtime.error(`Environment variable "${gatewayTokenRefEnv}" is missing or empty. Export it first, then rerun ${formatCliCommand("openclaw onboard --non-interactive")}.`);
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
	} else if (!explicitGatewayToken && existingTokenRef) nextConfig = {
		...nextConfig,
		gateway: {
			...nextConfig.gateway,
			auth: {
				...nextConfig.gateway?.auth,
				mode: "token"
			}
		}
	};
	else {
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
			runtime.error("Missing --gateway-password for password auth. Pass --gateway-password or use --gateway-auth token.");
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
		tailscaleResetOnExit
	};
}
//#endregion
//#region src/commands/onboard-non-interactive/local/output.ts
function logNonInteractiveOnboardingJson(params) {
	if (!params.opts.json) return;
	writeRuntimeJson(params.runtime, {
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
	});
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
function hasConnectionRefusedDetail(detail) {
	return /\b(?:econnrefused|connection refused|connect refused)\b/i.test(detail);
}
function classifyGatewayHealthFailure(params) {
	const detail = params.detail ?? "";
	const lastGatewayError = params.diagnostics?.lastGatewayError ?? "";
	const combined = `${detail}\n${lastGatewayError}`;
	if (/\b(?:unauthorized|forbidden|invalid token|invalid password|auth mismatch)\b/i.test(combined)) return "auth-mismatch";
	if (/\b(?:runtime[- ]deps?|runtime dependencies|cannot find module|sqlite-vec|loadextension)\b/i.test(combined)) return "module-missing";
	if (params.diagnostics?.service?.loaded === false && hasConnectionRefusedDetail(detail)) return "service-missing";
	const runtimeStatus = params.diagnostics?.service?.runtimeStatus;
	if (runtimeStatus && runtimeStatus !== "running" && runtimeStatus !== "active" && hasConnectionRefusedDetail(detail)) return "service-stopped";
	if (lastGatewayError.trim()) return "startup-blocked";
	if (hasConnectionRefusedDetail(detail)) return "not-listening";
}
function recoveryHintForGatewayHealthFailure(classification) {
	switch (classification) {
		case "auth-mismatch": return "Fix: run `openclaw doctor --fix`.";
		case "module-missing": return "Fix: run `openclaw doctor --fix`.";
		case "service-missing": return "Fix: run `openclaw gateway install --force`.";
		case "service-stopped": return "Fix: run `openclaw gateway restart`.";
		case "startup-blocked": return "Fix: run `openclaw gateway status --deep`.";
		case "not-listening": return "Fix: start `openclaw gateway run`, or run `openclaw gateway restart` for a managed gateway.";
		default: return;
	}
}
function logNonInteractiveOnboardingFailure(params) {
	const classification = classifyGatewayHealthFailure({
		detail: params.detail,
		diagnostics: params.diagnostics
	});
	const recoveryHint = recoveryHintForGatewayHealthFailure(classification);
	const hints = [...recoveryHint ? [recoveryHint] : [], ...params.hints?.filter(Boolean) ?? []];
	const gatewayRuntime = formatGatewayRuntimeSummary(params.diagnostics);
	if (params.opts.json) {
		writeRuntimeJson(params.runtime, {
			ok: false,
			mode: params.mode,
			phase: params.phase,
			message: params.message,
			classification,
			detail: params.detail,
			gateway: params.gateway,
			installDaemon: Boolean(params.installDaemon),
			daemonInstall: params.daemonInstall,
			daemonRuntime: params.daemonRuntime,
			diagnostics: params.diagnostics,
			hints: hints.length > 0 ? hints : void 0
		});
		return;
	}
	const lines = [
		params.message,
		classification ? `Classification: ${classification}` : void 0,
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
		runtime.error("Invalid --node-manager. Use \"npm\", \"pnpm\", or \"bun\".");
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
function resolveNonInteractiveWorkspaceDir(params) {
	return resolveUserPath((params.opts.workspace ?? params.baseConfig.agents?.defaults?.workspace ?? params.defaultWorkspaceDir).trim());
}
//#endregion
//#region src/commands/onboard-non-interactive/local.ts
const INSTALL_DAEMON_HEALTH_DEADLINE_MS = 45e3;
const ATTACH_EXISTING_GATEWAY_HEALTH_DEADLINE_MS = 15e3;
const INSTALL_DAEMON_HEALTH_PROBE_TIMEOUT_MS = 1e4;
const WINDOWS_INSTALL_DAEMON_HEALTH_DEADLINE_MS = 9e4;
const WINDOWS_INSTALL_DAEMON_HEALTH_PROBE_TIMEOUT_MS = 15e3;
const INSTALL_DAEMON_HEALTH_COMMAND_TIMEOUT_MS = 1e4;
const WINDOWS_INSTALL_DAEMON_HEALTH_COMMAND_TIMEOUT_MS = 9e4;
function resolveInstallDaemonGatewayHealthTiming(platform = process.platform) {
	if (platform === "win32") return {
		deadlineMs: WINDOWS_INSTALL_DAEMON_HEALTH_DEADLINE_MS,
		probeTimeoutMs: WINDOWS_INSTALL_DAEMON_HEALTH_PROBE_TIMEOUT_MS,
		healthCommandTimeoutMs: WINDOWS_INSTALL_DAEMON_HEALTH_COMMAND_TIMEOUT_MS
	};
	return {
		deadlineMs: INSTALL_DAEMON_HEALTH_DEADLINE_MS,
		probeTimeoutMs: INSTALL_DAEMON_HEALTH_PROBE_TIMEOUT_MS,
		healthCommandTimeoutMs: INSTALL_DAEMON_HEALTH_COMMAND_TIMEOUT_MS
	};
}
async function collectGatewayHealthFailureDiagnostics() {
	const diagnostics = {};
	try {
		const { resolveGatewayService } = await import("./service-BSFqO6fQ.js");
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
		const { readLastGatewayErrorLine } = await import("./diagnostics-BkwV7mrx.js");
		diagnostics.lastGatewayError = await readLastGatewayErrorLine(process.env) ?? void 0;
	} catch (err) {
		diagnostics.inspectError = diagnostics.inspectError ? `${diagnostics.inspectError}; log diagnostics failed: ${String(err)}` : `log diagnostics failed: ${String(err)}`;
	}
	return diagnostics.service || diagnostics.lastGatewayError || diagnostics.inspectError ? diagnostics : void 0;
}
async function resolveGatewayHealthProbeToken(nextConfig) {
	if (nextConfig.gateway?.auth?.mode === "password") {
		const resolved = await resolveConfiguredSecretInputString({
			config: nextConfig,
			env: process.env,
			value: nextConfig.gateway.auth.password,
			path: "gateway.auth.password",
			unresolvedReasonStyle: "detailed"
		});
		return {
			password: resolved.value,
			unresolvedRefReason: resolved.unresolvedRefReason
		};
	}
	const resolved = await resolveGatewayAuthToken({
		cfg: nextConfig,
		env: process.env,
		envFallback: "no-secret-ref",
		unresolvedReasonStyle: "detailed"
	});
	const probeAuth = {};
	if (resolved.token) probeAuth.token = resolved.token;
	if (resolved.unresolvedRefReason) probeAuth.unresolvedRefReason = resolved.unresolvedRefReason;
	return probeAuth;
}
function formatGatewayHealthFailureDetail(params) {
	return [params.probeDetail, params.unresolvedRefReason].filter(Boolean).join("\n") || void 0;
}
async function runNonInteractiveLocalSetup(params) {
	const { opts, runtime, baseConfig, baseHash } = params;
	const mode = "local";
	const workspaceDir = resolveNonInteractiveWorkspaceDir({
		opts,
		baseConfig,
		defaultWorkspaceDir: DEFAULT_WORKSPACE
	});
	let nextConfig = applyLocalSetupWorkspaceConfig(baseConfig, workspaceDir);
	if (opts.skipBootstrap) nextConfig = applySkipBootstrapConfig(nextConfig);
	const inferredAuthChoice = opts.authChoice ? void 0 : (await import("./auth-choice-inference-DReDQsYo.js")).inferAuthChoiceFromFlags(opts, {
		config: nextConfig,
		workspaceDir,
		env: process.env
	});
	if (!opts.authChoice && inferredAuthChoice && inferredAuthChoice.matches.length > 1) {
		runtime.error([
			"Multiple API key flags were provided for non-interactive setup.",
			"Use a single provider flag or pass --auth-choice explicitly.",
			`Flags: ${inferredAuthChoice.matches.map((match) => match.label).join(", ")}`
		].join("\n"));
		runtime.exit(1);
		return;
	}
	const authChoice = opts.authChoice ?? inferredAuthChoice?.choice ?? "skip";
	if (authChoice !== "skip") {
		const { applyNonInteractiveAuthChoice } = await import("./auth-choice-Cj_mRsnP.js");
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
	await replaceConfigFile({
		nextConfig,
		...baseHash !== void 0 ? { baseHash } : {},
		writeOptions: { allowConfigSizeDrop: true }
	});
	logConfigUpdated(runtime);
	await ensureWorkspaceAndSessions(workspaceDir, runtime, {
		skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
		skipOptionalBootstrapFiles: nextConfig.agents?.defaults?.skipOptionalBootstrapFiles
	});
	const daemonRuntimeRaw = opts.daemonRuntime ?? "node";
	let daemonInstallStatus;
	if (opts.installDaemon) {
		const { installGatewayDaemonNonInteractive } = await import("./daemon-install-CIPOWP4N.js");
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
		const { healthCommand } = await import("./health-Ihdx28c0.js");
		const links = resolveControlUiLinks({
			bind: gatewayResult.bind,
			port: gatewayResult.port,
			customBindHost: nextConfig.gateway?.customBindHost,
			basePath: void 0,
			tlsEnabled: nextConfig.gateway?.tls?.enabled === true
		});
		const installDaemonGatewayHealthTiming = resolveInstallDaemonGatewayHealthTiming();
		const probeAuth = await resolveGatewayHealthProbeToken(nextConfig);
		const probe = await waitForGatewayReachable({
			url: links.wsUrl,
			token: probeAuth.token,
			password: probeAuth.password,
			deadlineMs: opts.installDaemon ? installDaemonGatewayHealthTiming.deadlineMs : ATTACH_EXISTING_GATEWAY_HEALTH_DEADLINE_MS,
			probeTimeoutMs: opts.installDaemon ? installDaemonGatewayHealthTiming.probeTimeoutMs : void 0
		});
		if (!probe.ok) {
			const detail = formatGatewayHealthFailureDetail({
				probeDetail: probe.detail,
				unresolvedRefReason: probeAuth.unresolvedRefReason
			});
			const diagnostics = opts.installDaemon ? await collectGatewayHealthFailureDiagnostics() : void 0;
			logNonInteractiveOnboardingFailure({
				opts,
				runtime,
				mode,
				phase: "gateway-health",
				message: `Gateway did not become reachable at ${links.wsUrl}.`,
				detail,
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
			timeoutMs: opts.installDaemon ? installDaemonGatewayHealthTiming.healthCommandTimeoutMs : 1e4,
			config: nextConfig,
			token: probeAuth.token,
			password: probeAuth.password
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
	const { opts, runtime, baseConfig, baseHash } = params;
	const mode = "remote";
	const remoteUrl = normalizeOptionalString(opts.remoteUrl);
	if (!remoteUrl) {
		runtime.error(`Missing --remote-url for remote mode. Example: ${formatCliCommand("openclaw onboard --non-interactive --mode remote --remote-url ws://127.0.0.1:3000")}.`);
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
				token: normalizeOptionalString(opts.remoteToken)
			}
		}
	};
	if (opts.skipBootstrap) nextConfig = applySkipBootstrapConfig(nextConfig);
	nextConfig = applyWizardMetadata(nextConfig, {
		command: "onboard",
		mode
	});
	await replaceConfigFile({
		nextConfig,
		...baseHash !== void 0 ? { baseHash } : {},
		writeOptions: { allowConfigSizeDrop: true }
	});
	logConfigUpdated(runtime);
	const payload = {
		mode,
		remoteUrl,
		auth: opts.remoteToken ? "token" : "none"
	};
	if (opts.json) writeRuntimeJson(runtime, payload);
	else {
		runtime.log(`Remote gateway: ${remoteUrl}`);
		runtime.log(`Auth: ${payload.auth}`);
		runtime.log(`Tip: run \`${formatCliCommand("openclaw configure --section web")}\` to store your Brave API key for web_search. Docs: https://docs.openclaw.ai/tools/web`);
	}
}
//#endregion
//#region src/commands/onboard-non-interactive.ts
async function runNonInteractiveMigrationImport(params) {
	const providerId = params.opts.importFrom?.trim();
	if (!providerId) {
		params.runtime.error(`--import-from is required for non-interactive migration import. Run ${formatCliCommand("openclaw migrate list")} to choose a provider.`);
		params.runtime.exit(1);
		return;
	}
	const { detectSetupMigrationSources, runSetupMigrationImport } = await import("./setup.migration-import-Dieil7zd.js");
	const detections = await detectSetupMigrationSources({
		config: params.baseConfig,
		runtime: params.runtime
	});
	await runSetupMigrationImport({
		opts: {
			...params.opts,
			importFrom: providerId,
			nonInteractive: true
		},
		baseConfig: params.baseConfig,
		detections,
		prompter: createNonInteractiveLoggingPrompter(params.runtime, (message) => `Non-interactive migration import needs explicit flags before prompting: ${message}`),
		runtime: params.runtime,
		async commitConfigFile(config) {
			await replaceConfigFile({
				nextConfig: config,
				...params.baseHash !== void 0 ? { baseHash: params.baseHash } : {},
				writeOptions: { allowConfigSizeDrop: true }
			});
			logConfigUpdated(params.runtime);
			return config;
		}
	});
}
async function runNonInteractiveSetup(opts, runtime = defaultRuntime) {
	const snapshot = await readConfigFileSnapshot();
	if (snapshot.exists && !snapshot.valid) {
		runtime.error(`Config invalid. Run \`${formatCliCommand("openclaw doctor")}\` to repair it, then re-run setup.`);
		runtime.exit(1);
		return;
	}
	const baseConfig = snapshot.valid ? snapshot.exists ? snapshot.sourceConfig ?? snapshot.config : {} : {};
	const mode = opts.mode ?? "local";
	if (mode !== "local" && mode !== "remote") {
		runtime.error(`Invalid --mode "${String(mode)}". Use "local" or "remote", or run ${formatCliCommand("openclaw onboard")} for interactive setup.`);
		runtime.exit(1);
		return;
	}
	if (opts.importFrom || opts.importSource || opts.importSecrets || opts.flow === "import") {
		await runNonInteractiveMigrationImport({
			opts,
			runtime,
			baseConfig,
			baseHash: snapshot.hash
		});
		return;
	}
	if (mode === "remote") {
		await runNonInteractiveRemoteSetup({
			opts,
			runtime,
			baseConfig,
			baseHash: snapshot.hash
		});
		return;
	}
	await runNonInteractiveLocalSetup({
		opts,
		runtime,
		baseConfig,
		baseHash: snapshot.hash
	});
}
//#endregion
//#region src/commands/onboard.ts
const VALID_RESET_SCOPES = new Set([
	"config",
	"config+creds+sessions",
	"full"
]);
async function setupWizardCommand(opts, runtime = defaultRuntime) {
	assertSupportedRuntime(runtime);
	const originalAuthChoice = opts.authChoice;
	const normalizedAuthChoice = normalizeLegacyOnboardAuthChoice(originalAuthChoice, { env: process.env });
	if (opts.nonInteractive && isDeprecatedAuthChoice(originalAuthChoice, { env: process.env })) {
		runtime.error(formatDeprecatedNonInteractiveAuthChoiceError(originalAuthChoice, { env: process.env }));
		runtime.exit(1);
		return;
	}
	if (isDeprecatedAuthChoice(originalAuthChoice, { env: process.env })) runtime.log(resolveDeprecatedAuthChoiceReplacement(originalAuthChoice, { env: process.env }).message);
	const flow = opts.flow === "manual" ? "advanced" : opts.flow;
	const normalizedOpts = normalizedAuthChoice === opts.authChoice && flow === opts.flow ? opts : {
		...opts,
		authChoice: normalizedAuthChoice,
		flow
	};
	if (normalizedOpts.secretInputMode && normalizedOpts.secretInputMode !== "plaintext" && normalizedOpts.secretInputMode !== "ref") {
		runtime.error(`Invalid --secret-input-mode. Use "plaintext" or "ref", or run ${formatCliCommand("openclaw onboard")} for the interactive setup.`);
		runtime.exit(1);
		return;
	}
	if (normalizedOpts.resetScope && !VALID_RESET_SCOPES.has(normalizedOpts.resetScope)) {
		runtime.error(`Invalid --reset-scope. Use "config", "config+creds+sessions", or "full". Run ${formatCliCommand("openclaw onboard --reset --reset-scope config")} for a config-only reset.`);
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
		const baseConfig = snapshot.valid ? snapshot.sourceConfig ?? snapshot.config : {};
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
export { setupWizardCommand };
