import "./redact-CPjO5IzK.js";
import "./errors-CHvVoeNX.js";
import "./unhandled-rejections-BUxLQs1F.js";
import "./globals-I5DlBD2D.js";
import "./paths-1qR_mW4i.js";
import "./theme-UkqnBJaj.js";
import { u as restoreTerminalState } from "./subsystem-EnljYYs1.js";
import "./ansi-YpD2Ho3J.js";
import "./boolean-B938tROv.js";
import "./env-Bdj-riuG.js";
import "./warning-filter-xAwZkSAQ.js";
import { h as pathExists, y as resolveUserPath } from "./utils-Do8MzKyM.js";
import "./links-Cx-Xmp-Y.js";
import { Qu as formatControlUiSshHint, Xu as detectBrowserOpenSupport, ad as probeGatewayReachable, cd as resolveControlUiLinks, fd as waitForGatewayReachable, rd as openUrl } from "./auth-profiles-DqxBs6Au.js";
import "./plugins-allowlist-CTOQWcBK.js";
import "./registry-DrRO3PZ7.js";
import "./fetch-DM2X1MUS.js";
import "./config-state-Dtu4rsXl.js";
import "./filter-Qe6Ch68_.js";
import "./manifest-registry-CA0yK887.js";
import "./method-scopes-DDb5C1xl.js";
import { n as resolveCliName } from "./cli-name-C9PM6wRj.js";
import { t as formatCliCommand } from "./command-format-CS805JpF.js";
import "./plugins-CygWjihb.js";
import "./brew-BBTHZkpM.js";
import { y as DEFAULT_BOOTSTRAP_FILENAME } from "./agent-scope-tkfLX5MZ.js";
import "./logger-BwHrL168.js";
import "./exec-Fh3CK0qE.js";
import "./env-overrides-ArVaLl04.js";
import "./safe-text-ByhWP-8W.js";
import "./version-Dubp0iGu.js";
import "./config-VO8zzMSR.js";
import "./workspace-dirs-D1oDbsnN.js";
import "./search-manager-DIDe1qlM.js";
import "./ip-Cdtea-sx.js";
import "./device-metadata-normalization-a2oQYp64.js";
import "./query-expansion-CcKf_qr0.js";
import "./command-secret-targets-7sQA1Mwd.js";
import "./frontmatter-UI6LO8NQ.js";
import "./path-alias-guards-SF-nwQor.js";
import "./skills-eb8njEg8.js";
import "./commands-BRfqrztE.js";
import "./ports-DeHp-MTZ.js";
import "./ports-lsof-CCbcofNf.js";
import "./ssh-tunnel-Cu8erp19.js";
import "./mime-h80iV1FL.js";
import "./delivery-queue-CfAp_q6e.js";
import "./paths-YN5WLIkL.js";
import "./session-cost-usage-DeAwWk6A.js";
import "./fetch-CzYOE42F.js";
import "./identity-file-Dh-pAEVE.js";
import "./dm-policy-shared-qfNerugD.js";
import "./multimodal-IUqnzBU8.js";
import "./memory-search-BI0f8wZY.js";
import "./prompt-style-DqOsOwLH.js";
import "./secret-file-Bd-d3WTG.js";
import "./token-C5m9DX_R.js";
import "./restart-stale-pids-DzpGvXwg.js";
import "./accounts-B1y-wv7m.js";
import "./audit-CmcUcZU1.js";
import "./cli-utils-DRykF2zj.js";
import "./daemon-install-plan.shared-B7RGrAF1.js";
import "./runtime-paths-cQOj5Aup.js";
import "./runtime-guard-BGgJKfMx.js";
import { n as buildGatewayInstallPlan, r as gatewayInstallErrorHint, t as resolveGatewayInstallToken } from "./gateway-install-token-BqkLsen1.js";
import { n as GATEWAY_DAEMON_RUNTIME_OPTIONS, t as DEFAULT_GATEWAY_DAEMON_RUNTIME } from "./daemon-runtime-Tgt-ZRti.js";
import "./runtime-parse-DQXHHtms.js";
import "./launchd-BbDrm470.js";
import { n as resolveGatewayService, t as describeGatewayServiceRestart } from "./service-DC_Pq39i.js";
import { i as isSystemdUserServiceAvailable } from "./systemd-Bb__IPfT.js";
import { r as installCompletion } from "./completion-cli-lXtG5sJx.js";
import "./register.subclis-Dky2nOhj.js";
import "./command-registry-DZxchS89.js";
import "./program-context-BZIMrX-V.js";
import "./heartbeat-summary-Cn7gQrEE.js";
import { r as healthCommand } from "./health-D7ZxsaPF.js";
import { t as ensureControlUiAssetsBuilt } from "./control-ui-assets-AIHB76qG.js";
import { t as resolveSetupSecretInputString } from "./setup.secret-input-DnnKHt6m.js";
import "./note-DjpUEsPR.js";
import { t as formatHealthCheckFailure } from "./health-format-iCCqeq_w.js";
import { r as ensureCompletionCacheExists, t as checkShellCompletionStatus } from "./doctor-completion-CML35nn7.js";
import { t as runTui } from "./tui-B3YgN3lv.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
//#region src/wizard/setup.completion.ts
async function resolveProfileHint(shell) {
	const home = process.env.HOME || os.homedir();
	if (shell === "zsh") {return "~/.zshrc";}
	if (shell === "bash") {return await pathExists(path.join(home, ".bashrc")) ? "~/.bashrc" : "~/.bash_profile";}
	if (shell === "fish") {return "~/.config/fish/config.fish";}
	return "$PROFILE";
}
function formatReloadHint(shell, profileHint) {
	if (shell === "powershell") {return "Restart your shell (or reload your PowerShell profile).";}
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
		if (await deps.ensureCompletionCacheExists(cliName)) {await deps.installCompletion(completionStatus.shell, true, cliName);}
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
		}))) {return;}
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
async function finalizeSetupWizard(options) {
	const { flow, opts, baseConfig, nextConfig, settings, prompter, runtime } = options;
	const withWizardProgress = async (label, options, work) => {
		const progress = prompter.progress(label);
		try {
			return await work(progress);
		} finally {
			progress.stop(typeof options.doneMessage === "function" ? options.doneMessage() : options.doneMessage);
		}
	};
	const systemdAvailable = process.platform === "linux" ? await isSystemdUserServiceAvailable() : true;
	if (process.platform === "linux" && !systemdAvailable) {await prompter.note("Systemd user services are unavailable. Skipping lingering checks and service install.", "Systemd");}
	if (process.platform === "linux" && systemdAvailable) {
		const { ensureSystemdUserLingerInteractive } = await import("./systemd-linger-bhoEkWxH.js");
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
	if (explicitInstallDaemon !== void 0) {installDaemon = explicitInstallDaemon;}
	else if (process.platform === "linux" && !systemdAvailable) {installDaemon = false;}
	else if (flow === "quickstart") {installDaemon = true;}
	else {installDaemon = await prompter.confirm({
		message: "Install Gateway service (recommended)",
		initialValue: true
	});}
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
		if (flow === "quickstart") {await prompter.note("QuickStart uses Node for the Gateway service (stable + supported).", "Gateway service runtime");}
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
			} else if (action === "reinstall") {await withWizardProgress("Gateway service", { doneMessage: "Gateway service uninstalled." }, async (progress) => {
				progress.update("Uninstalling Gateway service…");
				await service.uninstall({
					env: process.env,
					stdout: process.stdout
				});
			});}
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
				for (const warning of tokenResolution.warnings) {await prompter.note(warning, "Gateway service");}
				if (tokenResolution.unavailableReason) {installError = [
					"Gateway install blocked:",
					tokenResolution.unavailableReason,
					"Fix gateway auth config/token input and rerun setup."
				].join(" ");}
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
				installError = err instanceof Error ? err.message : String(err);
			} finally {
				progress.stop(installError ? "Gateway service install failed." : "Gateway service installed.");
			}
			if (installError) {
				await prompter.note(`Gateway service install failed: ${installError}`, "Gateway");
				await prompter.note(gatewayInstallErrorHint(), "Gateway");
			}
		}
	}
	if (!opts.skipHealth) {
		await waitForGatewayReachable({
			url: resolveControlUiLinks({
				bind: nextConfig.gateway?.bind ?? "loopback",
				port: settings.port,
				customBindHost: nextConfig.gateway?.customBindHost,
				basePath: void 0
			}).wsUrl,
			token: settings.gatewayToken,
			deadlineMs: 15e3
		});
		try {
			await healthCommand({
				json: false,
				timeoutMs: 1e4
			}, runtime);
		} catch (err) {
			runtime.error(formatHealthCheckFailure(err));
			await prompter.note([
				"Docs:",
				"https://docs.openclaw.ai/gateway/health",
				"https://docs.openclaw.ai/gateway/troubleshooting"
			].join("\n"), "Health check help");
		}
	}
	const controlUiEnabled = nextConfig.gateway?.controlUi?.enabled ?? baseConfig.gateway?.controlUi?.enabled ?? true;
	if (!opts.skipUi && controlUiEnabled) {
		const controlUiAssets = await ensureControlUiAssetsBuilt(runtime);
		if (!controlUiAssets.ok && controlUiAssets.message) {runtime.error(controlUiAssets.message);}
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
		basePath: controlUiBasePath
	});
	const authedUrl = settings.authMode === "token" && settings.gatewayToken ? `${links.httpUrl}#token=${encodeURIComponent(settings.gatewayToken)}` : links.httpUrl;
	let resolvedGatewayPassword = "";
	if (settings.authMode === "password") {try {
		resolvedGatewayPassword = await resolveSetupSecretInputString({
			config: nextConfig,
			value: nextConfig.gateway?.auth?.password,
			path: "gateway.auth.password",
			env: process.env
		}) ?? "";
	} catch (error) {
		await prompter.note(["Could not resolve gateway.auth.password SecretRef for setup auth.", error instanceof Error ? error.message : String(error)].join("\n"), "Gateway auth");
	}}
	const gatewayProbe = await probeGatewayReachable({
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
	if (!opts.skipUi && gatewayProbe.ok) {
		if (hasBootstrap) {await prompter.note([
			"This is the defining action that makes your agent you.",
			"Please take your time.",
			"The more you tell it, the better the experience will be.",
			"We will send: \"Wake up, my friend!\""
		].join("\n"), "Start TUI (best option!)");}
		await prompter.note([
			"Gateway token: shared auth for the Gateway + Control UI.",
			"Stored in: ~/.openclaw/openclaw.json (gateway.auth.token) or OPENCLAW_GATEWAY_TOKEN.",
			`View token: ${formatCliCommand("openclaw config get gateway.auth.token")}`,
			`Generate token: ${formatCliCommand("openclaw doctor --generate-gateway-token")}`,
			"Web UI keeps dashboard URL tokens in memory for the current tab and strips them from the URL after load.",
			`Open the dashboard anytime: ${formatCliCommand("openclaw dashboard --no-open")}`,
			"If prompted: paste the token into Control UI settings (or use the tokenized dashboard URL)."
		].join("\n"), "Token");
		hatchChoice = await prompter.select({
			message: "How do you want to hatch your bot?",
			options: [
				{
					value: "tui",
					label: "Hatch in TUI (recommended)"
				},
				{
					value: "web",
					label: "Open the Web UI"
				},
				{
					value: "later",
					label: "Do this later"
				}
			],
			initialValue: "tui"
		});
		if (hatchChoice === "tui") {
			restoreTerminalState("pre-setup tui", { resumeStdinIfPaused: true });
			await runTui({
				url: links.wsUrl,
				token: settings.authMode === "token" ? settings.gatewayToken : void 0,
				password: settings.authMode === "password" ? resolvedGatewayPassword : "",
				deliver: false,
				message: hasBootstrap ? "Wake up, my friend!" : void 0
			});
			launchedTui = true;
		} else if (hatchChoice === "web") {
			if ((await detectBrowserOpenSupport()).ok) {
				controlUiOpened = await openUrl(authedUrl);
				if (!controlUiOpened) {controlUiOpenHint = formatControlUiSshHint({
					port: settings.port,
					basePath: controlUiBasePath,
					token: settings.authMode === "token" ? settings.gatewayToken : void 0
				});}
			} else {controlUiOpenHint = formatControlUiSshHint({
				port: settings.port,
				basePath: controlUiBasePath,
				token: settings.authMode === "token" ? settings.gatewayToken : void 0
			});}
			await prompter.note([
				`Dashboard link (with token): ${authedUrl}`,
				controlUiOpened ? "Opened in your browser. Keep that tab to control OpenClaw." : "Copy/paste this URL in a browser on this machine to control OpenClaw.",
				controlUiOpenHint
			].filter(Boolean).join("\n"), "Dashboard ready");
		} else {await prompter.note(`When you're ready: ${formatCliCommand("openclaw dashboard --no-open")}`, "Later");}
	} else if (opts.skipUi) {await prompter.note("Skipping Control UI/TUI prompts.", "Control UI");}
	await prompter.note(["Back up your agent workspace.", "Docs: https://docs.openclaw.ai/concepts/agent-workspace"].join("\n"), "Workspace backup");
	await prompter.note("Running agents on your computer is risky — harden your setup: https://docs.openclaw.ai/security", "Security");
	await setupWizardShellCompletion({
		flow,
		prompter
	});
	if (!opts.skipUi && settings.authMode === "token" && Boolean(settings.gatewayToken) && hatchChoice === null) {
		if ((await detectBrowserOpenSupport()).ok) {
			controlUiOpened = await openUrl(authedUrl);
			if (!controlUiOpened) {controlUiOpenHint = formatControlUiSshHint({
				port: settings.port,
				basePath: controlUiBasePath,
				token: settings.gatewayToken
			});}
		} else {controlUiOpenHint = formatControlUiSshHint({
			port: settings.port,
			basePath: controlUiBasePath,
			token: settings.gatewayToken
		});}
		await prompter.note([
			`Dashboard link (with token): ${authedUrl}`,
			controlUiOpened ? "Opened in your browser. Keep that tab to control OpenClaw." : "Copy/paste this URL in a browser on this machine to control OpenClaw.",
			controlUiOpenHint
		].filter(Boolean).join("\n"), "Dashboard ready");
	}
	const webSearchProvider = nextConfig.tools?.web?.search?.provider;
	const webSearchEnabled = nextConfig.tools?.web?.search?.enabled;
	if (webSearchProvider) {
		const { SEARCH_PROVIDER_OPTIONS, resolveExistingKey, hasExistingKey, hasKeyInEnv } = await import("./onboard-search-C5V0CGzG.js");
		const entry = SEARCH_PROVIDER_OPTIONS.find((e) => e.value === webSearchProvider);
		const label = entry?.label ?? webSearchProvider;
		const storedKey = resolveExistingKey(nextConfig, webSearchProvider);
		const keyConfigured = hasExistingKey(nextConfig, webSearchProvider);
		const envAvailable = entry ? hasKeyInEnv(entry) : false;
		const hasKey = keyConfigured || envAvailable;
		const keySource = storedKey ? "API key: stored in config." : keyConfigured ? "API key: configured via secret reference." : envAvailable ? `API key: provided via ${entry?.envKeys.join(" / ")} env var.` : void 0;
		if (webSearchEnabled !== false && hasKey) {await prompter.note([
			"Web search is enabled, so your agent can look things up online when needed.",
			"",
			`Provider: ${label}`,
			...keySource ? [keySource] : [],
			"Docs: https://docs.openclaw.ai/tools/web"
		].join("\n"), "Web search");}
		else if (!hasKey) {await prompter.note([
			`Provider ${label} is selected but no API key was found.`,
			"web_search will not work until a key is added.",
			`  ${formatCliCommand("openclaw configure --section web")}`,
			"",
			`Get your key at: ${entry?.signupUrl ?? "https://docs.openclaw.ai/tools/web"}`,
			"Docs: https://docs.openclaw.ai/tools/web"
		].join("\n"), "Web search");}
		else {await prompter.note([
			`Web search (${label}) is configured but disabled.`,
			`Re-enable: ${formatCliCommand("openclaw configure --section web")}`,
			"",
			"Docs: https://docs.openclaw.ai/tools/web"
		].join("\n"), "Web search");}
	} else {
		const { SEARCH_PROVIDER_OPTIONS, hasExistingKey, hasKeyInEnv } = await import("./onboard-search-C5V0CGzG.js");
		const legacyDetected = SEARCH_PROVIDER_OPTIONS.find((e) => hasExistingKey(nextConfig, e.value) || hasKeyInEnv(e));
		if (legacyDetected) {await prompter.note([`Web search is available via ${legacyDetected.label} (auto-detected).`, "Docs: https://docs.openclaw.ai/tools/web"].join("\n"), "Web search");}
		else {await prompter.note([
			"Web search was skipped. You can enable it later:",
			`  ${formatCliCommand("openclaw configure --section web")}`,
			"",
			"Docs: https://docs.openclaw.ai/tools/web"
		].join("\n"), "Web search");}
	}
	await prompter.note("What now: https://openclaw.ai/showcase (\"What People Are Building\").", "What now");
	await prompter.outro(controlUiOpened ? "Onboarding complete. Dashboard opened; keep that tab to control OpenClaw." : "Onboarding complete. Use the dashboard link above to control OpenClaw.");
	return { launchedTui };
}
//#endregion
export { finalizeSetupWizard };
