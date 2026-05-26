import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as sanitizeForLog } from "./ansi-4r6vVvJt.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as formatDocsLink } from "./links-CM5vg8_V.js";
import { n as isRich, r as theme } from "./theme-D58JpUfy.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { l as readBestEffortConfig } from "./io-DoswVvYe.js";
import "./config-B6Oplu5W.js";
import { N as saveExecApprovals, b as readExecApprovalsSnapshot } from "./exec-approvals-Bef7TPVc.js";
import { n as formatTimeAgo } from "./format-relative-Bjc3l98W.js";
import { n as callGatewayFromCli } from "./gateway-rpc-COT1oBPJ.js";
import { t as applyParentDefaultHelpAction } from "./parent-default-help-DQUF3qKA.js";
import { n as renderTable, t as getTerminalTableWidth } from "./table-ockhvL7y.js";
import { t as collectExecPolicyScopeSnapshots } from "./exec-approvals-effective-DvSlJ8_B.js";
import { i as nodesCallOpts, o as resolveNodeId } from "./rpc-Bnf_ycF1.js";
import JSON5 from "json5";
import fs from "node:fs/promises";
//#region src/cli/exec-approvals-cli.ts
const APPROVALS_GET_DEFAULT_TIMEOUT_MS = 6e4;
async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
	return Buffer.concat(chunks).toString("utf8");
}
async function resolveTargetNodeId(opts) {
	if (opts.gateway) return null;
	const raw = normalizeOptionalString(opts.node) ?? "";
	if (!raw) return null;
	return await resolveNodeId(opts, raw);
}
async function loadSnapshot(opts, nodeId) {
	return await callGatewayFromCli(nodeId ? "exec.approvals.node.get" : "exec.approvals.get", opts, nodeId ? { nodeId } : {});
}
function loadSnapshotLocal() {
	const snapshot = readExecApprovalsSnapshot();
	return {
		path: snapshot.path,
		exists: snapshot.exists,
		hash: snapshot.hash,
		file: snapshot.file
	};
}
function saveSnapshotLocal(file) {
	saveExecApprovals(file);
	return loadSnapshotLocal();
}
async function loadSnapshotTarget(opts) {
	if (!opts.gateway && !opts.node) return {
		snapshot: loadSnapshotLocal(),
		nodeId: null,
		source: "local"
	};
	const nodeId = await resolveTargetNodeId(opts);
	return {
		snapshot: await loadSnapshot(opts, nodeId),
		nodeId,
		source: nodeId ? "node" : "gateway"
	};
}
function exitWithError(message) {
	defaultRuntime.error(message);
	defaultRuntime.exit(1);
	throw new Error(message);
}
function requireTrimmedNonEmpty(value, message) {
	const trimmed = value.trim();
	if (!trimmed) exitWithError(message);
	return trimmed;
}
async function loadWritableSnapshotTarget(opts) {
	const { snapshot, nodeId, source } = await loadSnapshotTarget(opts);
	if (source === "local") defaultRuntime.log(theme.muted("Writing local approvals."));
	const targetLabel = source === "local" ? "local" : nodeId ? `node:${nodeId}` : "gateway";
	const baseHash = snapshot.hash;
	if (!baseHash) exitWithError("Exec approvals hash missing; reload and retry.");
	return {
		snapshot,
		nodeId,
		source,
		targetLabel,
		baseHash
	};
}
async function saveSnapshotTargeted(params) {
	const next = params.source === "local" ? saveSnapshotLocal(params.file) : await saveSnapshot(params.opts, params.nodeId, params.file, params.baseHash);
	if (params.opts.json) {
		defaultRuntime.writeJson(next, 0);
		return;
	}
	defaultRuntime.log(theme.muted(`Target: ${params.targetLabel}`));
	renderApprovalsSnapshot(next, params.targetLabel);
}
function formatCliError(err) {
	const msg = formatErrorMessage(err);
	const safe = sanitizeForLog(msg.includes("\n") ? msg.split("\n")[0] : msg);
	return safe.length > 300 ? `${safe.slice(0, 300)}...` : safe;
}
async function loadConfigForApprovalsTarget(params) {
	try {
		if (params.source === "local") return {
			config: await readBestEffortConfig(),
			timedOut: false
		};
		const snapshot = await callGatewayFromCli("config.get", params.opts, {});
		return {
			config: snapshot.config && typeof snapshot.config === "object" ? snapshot.config : null,
			timedOut: false
		};
	} catch (err) {
		return {
			config: null,
			timedOut: /^gateway timeout after \d+ms\b/i.test(formatCliError(err))
		};
	}
}
function buildEffectivePolicyReport(params) {
	const cfg = params.configLoad.config;
	const timeoutNote = params.configLoad.timedOut ? "Config fetch timed out. Re-run with a higher --timeout to inspect Effective Policy." : null;
	if (params.source === "node") {
		if (!cfg) return {
			scopes: [],
			note: timeoutNote ?? "Gateway config unavailable. Node output above shows host approvals state only, and final runtime policy still intersects with gateway tools.exec."
		};
		return {
			scopes: collectExecPolicyScopeSnapshots({
				cfg,
				approvals: params.approvals,
				hostPath: params.hostPath
			}),
			note: "Effective exec policy is the node host approvals file intersected with gateway tools.exec policy."
		};
	}
	if (!cfg) return {
		scopes: [],
		note: timeoutNote ?? "Config unavailable."
	};
	return {
		scopes: collectExecPolicyScopeSnapshots({
			cfg,
			approvals: params.approvals,
			hostPath: params.hostPath
		}),
		note: "Effective exec policy is the host approvals file intersected with requested tools.exec policy."
	};
}
function renderEffectivePolicy(params) {
	const rich = isRich();
	const heading = (text) => rich ? theme.heading(text) : text;
	const muted = (text) => rich ? theme.muted(text) : text;
	if (params.report.scopes.length === 0 && !params.report.note) return;
	defaultRuntime.log("");
	defaultRuntime.log(heading("Effective Policy"));
	if (params.report.scopes.length === 0) {
		defaultRuntime.log(muted(params.report.note ?? "No effective policy details available."));
		return;
	}
	const rows = params.report.scopes.map((summary) => ({
		Scope: summary.scopeLabel,
		Requested: `security=${summary.security.requested} (${summary.security.requestedSource})\nask=${summary.ask.requested} (${summary.ask.requestedSource})`,
		Host: `security=${summary.security.host} (${summary.security.hostSource})\nask=${summary.ask.host} (${summary.ask.hostSource})\naskFallback=${summary.askFallback.effective} (${summary.askFallback.source})`,
		Effective: `security=${summary.security.effective}\nask=${summary.ask.effective}`,
		Notes: `${summary.security.note}; ${summary.ask.note}`
	}));
	defaultRuntime.log(renderTable({
		width: getTerminalTableWidth(),
		columns: [
			{
				key: "Scope",
				header: "Scope",
				minWidth: 12
			},
			{
				key: "Requested",
				header: "Requested",
				minWidth: 24,
				flex: true
			},
			{
				key: "Host",
				header: "Host",
				minWidth: 24,
				flex: true
			},
			{
				key: "Effective",
				header: "Effective",
				minWidth: 16
			},
			{
				key: "Notes",
				header: "Notes",
				minWidth: 20,
				flex: true
			}
		],
		rows
	}).trimEnd());
	defaultRuntime.log("");
	defaultRuntime.log(muted(`Precedence: ${params.report.note}`));
}
function renderApprovalsSnapshot(snapshot, targetLabel) {
	const rich = isRich();
	const heading = (text) => rich ? theme.heading(text) : text;
	const muted = (text) => rich ? theme.muted(text) : text;
	const tableWidth = getTerminalTableWidth();
	const file = snapshot.file ?? { version: 1 };
	const defaults = file.defaults ?? {};
	const defaultsParts = [
		defaults.security ? `security=${defaults.security}` : null,
		defaults.ask ? `ask=${defaults.ask}` : null,
		defaults.askFallback ? `askFallback=${defaults.askFallback}` : null,
		typeof defaults.autoAllowSkills === "boolean" ? `autoAllowSkills=${defaults.autoAllowSkills ? "on" : "off"}` : null
	].filter(Boolean);
	const agents = file.agents ?? {};
	const allowlistRows = [];
	const now = Date.now();
	for (const [agentId, agent] of Object.entries(agents)) {
		const allowlist = Array.isArray(agent.allowlist) ? agent.allowlist : [];
		for (const entry of allowlist) {
			const pattern = normalizeOptionalString(entry?.pattern) ?? "";
			if (!pattern) continue;
			const lastUsedAt = typeof entry.lastUsedAt === "number" ? entry.lastUsedAt : null;
			allowlistRows.push({
				Target: targetLabel,
				Agent: agentId,
				Pattern: pattern,
				LastUsed: lastUsedAt ? formatTimeAgo(Math.max(0, now - lastUsedAt)) : muted("unknown")
			});
		}
	}
	const summaryRows = [
		{
			Field: "Target",
			Value: targetLabel
		},
		{
			Field: "Path",
			Value: snapshot.path
		},
		{
			Field: "Exists",
			Value: snapshot.exists ? "yes" : "no"
		},
		{
			Field: "Hash",
			Value: snapshot.hash
		},
		{
			Field: "Version",
			Value: String(file.version ?? 1)
		},
		{
			Field: "Socket",
			Value: file.socket?.path ?? "default"
		},
		{
			Field: "Defaults",
			Value: defaultsParts.length > 0 ? defaultsParts.join(", ") : "none"
		},
		{
			Field: "Agents",
			Value: String(Object.keys(agents).length)
		},
		{
			Field: "Allowlist",
			Value: String(allowlistRows.length)
		}
	];
	defaultRuntime.log(heading("Approvals"));
	defaultRuntime.log(renderTable({
		width: tableWidth,
		columns: [{
			key: "Field",
			header: "Field",
			minWidth: 8
		}, {
			key: "Value",
			header: "Value",
			minWidth: 24,
			flex: true
		}],
		rows: summaryRows
	}).trimEnd());
	if (allowlistRows.length === 0) {
		defaultRuntime.log("");
		defaultRuntime.log(muted("No allowlist entries."));
		return;
	}
	defaultRuntime.log("");
	defaultRuntime.log(heading("Allowlist"));
	defaultRuntime.log(renderTable({
		width: tableWidth,
		columns: [
			{
				key: "Target",
				header: "Target",
				minWidth: 10
			},
			{
				key: "Agent",
				header: "Agent",
				minWidth: 8
			},
			{
				key: "Pattern",
				header: "Pattern",
				minWidth: 20,
				flex: true
			},
			{
				key: "LastUsed",
				header: "Last Used",
				minWidth: 10
			}
		],
		rows: allowlistRows
	}).trimEnd());
}
async function saveSnapshot(opts, nodeId, file, baseHash) {
	return await callGatewayFromCli(nodeId ? "exec.approvals.node.set" : "exec.approvals.set", opts, nodeId ? {
		nodeId,
		file,
		baseHash
	} : {
		file,
		baseHash
	});
}
function resolveAgentKey(value) {
	const trimmed = normalizeOptionalString(value) ?? "";
	return trimmed ? trimmed : "*";
}
function normalizeAllowlistEntry(entry) {
	const pattern = normalizeOptionalString(entry?.pattern) ?? "";
	return pattern ? pattern : null;
}
function ensureAgent(file, agentKey) {
	const agents = file.agents ?? {};
	const entry = agents[agentKey] ?? {};
	file.agents = agents;
	return entry;
}
function isEmptyAgent(agent) {
	const allowlist = Array.isArray(agent.allowlist) ? agent.allowlist : [];
	return !agent.security && !agent.ask && !agent.askFallback && agent.autoAllowSkills === void 0 && allowlist.length === 0;
}
async function loadWritableAllowlistAgent(opts) {
	const { snapshot, nodeId, source, targetLabel, baseHash } = await loadWritableSnapshotTarget(opts);
	const file = snapshot.file ?? { version: 1 };
	file.version = 1;
	const agentKey = resolveAgentKey(opts.agent);
	const agent = ensureAgent(file, agentKey);
	return {
		nodeId,
		source,
		targetLabel,
		baseHash,
		file,
		agentKey,
		agent,
		allowlistEntries: Array.isArray(agent.allowlist) ? agent.allowlist : []
	};
}
async function runAllowlistMutation(pattern, opts, mutate) {
	try {
		const trimmedPattern = requireTrimmedNonEmpty(pattern, "Pattern required.");
		const context = await loadWritableAllowlistAgent(opts);
		if (!await mutate({
			...context,
			trimmedPattern
		})) return;
		await saveSnapshotTargeted({
			opts,
			source: context.source,
			nodeId: context.nodeId,
			file: context.file,
			baseHash: context.baseHash,
			targetLabel: context.targetLabel
		});
	} catch (err) {
		defaultRuntime.error(formatCliError(err));
		defaultRuntime.exit(1);
	}
}
function registerAllowlistMutationCommand(params) {
	const command = params.allowlist.command(`${params.name} <pattern>`).description(params.description).option("--node <node>", "Target node id/name/IP").option("--gateway", "Force gateway approvals", false).option("--agent <id>", "Agent id (defaults to \"*\")").action(async (pattern, opts) => {
		await runAllowlistMutation(pattern, opts, params.mutate);
	});
	nodesCallOpts(command);
	return command;
}
function registerExecApprovalsCli(program) {
	const formatExample = (cmd, desc) => `  ${theme.command(cmd)}\n    ${theme.muted(desc)}`;
	const approvals = program.command("approvals").alias("exec-approvals").description("Manage exec approvals (gateway or node host)").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/approvals", "docs.openclaw.ai/cli/approvals")}\n`);
	nodesCallOpts(approvals.command("get").description("Fetch exec approvals snapshot").option("--node <node>", "Target node id/name/IP").option("--gateway", "Force gateway approvals", false).action(async (opts) => {
		try {
			const { snapshot, nodeId, source } = await loadSnapshotTarget(opts);
			const effectivePolicy = buildEffectivePolicyReport({
				configLoad: await loadConfigForApprovalsTarget({
					opts,
					source
				}),
				source,
				approvals: snapshot.file,
				hostPath: snapshot.path
			});
			if (opts.json) {
				defaultRuntime.writeJson({
					...snapshot,
					effectivePolicy
				}, 0);
				return;
			}
			const muted = (text) => isRich() ? theme.muted(text) : text;
			if (source === "local") {
				defaultRuntime.log(muted("Showing local approvals."));
				defaultRuntime.log("");
			}
			renderApprovalsSnapshot(snapshot, source === "local" ? "local" : nodeId ? `node:${nodeId}` : "gateway");
			renderEffectivePolicy({ report: effectivePolicy });
		} catch (err) {
			defaultRuntime.error(formatCliError(err));
			defaultRuntime.exit(1);
		}
	}), { timeoutMs: APPROVALS_GET_DEFAULT_TIMEOUT_MS });
	nodesCallOpts(approvals.command("set").description("Replace exec approvals with a JSON file").option("--node <node>", "Target node id/name/IP").option("--gateway", "Force gateway approvals", false).option("--file <path>", "Path to JSON file to upload").option("--stdin", "Read JSON from stdin", false).action(async (opts) => {
		try {
			if (!opts.file && !opts.stdin) exitWithError("Provide --file or --stdin.");
			if (opts.file && opts.stdin) exitWithError("Use either --file or --stdin (not both).");
			const { source, nodeId, targetLabel, baseHash } = await loadWritableSnapshotTarget(opts);
			const raw = opts.stdin ? await readStdin() : await fs.readFile(String(opts.file), "utf8");
			let file;
			try {
				file = JSON5.parse(raw);
			} catch (err) {
				exitWithError(`Failed to parse approvals JSON: ${String(err)}`);
			}
			file.version = 1;
			await saveSnapshotTargeted({
				opts,
				source,
				nodeId,
				file,
				baseHash,
				targetLabel
			});
		} catch (err) {
			defaultRuntime.error(formatCliError(err));
			defaultRuntime.exit(1);
		}
	}));
	const allowlist = approvals.command("allowlist").description("Edit the per-agent allowlist").addHelpText("after", () => `\n${theme.heading("Examples:")}\n${formatExample("openclaw approvals allowlist add \"~/Projects/**/bin/rg\"", "Allowlist a local binary pattern for the main agent.")}\n${formatExample("openclaw approvals allowlist add --agent main --node <id|name|ip> \"/usr/bin/uptime\"", "Allowlist on a specific node/agent.")}\n${formatExample("openclaw approvals allowlist add --agent \"*\" \"/usr/bin/uname\"", "Allowlist for all agents (wildcard).")}\n${formatExample("openclaw approvals allowlist remove \"~/Projects/**/bin/rg\"", "Remove an allowlist pattern.")}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/approvals", "docs.openclaw.ai/cli/approvals")}\n`);
	registerAllowlistMutationCommand({
		allowlist,
		name: "add",
		description: "Add a glob pattern to an allowlist",
		mutate: ({ trimmedPattern, file, agent, agentKey, allowlistEntries }) => {
			if (allowlistEntries.some((entry) => normalizeAllowlistEntry(entry) === trimmedPattern)) {
				defaultRuntime.log("Already allowlisted.");
				return false;
			}
			allowlistEntries.push({
				pattern: trimmedPattern,
				lastUsedAt: Date.now()
			});
			agent.allowlist = allowlistEntries;
			file.agents = {
				...file.agents,
				[agentKey]: agent
			};
			return true;
		}
	});
	registerAllowlistMutationCommand({
		allowlist,
		name: "remove",
		description: "Remove a glob pattern from an allowlist",
		mutate: ({ trimmedPattern, file, agent, agentKey, allowlistEntries }) => {
			const nextEntries = allowlistEntries.filter((entry) => normalizeAllowlistEntry(entry) !== trimmedPattern);
			if (nextEntries.length === allowlistEntries.length) {
				defaultRuntime.log("Pattern not found.");
				return false;
			}
			if (nextEntries.length === 0) delete agent.allowlist;
			else agent.allowlist = nextEntries;
			if (isEmptyAgent(agent)) {
				const agents = { ...file.agents };
				delete agents[agentKey];
				file.agents = Object.keys(agents).length > 0 ? agents : void 0;
			} else file.agents = {
				...file.agents,
				[agentKey]: agent
			};
			return true;
		}
	});
	applyParentDefaultHelpAction(approvals);
}
//#endregion
export { registerExecApprovalsCli };
