import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { t as formatDocsLink } from "./links-CM5vg8_V.js";
import { r as theme } from "./theme-D58JpUfy.js";
import { g as shortenHomePath } from "./utils-sBTEdeml.js";
import "./agent-scope-CtLXGcWm.js";
import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { i as getRuntimeConfig, u as readConfigFileSnapshot } from "./io-DoswVvYe.js";
import { i as replaceConfigFile } from "./mutate-DLC8bveh.js";
import "./config-B6Oplu5W.js";
import { t as ADMIN_SCOPE } from "./operator-scopes-DGvgHuOd.js";
import "./method-scopes-D4RcH8qD.js";
import { r as callGateway } from "./call-t1U2G3yY.js";
import { i as invokeNativeHookRelayBridge, o as renderNativeHookRelayUnavailableResponse } from "./native-hook-relay-CKQJJkrR.js";
import { a as resolveHookEntries } from "./config-CRTtlu4C.js";
import { a as buildPluginDiagnosticsReport } from "./status-BvY0BMpM.js";
import { n as decorativePrefix, t as decorativeEmoji } from "./decorative-emoji-C7cb8Cby.js";
import { n as renderTable, t as getTerminalTableWidth } from "./table-ockhvL7y.js";
import { t as loadWorkspaceHookEntries } from "./workspace-CWRVtjYM.js";
import { t as buildWorkspaceHookStatus } from "./hooks-status-CCLCPEft.js";
import { n as runPluginInstallCommand } from "./plugins-install-command-BE8sb-tM.js";
import { t as runPluginUpdateCommand } from "./plugins-update-command-m6gaJCWy.js";
import "node:stream";
//#region src/cli/native-hook-relay-cli.ts
const MAX_NATIVE_HOOK_STDIN_BYTES = 1024 * 1024;
async function runNativeHookRelayCli(opts, deps = {}) {
	const stdin = deps.stdin ?? process.stdin;
	const stdout = deps.stdout ?? process.stdout;
	const stderr = deps.stderr ?? process.stderr;
	const callGatewayFn = deps.callGateway ?? callGateway;
	const provider = readRequiredOption(opts.provider, "provider");
	const relayId = readRequiredOption(opts.relayId, "relay-id");
	const event = readRequiredOption(opts.event, "event");
	let rawPayload;
	try {
		const rawInput = await readStreamText(stdin, MAX_NATIVE_HOOK_STDIN_BYTES);
		rawPayload = rawInput.trim() ? JSON.parse(rawInput) : null;
	} catch (error) {
		writeText(stderr, formatRelayCliError("failed to read native hook input", error));
		return 1;
	}
	try {
		const response = await invokeNativeHookRelayBridge({
			provider,
			relayId,
			event,
			rawPayload,
			registrationTimeoutMs: 100,
			timeoutMs: normalizeTimeoutMs(opts.timeout)
		});
		writeText(stdout, response.stdout);
		writeText(stderr, response.stderr);
		return response.exitCode;
	} catch {}
	try {
		const response = await callGatewayFn({
			method: "nativeHook.invoke",
			params: {
				provider,
				relayId,
				event,
				rawPayload
			},
			timeoutMs: normalizeTimeoutMs(opts.timeout),
			scopes: [ADMIN_SCOPE]
		});
		writeText(stdout, response.stdout);
		writeText(stderr, response.stderr);
		return response.exitCode;
	} catch (error) {
		writeText(stderr, formatRelayCliError("native hook relay unavailable", error));
		const response = renderNativeHookRelayUnavailableResponse({
			provider,
			event,
			message: "Native hook relay unavailable"
		});
		writeText(stdout, response.stdout);
		writeText(stderr, response.stderr);
		return response.exitCode;
	}
}
function readRequiredOption(value, name) {
	if (typeof value === "string" && value.trim()) return value.trim();
	throw new Error(`Missing required option --${name}`);
}
async function readStreamText(stream, maxBytes) {
	const chunks = [];
	let total = 0;
	for await (const chunk of stream) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.byteLength;
		if (total > maxBytes) throw new Error(`native hook input exceeds ${maxBytes} bytes`);
		chunks.push(buffer);
	}
	return Buffer.concat(chunks, total).toString("utf8");
}
function normalizeTimeoutMs(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 5e3;
}
function writeText(stream, value) {
	if (value) stream.write(value);
}
function formatRelayCliError(prefix, error) {
	return `${prefix}: ${error instanceof Error ? error.message : String(error)}\n`;
}
//#endregion
//#region src/cli/hooks-cli.ts
function mergeHookEntries(pluginEntries, workspaceEntries) {
	return resolveHookEntries([...pluginEntries, ...workspaceEntries]);
}
function buildHooksReport(config) {
	const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
	const workspaceEntries = loadWorkspaceHookEntries(workspaceDir, { config });
	return buildWorkspaceHookStatus(workspaceDir, {
		config,
		entries: mergeHookEntries(buildPluginDiagnosticsReport({
			config,
			workspaceDir
		}).hooks.map((hook) => hook.entry), workspaceEntries)
	});
}
function resolveHookForToggle(report, hookName, opts) {
	const hook = report.hooks.find((h) => h.name === hookName);
	if (!hook) throw new Error(`Hook "${hookName}" not found`);
	if (hook.managedByPlugin) throw new Error(`Hook "${hookName}" is managed by plugin "${hook.pluginId ?? "unknown"}" and cannot be enabled/disabled.`);
	if (opts?.requireEligible && !hook.requirementsSatisfied) throw new Error(`Hook "${hookName}" is not eligible (missing requirements)`);
	return hook;
}
function buildConfigWithHookEnabled(params) {
	const entries = { ...params.config.hooks?.internal?.entries };
	entries[params.hookName] = {
		...entries[params.hookName],
		enabled: params.enabled
	};
	const internal = {
		...params.config.hooks?.internal,
		...params.ensureHooksEnabled ? { enabled: true } : {},
		entries
	};
	return {
		...params.config,
		hooks: {
			...params.config.hooks,
			internal
		}
	};
}
function formatHookStatus(hook) {
	if (hook.loadable) return theme.success("✓ ready");
	if (!hook.enabledByConfig) return theme.warn(decorativePrefix("⏸", "disabled"));
	return theme.error("✗ missing");
}
function formatHookName(hook) {
	const emoji = hook.emoji ?? decorativeEmoji("🔗");
	const name = theme.command(hook.name);
	return emoji ? `${emoji} ${name}` : name;
}
function formatHookSource(hook) {
	if (!hook.managedByPlugin) return hook.source;
	return `plugin:${hook.pluginId ?? "unknown"}`;
}
function formatHookMissingSummary(hook) {
	const missing = [];
	if (hook.missing.bins.length > 0) missing.push(`bins: ${hook.missing.bins.join(", ")}`);
	if (hook.missing.anyBins.length > 0) missing.push(`anyBins: ${hook.missing.anyBins.join(", ")}`);
	if (hook.missing.env.length > 0) missing.push(`env: ${hook.missing.env.join(", ")}`);
	if (hook.missing.config.length > 0) missing.push(`config: ${hook.missing.config.join(", ")}`);
	if (hook.missing.os.length > 0) missing.push(`os: ${hook.missing.os.join(", ")}`);
	return missing.join("; ");
}
function exitHooksCliWithError(err) {
	defaultRuntime.error(`${theme.error("Error:")} ${formatErrorMessage(err)}`);
	process.exit(1);
}
function writeHooksOutput(value, json) {
	if (json) {
		defaultRuntime.writeStdout(value);
		return;
	}
	defaultRuntime.log(value);
}
async function runHooksCliAction(action) {
	try {
		await action();
	} catch (err) {
		exitHooksCliWithError(err);
	}
}
/**
* Format the hooks list output
*/
function formatHooksList(report, opts) {
	const hooks = opts.eligible ? report.hooks.filter((h) => h.loadable) : report.hooks;
	if (opts.json) {
		const jsonReport = {
			workspaceDir: report.workspaceDir,
			managedHooksDir: report.managedHooksDir,
			hooks: hooks.map((h) => ({
				name: h.name,
				description: h.description,
				emoji: h.emoji,
				eligible: h.loadable,
				disabled: !h.enabledByConfig,
				enabledByConfig: h.enabledByConfig,
				requirementsSatisfied: h.requirementsSatisfied,
				loadable: h.loadable,
				blockedReason: h.blockedReason,
				source: h.source,
				pluginId: h.pluginId,
				events: h.events,
				homepage: h.homepage,
				missing: h.missing,
				managedByPlugin: h.managedByPlugin
			}))
		};
		return JSON.stringify(jsonReport, null, 2);
	}
	if (hooks.length === 0) return opts.eligible ? `No eligible hooks found. Run \`${formatCliCommand("openclaw hooks list")}\` to see all hooks.` : "No hooks found.";
	const eligible = hooks.filter((h) => h.loadable);
	const tableWidth = getTerminalTableWidth();
	const rows = hooks.map((hook) => {
		const missing = formatHookMissingSummary(hook);
		return {
			Status: formatHookStatus(hook),
			Hook: formatHookName(hook),
			Description: theme.muted(hook.description),
			Source: formatHookSource(hook),
			Missing: missing ? theme.warn(missing) : ""
		};
	});
	const columns = [
		{
			key: "Status",
			header: "Status",
			minWidth: 10
		},
		{
			key: "Hook",
			header: "Hook",
			minWidth: 18,
			flex: true
		},
		{
			key: "Description",
			header: "Description",
			minWidth: 24,
			flex: true
		},
		{
			key: "Source",
			header: "Source",
			minWidth: 12,
			flex: true
		}
	];
	if (opts.verbose) columns.push({
		key: "Missing",
		header: "Missing",
		minWidth: 18,
		flex: true
	});
	const lines = [];
	lines.push(`${theme.heading("Hooks")} ${theme.muted(`(${eligible.length}/${hooks.length} ready)`)}`);
	lines.push(renderTable({
		width: tableWidth,
		columns,
		rows
	}).trimEnd());
	return lines.join("\n");
}
/**
* Format detailed info for a single hook
*/
function formatHookInfo(report, hookName, opts) {
	const hook = report.hooks.find((h) => h.name === hookName || h.hookKey === hookName);
	if (!hook) {
		if (opts.json) return JSON.stringify({
			error: "not found",
			hook: hookName
		}, null, 2);
		return `Hook "${hookName}" not found. Run \`${formatCliCommand("openclaw hooks list")}\` to see available hooks.`;
	}
	if (opts.json) return JSON.stringify({
		...hook,
		eligible: hook.loadable,
		disabled: !hook.enabledByConfig
	}, null, 2);
	const lines = [];
	const emoji = hook.emoji ?? decorativeEmoji("🔗");
	const status = hook.loadable ? theme.success("✓ Ready") : !hook.enabledByConfig ? theme.warn(decorativePrefix("⏸", "Disabled")) : theme.error("✗ Missing requirements");
	lines.push(`${emoji ? `${emoji} ` : ""}${theme.heading(hook.name)} ${status}`);
	lines.push("");
	lines.push(hook.description);
	lines.push("");
	lines.push(theme.heading("Details:"));
	if (hook.managedByPlugin) lines.push(`${theme.muted("  Source:")} ${hook.source} (${hook.pluginId ?? "unknown"})`);
	else lines.push(`${theme.muted("  Source:")} ${hook.source}`);
	lines.push(`${theme.muted("  Path:")} ${shortenHomePath(hook.filePath)}`);
	lines.push(`${theme.muted("  Handler:")} ${shortenHomePath(hook.handlerPath)}`);
	if (hook.homepage) lines.push(`${theme.muted("  Homepage:")} ${hook.homepage}`);
	if (hook.events.length > 0) lines.push(`${theme.muted("  Events:")} ${hook.events.join(", ")}`);
	if (hook.managedByPlugin) lines.push(theme.muted("  Managed by plugin; enable/disable via hooks CLI not available."));
	if (hook.blockedReason) lines.push(`${theme.muted("  Blocked reason:")} ${hook.blockedReason}`);
	if (hook.requirements.bins.length > 0 || hook.requirements.anyBins.length > 0 || hook.requirements.env.length > 0 || hook.requirements.config.length > 0 || hook.requirements.os.length > 0) {
		lines.push("");
		lines.push(theme.heading("Requirements:"));
		if (hook.requirements.bins.length > 0) {
			const binsStatus = hook.requirements.bins.map((bin) => {
				return hook.missing.bins.includes(bin) ? theme.error(`✗ ${bin}`) : theme.success(`✓ ${bin}`);
			});
			lines.push(`${theme.muted("  Binaries:")} ${binsStatus.join(", ")}`);
		}
		if (hook.requirements.anyBins.length > 0) {
			const anyBinsStatus = hook.missing.anyBins.length > 0 ? theme.error(`✗ (any of: ${hook.requirements.anyBins.join(", ")})`) : theme.success(`✓ (any of: ${hook.requirements.anyBins.join(", ")})`);
			lines.push(`${theme.muted("  Any binary:")} ${anyBinsStatus}`);
		}
		if (hook.requirements.env.length > 0) {
			const envStatus = hook.requirements.env.map((env) => {
				return hook.missing.env.includes(env) ? theme.error(`✗ ${env}`) : theme.success(`✓ ${env}`);
			});
			lines.push(`${theme.muted("  Environment:")} ${envStatus.join(", ")}`);
		}
		if (hook.requirements.config.length > 0) {
			const configStatus = hook.configChecks.map((check) => {
				return check.satisfied ? theme.success(`✓ ${check.path}`) : theme.error(`✗ ${check.path}`);
			});
			lines.push(`${theme.muted("  Config:")} ${configStatus.join(", ")}`);
		}
		if (hook.requirements.os.length > 0) {
			const osStatus = hook.missing.os.length > 0 ? theme.error(`✗ (${hook.requirements.os.join(", ")})`) : theme.success(`✓ (${hook.requirements.os.join(", ")})`);
			lines.push(`${theme.muted("  OS:")} ${osStatus}`);
		}
	}
	return lines.join("\n");
}
/**
* Format check output
*/
function formatHooksCheck(report, opts) {
	if (opts.json) {
		const eligible = report.hooks.filter((h) => h.loadable);
		const notEligible = report.hooks.filter((h) => !h.loadable);
		return JSON.stringify({
			total: report.hooks.length,
			eligible: eligible.length,
			notEligible: notEligible.length,
			hooks: {
				eligible: eligible.map((h) => h.name),
				notEligible: notEligible.map((h) => ({
					name: h.name,
					blockedReason: h.blockedReason,
					missing: h.missing
				}))
			}
		}, null, 2);
	}
	const eligible = report.hooks.filter((h) => h.loadable);
	const notEligible = report.hooks.filter((h) => !h.loadable);
	const lines = [];
	lines.push(theme.heading("Hooks Status"));
	lines.push("");
	lines.push(`${theme.muted("Total hooks:")} ${report.hooks.length}`);
	lines.push(`${theme.success("Ready:")} ${eligible.length}`);
	lines.push(`${theme.warn("Not ready:")} ${notEligible.length}`);
	if (notEligible.length > 0) {
		lines.push("");
		lines.push(theme.heading("Hooks not ready:"));
		for (const hook of notEligible) {
			const reasons = [];
			if (hook.blockedReason && hook.blockedReason !== "missing requirements") reasons.push(hook.blockedReason);
			if (hook.missing.bins.length > 0) reasons.push(`bins: ${hook.missing.bins.join(", ")}`);
			if (hook.missing.anyBins.length > 0) reasons.push(`anyBins: ${hook.missing.anyBins.join(", ")}`);
			if (hook.missing.env.length > 0) reasons.push(`env: ${hook.missing.env.join(", ")}`);
			if (hook.missing.config.length > 0) reasons.push(`config: ${hook.missing.config.join(", ")}`);
			if (hook.missing.os.length > 0) reasons.push(`os: ${hook.missing.os.join(", ")}`);
			const emoji = hook.emoji ?? decorativeEmoji("🔗");
			lines.push(`  ${emoji ? `${emoji} ` : ""}${hook.name} - ${reasons.join("; ")}`);
		}
	}
	return lines.join("\n");
}
async function enableHook(hookName) {
	const snapshot = await readConfigFileSnapshot();
	const config = snapshot.sourceConfig ?? snapshot.config;
	const hook = resolveHookForToggle(buildHooksReport(config), hookName, { requireEligible: true });
	await replaceConfigFile({
		nextConfig: buildConfigWithHookEnabled({
			config,
			hookName,
			enabled: true,
			ensureHooksEnabled: true
		}),
		...snapshot.hash !== void 0 ? { baseHash: snapshot.hash } : {}
	});
	defaultRuntime.log(`${theme.success("✓")} Enabled hook: ${hook.emoji ? `${hook.emoji} ${theme.command(hookName)}` : decorativePrefix("🔗", theme.command(hookName))}`);
}
async function disableHook(hookName) {
	const snapshot = await readConfigFileSnapshot();
	const config = snapshot.sourceConfig ?? snapshot.config;
	const hook = resolveHookForToggle(buildHooksReport(config), hookName);
	await replaceConfigFile({
		nextConfig: buildConfigWithHookEnabled({
			config,
			hookName,
			enabled: false
		}),
		...snapshot.hash !== void 0 ? { baseHash: snapshot.hash } : {}
	});
	defaultRuntime.log(`${theme.warn(decorativePrefix("⏸", "Disabled hook:"))} ${hook.emoji ? `${hook.emoji} ${theme.command(hookName)}` : decorativePrefix("🔗", theme.command(hookName))}`);
}
function registerHooksCli(program) {
	const hooks = program.command("hooks").description("Manage internal agent hooks").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/hooks", "docs.openclaw.ai/cli/hooks")}\n`);
	hooks.command("list").description("List all hooks").option("--eligible", "Show only eligible hooks", false).option("--json", "Output as JSON", false).option("-v, --verbose", "Show more details including missing requirements", false).action(async (opts) => runHooksCliAction(async () => {
		writeHooksOutput(formatHooksList(buildHooksReport(getRuntimeConfig()), opts), opts.json);
	}));
	hooks.command("info <name>").description("Show detailed information about a hook").option("--json", "Output as JSON", false).action(async (name, opts) => runHooksCliAction(async () => {
		writeHooksOutput(formatHookInfo(buildHooksReport(getRuntimeConfig()), name, opts), opts.json);
	}));
	hooks.command("check").description("Check hooks eligibility status").option("--json", "Output as JSON", false).action(async (opts) => runHooksCliAction(async () => {
		writeHooksOutput(formatHooksCheck(buildHooksReport(getRuntimeConfig()), opts), opts.json);
	}));
	hooks.command("enable <name>").description("Enable a hook").action(async (name) => runHooksCliAction(async () => {
		await enableHook(name);
	}));
	hooks.command("disable <name>").description("Disable a hook").action(async (name) => runHooksCliAction(async () => {
		await disableHook(name);
	}));
	hooks.command("relay", { hidden: true }).description("Internal native harness hook relay").requiredOption("--provider <provider>", "Native harness provider").requiredOption("--relay-id <id>", "Native hook relay id").requiredOption("--event <event>", "Native hook event").option("--timeout <ms>", "Gateway timeout in ms", "5000").action(async (opts) => runHooksCliAction(async () => {
		process.exitCode = await runNativeHookRelayCli(opts);
	}));
	hooks.command("install").description("Deprecated: install a hook pack via `openclaw plugins install`").argument("<path-or-spec>", "Path to a hook pack or npm package spec").option("-l, --link", "Link a local path instead of copying", false).option("--pin", "Record npm installs as exact resolved <name>@<version>", false).action(async (raw, opts) => {
		defaultRuntime.log(theme.warn("`openclaw hooks install` is deprecated; use `openclaw plugins install`."));
		await runPluginInstallCommand({
			raw,
			opts
		});
	});
	hooks.command("update").description("Deprecated: update hook packs via `openclaw plugins update`").argument("[id]", "Hook pack id (omit with --all)").option("--all", "Update all tracked hooks", false).option("--dry-run", "Show what would change without writing", false).action(async (id, opts) => {
		defaultRuntime.log(theme.warn("`openclaw hooks update` is deprecated; use `openclaw plugins update`."));
		await runPluginUpdateCommand({
			id,
			opts
		});
	});
	hooks.action(async () => runHooksCliAction(async () => {
		const report = buildHooksReport(getRuntimeConfig());
		defaultRuntime.log(formatHooksList(report, {}));
	}));
}
//#endregion
export { disableHook, enableHook, formatHookInfo, formatHooksCheck, formatHooksList, registerHooksCli };
