import { A as theme, k as isRich, p as defaultRuntime, w as setVerbose } from "./subsystem-DVwhOlEq.js";
import "./paths-BfR2LXbA.js";
import "./boolean-BHdNsbzF.js";
import { G as formatHelpExamples, Jf as capEntryCount, Uf as loadSessionStore, Xf as resolveMaintenanceConfig, Yf as pruneStaleEntries, Zf as enforceSessionDiskBudget, qf as updateSessionStore, zg as loadConfig } from "./auth-profiles-CAw5gP6f.js";
import "./agent-scope-DBEC2O3x.js";
import "./utils-8QNki08A.js";
import "./boundary-file-read-CcBHg_z-.js";
import "./logger-CDI_b4HB.js";
import "./exec-CHkvLtoM.js";
import "./github-copilot-token-CcBrBN3h.js";
import "./registry-B23eaqdH.js";
import "./skills-D75zdym7.js";
import "./frontmatter-BsxcWDrh.js";
import "./env-overrides-DWoj3eoQ.js";
import "./version-N--ZkDj4.js";
import "./search-manager-B1FsI6Ow.js";
import "./plugins-BKDaOrHv.js";
import "./query-expansion-kdDusy7Q.js";
import "./redact-D9pXgQ9w.js";
import { n as runCommandWithRuntime } from "./cli-utils-Cikq4_a8.js";
import "./fetch-ZNxqGXAR.js";
import "./path-alias-guards-Bq601o2U.js";
import "./delivery-queue-O9EZYTUe.js";
import { i as resolveSessionFilePathOptions, r as resolveSessionFilePath } from "./paths-QMxjnO9x.js";
import "./session-cost-usage-6HYiRnfr.js";
import "./prompt-style-2BF77KhS.js";
import { t as formatDocsLink } from "./links-BpBLDDXV.js";
import "./skills-status-DyIMLVt2.js";
import "./dangerous-tools-CjTbQr89.js";
import "./skill-scanner-CREeAGqo.js";
import "./issue-format-jHeRIpoa.js";
import "./channels-status-issues-BMEgAbeb.js";
import { n as parsePositiveIntOrUndefined } from "./helpers-CMntEmit.js";
import "./systemd-DuQVc30D.js";
import "./service-DB3y-xDN.js";
import "./probe-auth-CQpCFrNo.js";
import "./diagnostics-C6sYQF2z.js";
import "./table-D9UWblu1.js";
import { n as statusCommand } from "./status-BcyrXiU7.js";
import { r as healthCommand } from "./health-Dpej8X2i.js";
import "./channel-account-context-DB38RRf7.js";
import "./node-command-policy-Dck2qLDQ.js";
import "./audit-CCNYmynk.js";
import "./node-service-DKCLz93M.js";
import "./status.update-CD0Rwgeu.js";
import { a as resolveSessionDisplayDefaults, c as resolveSessionStoreTargetsOrExit, i as formatSessionModelCell, n as formatSessionFlagsCell, o as resolveSessionDisplayModel, r as formatSessionKeyCell, s as toSessionDisplayRows, sessionsCommand, t as formatSessionAgeCell } from "./sessions-Mnm7nOXU.js";
import fs from "node:fs";
//#region src/commands/sessions-cleanup.ts
const ACTION_PAD = 12;
function resolveSessionCleanupAction(params) {
	if (params.missingKeys.has(params.key)) return "prune-missing";
	if (params.staleKeys.has(params.key)) return "prune-stale";
	if (params.cappedKeys.has(params.key)) return "cap-overflow";
	if (params.budgetEvictedKeys.has(params.key)) return "evict-budget";
	return "keep";
}
function formatCleanupActionCell(action, rich) {
	const label = action.padEnd(ACTION_PAD);
	if (!rich) return label;
	if (action === "keep") return theme.muted(label);
	if (action === "prune-missing") return theme.error(label);
	if (action === "prune-stale") return theme.warn(label);
	if (action === "cap-overflow") return theme.accentBright(label);
	return theme.error(label);
}
function buildActionRows(params) {
	return toSessionDisplayRows(params.beforeStore).map((row) => ({
		...row,
		action: resolveSessionCleanupAction({
			key: row.key,
			missingKeys: params.missingKeys,
			staleKeys: params.staleKeys,
			cappedKeys: params.cappedKeys,
			budgetEvictedKeys: params.budgetEvictedKeys
		})
	}));
}
function pruneMissingTranscriptEntries(params) {
	const sessionPathOpts = resolveSessionFilePathOptions({ storePath: params.storePath });
	let removed = 0;
	for (const [key, entry] of Object.entries(params.store)) {
		if (!entry?.sessionId) continue;
		const transcriptPath = resolveSessionFilePath(entry.sessionId, entry, sessionPathOpts);
		if (!fs.existsSync(transcriptPath)) {
			delete params.store[key];
			removed += 1;
			params.onPruned?.(key);
		}
	}
	return removed;
}
async function previewStoreCleanup(params) {
	const maintenance = resolveMaintenanceConfig();
	const beforeStore = loadSessionStore(params.target.storePath, { skipCache: true });
	const previewStore = structuredClone(beforeStore);
	const staleKeys = /* @__PURE__ */ new Set();
	const cappedKeys = /* @__PURE__ */ new Set();
	const missingKeys = /* @__PURE__ */ new Set();
	const missing = params.fixMissing === true ? pruneMissingTranscriptEntries({
		store: previewStore,
		storePath: params.target.storePath,
		onPruned: (key) => {
			missingKeys.add(key);
		}
	}) : 0;
	const pruned = pruneStaleEntries(previewStore, maintenance.pruneAfterMs, {
		log: false,
		onPruned: ({ key }) => {
			staleKeys.add(key);
		}
	});
	const capped = capEntryCount(previewStore, maintenance.maxEntries, {
		log: false,
		onCapped: ({ key }) => {
			cappedKeys.add(key);
		}
	});
	const beforeBudgetStore = structuredClone(previewStore);
	const diskBudget = await enforceSessionDiskBudget({
		store: previewStore,
		storePath: params.target.storePath,
		activeSessionKey: params.activeKey,
		maintenance,
		warnOnly: false,
		dryRun: true
	});
	const budgetEvictedKeys = /* @__PURE__ */ new Set();
	for (const key of Object.keys(beforeBudgetStore)) if (!Object.hasOwn(previewStore, key)) budgetEvictedKeys.add(key);
	const beforeCount = Object.keys(beforeStore).length;
	const afterPreviewCount = Object.keys(previewStore).length;
	const wouldMutate = missing > 0 || pruned > 0 || capped > 0 || Boolean((diskBudget?.removedEntries ?? 0) > 0 || (diskBudget?.removedFiles ?? 0) > 0);
	return {
		summary: {
			agentId: params.target.agentId,
			storePath: params.target.storePath,
			mode: params.mode,
			dryRun: params.dryRun,
			beforeCount,
			afterCount: afterPreviewCount,
			missing,
			pruned,
			capped,
			diskBudget,
			wouldMutate
		},
		actionRows: buildActionRows({
			beforeStore,
			staleKeys,
			cappedKeys,
			budgetEvictedKeys,
			missingKeys
		})
	};
}
function renderStoreDryRunPlan(params) {
	const rich = isRich();
	if (params.showAgentHeader) params.runtime.log(`Agent: ${params.summary.agentId}`);
	params.runtime.log(`Session store: ${params.summary.storePath}`);
	params.runtime.log(`Maintenance mode: ${params.summary.mode}`);
	params.runtime.log(`Entries: ${params.summary.beforeCount} -> ${params.summary.afterCount} (remove ${params.summary.beforeCount - params.summary.afterCount})`);
	params.runtime.log(`Would prune missing transcripts: ${params.summary.missing}`);
	params.runtime.log(`Would prune stale: ${params.summary.pruned}`);
	params.runtime.log(`Would cap overflow: ${params.summary.capped}`);
	if (params.summary.diskBudget) params.runtime.log(`Would enforce disk budget: ${params.summary.diskBudget.totalBytesBefore} -> ${params.summary.diskBudget.totalBytesAfter} bytes (files ${params.summary.diskBudget.removedFiles}, entries ${params.summary.diskBudget.removedEntries})`);
	if (params.actionRows.length === 0) return;
	params.runtime.log("");
	params.runtime.log("Planned session actions:");
	const header = [
		"Action".padEnd(ACTION_PAD),
		"Key".padEnd(26),
		"Age".padEnd(9),
		"Model".padEnd(14),
		"Flags"
	].join(" ");
	params.runtime.log(rich ? theme.heading(header) : header);
	for (const actionRow of params.actionRows) {
		const model = resolveSessionDisplayModel(params.cfg, actionRow, params.displayDefaults);
		const line = [
			formatCleanupActionCell(actionRow.action, rich),
			formatSessionKeyCell(actionRow.key, rich),
			formatSessionAgeCell(actionRow.updatedAt, rich),
			formatSessionModelCell(model, rich),
			formatSessionFlagsCell(actionRow, rich)
		].join(" ");
		params.runtime.log(line.trimEnd());
	}
}
async function sessionsCleanupCommand(opts, runtime) {
	const cfg = loadConfig();
	const displayDefaults = resolveSessionDisplayDefaults(cfg);
	const mode = opts.enforce ? "enforce" : resolveMaintenanceConfig().mode;
	const targets = resolveSessionStoreTargetsOrExit({
		cfg,
		opts: {
			store: opts.store,
			agent: opts.agent,
			allAgents: opts.allAgents
		},
		runtime
	});
	if (!targets) return;
	const previewResults = [];
	for (const target of targets) {
		const result = await previewStoreCleanup({
			target,
			mode,
			dryRun: Boolean(opts.dryRun),
			activeKey: opts.activeKey,
			fixMissing: Boolean(opts.fixMissing)
		});
		previewResults.push(result);
	}
	if (opts.dryRun) {
		if (opts.json) {
			if (previewResults.length === 1) {
				runtime.log(JSON.stringify(previewResults[0]?.summary ?? {}, null, 2));
				return;
			}
			runtime.log(JSON.stringify({
				allAgents: true,
				mode,
				dryRun: true,
				stores: previewResults.map((result) => result.summary)
			}, null, 2));
			return;
		}
		for (let i = 0; i < previewResults.length; i += 1) {
			const result = previewResults[i];
			if (i > 0) runtime.log("");
			renderStoreDryRunPlan({
				cfg,
				summary: result.summary,
				actionRows: result.actionRows,
				displayDefaults,
				runtime,
				showAgentHeader: previewResults.length > 1
			});
		}
		return;
	}
	const appliedSummaries = [];
	for (const target of targets) {
		const appliedReportRef = { current: null };
		const missingApplied = await updateSessionStore(target.storePath, async (store) => {
			if (!opts.fixMissing) return 0;
			return pruneMissingTranscriptEntries({
				store,
				storePath: target.storePath
			});
		}, {
			activeSessionKey: opts.activeKey,
			maintenanceOverride: { mode },
			onMaintenanceApplied: (report) => {
				appliedReportRef.current = report;
			}
		});
		const afterStore = loadSessionStore(target.storePath, { skipCache: true });
		const preview = previewResults.find((result) => result.summary.storePath === target.storePath);
		const appliedReport = appliedReportRef.current;
		const summary = appliedReport === null ? {
			...preview?.summary ?? {
				agentId: target.agentId,
				storePath: target.storePath,
				mode,
				dryRun: false,
				beforeCount: 0,
				afterCount: 0,
				missing: 0,
				pruned: 0,
				capped: 0,
				diskBudget: null,
				wouldMutate: false
			},
			dryRun: false,
			applied: true,
			appliedCount: Object.keys(afterStore).length
		} : {
			agentId: target.agentId,
			storePath: target.storePath,
			mode: appliedReport.mode,
			dryRun: false,
			beforeCount: appliedReport.beforeCount,
			afterCount: appliedReport.afterCount,
			missing: missingApplied,
			pruned: appliedReport.pruned,
			capped: appliedReport.capped,
			diskBudget: appliedReport.diskBudget,
			wouldMutate: missingApplied > 0 || appliedReport.pruned > 0 || appliedReport.capped > 0 || Boolean((appliedReport.diskBudget?.removedEntries ?? 0) > 0 || (appliedReport.diskBudget?.removedFiles ?? 0) > 0),
			applied: true,
			appliedCount: Object.keys(afterStore).length
		};
		appliedSummaries.push(summary);
	}
	if (opts.json) {
		if (appliedSummaries.length === 1) {
			runtime.log(JSON.stringify(appliedSummaries[0] ?? {}, null, 2));
			return;
		}
		runtime.log(JSON.stringify({
			allAgents: true,
			mode,
			dryRun: false,
			stores: appliedSummaries
		}, null, 2));
		return;
	}
	for (let i = 0; i < appliedSummaries.length; i += 1) {
		const summary = appliedSummaries[i];
		if (i > 0) runtime.log("");
		if (appliedSummaries.length > 1) runtime.log(`Agent: ${summary.agentId}`);
		runtime.log(`Session store: ${summary.storePath}`);
		runtime.log(`Applied maintenance. Current entries: ${summary.appliedCount ?? 0}`);
	}
}
//#endregion
//#region src/cli/program/register.status-health-sessions.ts
function resolveVerbose(opts) {
	return Boolean(opts.verbose || opts.debug);
}
function parseTimeoutMs(timeout) {
	const parsed = parsePositiveIntOrUndefined(timeout);
	if (timeout !== void 0 && parsed === void 0) {
		defaultRuntime.error("--timeout must be a positive integer (milliseconds)");
		defaultRuntime.exit(1);
		return null;
	}
	return parsed;
}
async function runWithVerboseAndTimeout(opts, action) {
	const verbose = resolveVerbose(opts);
	setVerbose(verbose);
	const timeoutMs = parseTimeoutMs(opts.timeout);
	if (timeoutMs === null) return;
	await runCommandWithRuntime(defaultRuntime, async () => {
		await action({
			verbose,
			timeoutMs
		});
	});
}
function registerStatusHealthSessionsCommands(program) {
	program.command("status").description("Show channel health and recent session recipients").option("--json", "Output JSON instead of text", false).option("--all", "Full diagnosis (read-only, pasteable)", false).option("--usage", "Show model provider usage/quota snapshots", false).option("--deep", "Probe channels (WhatsApp Web + Telegram + Discord + Slack + Signal)", false).option("--timeout <ms>", "Probe timeout in milliseconds", "10000").option("--verbose", "Verbose logging", false).option("--debug", "Alias for --verbose", false).addHelpText("after", () => `\n${theme.heading("Examples:")}\n${formatHelpExamples([
		["openclaw status", "Show channel health + session summary."],
		["openclaw status --all", "Full diagnosis (read-only)."],
		["openclaw status --json", "Machine-readable output."],
		["openclaw status --usage", "Show model provider usage/quota snapshots."],
		["openclaw status --deep", "Run channel probes (WA + Telegram + Discord + Slack + Signal)."],
		["openclaw status --deep --timeout 5000", "Tighten probe timeout."]
	])}`).addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/status", "docs.openclaw.ai/cli/status")}\n`).action(async (opts) => {
		await runWithVerboseAndTimeout(opts, async ({ verbose, timeoutMs }) => {
			await statusCommand({
				json: Boolean(opts.json),
				all: Boolean(opts.all),
				deep: Boolean(opts.deep),
				usage: Boolean(opts.usage),
				timeoutMs,
				verbose
			}, defaultRuntime);
		});
	});
	program.command("health").description("Fetch health from the running gateway").option("--json", "Output JSON instead of text", false).option("--timeout <ms>", "Connection timeout in milliseconds", "10000").option("--verbose", "Verbose logging", false).option("--debug", "Alias for --verbose", false).addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/health", "docs.openclaw.ai/cli/health")}\n`).action(async (opts) => {
		await runWithVerboseAndTimeout(opts, async ({ verbose, timeoutMs }) => {
			await healthCommand({
				json: Boolean(opts.json),
				timeoutMs,
				verbose
			}, defaultRuntime);
		});
	});
	const sessionsCmd = program.command("sessions").description("List stored conversation sessions").option("--json", "Output as JSON", false).option("--verbose", "Verbose logging", false).option("--store <path>", "Path to session store (default: resolved from config)").option("--agent <id>", "Agent id to inspect (default: configured default agent)").option("--all-agents", "Aggregate sessions across all configured agents", false).option("--active <minutes>", "Only show sessions updated within the past N minutes").addHelpText("after", () => `\n${theme.heading("Examples:")}\n${formatHelpExamples([
		["openclaw sessions", "List all sessions."],
		["openclaw sessions --agent work", "List sessions for one agent."],
		["openclaw sessions --all-agents", "Aggregate sessions across agents."],
		["openclaw sessions --active 120", "Only last 2 hours."],
		["openclaw sessions --json", "Machine-readable output."],
		["openclaw sessions --store ./tmp/sessions.json", "Use a specific session store."]
	])}\n\n${theme.muted("Shows token usage per session when the agent reports it; set agents.defaults.contextTokens to cap the window and show %.")}`).addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/sessions", "docs.openclaw.ai/cli/sessions")}\n`).action(async (opts) => {
		setVerbose(Boolean(opts.verbose));
		await sessionsCommand({
			json: Boolean(opts.json),
			store: opts.store,
			agent: opts.agent,
			allAgents: Boolean(opts.allAgents),
			active: opts.active
		}, defaultRuntime);
	});
	sessionsCmd.enablePositionalOptions();
	sessionsCmd.command("cleanup").description("Run session-store maintenance now").option("--store <path>", "Path to session store (default: resolved from config)").option("--agent <id>", "Agent id to maintain (default: configured default agent)").option("--all-agents", "Run maintenance across all configured agents", false).option("--dry-run", "Preview maintenance actions without writing", false).option("--enforce", "Apply maintenance even when configured mode is warn", false).option("--fix-missing", "Remove store entries whose transcript files are missing (bypasses age/count retention)", false).option("--active-key <key>", "Protect this session key from budget-eviction").option("--json", "Output JSON", false).addHelpText("after", () => `\n${theme.heading("Examples:")}\n${formatHelpExamples([
		["openclaw sessions cleanup --dry-run", "Preview stale/cap cleanup."],
		["openclaw sessions cleanup --dry-run --fix-missing", "Also preview pruning entries with missing transcript files."],
		["openclaw sessions cleanup --enforce", "Apply maintenance now."],
		["openclaw sessions cleanup --agent work --dry-run", "Preview one agent store."],
		["openclaw sessions cleanup --all-agents --dry-run", "Preview all agent stores."],
		["openclaw sessions cleanup --enforce --store ./tmp/sessions.json", "Use a specific store."]
	])}`).action(async (opts, command) => {
		const parentOpts = command.parent?.opts();
		await runCommandWithRuntime(defaultRuntime, async () => {
			await sessionsCleanupCommand({
				store: opts.store ?? parentOpts?.store,
				agent: opts.agent ?? parentOpts?.agent,
				allAgents: Boolean(opts.allAgents || parentOpts?.allAgents),
				dryRun: Boolean(opts.dryRun),
				enforce: Boolean(opts.enforce),
				fixMissing: Boolean(opts.fixMissing),
				activeKey: opts.activeKey,
				json: Boolean(opts.json || parentOpts?.json)
			}, defaultRuntime);
		});
	});
}
//#endregion
export { registerStatusHealthSessionsCommands };
