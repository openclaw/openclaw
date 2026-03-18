import "./redact-qojvLPM7.js";
import "./errors-nCFRNLA6.js";
import "./unhandled-rejections-DGuis5pC.js";
import "./globals-B6h30oSy.js";
import "./paths-DqbqmTPe.js";
import "./theme-CL08MjAq.js";
import { m as restoreTerminalState, p as init_restore } from "./subsystem-CZwunM2N.js";
import "./ansi-CeMmGDji.js";
import "./boolean-B938tROv.js";
import "./env--LwFRA3k.js";
import "./warning-filter-xAwZkSAQ.js";
import { b as resolveUserPath, d as init_utils, g as pathExists } from "./utils-BiUV1eIQ.js";
import "./links-DPi3kBux.js";
import { Yu as detectBrowserOpenSupport, Zu as formatControlUiSshHint, dd as waitForGatewayReachable, id as probeGatewayReachable, nd as openUrl, sd as resolveControlUiLinks } from "./auth-profiles-DAOR1fRn.js";
import "./plugins-allowlist-E4LSkJ7R.js";
import "./registry-ep1yQ6WN.js";
import "./fetch-COjVSrBr.js";
import "./config-state-CkhXLglq.js";
import "./filter-Qe6Ch68_.js";
import "./manifest-registry-DZywV-kg.js";
import "./method-scopes-CLHNYIU6.js";
import { n as resolveCliName } from "./cli-name-C9PM6wRj.js";
import { t as formatCliCommand } from "./command-format-CS805JpF.js";
import "./plugins-DC9n978g.js";
import "./brew-CAA1PAwX.js";
import { y as DEFAULT_BOOTSTRAP_FILENAME } from "./agent-scope-C0PckUtv.js";
import "./logger-DLmJXd-S.js";
import "./exec-BmPfiSbq.js";
import "./env-overrides-Dbt5eAZJ.js";
import "./safe-text-BN5UJvnR.js";
import "./version-Dubp0iGu.js";
import "./config-DZ3oWznn.js";
import "./workspace-dirs-Ejflbukt.js";
import "./search-manager-CVctuSlw.js";
import "./ip-Cdtea-sx.js";
import "./device-metadata-normalization-a2oQYp64.js";
import "./query-expansion-V82ct97U.js";
import "./command-secret-targets-7sQA1Mwd.js";
import "./frontmatter-UI6LO8NQ.js";
import "./path-alias-guards-SF-nwQor.js";
import "./skills-DUmWDILI.js";
import "./commands-BfMCtxuV.js";
import "./ports-D4BnBb9r.js";
import "./ports-lsof-CCbcofNf.js";
import "./ssh-tunnel-DMTCLBKm.js";
import "./mime-h80iV1FL.js";
import "./delivery-queue-_j5H8TrE.js";
import "./paths-55bRPK_d.js";
import "./session-cost-usage-DqIvfSaZ.js";
import "./fetch-wLdC1F30.js";
import "./identity-file-GRgHESaI.js";
import "./dm-policy-shared-QWD8iFx0.js";
import "./multimodal-IUqnzBU8.js";
import "./memory-search-ur8rDo4q.js";
import "./prompt-style-CEH2A0QE.js";
import "./secret-file-CGJfrW4K.js";
import "./token-BE5e8NTA.js";
import "./restart-stale-pids-Be6QOzfZ.js";
import "./accounts-C8zoA5z4.js";
import "./audit-BTP1ZwHz.js";
import "./cli-utils-DRykF2zj.js";
import "./daemon-install-plan.shared-C-C6Cfb3.js";
import "./runtime-paths-BAKbI1QA.js";
import "./runtime-guard-BeaHeRr7.js";
import { n as buildGatewayInstallPlan, r as gatewayInstallErrorHint, t as resolveGatewayInstallToken } from "./gateway-install-token-TIg1tNFo.js";
import { n as GATEWAY_DAEMON_RUNTIME_OPTIONS, t as DEFAULT_GATEWAY_DAEMON_RUNTIME } from "./daemon-runtime-Tgt-ZRti.js";
import "./runtime-parse-DJmitJVt.js";
import "./launchd-CYc1PBHk.js";
import { n as resolveGatewayService, t as describeGatewayServiceRestart } from "./service-BRvD766e.js";
import { i as isSystemdUserServiceAvailable } from "./systemd-Ca2xqSN-.js";
import { r as installCompletion } from "./completion-cli-DRcn8vnZ.js";
import "./register.subclis-CQ_VXgqx.js";
import "./command-registry-CwuyfmaL.js";
import "./program-context-BZIMrX-V.js";
import "./heartbeat-summary-CLoUvRc6.js";
import { r as healthCommand } from "./health-BcAvG-SY.js";
import { t as ensureControlUiAssetsBuilt } from "./control-ui-assets-UkuykTLs.js";
import { t as resolveSetupSecretInputString } from "./setup.secret-input-D-o1vWQB.js";
import "./note-DNiLBVhx.js";
import { t as formatHealthCheckFailure } from "./health-format-JH8HNQtJ.js";
import { r as ensureCompletionCacheExists, t as checkShellCompletionStatus } from "./doctor-completion-D-C7dX9r.js";
import { t as runTui } from "./tui-DqUE_VNj.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
//#region src/wizard/setup.completion.ts
init_restore();
init_utils();
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
init_utils();
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
	if (process.platform === "linux" && !systemdAvailable) await prompter.note("Systemd user services are unavailable. Skipping lingering checks and service install.", "Systemd");
	if (process.platform === "linux" && systemdAvailable) {
		const { ensureSystemdUserLingerInteractive } = await import("./systemd-linger-tRCOeeR5.js");
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
		basePath: controlUiBasePath
	});
	const authedUrl = settings.authMode === "token" && settings.gatewayToken ? `${links.httpUrl}#token=${encodeURIComponent(settings.gatewayToken)}` : links.httpUrl;
	let resolvedGatewayPassword = "";
	if (settings.authMode === "password") try {
		resolvedGatewayPassword = await resolveSetupSecretInputString({
			config: nextConfig,
			value: nextConfig.gateway?.auth?.password,
			path: "gateway.auth.password",
			env: process.env
		}) ?? "";
	} catch (error) {
		await prompter.note(["Could not resolve gateway.auth.password SecretRef for setup auth.", error instanceof Error ? error.message : String(error)].join("\n"), "Gateway auth");
	}
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
		if (hasBootstrap) await prompter.note([
			"This is the defining action that makes your agent you.",
			"Please take your time.",
			"The more you tell it, the better the experience will be.",
			"We will send: \"Wake up, my friend!\""
		].join("\n"), "Start TUI (best option!)");
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
	if (!opts.skipUi && settings.authMode === "token" && Boolean(settings.gatewayToken) && hatchChoice === null) {
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
	const webSearchProvider = nextConfig.tools?.web?.search?.provider;
	const webSearchEnabled = nextConfig.tools?.web?.search?.enabled;
	if (webSearchProvider) {
		const { SEARCH_PROVIDER_OPTIONS, resolveExistingKey, hasExistingKey, hasKeyInEnv } = await import("./onboard-search-B0I4HMO0.js");
		const entry = SEARCH_PROVIDER_OPTIONS.find((e) => e.value === webSearchProvider);
		const label = entry?.label ?? webSearchProvider;
		const storedKey = resolveExistingKey(nextConfig, webSearchProvider);
		const keyConfigured = hasExistingKey(nextConfig, webSearchProvider);
		const envAvailable = entry ? hasKeyInEnv(entry) : false;
		const hasKey = keyConfigured || envAvailable;
		const keySource = storedKey ? "API key: stored in config." : keyConfigured ? "API key: configured via secret reference." : envAvailable ? `API key: provided via ${entry?.envKeys.join(" / ")} env var.` : void 0;
		if (webSearchEnabled !== false && hasKey) await prompter.note([
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
		const { SEARCH_PROVIDER_OPTIONS, hasExistingKey, hasKeyInEnv } = await import("./onboard-search-B0I4HMO0.js");
		const legacyDetected = SEARCH_PROVIDER_OPTIONS.find((e) => hasExistingKey(nextConfig, e.value) || hasKeyInEnv(e));
		if (legacyDetected) await prompter.note([`Web search is available via ${legacyDetected.label} (auto-detected).`, "Docs: https://docs.openclaw.ai/tools/web"].join("\n"), "Web search");
		else await prompter.note([
			"Web search was skipped. You can enable it later:",
			`  ${formatCliCommand("openclaw configure --section web")}`,
			"",
			"Docs: https://docs.openclaw.ai/tools/web"
		].join("\n"), "Web search");
	}
	await prompter.note("What now: https://openclaw.ai/showcase (\"What People Are Building\").", "What now");
	await prompter.outro(controlUiOpened ? "Onboarding complete. Dashboard opened; keep that tab to control OpenClaw." : "Onboarding complete. Use the dashboard link above to control OpenClaw.");
	return { launchedTui };
}
//#endregion
export { finalizeSetupWizard };
