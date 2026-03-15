import "./redact-CPjO5IzK.js";
import "./errors-CHvVoeNX.js";
import "./unhandled-rejections-BUxLQs1F.js";
import "./globals-I5DlBD2D.js";
import "./paths-1qR_mW4i.js";
import { n as isRich, r as theme, t as colorize } from "./theme-UkqnBJaj.js";
import { l as defaultRuntime } from "./subsystem-EnljYYs1.js";
import "./ansi-YpD2Ho3J.js";
import "./boolean-B938tROv.js";
import "./env-Bdj-riuG.js";
import "./warning-filter-xAwZkSAQ.js";
import "./utils-Do8MzKyM.js";
import { t as formatDocsLink } from "./links-Cx-Xmp-Y.js";
import { Bb as loadConfig, Jp as listSandboxContainers, Qv as resolveMainSessionKey, Xp as removeSandboxContainer, Xv as resolveAgentMainSessionKey, Yp as removeSandboxBrowserContainer, im as loadSessionStore, in as formatHelpExamples, qp as listSandboxBrowsers } from "./auth-profiles-DqxBs6Au.js";
import "./plugins-allowlist-CTOQWcBK.js";
import { s as normalizeAnyChannelId } from "./registry-DrRO3PZ7.js";
import { S as parseAgentSessionKey, c as normalizeAgentId, l as normalizeMainKey, r as buildAgentMainSessionKey, u as resolveAgentIdFromSessionKey } from "./session-key-D2lHwVVl.js";
import "./fetch-DM2X1MUS.js";
import "./config-state-Dtu4rsXl.js";
import "./filter-Qe6Ch68_.js";
import "./manifest-registry-CA0yK887.js";
import { fn as INTERNAL_MESSAGE_CHANNEL } from "./method-scopes-DDb5C1xl.js";
import { t as formatCliCommand } from "./command-format-CS805JpF.js";
import "./plugins-CygWjihb.js";
import "./brew-BBTHZkpM.js";
import { i as resolveAgentConfig } from "./agent-scope-tkfLX5MZ.js";
import "./logger-BwHrL168.js";
import "./exec-Fh3CK0qE.js";
import "./env-overrides-ArVaLl04.js";
import "./safe-text-ByhWP-8W.js";
import "./version-Dubp0iGu.js";
import "./config-VO8zzMSR.js";
import { H as resolveSandboxToolPolicyForAgent, z as resolveSandboxConfigForAgent } from "./workspace-dirs-D1oDbsnN.js";
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
import { l as resolveStorePath } from "./paths-YN5WLIkL.js";
import "./session-cost-usage-DeAwWk6A.js";
import "./fetch-CzYOE42F.js";
import "./identity-file-Dh-pAEVE.js";
import { s as formatDurationCompact } from "./account-summary-DtY_0EC1.js";
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
import { confirm } from "@clack/prompts";
//#region src/commands/sandbox-explain.ts
const SANDBOX_DOCS_URL = "https://docs.openclaw.ai/sandbox";
function normalizeExplainSessionKey(params) {
	const raw = (params.session ?? "").trim();
	if (!raw) {return resolveAgentMainSessionKey({
		cfg: params.cfg,
		agentId: params.agentId
	});}
	if (raw.includes(":")) {return raw;}
	if (raw === "global") {return "global";}
	return buildAgentMainSessionKey({
		agentId: params.agentId,
		mainKey: normalizeMainKey(raw)
	});
}
function inferProviderFromSessionKey(params) {
	const parsed = parseAgentSessionKey(params.sessionKey);
	if (!parsed) {return;}
	const rest = parsed.rest.trim();
	if (!rest) {return;}
	const parts = rest.split(":").filter(Boolean);
	if (parts.length === 0) {return;}
	const configuredMainKey = normalizeMainKey(params.cfg.session?.mainKey);
	if (parts[0] === configuredMainKey) {return;}
	const candidate = parts[0]?.trim().toLowerCase();
	if (!candidate) {return;}
	if (candidate === "webchat") {return INTERNAL_MESSAGE_CHANNEL;}
	return normalizeAnyChannelId(candidate) ?? void 0;
}
function resolveActiveChannel(params) {
	const entry = loadSessionStore(resolveStorePath(params.cfg.session?.store, { agentId: params.agentId }))[params.sessionKey];
	const candidate = (entry?.lastChannel ?? entry?.channel ?? entry?.lastProvider ?? entry?.provider ?? "").trim().toLowerCase();
	if (candidate === "webchat") {return INTERNAL_MESSAGE_CHANNEL;}
	const normalized = normalizeAnyChannelId(candidate);
	if (normalized) {return normalized;}
	return inferProviderFromSessionKey({
		cfg: params.cfg,
		sessionKey: params.sessionKey
	});
}
async function sandboxExplainCommand(opts, runtime) {
	const cfg = loadConfig();
	const defaultAgentId = resolveAgentIdFromSessionKey(resolveMainSessionKey(cfg));
	const resolvedAgentId = normalizeAgentId(opts.agent?.trim() ? opts.agent : opts.session?.trim() ? resolveAgentIdFromSessionKey(opts.session) : defaultAgentId);
	const sessionKey = normalizeExplainSessionKey({
		cfg,
		agentId: resolvedAgentId,
		session: opts.session
	});
	const sandboxCfg = resolveSandboxConfigForAgent(cfg, resolvedAgentId);
	const toolPolicy = resolveSandboxToolPolicyForAgent(cfg, resolvedAgentId);
	const mainSessionKey = resolveAgentMainSessionKey({
		cfg,
		agentId: resolvedAgentId
	});
	const sessionIsSandboxed = sandboxCfg.mode === "all" ? true : sandboxCfg.mode === "off" ? false : sessionKey.trim() !== mainSessionKey.trim();
	const channel = resolveActiveChannel({
		cfg,
		agentId: resolvedAgentId,
		sessionKey
	});
	const agentConfig = resolveAgentConfig(cfg, resolvedAgentId);
	const elevatedGlobal = cfg.tools?.elevated;
	const elevatedAgent = agentConfig?.tools?.elevated;
	const elevatedGlobalEnabled = elevatedGlobal?.enabled !== false;
	const elevatedAgentEnabled = elevatedAgent?.enabled !== false;
	const elevatedEnabled = elevatedGlobalEnabled && elevatedAgentEnabled;
	const globalAllow = channel ? elevatedGlobal?.allowFrom?.[channel] : void 0;
	const agentAllow = channel ? elevatedAgent?.allowFrom?.[channel] : void 0;
	const allowTokens = (values) => (values ?? []).map((v) => String(v).trim()).filter(Boolean);
	const globalAllowTokens = allowTokens(globalAllow);
	const agentAllowTokens = allowTokens(agentAllow);
	const elevatedAllowedByConfig = elevatedEnabled && Boolean(channel) && globalAllowTokens.length > 0 && (elevatedAgent?.allowFrom ? agentAllowTokens.length > 0 : true);
	const elevatedAlwaysAllowedByConfig = elevatedAllowedByConfig && globalAllowTokens.includes("*") && (elevatedAgent?.allowFrom ? agentAllowTokens.includes("*") : true);
	const elevatedFailures = [];
	if (!elevatedGlobalEnabled) {elevatedFailures.push({
		gate: "enabled",
		key: "tools.elevated.enabled"
	});}
	if (!elevatedAgentEnabled) {elevatedFailures.push({
		gate: "enabled",
		key: "agents.list[].tools.elevated.enabled"
	});}
	if (channel && globalAllowTokens.length === 0) {elevatedFailures.push({
		gate: "allowFrom",
		key: `tools.elevated.allowFrom.${channel}`
	});}
	if (channel && elevatedAgent?.allowFrom && agentAllowTokens.length === 0) {elevatedFailures.push({
		gate: "allowFrom",
		key: `agents.list[].tools.elevated.allowFrom.${channel}`
	});}
	const fixIt = [];
	if (sandboxCfg.mode !== "off") {
		fixIt.push("agents.defaults.sandbox.mode=off");
		fixIt.push("agents.list[].sandbox.mode=off");
	}
	fixIt.push("tools.sandbox.tools.allow");
	fixIt.push("tools.sandbox.tools.deny");
	fixIt.push("agents.list[].tools.sandbox.tools.allow");
	fixIt.push("agents.list[].tools.sandbox.tools.deny");
	fixIt.push("tools.elevated.enabled");
	if (channel) {fixIt.push(`tools.elevated.allowFrom.${channel}`);}
	const payload = {
		docsUrl: SANDBOX_DOCS_URL,
		agentId: resolvedAgentId,
		sessionKey,
		mainSessionKey,
		sandbox: {
			mode: sandboxCfg.mode,
			scope: sandboxCfg.scope,
			perSession: sandboxCfg.scope === "session",
			workspaceAccess: sandboxCfg.workspaceAccess,
			workspaceRoot: sandboxCfg.workspaceRoot,
			sessionIsSandboxed,
			tools: {
				allow: toolPolicy.allow,
				deny: toolPolicy.deny,
				sources: toolPolicy.sources
			}
		},
		elevated: {
			enabled: elevatedEnabled,
			channel,
			allowedByConfig: elevatedAllowedByConfig,
			alwaysAllowedByConfig: elevatedAlwaysAllowedByConfig,
			allowFrom: {
				global: channel ? globalAllowTokens : void 0,
				agent: elevatedAgent?.allowFrom && channel ? agentAllowTokens : void 0
			},
			failures: elevatedFailures
		},
		fixIt
	};
	if (opts.json) {
		runtime.log(`${JSON.stringify(payload, null, 2)}\n`);
		return;
	}
	const rich = isRich();
	const heading = (value) => colorize(rich, theme.heading, value);
	const key = (value) => colorize(rich, theme.muted, value);
	const value = (val) => colorize(rich, theme.info, val);
	const ok = (val) => colorize(rich, theme.success, val);
	const warn = (val) => colorize(rich, theme.warn, val);
	const err = (val) => colorize(rich, theme.error, val);
	const bool = (flag) => flag ? ok("true") : err("false");
	const lines = [];
	lines.push(heading("Effective sandbox:"));
	lines.push(`  ${key("agentId:")} ${value(payload.agentId)}`);
	lines.push(`  ${key("sessionKey:")} ${value(payload.sessionKey)}`);
	lines.push(`  ${key("mainSessionKey:")} ${value(payload.mainSessionKey)}`);
	lines.push(`  ${key("runtime:")} ${payload.sandbox.sessionIsSandboxed ? warn("sandboxed") : ok("direct")}`);
	lines.push(`  ${key("mode:")} ${value(payload.sandbox.mode)} ${key("scope:")} ${value(payload.sandbox.scope)} ${key("perSession:")} ${bool(payload.sandbox.perSession)}`);
	lines.push(`  ${key("workspaceAccess:")} ${value(payload.sandbox.workspaceAccess)} ${key("workspaceRoot:")} ${value(payload.sandbox.workspaceRoot)}`);
	lines.push("");
	lines.push(heading("Sandbox tool policy:"));
	lines.push(`  ${key(`allow (${payload.sandbox.tools.sources.allow.source}):`)} ${value(payload.sandbox.tools.allow.join(", ") || "(empty)")}`);
	lines.push(`  ${key(`deny  (${payload.sandbox.tools.sources.deny.source}):`)} ${value(payload.sandbox.tools.deny.join(", ") || "(empty)")}`);
	lines.push("");
	lines.push(heading("Elevated:"));
	lines.push(`  ${key("enabled:")} ${bool(payload.elevated.enabled)}`);
	lines.push(`  ${key("channel:")} ${value(payload.elevated.channel ?? "(unknown)")}`);
	lines.push(`  ${key("allowedByConfig:")} ${bool(payload.elevated.allowedByConfig)}`);
	if (payload.elevated.failures.length > 0) {lines.push(`  ${key("failing gates:")} ${warn(payload.elevated.failures.map((f) => `${f.gate} (${f.key})`).join(", "))}`);}
	if (payload.sandbox.mode === "non-main" && payload.sandbox.sessionIsSandboxed) {
		lines.push("");
		lines.push(`${warn("Hint:")} sandbox mode is non-main; use main session key to run direct: ${value(payload.mainSessionKey)}`);
	}
	lines.push("");
	lines.push(heading("Fix-it:"));
	for (const key of payload.fixIt) {lines.push(`  - ${key}`);}
	lines.push("");
	lines.push(`${key("Docs:")} ${formatDocsLink("/sandbox", "docs.openclaw.ai/sandbox")}`);
	runtime.log(`${lines.join("\n")}\n`);
}
//#endregion
//#region src/commands/sandbox-formatters.ts
/**
* Formatting utilities for sandbox CLI output
*/
function formatStatus(running) {
	return running ? "🟢 running" : "⚫ stopped";
}
function formatSimpleStatus(running) {
	return running ? "running" : "stopped";
}
function formatImageMatch(matches) {
	return matches ? "✓" : "⚠️  mismatch";
}
//#endregion
//#region src/commands/sandbox-display.ts
function displayItems(items, config, runtime) {
	if (items.length === 0) {
		runtime.log(config.emptyMessage);
		return;
	}
	runtime.log(`\n${config.title}\n`);
	for (const item of items) {config.renderItem(item, runtime);}
}
function displayContainers(containers, runtime) {
	displayItems(containers, {
		emptyMessage: "No sandbox runtimes found.",
		title: "📦 Sandbox Runtimes:",
		renderItem: (container, rt) => {
			rt.log(`  ${container.runtimeLabel ?? container.containerName}`);
			rt.log(`    Status:  ${formatStatus(container.running)}`);
			rt.log(`    ${container.configLabelKind ?? "Image"}:   ${container.image} ${formatImageMatch(container.imageMatch)}`);
			rt.log(`    Backend: ${container.backendId ?? "docker"}`);
			rt.log(`    Age:     ${formatDurationCompact(Date.now() - container.createdAtMs, { spaced: true }) ?? "0s"}`);
			rt.log(`    Idle:    ${formatDurationCompact(Date.now() - container.lastUsedAtMs, { spaced: true }) ?? "0s"}`);
			rt.log(`    Session: ${container.sessionKey}`);
			rt.log("");
		}
	}, runtime);
}
function displayBrowsers(browsers, runtime) {
	displayItems(browsers, {
		emptyMessage: "No sandbox browser containers found.",
		title: "🌐 Sandbox Browser Containers:",
		renderItem: (browser, rt) => {
			rt.log(`  ${browser.containerName}`);
			rt.log(`    Status:  ${formatStatus(browser.running)}`);
			rt.log(`    Image:   ${browser.image} ${formatImageMatch(browser.imageMatch)}`);
			rt.log(`    CDP:     ${browser.cdpPort}`);
			if (browser.noVncPort) {rt.log(`    noVNC:   ${browser.noVncPort}`);}
			rt.log(`    Age:     ${formatDurationCompact(Date.now() - browser.createdAtMs, { spaced: true }) ?? "0s"}`);
			rt.log(`    Idle:    ${formatDurationCompact(Date.now() - browser.lastUsedAtMs, { spaced: true }) ?? "0s"}`);
			rt.log(`    Session: ${browser.sessionKey}`);
			rt.log("");
		}
	}, runtime);
}
function displaySummary(containers, browsers, runtime) {
	const totalCount = containers.length + browsers.length;
	const runningCount = containers.filter((c) => c.running).length + browsers.filter((b) => b.running).length;
	const mismatchCount = containers.filter((c) => !c.imageMatch).length + browsers.filter((b) => !b.imageMatch).length;
	runtime.log(`Total: ${totalCount} (${runningCount} running)`);
	if (mismatchCount > 0) {
		runtime.log(`\n⚠️  ${mismatchCount} runtime(s) with config mismatch detected.`);
		runtime.log(`   Run '${formatCliCommand("openclaw sandbox recreate --all")}' to update all runtimes.`);
	}
}
function displayRecreatePreview(containers, browsers, runtime) {
	runtime.log("\nSandbox runtimes to be recreated:\n");
	if (containers.length > 0) {
		runtime.log("📦 Sandbox Runtimes:");
		for (const container of containers) {runtime.log(`  - ${container.runtimeLabel ?? container.containerName} [${container.backendId ?? "docker"}] (${formatSimpleStatus(container.running)})`);}
	}
	if (browsers.length > 0) {
		runtime.log("\n🌐 Browser Containers:");
		for (const browser of browsers) {runtime.log(`  - ${browser.containerName} (${formatSimpleStatus(browser.running)})`);}
	}
	const total = containers.length + browsers.length;
	runtime.log(`\nTotal: ${total} runtime(s)`);
}
function displayRecreateResult(result, runtime) {
	runtime.log(`\nDone: ${result.successCount} removed, ${result.failCount} failed`);
	if (result.successCount > 0) {runtime.log("\nRuntimes will be automatically recreated when the agent is next used.");}
}
//#endregion
//#region src/commands/sandbox.ts
async function sandboxListCommand(opts, runtime) {
	const containers = opts.browser ? [] : await listSandboxContainers().catch(() => []);
	const browsers = opts.browser ? await listSandboxBrowsers().catch(() => []) : [];
	if (opts.json) {
		runtime.log(JSON.stringify({
			containers,
			browsers
		}, null, 2));
		return;
	}
	if (opts.browser) {displayBrowsers(browsers, runtime);}
	else {displayContainers(containers, runtime);}
	displaySummary(containers, browsers, runtime);
}
async function sandboxRecreateCommand(opts, runtime) {
	if (!validateRecreateOptions(opts, runtime)) {return;}
	const filtered = await fetchAndFilterContainers(opts);
	if (filtered.containers.length + filtered.browsers.length === 0) {
		runtime.log("No sandbox runtimes found matching the criteria.");
		return;
	}
	displayRecreatePreview(filtered.containers, filtered.browsers, runtime);
	if (!opts.force && !await confirmRecreate()) {
		runtime.log("Cancelled.");
		return;
	}
	const result = await removeContainers(filtered, runtime);
	displayRecreateResult(result, runtime);
	if (result.failCount > 0) {runtime.exit(1);}
}
function validateRecreateOptions(opts, runtime) {
	if (!opts.all && !opts.session && !opts.agent) {
		runtime.error("Please specify --all, --session <key>, or --agent <id>");
		runtime.exit(1);
		return false;
	}
	if ([
		opts.all,
		opts.session,
		opts.agent
	].filter(Boolean).length > 1) {
		runtime.error("Please specify only one of: --all, --session, --agent");
		runtime.exit(1);
		return false;
	}
	return true;
}
async function fetchAndFilterContainers(opts) {
	const allContainers = await listSandboxContainers().catch(() => []);
	const allBrowsers = await listSandboxBrowsers().catch(() => []);
	let containers = opts.browser ? [] : allContainers;
	let browsers = opts.browser ? allBrowsers : [];
	if (opts.session) {
		containers = containers.filter((c) => c.sessionKey === opts.session);
		browsers = browsers.filter((b) => b.sessionKey === opts.session);
	} else if (opts.agent) {
		const matchesAgent = createAgentMatcher(opts.agent);
		containers = containers.filter(matchesAgent);
		browsers = browsers.filter(matchesAgent);
	}
	return {
		containers,
		browsers
	};
}
function createAgentMatcher(agentId) {
	const agentPrefix = `agent:${agentId}`;
	return (item) => item.sessionKey === agentPrefix || item.sessionKey.startsWith(`${agentPrefix}:`);
}
async function confirmRecreate() {
	const result = await confirm({
		message: "This will stop and remove these containers. Continue?",
		initialValue: false
	});
	return result !== false && result !== Symbol.for("clack:cancel");
}
async function removeContainers(filtered, runtime) {
	runtime.log("\nRemoving sandbox runtimes...\n");
	let successCount = 0;
	let failCount = 0;
	for (const container of filtered.containers) {if ((await removeContainer(container.containerName, removeSandboxContainer, runtime)).success) successCount++;
	else failCount++;}
	for (const browser of filtered.browsers) {if ((await removeContainer(browser.containerName, removeSandboxBrowserContainer, runtime)).success) successCount++;
	else failCount++;}
	return {
		successCount,
		failCount
	};
}
async function removeContainer(containerName, removeFn, runtime) {
	try {
		await removeFn(containerName);
		runtime.log(`✓ Removed ${containerName}`);
		return { success: true };
	} catch (err) {
		runtime.error(`✗ Failed to remove ${containerName}: ${String(err)}`);
		return { success: false };
	}
}
//#endregion
//#region src/cli/sandbox-cli.ts
const SANDBOX_EXAMPLES = {
	main: [
		["openclaw sandbox list", "List all sandbox containers."],
		["openclaw sandbox list --browser", "List only browser containers."],
		["openclaw sandbox recreate --all", "Recreate all containers."],
		["openclaw sandbox recreate --session main", "Recreate a specific session."],
		["openclaw sandbox recreate --agent mybot", "Recreate agent containers."],
		["openclaw sandbox explain", "Explain effective sandbox config."]
	],
	list: [
		["openclaw sandbox list", "List all sandbox containers."],
		["openclaw sandbox list --browser", "List only browser containers."],
		["openclaw sandbox list --json", "JSON output."]
	],
	recreate: [
		["openclaw sandbox recreate --all", "Recreate all containers."],
		["openclaw sandbox recreate --session main", "Recreate a specific session."],
		["openclaw sandbox recreate --agent mybot", "Recreate a specific agent (includes sub-agents)."],
		["openclaw sandbox recreate --browser --all", "Recreate only browser containers."],
		["openclaw sandbox recreate --all --force", "Skip confirmation."]
	],
	explain: [
		["openclaw sandbox explain", "Show effective sandbox config."],
		["openclaw sandbox explain --session agent:main:main", "Explain a specific session."],
		["openclaw sandbox explain --agent work", "Explain an agent sandbox."],
		["openclaw sandbox explain --json", "JSON output."]
	]
};
function createRunner(commandFn) {
	return async (opts) => {
		try {
			await commandFn(opts, defaultRuntime);
		} catch (err) {
			defaultRuntime.error(String(err));
			defaultRuntime.exit(1);
		}
	};
}
function registerSandboxCli(program) {
	const sandbox = program.command("sandbox").description("Manage sandbox containers (Docker-based agent isolation)").addHelpText("after", () => `\n${theme.heading("Examples:")}\n${formatHelpExamples(SANDBOX_EXAMPLES.main)}\n`).addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/sandbox", "docs.openclaw.ai/cli/sandbox")}\n`).action(() => {
		sandbox.help({ error: true });
	});
	sandbox.command("list").description("List sandbox containers and their status").option("--json", "Output result as JSON", false).option("--browser", "List browser containers only", false).addHelpText("after", () => `\n${theme.heading("Examples:")}\n${formatHelpExamples(SANDBOX_EXAMPLES.list)}\n\n${theme.heading("Output includes:")}\n${theme.muted("- Container name and status (running/stopped)")}\n${theme.muted("- Docker image and whether it matches current config")}\n${theme.muted("- Age (time since creation)")}\n${theme.muted("- Idle time (time since last use)")}\n${theme.muted("- Associated session/agent ID")}`).action(createRunner((opts) => sandboxListCommand({
		browser: Boolean(opts.browser),
		json: Boolean(opts.json)
	}, defaultRuntime)));
	sandbox.command("recreate").description("Remove containers to force recreation with updated config").option("--all", "Recreate all sandbox containers", false).option("--session <key>", "Recreate container for specific session").option("--agent <id>", "Recreate containers for specific agent").option("--browser", "Only recreate browser containers", false).option("--force", "Skip confirmation prompt", false).addHelpText("after", () => `\n${theme.heading("Examples:")}\n${formatHelpExamples(SANDBOX_EXAMPLES.recreate)}\n\n${theme.heading("Why use this?")}\n${theme.muted("After updating Docker images or sandbox configuration, existing containers continue running with old settings.")}\n${theme.muted("This command removes them so they'll be recreated automatically with current config when next needed.")}\n\n${theme.heading("Filter options:")}\n${theme.muted("  --all          Remove all sandbox containers")}\n${theme.muted("  --session      Remove container for specific session key")}\n${theme.muted("  --agent        Remove containers for agent (includes agent:id:* variants)")}\n\n${theme.heading("Modifiers:")}\n${theme.muted("  --browser      Only affect browser containers (not regular sandbox)")}\n${theme.muted("  --force        Skip confirmation prompt")}`).action(createRunner((opts) => sandboxRecreateCommand({
		all: Boolean(opts.all),
		session: opts.session,
		agent: opts.agent,
		browser: Boolean(opts.browser),
		force: Boolean(opts.force)
	}, defaultRuntime)));
	sandbox.command("explain").description("Explain effective sandbox/tool policy for a session/agent").option("--session <key>", "Session key to inspect (defaults to agent main)").option("--agent <id>", "Agent id to inspect (defaults to derived agent)").option("--json", "Output result as JSON", false).addHelpText("after", () => `\n${theme.heading("Examples:")}\n${formatHelpExamples(SANDBOX_EXAMPLES.explain)}\n`).action(createRunner((opts) => sandboxExplainCommand({
		session: opts.session,
		agent: opts.agent,
		json: Boolean(opts.json)
	}, defaultRuntime)));
}
//#endregion
export { registerSandboxCli };
