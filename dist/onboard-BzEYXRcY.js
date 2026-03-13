import { m as restoreTerminalState, p as defaultRuntime } from "./subsystem-DVwhOlEq.js";
import { u as resolveGatewayPort } from "./paths-BfR2LXbA.js";
import { Dt as resolveControlUiLinks, Et as randomToken, Hg as readConfigFileSnapshot, Kg as writeConfigFile, ft as DEFAULT_WORKSPACE, gt as ensureWorkspaceAndSessions, jt as waitForGatewayReachable, pt as applyWizardMetadata, xt as normalizeGatewayTokenInput, yt as handleReset } from "./auth-profiles-CAw5gP6f.js";
import { t as formatCliCommand } from "./command-format-CO3N-oGG.js";
import { v as resolveUserPath } from "./utils-8QNki08A.js";
import { s as isValidEnvSecretRefId } from "./types.secrets-CQ90JO4F.js";
import { At as resolveDefaultSecretProviderAlias } from "./plugins-BKDaOrHv.js";
import { t as WizardCancelledError } from "./prompts-C1pw879X.js";
import { t as createClackPrompter } from "./clack-prompter-CXacm0PY.js";
import { t as assertSupportedRuntime } from "./runtime-guard-CPrdsppg.js";
import "./daemon-runtime-JtoqXmal.js";
import { t as runOnboardingWizard } from "./onboarding-CbAyEwAW.js";
import { n as logConfigUpdated } from "./logging-4N75Zj7h.js";
import { i as normalizeLegacyOnboardAuthChoice, r as isDeprecatedAuthChoice, t as ONBOARD_PROVIDER_AUTH_FLAGS } from "./onboard-provider-auth-flags-CeCwMLnT.js";
import { t as applyOnboardingLocalWorkspaceConfig } from "./onboard-config-Cc0V1FPc.js";
//#region src/commands/onboard-interactive.ts
async function runInteractiveOnboarding(opts, runtime = defaultRuntime) {
	const prompter = createClackPrompter();
	let exitCode = null;
	try {
		await runOnboardingWizard(opts, runtime, prompter);
	} catch (err) {
		if (err instanceof WizardCancelledError) {
			exitCode = 1;
			return;
		}
		throw err;
	} finally {
		restoreTerminalState("onboarding finish", { resumeStdinIfPaused: false });
		if (exitCode !== null) runtime.exit(exitCode);
	}
}
//#endregion
//#region src/commands/onboard-non-interactive/local/auth-choice-inference.ts
function hasStringValue(value) {
	return typeof value === "string" ? value.trim().length > 0 : Boolean(value);
}
function inferAuthChoiceFromFlags(opts) {
	const matches = ONBOARD_PROVIDER_AUTH_FLAGS.filter(({ optionKey }) => hasStringValue(opts[optionKey])).map((flag) => ({
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
		mode: params.mode,
		workspace: params.workspaceDir,
		authChoice: params.authChoice,
		gateway: params.gateway,
		installDaemon: Boolean(params.installDaemon),
		daemonRuntime: params.daemonRuntime,
		skipSkills: Boolean(params.skipSkills),
		skipHealth: Boolean(params.skipHealth)
	}, null, 2));
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
function resolveNonInteractiveWorkspaceDir(params) {
	return resolveUserPath((params.opts.workspace ?? params.baseConfig.agents?.defaults?.workspace ?? params.defaultWorkspaceDir).trim());
}
//#endregion
//#region src/commands/onboard-non-interactive/local.ts
async function runNonInteractiveOnboardingLocal(params) {
	const { opts, runtime, baseConfig } = params;
	const mode = "local";
	const workspaceDir = resolveNonInteractiveWorkspaceDir({
		opts,
		baseConfig,
		defaultWorkspaceDir: DEFAULT_WORKSPACE
	});
	let nextConfig = applyOnboardingLocalWorkspaceConfig(baseConfig, workspaceDir);
	const inferredAuthChoice = inferAuthChoiceFromFlags(opts);
	if (!opts.authChoice && inferredAuthChoice.matches.length > 1) {
		runtime.error([
			"Multiple API key flags were provided for non-interactive onboarding.",
			"Use a single provider flag or pass --auth-choice explicitly.",
			`Flags: ${inferredAuthChoice.matches.map((match) => match.label).join(", ")}`
		].join("\n"));
		runtime.exit(1);
		return;
	}
	const authChoice = opts.authChoice ?? inferredAuthChoice.choice ?? "skip";
	if (authChoice !== "skip") {
		const { applyNonInteractiveAuthChoice } = await import("./auth-choice-gXRVCfPC.js");
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
	if (opts.installDaemon) {
		const { installGatewayDaemonNonInteractive } = await import("./daemon-install-BvfONBeC.js");
		await installGatewayDaemonNonInteractive({
			nextConfig,
			opts,
			runtime,
			port: gatewayResult.port
		});
	}
	const daemonRuntimeRaw = opts.daemonRuntime ?? "node";
	if (!opts.skipHealth) {
		const { healthCommand } = await import("./health-Dpej8X2i.js").then((n) => n.i);
		const links = resolveControlUiLinks({
			bind: gatewayResult.bind,
			port: gatewayResult.port,
			customBindHost: nextConfig.gateway?.customBindHost,
			basePath: void 0
		});
		const probe = await waitForGatewayReachable({
			url: links.wsUrl,
			token: gatewayResult.gatewayToken,
			deadlineMs: 15e3
		});
		if (!probe.ok) {
			const message = [
				`Gateway did not become reachable at ${links.wsUrl}.`,
				probe.detail ? `Last probe: ${probe.detail}` : void 0,
				!opts.installDaemon ? [
					"Non-interactive local onboarding only waits for an already-running gateway unless you pass --install-daemon.",
					`Fix: start \`${formatCliCommand("openclaw gateway run")}\`, re-run with \`--install-daemon\`, or use \`--skip-health\`.`,
					process.platform === "win32" ? "Native Windows managed gateway install tries Scheduled Tasks first and falls back to a per-user Startup-folder login item when task creation is denied." : void 0
				].filter(Boolean).join("\n") : void 0
			].filter(Boolean).join("\n");
			runtime.error(message);
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
		daemonRuntime: opts.installDaemon ? daemonRuntimeRaw : void 0,
		skipSkills: Boolean(opts.skipSkills),
		skipHealth: Boolean(opts.skipHealth)
	});
	if (!opts.json) runtime.log(`Tip: run \`${formatCliCommand("openclaw configure --section web")}\` to store your Brave API key for web_search. Docs: https://docs.openclaw.ai/tools/web`);
}
//#endregion
//#region src/commands/onboard-non-interactive/remote.ts
async function runNonInteractiveOnboardingRemote(params) {
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
async function runNonInteractiveOnboarding(opts, runtime = defaultRuntime) {
	const snapshot = await readConfigFileSnapshot();
	if (snapshot.exists && !snapshot.valid) {
		runtime.error(`Config invalid. Run \`${formatCliCommand("openclaw doctor")}\` to repair it, then re-run onboarding.`);
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
		await runNonInteractiveOnboardingRemote({
			opts,
			runtime,
			baseConfig
		});
		return;
	}
	await runNonInteractiveOnboardingLocal({
		opts,
		runtime,
		baseConfig
	});
}
//#endregion
//#region src/commands/onboard.ts
const VALID_RESET_SCOPES = new Set([
	"config",
	"config+creds+sessions",
	"full"
]);
async function onboardCommand(opts, runtime = defaultRuntime) {
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
			"Non-interactive onboarding requires explicit risk acknowledgement.",
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
		"Windows detected — OpenClaw runs great on WSL2!",
		"Native Windows might be trickier.",
		"Quick setup: wsl --install (one command, one reboot)",
		"Guide: https://docs.openclaw.ai/windows"
	].join("\n"));
	if (normalizedOpts.nonInteractive) {
		await runNonInteractiveOnboarding(normalizedOpts, runtime);
		return;
	}
	await runInteractiveOnboarding(normalizedOpts, runtime);
}
//#endregion
export { onboardCommand as t };
