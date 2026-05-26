import { g as resolveOAuthDir, i as isNixMode, o as resolveConfigPath, u as resolveGatewayPort, v as resolveStateDir } from "./paths-Cnwfh6dH.js";
import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import { t as formatCliCommand } from "./command-format-OwPqnbXG.js";
import { t as formatDocsLink } from "./links-Dz4PCYCN.js";
import { r as theme } from "./theme-CStEj1vt.js";
import { f as resolveHomeDir } from "./utils-CKsuXgDI.js";
import { n as defaultRuntime } from "./runtime-DDH_zqCr.js";
import { t as resolveGatewayAuthToken } from "./auth-token-resolution-9zvKyWwm.js";
import { r as runCommandWithTimeout } from "./exec-DusmGtXL.js";
import { i as getRuntimeConfig, u as readConfigFileSnapshot } from "./io-5xE1dPMK.js";
import "./config-CzeRK-GW.js";
import { i as resolveGatewayService } from "./service-ZFeJibwt.js";
import { t as resolveControlUiLinks } from "./control-ui-links-Dmhd3Har.js";
import { a as removeStateAndLinkedPaths, i as removePath, o as removeWorkspaceDirs, r as listAgentSessionDirs, t as buildCleanupPlan } from "./cleanup-utils-DQ3qPzr6.js";
import { n as stylePromptMessage, r as stylePromptTitle, t as stylePromptHint } from "./prompt-style-CIp8kcUv.js";
import { n as runCommandWithRuntime } from "./cli-utils-C7ZilvgD.js";
import { n as openUrl, t as detectBrowserOpenSupport } from "./browser-open-Cc87s-qT.js";
import { i as formatControlUiSshHint } from "./onboard-helpers-D5MK7ND9.js";
import { t as doctorCommand } from "./doctor-CeUsf4pE.js";
import { t as selectStyled } from "./prompt-select-styled-D0ZUcWeu.js";
import path from "node:path";
import { cancel, confirm, isCancel, multiselect } from "@clack/prompts";
//#region src/infra/clipboard.ts
async function copyToClipboard(value) {
	for (const attempt of [
		{ argv: ["pbcopy"] },
		{ argv: [
			"xclip",
			"-selection",
			"clipboard"
		] },
		{ argv: ["wl-copy"] },
		{ argv: ["clip.exe"] },
		{ argv: [
			"powershell",
			"-NoProfile",
			"-Command",
			"Set-Clipboard"
		] }
	]) try {
		const result = await runCommandWithTimeout(attempt.argv, {
			timeoutMs: 3e3,
			input: value
		});
		if (result.code === 0 && !result.killed) return true;
	} catch {}
	return false;
}
//#endregion
//#region src/commands/dashboard.ts
async function dashboardCommand(runtime = defaultRuntime, options = {}) {
	const snapshot = await readConfigFileSnapshot();
	const cfg = snapshot.valid ? snapshot.sourceConfig ?? snapshot.config : {};
	const port = resolveGatewayPort(cfg);
	const bind = cfg.gateway?.bind ?? "loopback";
	const basePath = cfg.gateway?.controlUi?.basePath;
	const customBindHost = cfg.gateway?.customBindHost;
	const resolvedToken = await resolveGatewayAuthToken({
		cfg,
		env: process.env,
		envFallback: "always"
	});
	const token = resolvedToken.token ?? "";
	const links = resolveControlUiLinks({
		port,
		bind: bind === "lan" ? "loopback" : bind,
		customBindHost,
		basePath,
		tlsEnabled: cfg.gateway?.tls?.enabled === true
	});
	const includeTokenInUrl = token.length > 0 && !resolvedToken.secretRefConfigured;
	const dashboardUrl = includeTokenInUrl ? `${links.httpUrl}#token=${encodeURIComponent(token)}` : links.httpUrl;
	runtime.log(`Dashboard URL: ${links.httpUrl}`);
	if (includeTokenInUrl) runtime.log("Token auto-auth included in browser/clipboard URL.");
	if (resolvedToken.secretRefConfigured && token) runtime.log("Token auto-auth is disabled for SecretRef-managed gateway.auth.token; use your external token source if prompted.");
	if (resolvedToken.unresolvedRefReason) {
		runtime.log(`Token auto-auth unavailable: ${resolvedToken.unresolvedRefReason}`);
		runtime.log("Set OPENCLAW_GATEWAY_TOKEN in this shell or resolve your secret provider, then rerun `openclaw dashboard`.");
	}
	const copied = await copyToClipboard(dashboardUrl).catch(() => false);
	runtime.log(copied ? "Copied to clipboard." : "Copy to clipboard unavailable.");
	let opened = false;
	let hint;
	if (!options.noOpen) {
		if ((await detectBrowserOpenSupport()).ok) opened = await openUrl(dashboardUrl);
		if (!opened) hint = formatControlUiSshHint({
			port,
			basePath
		});
	} else hint = copied && includeTokenInUrl ? "Browser launch disabled (--no-open). Token-authenticated URL copied to clipboard." : "Browser launch disabled (--no-open). Use the URL above.";
	const fallbackToManualAuth = !copied && !opened && includeTokenInUrl;
	const suppressNoOpenHint = options.noOpen === true && fallbackToManualAuth;
	if (opened) runtime.log("Opened in your browser. Keep that tab to control OpenClaw.");
	else if (hint && !suppressNoOpenHint) runtime.log(hint);
	if (fallbackToManualAuth) runtime.log("Token auto-auth not delivered. Append your gateway token (from OPENCLAW_GATEWAY_TOKEN or gateway.auth.token) as a URL fragment with key `token` to authenticate.");
}
//#endregion
//#region src/commands/cleanup-plan.ts
function resolveCleanupPlanFromDisk() {
	const cfg = getRuntimeConfig();
	const stateDir = resolveStateDir();
	const configPath = resolveConfigPath();
	const oauthDir = resolveOAuthDir();
	return {
		cfg,
		stateDir,
		configPath,
		oauthDir,
		...buildCleanupPlan({
			cfg,
			stateDir,
			configPath,
			oauthDir
		})
	};
}
//#endregion
//#region src/commands/reset.ts
async function stopGatewayIfRunning(runtime) {
	if (isNixMode) return;
	const service = resolveGatewayService();
	let loaded = false;
	try {
		loaded = await service.isLoaded({ env: process.env });
	} catch (err) {
		runtime.error(`Gateway service check failed: ${String(err)}`);
		return;
	}
	if (!loaded) return;
	try {
		await service.stop({
			env: process.env,
			stdout: process.stdout
		});
	} catch (err) {
		runtime.error(`Gateway stop failed: ${String(err)}`);
	}
}
function logBackupRecommendation$1(runtime) {
	runtime.log(`Recommended first: ${formatCliCommand("openclaw backup create")}`);
}
async function resetCommand(runtime, opts) {
	const interactive = !opts.nonInteractive;
	if (!interactive && !opts.yes) {
		runtime.error("Non-interactive mode requires --yes.");
		runtime.exit(1);
		return;
	}
	let scope = opts.scope;
	if (!scope) {
		if (!interactive) {
			runtime.error("Non-interactive mode requires --scope.");
			runtime.exit(1);
			return;
		}
		const selection = await selectStyled({
			message: "Reset scope",
			options: [
				{
					value: "config",
					label: "Config only",
					hint: "openclaw.json"
				},
				{
					value: "config+creds+sessions",
					label: "Config + credentials + sessions",
					hint: "keeps workspace + auth profiles"
				},
				{
					value: "full",
					label: "Full reset",
					hint: "state dir + workspace"
				}
			],
			initialValue: "config+creds+sessions"
		});
		if (isCancel(selection)) {
			cancel(stylePromptTitle("Reset cancelled.") ?? "Reset cancelled.");
			runtime.exit(0);
			return;
		}
		scope = selection;
	}
	if (![
		"config",
		"config+creds+sessions",
		"full"
	].includes(scope)) {
		runtime.error("Invalid --scope. Expected \"config\", \"config+creds+sessions\", or \"full\".");
		runtime.exit(1);
		return;
	}
	if (interactive && !opts.yes) {
		const ok = await confirm({ message: stylePromptMessage(`Proceed with ${scope} reset?`) });
		if (isCancel(ok) || !ok) {
			cancel(stylePromptTitle("Reset cancelled.") ?? "Reset cancelled.");
			runtime.exit(0);
			return;
		}
	}
	const dryRun = Boolean(opts.dryRun);
	const { stateDir, configPath, oauthDir, configInsideState, oauthInsideState, workspaceDirs } = resolveCleanupPlanFromDisk();
	if (scope !== "config") {
		logBackupRecommendation$1(runtime);
		if (dryRun) runtime.log("[dry-run] stop gateway service");
		else await stopGatewayIfRunning(runtime);
	}
	if (scope === "config") {
		await removePath(configPath, runtime, {
			dryRun,
			label: configPath
		});
		return;
	}
	if (scope === "config+creds+sessions") {
		await removePath(configPath, runtime, {
			dryRun,
			label: configPath
		});
		await removePath(oauthDir, runtime, {
			dryRun,
			label: oauthDir
		});
		const sessionDirs = await listAgentSessionDirs(stateDir);
		for (const dir of sessionDirs) await removePath(dir, runtime, {
			dryRun,
			label: dir
		});
		runtime.log(`Next: ${formatCliCommand("openclaw onboard --install-daemon")}`);
		return;
	}
	if (scope === "full") {
		await removeStateAndLinkedPaths({
			stateDir,
			configPath,
			oauthDir,
			configInsideState,
			oauthInsideState
		}, runtime, { dryRun });
		await removeWorkspaceDirs(workspaceDirs, runtime, { dryRun });
		runtime.log(`Next: ${formatCliCommand("openclaw onboard --install-daemon")}`);
		return;
	}
}
//#endregion
//#region src/commands/uninstall.ts
const multiselectStyled = (params) => multiselect({
	...params,
	message: stylePromptMessage(params.message),
	options: params.options.map((opt) => opt.hint === void 0 ? opt : {
		...opt,
		hint: stylePromptHint(opt.hint)
	})
});
function buildScopeSelection(opts) {
	const hadExplicit = Boolean(opts.all || opts.service || opts.state || opts.workspace || opts.app);
	const scopes = /* @__PURE__ */ new Set();
	if (opts.all || opts.service) scopes.add("service");
	if (opts.all || opts.state) scopes.add("state");
	if (opts.all || opts.workspace) scopes.add("workspace");
	if (opts.all || opts.app) scopes.add("app");
	return {
		scopes,
		hadExplicit
	};
}
async function stopAndUninstallService(runtime) {
	if (isNixMode) {
		runtime.error(`Nix mode detected; service uninstall is disabled. Manage the service through your Nix profile instead, then run ${formatCliCommand("openclaw status")} to verify.`);
		return false;
	}
	const service = resolveGatewayService();
	let loaded = false;
	try {
		loaded = await service.isLoaded({ env: process.env });
	} catch (err) {
		runtime.error(`Gateway service check failed: ${formatErrorMessage(err)}. Run ${formatCliCommand("openclaw gateway status --deep")} for service diagnostics.`);
		return false;
	}
	if (!loaded) {
		runtime.log(`Gateway service ${service.notLoadedText}.`);
		return true;
	}
	try {
		await service.stop({
			env: process.env,
			stdout: process.stdout
		});
	} catch (err) {
		runtime.error(`Gateway stop failed: ${formatErrorMessage(err)}. Run ${formatCliCommand("openclaw gateway status --deep")} before retrying uninstall.`);
	}
	try {
		await service.uninstall({
			env: process.env,
			stdout: process.stdout
		});
		return true;
	} catch (err) {
		runtime.error(`Gateway uninstall failed: ${formatErrorMessage(err)}. Run ${formatCliCommand("openclaw gateway status --deep")} for the service state.`);
		return false;
	}
}
async function removeMacApp(runtime, dryRun) {
	if (process.platform !== "darwin") return;
	await removePath("/Applications/OpenClaw.app", runtime, {
		dryRun,
		label: "/Applications/OpenClaw.app"
	});
}
function logBackupRecommendation(runtime) {
	runtime.log(`Recommended first: ${formatCliCommand("openclaw backup create")}`);
}
async function uninstallCommand(runtime, opts) {
	const { scopes, hadExplicit } = buildScopeSelection(opts);
	const interactive = !opts.nonInteractive;
	if (!interactive && !opts.yes) {
		runtime.error(`Non-interactive uninstall requires --yes. Preview first with ${formatCliCommand("openclaw uninstall --dry-run --all")}.`);
		runtime.exit(1);
		return;
	}
	if (!hadExplicit) {
		if (!interactive) {
			runtime.error(`Non-interactive uninstall requires explicit scopes. Use --all, or choose scopes such as --service --state.`);
			runtime.exit(1);
			return;
		}
		const selection = await multiselectStyled({
			message: "Uninstall which components?",
			options: [
				{
					value: "service",
					label: "Gateway service",
					hint: "launchd / systemd / schtasks"
				},
				{
					value: "state",
					label: "State + config",
					hint: "~/.openclaw"
				},
				{
					value: "workspace",
					label: "Workspace",
					hint: "agent files"
				},
				{
					value: "app",
					label: "macOS app",
					hint: "/Applications/OpenClaw.app"
				}
			],
			initialValues: [
				"service",
				"state",
				"workspace"
			]
		});
		if (isCancel(selection)) {
			cancel(stylePromptTitle("Uninstall cancelled.") ?? "Uninstall cancelled.");
			runtime.exit(0);
			return;
		}
		for (const value of selection) scopes.add(value);
	}
	if (scopes.size === 0) {
		runtime.log("Nothing selected.");
		return;
	}
	if (interactive && !opts.yes) {
		const ok = await confirm({ message: stylePromptMessage("Proceed with uninstall?") });
		if (isCancel(ok) || !ok) {
			cancel(stylePromptTitle("Uninstall cancelled.") ?? "Uninstall cancelled.");
			runtime.exit(0);
			return;
		}
	}
	const dryRun = Boolean(opts.dryRun);
	const { stateDir, configPath, oauthDir, configInsideState, oauthInsideState, workspaceDirs } = resolveCleanupPlanFromDisk();
	if (scopes.has("state") || scopes.has("workspace")) logBackupRecommendation(runtime);
	if (scopes.has("service")) if (dryRun) runtime.log("[dry-run] remove gateway service");
	else await stopAndUninstallService(runtime);
	if (scopes.has("state")) await removeStateAndLinkedPaths({
		stateDir,
		configPath,
		oauthDir,
		configInsideState,
		oauthInsideState
	}, runtime, { dryRun });
	if (scopes.has("workspace")) await removeWorkspaceDirs(workspaceDirs, runtime, { dryRun });
	if (scopes.has("app")) await removeMacApp(runtime, dryRun);
	runtime.log("CLI still installed. Remove via npm/pnpm if desired.");
	if (scopes.has("state") && !scopes.has("workspace")) {
		const home = resolveHomeDir();
		if (home && workspaceDirs.some((dir) => dir.startsWith(path.resolve(home)))) runtime.log("Tip: workspaces were preserved. Re-run with --workspace to remove them.");
	}
}
//#endregion
//#region src/cli/program/register.maintenance.ts
function registerMaintenanceCommands(program) {
	program.command("doctor").description("Health checks + quick fixes for the gateway and channels").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/doctor", "docs.openclaw.ai/cli/doctor")}\n`).option("--no-workspace-suggestions", "Disable workspace memory system suggestions", false).option("--yes", "Accept defaults without prompting", false).option("--repair", "Apply recommended repairs without prompting", false).option("--fix", "Apply recommended repairs (alias for --repair)", false).option("--force", "Apply aggressive repairs (overwrites custom service config)", false).option("--non-interactive", "Run without prompts (safe migrations only)", false).option("--generate-gateway-token", "Generate and configure a gateway token", false).option("--deep", "Scan system services for extra gateway installs", false).action(async (opts) => {
		await runCommandWithRuntime(defaultRuntime, async () => {
			await doctorCommand(defaultRuntime, {
				workspaceSuggestions: opts.workspaceSuggestions,
				yes: Boolean(opts.yes),
				repair: Boolean(opts.repair) || Boolean(opts.fix),
				force: Boolean(opts.force),
				nonInteractive: Boolean(opts.nonInteractive),
				generateGatewayToken: Boolean(opts.generateGatewayToken),
				deep: Boolean(opts.deep)
			});
			defaultRuntime.exit(0);
		});
	});
	program.command("dashboard").description("Open the Control UI with your current token").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/dashboard", "docs.openclaw.ai/cli/dashboard")}\n`).option("--no-open", "Print URL but do not launch a browser").action(async (opts) => {
		await runCommandWithRuntime(defaultRuntime, async () => {
			await dashboardCommand(defaultRuntime, { noOpen: opts.open === false });
		});
	});
	program.command("reset").description("Reset local config/state (keeps the CLI installed)").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/reset", "docs.openclaw.ai/cli/reset")}\n`).option("--scope <scope>", "config|config+creds+sessions|full (default: interactive prompt)").option("--yes", "Skip confirmation prompts", false).option("--non-interactive", "Disable prompts (requires --scope + --yes)", false).option("--dry-run", "Print actions without removing files", false).action(async (opts) => {
		await runCommandWithRuntime(defaultRuntime, async () => {
			await resetCommand(defaultRuntime, {
				scope: opts.scope,
				yes: Boolean(opts.yes),
				nonInteractive: Boolean(opts.nonInteractive),
				dryRun: Boolean(opts.dryRun)
			});
		});
	});
	program.command("uninstall").description("Uninstall the gateway service + local data (CLI remains)").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/uninstall", "docs.openclaw.ai/cli/uninstall")}\n`).option("--service", "Remove the gateway service", false).option("--state", "Remove state + config", false).option("--workspace", "Remove workspace dirs", false).option("--app", "Remove the macOS app", false).option("--all", "Remove service + state + workspace + app", false).option("--yes", "Skip confirmation prompts", false).option("--non-interactive", "Disable prompts (requires --yes)", false).option("--dry-run", "Print actions without removing files", false).action(async (opts) => {
		await runCommandWithRuntime(defaultRuntime, async () => {
			await uninstallCommand(defaultRuntime, {
				service: Boolean(opts.service),
				state: Boolean(opts.state),
				workspace: Boolean(opts.workspace),
				app: Boolean(opts.app),
				all: Boolean(opts.all),
				yes: Boolean(opts.yes),
				nonInteractive: Boolean(opts.nonInteractive),
				dryRun: Boolean(opts.dryRun)
			});
		});
	});
}
//#endregion
export { registerMaintenanceCommands };
