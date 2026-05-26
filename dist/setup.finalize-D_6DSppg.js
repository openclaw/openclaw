import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import { n as resolveCliName } from "./cli-name-DBD8zPGg.js";
import { t as formatCliCommand } from "./command-format-OwPqnbXG.js";
import { t as restoreTerminalState } from "./restore-Bf3iQQZN.js";
import { t as attachChildProcessBridge } from "./child-process-bridge-F26FvTxb.js";
import { p as resolveUserPath, u as pathExists } from "./utils-CKsuXgDI.js";
import { n as buildGatewayInstallPlan, r as gatewayInstallErrorHint } from "./auth-install-policy-QSWBj93K.js";
import { a as isSystemdUserServiceAvailable } from "./systemd-BK-AEF9X.js";
import { n as GATEWAY_DAEMON_RUNTIME_OPTIONS, t as DEFAULT_GATEWAY_DAEMON_RUNTIME } from "./daemon-runtime-6GBG3wLv.js";
import { t as resolveGatewayInstallToken } from "./gateway-install-token-BmVmPwwQ.js";
import { i as resolveGatewayService, t as describeGatewayServiceRestart } from "./service-ZFeJibwt.js";
import { t as resolveControlUiLinks } from "./control-ui-links-Dmhd3Har.js";
import { n as DEFAULT_BOOTSTRAP_FILENAME } from "./workspace-BNTZ_9-b.js";
import { t as describeCodexNativeWebSearch } from "./codex-native-web-search.shared-C3S6VOBC.js";
import { n as listConfiguredWebSearchProviders } from "./runtime-DXf4_m8K.js";
import { i as installCompletion } from "./completion-runtime-BIti1TdT.js";
import { n as openUrl, t as detectBrowserOpenSupport } from "./browser-open-Cc87s-qT.js";
import { i as formatControlUiSshHint, m as waitForGatewayReachable, u as probeGatewayReachable } from "./onboard-helpers-D5MK7ND9.js";
import { t as ensureControlUiAssetsBuilt } from "./control-ui-assets-vj1J24Md.js";
import { t as resolveSetupSecretInputString } from "./setup.secret-input-BE7C__Z7.js";
import { n as formatHealthCheckFailure } from "./health-format-BEoD1xTo.js";
import { n as healthCommand } from "./health-IaeWgo39.js";
import { r as ensureCompletionCacheExists, t as checkShellCompletionStatus } from "./doctor-completion-DXYNasnV.js";
import { n as TUI_SETUP_AUTH_SOURCE_ENV, t as TUI_SETUP_AUTH_SOURCE_CONFIG } from "./setup-launch-env-fM3JXYPL.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { spawn } from "node:child_process";
//#region src/tui/tui-launch.ts
function appendOption(args, flag, value) {
	if (value === void 0) return;
	args.push(flag, String(value));
}
function filterTuiExecArgv(execArgv) {
	const filtered = [];
	for (let index = 0; index < execArgv.length; index += 1) {
		const arg = execArgv[index] ?? "";
		if (arg === "--inspect" || arg.startsWith("--inspect=") || arg === "--inspect-brk" || arg.startsWith("--inspect-brk=") || arg === "--inspect-wait" || arg.startsWith("--inspect-wait=")) {
			const next = execArgv[index + 1];
			if (!arg.includes("=") && typeof next === "string" && !next.startsWith("-")) index += 1;
			continue;
		}
		if (arg === "--inspect-port") {
			const next = execArgv[index + 1];
			if (typeof next === "string" && !next.startsWith("-")) index += 1;
			continue;
		}
		if (arg.startsWith("--inspect-port=")) continue;
		filtered.push(arg);
	}
	return filtered;
}
function buildCurrentCliEntryArgs() {
	const entry = process.argv[1]?.trim();
	if (!entry) throw new Error("unable to relaunch TUI: current CLI entry path is unavailable");
	return path.isAbsolute(entry) ? [entry] : [];
}
function buildTuiCliArgs(opts) {
	const args = [
		...filterTuiExecArgv(process.execArgv),
		...buildCurrentCliEntryArgs(),
		"tui"
	];
	if (opts.local) args.push("--local");
	appendOption(args, "--url", opts.url);
	appendOption(args, "--token", opts.token);
	appendOption(args, "--password", opts.password);
	appendOption(args, "--session", opts.session);
	appendOption(args, "--thinking", opts.thinking);
	appendOption(args, "--message", opts.message);
	appendOption(args, "--timeout-ms", opts.timeoutMs);
	appendOption(args, "--history-limit", opts.historyLimit);
	if (opts.deliver) args.push("--deliver");
	return args;
}
async function launchTuiCli(opts, launchOptions = {}) {
	const args = buildTuiCliArgs(opts);
	const env = launchOptions.gatewayUrl || launchOptions.authSource ? {
		...process.env,
		...launchOptions.gatewayUrl ? { OPENCLAW_GATEWAY_URL: launchOptions.gatewayUrl } : {},
		...launchOptions.authSource === "config" ? { [TUI_SETUP_AUTH_SOURCE_ENV]: TUI_SETUP_AUTH_SOURCE_CONFIG } : {}
	} : process.env;
	const stdinWasPaused = typeof process.stdin.isPaused === "function" ? process.stdin.isPaused() : false;
	process.stdin.pause();
	await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, args, {
			stdio: "inherit",
			env
		});
		const { detach } = attachChildProcessBridge(child);
		child.once("error", (error) => {
			detach();
			reject(/* @__PURE__ */ new Error(`failed to launch TUI: ${formatErrorMessage(error)}`));
		});
		child.once("exit", (code, signal) => {
			detach();
			if (signal) {
				reject(/* @__PURE__ */ new Error(`TUI exited from signal ${signal}`));
				return;
			}
			if ((code ?? 0) !== 0) {
				reject(/* @__PURE__ */ new Error(`TUI exited with code ${code ?? 1}`));
				return;
			}
			resolve();
		});
	}).finally(() => {
		if (!stdinWasPaused) process.stdin.resume();
	});
}
//#endregion
//#region src/wizard/setup.completion.ts
async function resolveProfileHint(shell) {
	const home = process.env.HOME || os.homedir();
	if (shell === "zsh") return "~/.zshrc";
	if (shell === "bash") return await pathExists(path.join(home, ".bashrc")) ? "~/.bashrc" : "~/.bash_profile";
	if (shell === "fish") return "~/.config/fish/config.fish";
	return "$PROFILE";
}
function formatReloadHint(shell, profileHint) {
	if (shell === "powershell") return "Restart your shell (or reload your PowerShell profile).";
	return `Restart your shell or run: source ${profileHint}`;
}
async function setupWizardShellCompletion(params) {
	const deps = {
		resolveCliName,
		checkShellCompletionStatus,
		ensureCompletionCacheExists,
		installCompletion,
		...params.deps
	};
	const cliName = deps.resolveCliName();
	const completionStatus = await deps.checkShellCompletionStatus(cliName);
	if (completionStatus.usesSlowPattern) {
		if (await deps.ensureCompletionCacheExists(cliName)) await deps.installCompletion(completionStatus.shell, true, cliName);
		return;
	}
	if (completionStatus.profileInstalled && !completionStatus.cacheExists) {
		await deps.ensureCompletionCacheExists(cliName);
		return;
	}
	if (!completionStatus.profileInstalled) {
		if (!(params.flow === "quickstart" ? true : await params.prompter.confirm({
			message: `Enable ${completionStatus.shell} shell completion for ${cliName}?`,
			initialValue: true
		}))) return;
		if (!await deps.ensureCompletionCacheExists(cliName)) {
			await params.prompter.note(`Failed to generate completion cache. Run \`${cliName} completion --install\` later.`, "Shell completion");
			return;
		}
		await deps.installCompletion(completionStatus.shell, true, cliName);
		const profileHint = await resolveProfileHint(completionStatus.shell);
		await params.prompter.note(`Shell completion installed. ${formatReloadHint(completionStatus.shell, profileHint)}`, "Shell completion");
	}
}
//#endregion
//#region src/wizard/setup.finalize.ts
let onboardSearchModulePromise;
const HATCH_TUI_TIMEOUT_MS = 300 * 1e3;
function loadOnboardSearchModule() {
	onboardSearchModulePromise ??= import("./onboard-search-Co6_AoKn.js");
	return onboardSearchModulePromise;
}
async function finalizeSetupWizard(options) {
	const { flow, opts, baseConfig, nextConfig, settings, prompter, runtime } = options;
	let gatewayProbe = { ok: true };
	let resolvedGatewayPassword = "";
	const withWizardProgress = async (label, options, work) => {
		const progress = prompter.progress(label);
		try {
			return await work(progress);
		} finally {
			progress.stop(typeof options.doneMessage === "function" ? options.doneMessage() : options.doneMessage);
		}
	};
	const systemdAvailable = process.platform === "linux" ? await isSystemdUserServiceAvailable() : true;
	if (process.platform === "linux" && !systemdAvailable) await prompter.note("Systemd user services are unavailable. Skipping lingering checks and service install.", "Systemd");
	if (process.platform === "linux" && systemdAvailable) {
		const { ensureSystemdUserLingerInteractive } = await import("./systemd-linger-wNfr--fO.js");
		await ensureSystemdUserLingerInteractive({
			runtime,
			prompter: {
				confirm: prompter.confirm,
				note: prompter.note
			},
			reason: "Linux installs use a systemd user service by default. Without lingering, systemd stops the user session on logout/idle and kills the Gateway.",
			requireConfirm: false
		});
	}
	const explicitInstallDaemon = typeof opts.installDaemon === "boolean" ? opts.installDaemon : void 0;
	let installDaemon;
	if (explicitInstallDaemon !== void 0) installDaemon = explicitInstallDaemon;
	else if (process.platform === "linux" && !systemdAvailable) installDaemon = false;
	else if (flow === "quickstart") installDaemon = true;
	else installDaemon = await prompter.confirm({
		message: "Install Gateway service (recommended)",
		initialValue: true
	});
	if (process.platform === "linux" && !systemdAvailable && installDaemon) {
		await prompter.note("Systemd user services are unavailable; skipping service install. Use your container supervisor or `docker compose up -d`.", "Gateway service");
		installDaemon = false;
	}
	if (installDaemon) {
		const daemonRuntime = flow === "quickstart" ? DEFAULT_GATEWAY_DAEMON_RUNTIME : await prompter.select({
			message: "Gateway service runtime",
			options: GATEWAY_DAEMON_RUNTIME_OPTIONS,
			initialValue: opts.daemonRuntime ?? "node"
		});
		if (flow === "quickstart") await prompter.note("QuickStart uses Node for the Gateway service (stable + supported).", "Gateway service runtime");
		const service = resolveGatewayService();
		const loaded = await service.isLoaded({ env: process.env });
		let restartWasScheduled = false;
		if (loaded) {
			const action = await prompter.select({
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
			});
			if (action === "restart") {
				let restartDoneMessage = "Gateway service restarted.";
				await withWizardProgress("Gateway service", { doneMessage: () => restartDoneMessage }, async (progress) => {
					progress.update("Restarting Gateway service…");
					const restartStatus = describeGatewayServiceRestart("Gateway", await service.restart({
						env: process.env,
						stdout: process.stdout
					}));
					restartDoneMessage = restartStatus.progressMessage;
					restartWasScheduled = restartStatus.scheduled;
				});
			} else if (action === "reinstall") await withWizardProgress("Gateway service", { doneMessage: "Gateway service uninstalled." }, async (progress) => {
				progress.update("Uninstalling Gateway service…");
				await service.uninstall({
					env: process.env,
					stdout: process.stdout
				});
			});
		}
		if (!loaded || !restartWasScheduled && loaded && !await service.isLoaded({ env: process.env })) {
			const progress = prompter.progress("Gateway service");
			let installError = null;
			try {
				progress.update("Preparing Gateway service…");
				const tokenResolution = await resolveGatewayInstallToken({
					config: nextConfig,
					env: process.env
				});
				for (const warning of tokenResolution.warnings) await prompter.note(warning, "Gateway service");
				if (tokenResolution.unavailableReason) installError = [
					"Gateway install blocked:",
					tokenResolution.unavailableReason,
					"Fix gateway auth config/token input and rerun setup."
				].join(" ");
				else {
					const { programArguments, workingDirectory, environment } = await buildGatewayInstallPlan({
						env: process.env,
						port: settings.port,
						runtime: daemonRuntime,
						warn: (message, title) => prompter.note(message, title),
						config: nextConfig
					});
					progress.update("Installing Gateway service…");
					await service.install({
						env: process.env,
						stdout: process.stdout,
						programArguments,
						workingDirectory,
						environment
					});
				}
			} catch (err) {
				installError = formatErrorMessage(err);
			} finally {
				progress.stop(installError ? "Gateway service install failed." : "Gateway service installed.");
			}
			if (installError) {
				await prompter.note(`Gateway service install failed: ${installError}`, "Gateway");
				await prompter.note(gatewayInstallErrorHint(), "Gateway");
			}
		}
	}
	if (settings.authMode === "password") try {
		resolvedGatewayPassword = await resolveSetupSecretInputString({
			config: nextConfig,
			value: nextConfig.gateway?.auth?.password,
			path: "gateway.auth.password",
			env: process.env
		}) ?? "";
	} catch (error) {
		await prompter.note(["Could not resolve gateway.auth.password SecretRef for setup auth.", formatErrorMessage(error)].join("\n"), "Gateway auth");
	}
	if (!opts.skipHealth) {
		const probeLinks = resolveControlUiLinks({
			bind: nextConfig.gateway?.bind ?? "loopback",
			port: settings.port,
			customBindHost: nextConfig.gateway?.customBindHost,
			basePath: void 0,
			tlsEnabled: nextConfig.gateway?.tls?.enabled === true
		});
		gatewayProbe = await waitForGatewayReachable({
			url: probeLinks.wsUrl,
			token: settings.authMode === "token" ? settings.gatewayToken : void 0,
			password: settings.authMode === "password" ? resolvedGatewayPassword : void 0,
			deadlineMs: 15e3
		});
		if (gatewayProbe.ok) try {
			await healthCommand({
				json: false,
				timeoutMs: 1e4,
				config: settings.authMode === "token" && settings.gatewayToken ? {
					...nextConfig,
					gateway: {
						...nextConfig.gateway,
						auth: {
							...nextConfig.gateway?.auth,
							mode: "token",
							token: settings.gatewayToken
						}
					}
				} : nextConfig,
				token: settings.authMode === "token" ? settings.gatewayToken : void 0,
				password: settings.authMode === "password" ? resolvedGatewayPassword : void 0
			}, runtime);
		} catch (err) {
			runtime.error(formatHealthCheckFailure(err));
			await prompter.note([
				"Docs:",
				"https://docs.openclaw.ai/gateway/health",
				"https://docs.openclaw.ai/gateway/troubleshooting"
			].join("\n"), "Health check help");
		}
		else if (installDaemon) {
			runtime.error(formatHealthCheckFailure(new Error(gatewayProbe.detail ?? `gateway did not become reachable at ${probeLinks.wsUrl}`)));
			await prompter.note([
				"Docs:",
				"https://docs.openclaw.ai/gateway/health",
				"https://docs.openclaw.ai/gateway/troubleshooting"
			].join("\n"), "Health check help");
		} else await prompter.note([
			"Gateway not detected yet.",
			"Setup was run without Gateway service install, so no background gateway is expected.",
			`Start now: ${formatCliCommand("openclaw gateway run")}`,
			`Or rerun with: ${formatCliCommand("openclaw onboard --install-daemon")}`,
			`Or skip this probe next time: ${formatCliCommand("openclaw onboard --skip-health")}`
		].join("\n"), "Gateway");
	}
	const controlUiEnabled = nextConfig.gateway?.controlUi?.enabled ?? baseConfig.gateway?.controlUi?.enabled ?? true;
	if (!opts.skipUi && controlUiEnabled) {
		const controlUiAssets = await ensureControlUiAssetsBuilt(runtime);
		if (!controlUiAssets.ok && controlUiAssets.message) runtime.error(controlUiAssets.message);
	}
	await prompter.note([
		"Add nodes for extra features:",
		"- macOS app (system + notifications)",
		"- iOS app (camera/canvas)",
		"- Android app (camera/canvas)"
	].join("\n"), "Optional apps");
	const controlUiBasePath = nextConfig.gateway?.controlUi?.basePath ?? baseConfig.gateway?.controlUi?.basePath;
	const links = resolveControlUiLinks({
		bind: settings.bind,
		port: settings.port,
		customBindHost: settings.customBindHost,
		basePath: controlUiBasePath,
		tlsEnabled: nextConfig.gateway?.tls?.enabled === true
	});
	const authedUrl = settings.authMode === "token" && settings.gatewayToken ? `${links.httpUrl}#token=${encodeURIComponent(settings.gatewayToken)}` : links.httpUrl;
	if (opts.skipHealth || !gatewayProbe.ok) gatewayProbe = await probeGatewayReachable({
		url: links.wsUrl,
		token: settings.authMode === "token" ? settings.gatewayToken : void 0,
		password: settings.authMode === "password" ? resolvedGatewayPassword : ""
	});
	const gatewayStatusLine = gatewayProbe.ok ? "Gateway: reachable" : `Gateway: not detected${gatewayProbe.detail ? ` (${gatewayProbe.detail})` : ""}`;
	const bootstrapPath = path.join(resolveUserPath(options.workspaceDir), DEFAULT_BOOTSTRAP_FILENAME);
	const hasBootstrap = await fs.access(bootstrapPath).then(() => true).catch(() => false);
	await prompter.note([
		`Web UI: ${links.httpUrl}`,
		settings.authMode === "token" && settings.gatewayToken ? `Web UI (with token): ${authedUrl}` : void 0,
		`Gateway WS: ${links.wsUrl}`,
		gatewayStatusLine,
		"Docs: https://docs.openclaw.ai/web/control-ui"
	].filter(Boolean).join("\n"), "Control UI");
	let controlUiOpened = false;
	let controlUiOpenHint;
	let hatchChoice = null;
	let launchedTui = false;
	if (!opts.skipUi) {
		if (hasBootstrap) await prompter.note([
			"Your workspace is ready.",
			"The first Terminal chat run will send: \"Wake up, my friend!\"",
			"Edit BOOTSTRAP.md later to change how the agent introduces itself."
		].join("\n"), "Hatch your agent");
		if (gatewayProbe.ok) await prompter.note([
			"Gateway token: shared auth for the Gateway + Control UI.",
			"Stored in: $OPENCLAW_CONFIG_PATH (default: ~/.openclaw/openclaw.json) under gateway.auth.token, or in OPENCLAW_GATEWAY_TOKEN.",
			`View token: ${formatCliCommand("openclaw config get gateway.auth.token")}`,
			`Generate token: ${formatCliCommand("openclaw doctor --generate-gateway-token")}`,
			"Web UI keeps dashboard URL tokens in memory for the current tab and strips them from the URL after load.",
			`Open the dashboard anytime: ${formatCliCommand("openclaw dashboard --no-open")}`,
			"If prompted: paste the token into Control UI settings (or use the tokenized dashboard URL)."
		].join("\n"), "Token");
		const hatchOptions = [
			{
				value: "tui",
				label: "Hatch in Terminal (recommended)"
			},
			...gatewayProbe.ok ? [{
				value: "web",
				label: "Hatch in Browser"
			}] : [],
			{
				value: "later",
				label: "Hatch later"
			}
		];
		hatchChoice = await prompter.select({
			message: "How do you want to hatch your agent?",
			options: hatchOptions,
			initialValue: "tui"
		});
		if (hatchChoice === "tui") {
			restoreTerminalState("pre-setup tui", { resumeStdinIfPaused: true });
			try {
				await launchTuiCli({
					local: true,
					deliver: false,
					message: hasBootstrap ? "Wake up, my friend!" : void 0,
					timeoutMs: HATCH_TUI_TIMEOUT_MS
				});
			} finally {
				restoreTerminalState("post-setup tui", { resumeStdinIfPaused: true });
			}
			launchedTui = true;
		} else if (hatchChoice === "web") {
			if ((await detectBrowserOpenSupport()).ok) {
				controlUiOpened = await openUrl(authedUrl);
				if (!controlUiOpened) controlUiOpenHint = formatControlUiSshHint({
					port: settings.port,
					basePath: controlUiBasePath,
					token: settings.authMode === "token" ? settings.gatewayToken : void 0
				});
			} else controlUiOpenHint = formatControlUiSshHint({
				port: settings.port,
				basePath: controlUiBasePath,
				token: settings.authMode === "token" ? settings.gatewayToken : void 0
			});
			await prompter.note([
				`Dashboard link (with token): ${authedUrl}`,
				controlUiOpened ? "Opened in your browser. Keep that tab to control OpenClaw." : "Copy/paste this URL in a browser on this machine to control OpenClaw.",
				controlUiOpenHint
			].filter(Boolean).join("\n"), "Dashboard ready");
		} else await prompter.note(`When you're ready: ${formatCliCommand("openclaw dashboard --no-open")}`, "Later");
	} else if (opts.skipUi) await prompter.note("Skipping Control UI/TUI prompts.", "Control UI");
	await prompter.note(["Back up your agent workspace.", "Docs: https://docs.openclaw.ai/concepts/agent-workspace"].join("\n"), "Workspace backup");
	await prompter.note("Running agents on your computer is risky — harden your setup: https://docs.openclaw.ai/security", "Security");
	await setupWizardShellCompletion({
		flow,
		prompter
	});
	if (!opts.skipUi && gatewayProbe.ok && settings.authMode === "token" && Boolean(settings.gatewayToken) && hatchChoice === null) {
		if ((await detectBrowserOpenSupport()).ok) {
			controlUiOpened = await openUrl(authedUrl);
			if (!controlUiOpened) controlUiOpenHint = formatControlUiSshHint({
				port: settings.port,
				basePath: controlUiBasePath,
				token: settings.gatewayToken
			});
		} else controlUiOpenHint = formatControlUiSshHint({
			port: settings.port,
			basePath: controlUiBasePath,
			token: settings.gatewayToken
		});
		await prompter.note([
			`Dashboard link (with token): ${authedUrl}`,
			controlUiOpened ? "Opened in your browser. Keep that tab to control OpenClaw." : "Copy/paste this URL in a browser on this machine to control OpenClaw.",
			controlUiOpenHint
		].filter(Boolean).join("\n"), "Dashboard ready");
	}
	const codexNativeSummary = describeCodexNativeWebSearch(nextConfig);
	const webSearchProvider = nextConfig.tools?.web?.search?.provider;
	const webSearchEnabled = nextConfig.tools?.web?.search?.enabled;
	const configuredSearchProviders = listConfiguredWebSearchProviders({ config: nextConfig });
	if (webSearchProvider) {
		const { resolveExistingKey, hasExistingKey, hasKeyInEnv } = await loadOnboardSearchModule();
		const entry = configuredSearchProviders.find((e) => e.id === webSearchProvider);
		const label = entry?.label ?? webSearchProvider;
		const storedKey = entry ? resolveExistingKey(nextConfig, webSearchProvider) : void 0;
		const keyConfigured = entry ? hasExistingKey(nextConfig, webSearchProvider) : false;
		const envAvailable = entry ? hasKeyInEnv(entry) : false;
		const hasKey = keyConfigured || envAvailable;
		const keySource = storedKey ? "API key: stored in config." : keyConfigured ? "API key: configured via secret reference." : envAvailable ? `API key: provided via ${entry?.envVars.join(" / ")} env var.` : void 0;
		if (!entry) await prompter.note([
			`Web search provider ${label} is selected but unavailable under the current plugin policy.`,
			"web_search will not work until the provider is re-enabled or a different provider is selected.",
			`  ${formatCliCommand("openclaw configure --section web")}`,
			"",
			"Docs: https://docs.openclaw.ai/tools/web"
		].join("\n"), "Web search");
		else if (webSearchEnabled !== false && hasKey) await prompter.note([
			"Web search is enabled, so your agent can look things up online when needed.",
			"",
			`Provider: ${label}`,
			...keySource ? [keySource] : [],
			"Docs: https://docs.openclaw.ai/tools/web"
		].join("\n"), "Web search");
		else if (!hasKey) await prompter.note([
			`Provider ${label} is selected but no API key was found.`,
			"web_search will not work until a key is added.",
			`  ${formatCliCommand("openclaw configure --section web")}`,
			"",
			`Get your key at: ${entry?.signupUrl ?? "https://docs.openclaw.ai/tools/web"}`,
			"Docs: https://docs.openclaw.ai/tools/web"
		].join("\n"), "Web search");
		else await prompter.note([
			`Web search (${label}) is configured but disabled.`,
			`Re-enable: ${formatCliCommand("openclaw configure --section web")}`,
			"",
			"Docs: https://docs.openclaw.ai/tools/web"
		].join("\n"), "Web search");
	} else {
		const { hasExistingKey, hasKeyInEnv } = await loadOnboardSearchModule();
		const legacyDetected = configuredSearchProviders.find((e) => hasExistingKey(nextConfig, e.id) || hasKeyInEnv(e));
		if (legacyDetected) await prompter.note([`Web search is available via ${legacyDetected.label} (auto-detected).`, "Docs: https://docs.openclaw.ai/tools/web"].join("\n"), "Web search");
		else if (codexNativeSummary) await prompter.note([
			"Managed web search provider was skipped.",
			codexNativeSummary,
			"Docs: https://docs.openclaw.ai/tools/web"
		].join("\n"), "Web search");
		else await prompter.note([
			"Web search was skipped. You can enable it later:",
			`  ${formatCliCommand("openclaw configure --section web")}`,
			"",
			"Docs: https://docs.openclaw.ai/tools/web"
		].join("\n"), "Web search");
	}
	if (codexNativeSummary) await prompter.note([
		codexNativeSummary,
		"Used only for Codex-capable models.",
		"Docs: https://docs.openclaw.ai/tools/web"
	].join("\n"), "Codex native search");
	await prompter.note("What now: https://openclaw.ai/showcase (\"What People Are Building\").", "What now");
	await prompter.outro(controlUiOpened ? "Onboarding complete. Dashboard opened; keep that tab to control OpenClaw." : "Onboarding complete. Use the dashboard link above to control OpenClaw.");
	return { launchedTui };
}
//#endregion
export { finalizeSetupWizard };
