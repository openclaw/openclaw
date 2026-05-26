import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { n as resolveCliName } from "./cli-name-C-K1n6ar.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { t as restoreTerminalState } from "./restore-D60-WDR7.js";
import { t as attachChildProcessBridge } from "./child-process-bridge-Lz6wlGQK.js";
import { p as resolveUserPath, u as pathExists } from "./utils-sBTEdeml.js";
import { n as buildGatewayInstallPlan, r as gatewayInstallErrorHint } from "./auth-install-policy-BV9KSYis.js";
import { a as isSystemdUserServiceAvailable } from "./systemd-DsQkjgIm.js";
import { s as resolveDefaultAgentDir } from "./agent-scope-config-CMp71_27.js";
import { n as GATEWAY_DAEMON_RUNTIME_OPTIONS, t as DEFAULT_GATEWAY_DAEMON_RUNTIME } from "./daemon-runtime-C5rLdYLT.js";
import { t as resolveGatewayInstallToken } from "./gateway-install-token-D0PJZIzI.js";
import { i as resolveGatewayService, t as describeGatewayServiceRestart } from "./service-CTzdMGsq.js";
import { t as resolveControlUiLinks } from "./control-ui-links-BSo6xNaU.js";
import { n as DEFAULT_BOOTSTRAP_FILENAME } from "./workspace-DTx8zuCN.js";
import { t as describeCodexNativeWebSearch } from "./codex-native-web-search.shared-BOjjagpd.js";
import { i as hasAuthProfileForProvider } from "./model-config.helpers-6EP_rOvT.js";
import { n as listConfiguredWebSearchProviders } from "./runtime-JrxuINJZ.js";
import { n as t } from "./i18n-CWNhN747.js";
import { a as installCompletion, i as formatCompletionReloadCommand, l as resolveCompletionProfilePath } from "./completion-runtime-Bk_B9fm2.js";
import { n as openUrl, t as detectBrowserOpenSupport } from "./browser-open-BTGCmG6r.js";
import { i as formatControlUiSshHint, m as waitForGatewayReachable, u as probeGatewayReachable } from "./onboard-helpers-BaLdeEkj.js";
import { r as ensureCompletionCacheExists, t as checkShellCompletionStatus } from "./doctor-completion-Cc2OSfd4.js";
import { t as ensureControlUiAssetsBuilt } from "./control-ui-assets-W5GRTbBr.js";
import { t as resolveSetupSecretInputString } from "./setup.secret-input-CDzkHBam.js";
import { n as formatHealthCheckFailure } from "./health-format-DaSqSjzQ.js";
import { n as healthCommand } from "./health-MpLQnEZv.js";
import { n as TUI_SETUP_AUTH_SOURCE_ENV, t as TUI_SETUP_AUTH_SOURCE_CONFIG } from "./setup-launch-env-DehdAyoV.js";
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
	return resolveCompletionProfilePath("powershell");
}
function formatReloadHint(shell, profileHint) {
	if (shell === "powershell") return t("wizard.completion.reloadPowerShell", { command: formatCompletionReloadCommand("powershell", profileHint) });
	return t("wizard.completion.reloadShell", { profile: profileHint });
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
			message: t("wizard.completion.enable", {
				shell: completionStatus.shell,
				cli: cliName
			}),
			initialValue: true
		}))) return;
		if (!await deps.ensureCompletionCacheExists(cliName)) {
			await params.prompter.note(t("wizard.completion.cacheFailed", { command: `${cliName} completion --install` }), t("wizard.completion.title"));
			return;
		}
		await deps.installCompletion(completionStatus.shell, true, cliName);
		const profileHint = await resolveProfileHint(completionStatus.shell);
		await params.prompter.note(t("wizard.completion.installed", { reloadHint: formatReloadHint(completionStatus.shell, profileHint) }), t("wizard.completion.title"));
	}
}
//#endregion
//#region src/wizard/setup.finalize.ts
let onboardSearchModulePromise;
const HATCH_TUI_TIMEOUT_MS = 300 * 1e3;
function getLocalizedGatewayDaemonRuntimeOptions() {
	return GATEWAY_DAEMON_RUNTIME_OPTIONS.map((option) => ({
		hint: option.value === "node" ? t("wizard.finalize.daemonRuntimeNodeHint") : option.hint ?? void 0,
		label: option.value === "node" ? t("wizard.finalize.daemonRuntimeNode") : option.label,
		value: option.value
	}));
}
function loadOnboardSearchModule() {
	onboardSearchModulePromise ??= import("./onboard-search-DQdjHj2S.js");
	return onboardSearchModulePromise;
}
async function finalizeSetupWizard(options) {
	const { flow, opts, baseConfig, nextConfig, settings, prompter, runtime } = options;
	const suppressGatewayTokenOutput = opts.suppressGatewayTokenOutput === true;
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
	if (process.platform === "linux" && !systemdAvailable) await prompter.note(t("wizard.finalize.systemdUnavailable"), "Systemd");
	if (process.platform === "linux" && systemdAvailable) {
		const { ensureSystemdUserLingerInteractive } = await import("./systemd-linger-CEeYFUyI.js");
		await ensureSystemdUserLingerInteractive({
			runtime,
			prompter: {
				confirm: prompter.confirm,
				note: prompter.note
			},
			reason: t("wizard.finalize.systemdLingerReason"),
			requireConfirm: false
		});
	}
	const explicitInstallDaemon = typeof opts.installDaemon === "boolean" ? opts.installDaemon : void 0;
	let installDaemon;
	if (explicitInstallDaemon !== void 0) installDaemon = explicitInstallDaemon;
	else if (process.platform === "linux" && !systemdAvailable) installDaemon = false;
	else if (flow === "quickstart") installDaemon = true;
	else installDaemon = await prompter.confirm({
		message: t("wizard.finalize.installGateway"),
		initialValue: true
	});
	if (process.platform === "linux" && !systemdAvailable && installDaemon) {
		await prompter.note(t("wizard.finalize.systemdInstallSkipped"), t("wizard.finalize.gatewayService"));
		installDaemon = false;
	}
	if (installDaemon) {
		const daemonRuntime = flow === "quickstart" ? DEFAULT_GATEWAY_DAEMON_RUNTIME : await prompter.select({
			message: t("wizard.finalize.daemonRuntime"),
			options: getLocalizedGatewayDaemonRuntimeOptions(),
			initialValue: opts.daemonRuntime ?? "node"
		});
		if (flow === "quickstart") await prompter.note(t("wizard.finalize.quickstartNodeRuntime"), t("wizard.finalize.daemonRuntime"));
		const service = resolveGatewayService();
		const loaded = await service.isLoaded({ env: process.env });
		let restartWasScheduled = false;
		if (loaded) {
			const action = await prompter.select({
				message: t("wizard.finalize.alreadyInstalled"),
				options: [
					{
						value: "restart",
						label: t("wizard.finalize.restart")
					},
					{
						value: "reinstall",
						label: t("wizard.finalize.reinstall")
					},
					{
						value: "skip",
						label: t("common.skip")
					}
				]
			});
			if (action === "restart") {
				let restartDoneMessage = t("wizard.finalize.gatewayServiceRestarted");
				await withWizardProgress(t("wizard.finalize.gatewayService"), { doneMessage: () => restartDoneMessage }, async (progress) => {
					progress.update(t("wizard.finalize.gatewayServiceRestarting"));
					const restartStatus = describeGatewayServiceRestart("Gateway", await service.restart({
						env: process.env,
						stdout: process.stdout
					}));
					restartDoneMessage = restartStatus.scheduled ? t("wizard.finalize.gatewayServiceRestartScheduled") : t("wizard.finalize.gatewayServiceRestarted");
					restartWasScheduled = restartStatus.scheduled;
				});
			} else if (action === "reinstall") await withWizardProgress(t("wizard.finalize.gatewayService"), { doneMessage: t("wizard.finalize.gatewayServiceUninstalled") }, async (progress) => {
				progress.update(t("wizard.finalize.gatewayServiceUninstalling"));
				await service.uninstall({
					env: process.env,
					stdout: process.stdout
				});
			});
		}
		if (!loaded || !restartWasScheduled && loaded && !await service.isLoaded({ env: process.env })) {
			const progress = prompter.progress(t("wizard.finalize.gatewayService"));
			let installError = null;
			try {
				progress.update(t("wizard.finalize.gatewayServicePreparing"));
				const tokenResolution = await resolveGatewayInstallToken({
					config: nextConfig,
					env: process.env
				});
				for (const warning of tokenResolution.warnings) await prompter.note(warning, "Gateway service");
				if (tokenResolution.unavailableReason) installError = [
					t("wizard.finalize.gatewayInstallBlocked"),
					tokenResolution.unavailableReason,
					t("wizard.finalize.gatewayInstallFixAuth")
				].join(" ");
				else {
					const { programArguments, workingDirectory, environment } = await buildGatewayInstallPlan({
						env: process.env,
						port: settings.port,
						runtime: daemonRuntime,
						warn: (message, title) => prompter.note(message, title),
						config: nextConfig
					});
					progress.update(t("wizard.finalize.gatewayServiceInstalling"));
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
				progress.stop(installError ? t("wizard.finalize.gatewayServiceInstallFailed") : t("wizard.finalize.gatewayServiceInstalled"));
			}
			if (installError) {
				await prompter.note(t("wizard.finalize.gatewayServiceInstallFailedWithError", { error: installError }), "Gateway");
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
		await prompter.note([t("wizard.finalize.secretRefAuthFailed", { field: "gateway.auth.password" }), formatErrorMessage(error)].join("\n"), t("wizard.gateway.auth"));
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
				t("common.docs"),
				"https://docs.openclaw.ai/gateway/health",
				"https://docs.openclaw.ai/gateway/troubleshooting"
			].join("\n"), t("wizard.finalize.healthCheckHelp"));
		}
		else if (installDaemon) {
			runtime.error(formatHealthCheckFailure(new Error(gatewayProbe.detail ?? `gateway did not become reachable at ${probeLinks.wsUrl}`)));
			await prompter.note([
				t("common.docs"),
				"https://docs.openclaw.ai/gateway/health",
				"https://docs.openclaw.ai/gateway/troubleshooting"
			].join("\n"), t("wizard.finalize.healthCheckHelp"));
		} else await prompter.note([
			t("wizard.finalize.gatewayNotDetected"),
			t("wizard.finalize.noBackgroundGatewayExpected"),
			t("wizard.finalize.startGatewayNow", { command: formatCliCommand("openclaw gateway run") }),
			t("wizard.finalize.rerunInstallDaemon", { command: formatCliCommand("openclaw onboard --install-daemon") }),
			t("wizard.finalize.skipHealthNextTime", { command: formatCliCommand("openclaw onboard --skip-health") })
		].join("\n"), "Gateway");
	}
	const controlUiEnabled = nextConfig.gateway?.controlUi?.enabled ?? baseConfig.gateway?.controlUi?.enabled ?? true;
	if (!opts.skipUi && controlUiEnabled) {
		const controlUiAssets = await ensureControlUiAssetsBuilt(runtime);
		if (!controlUiAssets.ok && controlUiAssets.message) runtime.error(controlUiAssets.message);
	}
	await prompter.note([
		t("wizard.finalize.addNodes"),
		`- ${t("wizard.finalize.nodeMac")}`,
		`- ${t("wizard.finalize.nodeIos")}`,
		`- ${t("wizard.finalize.nodeAndroid")}`
	].join("\n"), t("wizard.finalize.optionalApps"));
	const controlUiBasePath = nextConfig.gateway?.controlUi?.basePath ?? baseConfig.gateway?.controlUi?.basePath;
	const links = resolveControlUiLinks({
		bind: settings.bind,
		port: settings.port,
		customBindHost: settings.customBindHost,
		basePath: controlUiBasePath,
		tlsEnabled: nextConfig.gateway?.tls?.enabled === true
	});
	const authedUrl = settings.authMode === "token" && settings.gatewayToken && !suppressGatewayTokenOutput ? `${links.httpUrl}#token=${encodeURIComponent(settings.gatewayToken)}` : links.httpUrl;
	if (opts.skipHealth || !gatewayProbe.ok) gatewayProbe = await probeGatewayReachable({
		url: links.wsUrl,
		token: settings.authMode === "token" ? settings.gatewayToken : void 0,
		password: settings.authMode === "password" ? resolvedGatewayPassword : ""
	});
	const gatewayStatusLine = gatewayProbe.ok ? t("wizard.finalize.gatewayReachable") : t("wizard.finalize.gatewayNotDetectedStatus", { detail: gatewayProbe.detail ? ` (${gatewayProbe.detail})` : "" });
	const bootstrapPath = path.join(resolveUserPath(options.workspaceDir), DEFAULT_BOOTSTRAP_FILENAME);
	const hasBootstrap = await fs.access(bootstrapPath).then(() => true).catch(() => false);
	await prompter.note([
		t("wizard.finalize.webUiUrl", { url: links.httpUrl }),
		settings.authMode === "token" && settings.gatewayToken && !suppressGatewayTokenOutput ? t("wizard.finalize.webUiWithTokenUrl", { url: authedUrl }) : void 0,
		t("wizard.finalize.gatewayWsUrl", { url: links.wsUrl }),
		gatewayStatusLine,
		t("wizard.finalize.controlUiDocs")
	].filter(Boolean).join("\n"), "Control UI");
	let controlUiOpened = false;
	let controlUiOpenHint;
	let hatchChoice = null;
	let launchedTui = false;
	if (!opts.skipUi) {
		if (hasBootstrap) await prompter.note([
			t("wizard.finalize.workspaceReady"),
			t("wizard.finalize.firstTerminalChat"),
			t("wizard.finalize.editBootstrap")
		].join("\n"), t("wizard.finalize.hatchYourAgent"));
		if (gatewayProbe.ok) {
			const tokenNotes = [
				t("wizard.finalize.gatewayTokenShared"),
				t("wizard.finalize.gatewayTokenStored"),
				t("wizard.finalize.gatewayTokenView", { command: formatCliCommand("openclaw config get gateway.auth.token") }),
				t("wizard.finalize.gatewayTokenGenerate", { command: formatCliCommand("openclaw doctor --generate-gateway-token") }),
				suppressGatewayTokenOutput ? void 0 : t("wizard.finalize.dashboardTokenMemory"),
				t("wizard.finalize.dashboardOpenAnytime", { command: formatCliCommand("openclaw dashboard --no-open") }),
				suppressGatewayTokenOutput ? void 0 : t("wizard.finalize.dashboardTokenPrompt")
			].filter(Boolean);
			await prompter.note(tokenNotes.join("\n"), "Token");
		}
		const hatchOptions = [
			{
				value: "tui",
				label: t("wizard.finalize.terminalHatch")
			},
			...gatewayProbe.ok ? [{
				value: "web",
				label: t("wizard.finalize.browserHatch")
			}] : [],
			{
				value: "later",
				label: t("wizard.finalize.hatchLater")
			}
		];
		hatchChoice = await prompter.select({
			message: t("wizard.finalize.hatchPrompt"),
			options: hatchOptions,
			initialValue: "tui"
		});
		if (hatchChoice === "tui") {
			restoreTerminalState("pre-setup tui", { resumeStdinIfPaused: true });
			try {
				await launchTuiCli({
					local: true,
					deliver: false,
					message: hasBootstrap ? t("wizard.finalize.bootstrapHatchMessage") : void 0,
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
					token: settings.authMode === "token" && !suppressGatewayTokenOutput ? settings.gatewayToken : void 0
				});
			} else controlUiOpenHint = formatControlUiSshHint({
				port: settings.port,
				basePath: controlUiBasePath,
				token: settings.authMode === "token" && !suppressGatewayTokenOutput ? settings.gatewayToken : void 0
			});
			await prompter.note([
				t("wizard.finalize.dashboardLinkWithToken", { url: authedUrl }),
				controlUiOpened ? t("wizard.finalize.dashboardOpened") : t("wizard.finalize.dashboardCopyPaste"),
				controlUiOpenHint
			].filter(Boolean).join("\n"), t("wizard.finalize.dashboardReady"));
		} else await prompter.note(t("wizard.finalize.dashboardWhenReady", { command: formatCliCommand("openclaw dashboard --no-open") }), t("wizard.finalize.laterTitle"));
	} else if (opts.skipUi) await prompter.note(t("wizard.finalize.skipControlUi"), t("wizard.finalize.controlUiTitle"));
	await prompter.note([t("wizard.finalize.backupWorkspace"), t("wizard.finalize.workspaceDocs")].join("\n"), t("wizard.finalize.workspaceBackupTitle"));
	await prompter.note(t("wizard.finalize.securityReminder"), t("wizard.security.title"));
	await setupWizardShellCompletion({
		flow,
		prompter
	});
	if (!opts.skipUi && gatewayProbe.ok && settings.authMode === "token" && Boolean(settings.gatewayToken) && !suppressGatewayTokenOutput && hatchChoice === null) {
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
			t("wizard.finalize.dashboardLinkWithToken", { url: authedUrl }),
			controlUiOpened ? t("wizard.finalize.dashboardOpened") : t("wizard.finalize.dashboardCopyPaste"),
			controlUiOpenHint
		].filter(Boolean).join("\n"), t("wizard.finalize.dashboardReady"));
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
		const agentDir = resolveDefaultAgentDir(nextConfig);
		const authProviderId = entry?.authProviderId?.trim();
		const authProviderLabel = authProviderId === "xai" ? "xAI" : authProviderId;
		const providerAuthProfileAvailable = authProviderId ? hasAuthProfileForProvider({
			provider: authProviderId,
			agentDir
		}) : false;
		const oauthAuthProfileAvailable = authProviderId && providerAuthProfileAvailable ? hasAuthProfileForProvider({
			provider: authProviderId,
			agentDir,
			type: "oauth"
		}) : false;
		const hasCredential = hasKey || providerAuthProfileAvailable;
		const keySource = storedKey ? t("wizard.finalize.webSearchKeyStored") : keyConfigured ? t("wizard.finalize.webSearchKeyRef") : envAvailable ? t("wizard.finalize.webSearchKeyEnv", { env: entry?.envVars.join(" / ") ?? "" }) : oauthAuthProfileAvailable && authProviderLabel ? t("wizard.finalize.webSearchOAuthProfile", { provider: authProviderLabel }) : providerAuthProfileAvailable && authProviderLabel ? t("wizard.finalize.webSearchAuthProfile", { provider: authProviderLabel }) : void 0;
		if (!entry) await prompter.note([
			t("wizard.finalize.webSearchProviderUnavailable", { provider: label }),
			t("wizard.finalize.webSearchUnavailableAction"),
			`  ${formatCliCommand("openclaw configure --section web")}`,
			"",
			t("wizard.finalize.webDocs")
		].join("\n"), t("wizard.finalize.webSearchTitle"));
		else if (webSearchEnabled !== false && hasCredential) await prompter.note([
			t("wizard.finalize.webSearchEnabled"),
			"",
			t("wizard.finalize.webSearchProvider", { provider: label }),
			...keySource ? [keySource] : [],
			t("wizard.finalize.webDocs")
		].join("\n"), t("wizard.finalize.webSearchTitle"));
		else if (!hasCredential) await prompter.note([
			t("wizard.finalize.webSearchNoKey", { provider: label }),
			t("wizard.finalize.webSearchNeedsKey"),
			`  ${formatCliCommand("openclaw configure --section web")}`,
			"",
			t("wizard.finalize.webSearchGetKey", { url: entry?.signupUrl ?? "https://docs.openclaw.ai/tools/web" }),
			t("wizard.finalize.webDocs")
		].join("\n"), t("wizard.finalize.webSearchTitle"));
		else await prompter.note([
			t("wizard.finalize.webSearchDisabled", { provider: label }),
			t("wizard.finalize.webSearchReenable", { command: formatCliCommand("openclaw configure --section web") }),
			"",
			t("wizard.finalize.webDocs")
		].join("\n"), t("wizard.finalize.webSearchTitle"));
	} else {
		const { hasExistingKey, hasKeyInEnv } = await loadOnboardSearchModule();
		const legacyDetected = configuredSearchProviders.find((e) => hasExistingKey(nextConfig, e.id) || hasKeyInEnv(e));
		if (legacyDetected) await prompter.note([t("wizard.finalize.webSearchAutoDetected", { provider: legacyDetected.label }), t("wizard.finalize.webDocs")].join("\n"), t("wizard.finalize.webSearchTitle"));
		else if (codexNativeSummary) await prompter.note([
			t("wizard.finalize.managedWebSearchSkipped"),
			codexNativeSummary,
			t("wizard.finalize.webDocs")
		].join("\n"), t("wizard.finalize.webSearchTitle"));
		else await prompter.note([
			t("wizard.finalize.webSearchSkipped"),
			`  ${formatCliCommand("openclaw configure --section web")}`,
			"",
			t("wizard.finalize.webDocs")
		].join("\n"), t("wizard.finalize.webSearchTitle"));
	}
	if (codexNativeSummary) await prompter.note([
		codexNativeSummary,
		t("wizard.finalize.codexNativeSearchOnly"),
		t("wizard.finalize.webDocs")
	].join("\n"), t("wizard.finalize.codexNativeSearchTitle"));
	await prompter.note(t("wizard.finalize.whatNow"), t("wizard.finalize.whatNowTitle"));
	await prompter.outro(controlUiOpened ? t("wizard.finalize.outroDashboardOpened") : t("wizard.finalize.outroDashboardLink"));
	return { launchedTui };
}
//#endregion
export { finalizeSetupWizard };
