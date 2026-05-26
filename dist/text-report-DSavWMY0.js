import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { n as VERSION } from "./version-CQfgAE7_.js";
import { a as buildPairingConnectRecoveryTitle, o as describePairingConnectRequirement } from "./connect-error-details-BNpp20bs.js";
import { t as areRuntimeModelRefsEquivalent } from "./model-runtime-aliases-D35Lx2no.js";
import { n as formatTimeAgo } from "./format-relative-Bjc3l98W.js";
import "./update-control-plane-sentinel-C4970WGr.js";
import "./format-qvQo2sAg.js";
import { u as buildStatusOverviewRowsFromSurface } from "./status-runtime-shared-CC7Iwhf3.js";
import { n as statusChannelsTableColumns, t as buildStatusChannelsTableRows } from "./channels-table-CgZQAI5Q.js";
//#region src/commands/status-overview-values.ts
function countActiveStatusAgents(params) {
	const activeThresholdMs = params.activeThresholdMs ?? 10 * 6e4;
	return params.agentStatus.agents.filter((agent) => agent.lastActiveAgeMs != null && agent.lastActiveAgeMs <= activeThresholdMs).length;
}
function buildStatusAllAgentsValue(params) {
	const activeAgents = countActiveStatusAgents(params);
	return `${params.agentStatus.agents.length} total · ${params.agentStatus.bootstrapPendingCount} bootstrapping · ${activeAgents} active · ${params.agentStatus.totalSessions} sessions`;
}
function buildStatusSecretsValue(count) {
	return count > 0 ? `${count} diagnostic${count === 1 ? "" : "s"}` : "none";
}
function buildStatusEventsValue(params) {
	return params.queuedSystemEvents.length > 0 ? `${params.queuedSystemEvents.length} queued` : "none";
}
function buildStatusProbesValue(params) {
	return params.health ? params.ok("enabled") : params.muted("skipped (use --deep)");
}
function buildStatusPluginCompatibilityValue(params) {
	if (params.notices.length === 0) return params.ok("none");
	const pluginCount = new Set(params.notices.map((notice) => notice.pluginId ?? notice.plugin ?? "")).size;
	return params.warn(`${params.notices.length} notice${params.notices.length === 1 ? "" : "s"} · ${pluginCount} plugin${pluginCount === 1 ? "" : "s"}`);
}
function buildStatusSessionsOverviewValue(params) {
	const defaultCtx = params.sessions.defaults.contextTokens ? ` (${params.formatKTokens(params.sessions.defaults.contextTokens)} ctx)` : "";
	const storeLabel = params.sessions.paths.length > 1 ? `${params.sessions.paths.length} stores` : params.sessions.paths[0] ?? "unknown";
	return `${params.sessions.count} active · default ${params.sessions.defaults.model ?? "unknown"}${defaultCtx} · ${storeLabel}`;
}
//#endregion
//#region src/commands/status.command-sections.ts
const statusHealthColumns = [
	{
		key: "Item",
		header: "Item",
		minWidth: 10
	},
	{
		key: "Status",
		header: "Status",
		minWidth: 8
	},
	{
		key: "Detail",
		header: "Detail",
		flex: true,
		minWidth: 28
	}
];
function buildStatusAgentsValue(params) {
	const pending = params.agentStatus.bootstrapPendingCount > 0 ? `${params.agentStatus.bootstrapPendingCount} bootstrap file${params.agentStatus.bootstrapPendingCount === 1 ? "" : "s"} present` : "no bootstrap files";
	const def = params.agentStatus.agents.find((a) => a.id === params.agentStatus.defaultId);
	const defActive = def?.lastActiveAgeMs != null ? params.formatTimeAgo(def.lastActiveAgeMs) : "unknown";
	const defSuffix = def ? ` · default ${def.id} active ${defActive}` : "";
	return `${params.agentStatus.agents.length} · ${pending} · sessions ${params.agentStatus.totalSessions}${defSuffix}`;
}
function buildStatusTasksValue(params) {
	if (params.summary.tasks.total <= 0) return params.muted("none");
	return [
		`${params.summary.tasks.active} active`,
		`${params.summary.tasks.byStatus.queued} queued`,
		`${params.summary.tasks.byStatus.running} running`,
		params.summary.tasks.failures > 0 ? params.warn(`${params.summary.tasks.failures} issue${params.summary.tasks.failures === 1 ? "" : "s"}`) : params.muted("no issues"),
		params.summary.taskAudit.errors > 0 ? params.warn(`audit ${params.summary.taskAudit.errors} error${params.summary.taskAudit.errors === 1 ? "" : "s"} · ${params.summary.taskAudit.warnings} warn`) : params.summary.taskAudit.warnings > 0 ? params.muted(`audit ${params.summary.taskAudit.warnings} warn`) : params.muted("audit clean"),
		`${params.summary.tasks.total} tracked`
	].join(" · ");
}
function buildStatusHeartbeatValue(params) {
	const parts = params.summary.heartbeat.agents.map((agent) => {
		if (!agent.enabled || !agent.everyMs) return `disabled (${agent.agentId})`;
		return `${agent.every} (${agent.agentId})`;
	}).filter(Boolean);
	return parts.length > 0 ? parts.join(", ") : "disabled";
}
function buildStatusLastHeartbeatValue(params) {
	if (!params.deep) return null;
	if (!params.gatewayReachable) return params.warn("unavailable");
	if (!params.lastHeartbeat) return params.muted("none");
	const age = params.formatTimeAgo(Date.now() - params.lastHeartbeat.ts);
	const channel = params.lastHeartbeat.channel ?? "unknown";
	const accountLabel = params.lastHeartbeat.accountId ? `account ${params.lastHeartbeat.accountId}` : null;
	return [
		params.lastHeartbeat.status,
		`${age} ago`,
		channel,
		accountLabel
	].filter(Boolean).join(" · ");
}
function buildStatusMemoryValue(params) {
	if (!params.memoryPlugin.enabled) {
		const suffix = params.memoryPlugin.reason ? ` (${params.memoryPlugin.reason})` : "";
		return params.muted(`disabled${suffix}`);
	}
	if (!params.memory) {
		const slot = params.memoryPlugin.slot ? `plugin ${params.memoryPlugin.slot}` : "plugin";
		return params.muted(`enabled (${slot}) · ${params.memoryUnavailableLabel ?? "unavailable"}`);
	}
	const parts = [];
	const dirtySuffix = params.memory.dirty ? ` · ${params.warn("dirty")}` : "";
	parts.push(`${params.memory.files} files · ${params.memory.chunks} chunks${dirtySuffix}`);
	if (params.memory.sources?.length) parts.push(`sources ${params.memory.sources.join(", ")}`);
	if (params.memoryPlugin.slot) parts.push(`plugin ${params.memoryPlugin.slot}`);
	const colorByTone = (tone, text) => tone === "ok" ? params.ok(text) : tone === "warn" ? params.warn(text) : params.muted(text);
	if (params.memory.vector) {
		const vector = params.memory.backend === "builtin" && params.memory.vector.storeAvailable !== void 0 ? {
			...params.memory.vector,
			available: params.memory.vector.storeAvailable
		} : params.memory.vector;
		const state = params.resolveMemoryVectorState(vector);
		const prefix = params.memory.backend === "builtin" ? "vector store" : "vector";
		const label = state.state === "disabled" ? `${prefix} off` : `${prefix} ${state.state}`;
		parts.push(colorByTone(state.tone, label));
	}
	if (params.memory.fts) {
		const state = params.resolveMemoryFtsState(params.memory.fts);
		const label = state.state === "disabled" ? "fts off" : `fts ${state.state}`;
		parts.push(colorByTone(state.tone, label));
	}
	if (params.memory.cache) {
		const summary = params.resolveMemoryCacheSummary(params.memory.cache);
		parts.push(colorByTone(summary.tone, summary.text));
	}
	return parts.join(" · ");
}
function buildStatusSecurityAuditLines(params) {
	const fmtSummary = (value) => {
		return [
			params.theme.error(`${value.critical} critical`),
			params.theme.warn(`${value.warn} warn`),
			params.theme.muted(`${value.info} info`)
		].join(" · ");
	};
	const lines = [params.theme.muted(`Summary: ${fmtSummary(params.securityAudit.summary)}`)];
	const importantFindings = params.securityAudit.findings.filter((f) => f.severity === "critical" || f.severity === "warn");
	if (importantFindings.length === 0) lines.push(params.theme.muted("No critical or warn findings detected."));
	else {
		const severityLabel = (sev) => sev === "critical" ? params.theme.error("CRITICAL") : sev === "warn" ? params.theme.warn("WARN") : params.theme.muted("INFO");
		const sevRank = (sev) => sev === "critical" ? 0 : sev === "warn" ? 1 : 2;
		const shown = [...importantFindings].toSorted((a, b) => sevRank(a.severity) - sevRank(b.severity)).slice(0, 6);
		for (const finding of shown) {
			lines.push(`  ${severityLabel(finding.severity)} ${finding.title}`);
			lines.push(`    ${params.shortenText(finding.detail.replaceAll("\n", " "), 160)}`);
			if (finding.remediation?.trim()) lines.push(`    ${params.theme.muted(`Fix: ${finding.remediation.trim()}`)}`);
		}
		if (importantFindings.length > shown.length) lines.push(params.theme.muted(`… +${importantFindings.length - shown.length} more`));
	}
	lines.push(params.theme.muted(`Full report: ${params.formatCliCommand("openclaw security audit")}`));
	lines.push(params.theme.muted(`Deep probe: ${params.formatCliCommand("openclaw security audit --deep")}`));
	return lines;
}
function buildStatusHealthRows(params) {
	const rows = [{
		Item: "Gateway",
		Status: params.ok("reachable"),
		Detail: `${params.health.durationMs}ms`
	}];
	if (params.health.eventLoop) rows.push({
		Item: "Event loop",
		Status: params.health.eventLoop.degraded ? params.warn("WARN") : params.ok("OK"),
		Detail: formatEventLoopHealthDetail(params.health.eventLoop)
	});
	if (params.health.modelPricing?.state === "degraded") rows.push({
		Item: "Model pricing",
		Status: params.warn("WARN"),
		Detail: `optional pricing refresh degraded${params.health.modelPricing.detail ? `: ${params.health.modelPricing.detail}` : ""}`
	});
	for (const line of params.formatHealthChannelLines(params.health, { accountMode: "all" })) {
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const item = line.slice(0, colon).trim();
		const detail = line.slice(colon + 1).trim();
		const normalized = normalizeLowercaseStringOrEmpty(detail);
		const status = normalized.startsWith("ok") ? params.ok("OK") : normalized.startsWith("failed") ? params.warn("WARN") : normalized.startsWith("not configured") ? params.muted("OFF") : normalized.startsWith("configured") ? params.ok("OK") : normalized.startsWith("linked") ? params.ok("LINKED") : normalized.startsWith("not linked") ? params.warn("UNLINKED") : params.warn("WARN");
		rows.push({
			Item: item,
			Status: status,
			Detail: detail
		});
	}
	return rows;
}
function formatEventLoopHealthDetail(eventLoop) {
	return [
		eventLoop.reasons.length > 0 ? `reasons ${eventLoop.reasons.join(",")}` : "healthy",
		`max ${Math.round(eventLoop.delayMaxMs)}ms`,
		`p99 ${Math.round(eventLoop.delayP99Ms)}ms`,
		`util ${eventLoop.utilization}`,
		`cpu ${eventLoop.cpuCoreRatio}`
	].join(" · ");
}
function buildStatusSessionsRows(params) {
	if (params.recent.length === 0) return [];
	return params.recent.map((sess) => ({
		Key: params.shortenText(sess.key, 32),
		Kind: sess.kind,
		Age: sess.updatedAt && sess.age != null ? params.formatTimeAgo(sess.age) : "no activity",
		Model: sess.model ?? "unknown",
		Runtime: sess.runtime ?? "unknown",
		Tokens: params.formatTokensCompact(sess),
		...params.verbose ? { Cache: params.formatPromptCacheCompact(sess) || params.muted("—") } : {}
	}));
}
function buildStatusModelSelectionLines(params) {
	const mismatches = params.recent.filter((sess) => {
		if (!sess.configuredModel || !sess.selectedModel || !sess.modelSelectionReason) return false;
		return sess.configuredModel !== sess.selectedModel && !areRuntimeModelRefsEquivalent(sess.configuredModel, sess.selectedModel);
	});
	if (mismatches.length === 0) return [];
	const limit = params.limit ?? 3;
	const lines = [];
	for (const sess of mismatches.slice(0, limit)) {
		const key = params.shortenText(sess.key, 48);
		const configured = sess.configuredModel ?? "unknown";
		const selected = sess.selectedModel ?? "unknown";
		lines.push(params.warn(`Session ${key} is pinned to ${selected}; config primary ${configured} will apply to new/unpinned sessions.`), `  Configured default: ${configured}`, `  Session selected: ${selected}`, `  Reason: ${sess.modelSelectionReason ?? "session override"}`, `  Clear with: /model ${configured} or /reset`, "  Docs: https://docs.openclaw.ai/concepts/models#selection-source-and-fallback-behavior");
	}
	if (mismatches.length > limit) lines.push(params.muted(`  … +${mismatches.length - limit} more pinned session(s)`));
	return lines;
}
function buildStatusFooterLines(params) {
	return [
		"FAQ: https://docs.openclaw.ai/faq",
		"Troubleshooting: https://docs.openclaw.ai/troubleshooting",
		...params.updateHint ? ["", params.warn(params.updateHint)] : [],
		"Next steps:",
		`  Need to share?      ${params.formatCliCommand("openclaw status --all")}`,
		`  Need to debug live? ${params.formatCliCommand("openclaw logs --follow")}`,
		params.nodeOnlyGateway ? `  Need node service?  ${params.formatCliCommand("openclaw node status")}` : params.gatewayReachable ? `  Need to test channels? ${params.formatCliCommand("openclaw status --deep")}` : `  Fix reachability first: ${params.formatCliCommand("openclaw gateway probe")}`
	];
}
function buildStatusPluginCompatibilityLines(params) {
	if (params.notices.length === 0) return [];
	const limit = params.limit ?? 8;
	return [...params.notices.slice(0, limit).map((notice) => {
		return `  ${notice.severity === "warn" ? params.warn("WARN") : params.muted("INFO")} ${params.formatNotice(notice)}`;
	}), ...params.notices.length > limit ? [params.muted(`  … +${params.notices.length - limit} more`)] : []];
}
function buildStatusPairingRecoveryLines(params) {
	if (!params.pairingRecovery) return [];
	return [
		params.warn(buildPairingConnectRecoveryTitle(params.pairingRecovery.reason ?? void 0)),
		...params.pairingRecovery.reason ? [params.muted(`Reason: ${describePairingConnectRequirement(params.pairingRecovery.reason)}.`)] : [],
		...params.pairingRecovery.remediationHint ? [params.muted(`Hint: ${params.pairingRecovery.remediationHint}`)] : [],
		...params.pairingRecovery.requestId ? [params.muted(`Recovery: ${params.formatCliCommand(`openclaw devices approve ${params.pairingRecovery.requestId}`)}`)] : [],
		params.muted(`Fallback: ${params.formatCliCommand("openclaw devices approve --latest")}`),
		params.muted(`Inspect: ${params.formatCliCommand("openclaw devices list")}`)
	];
}
function buildStatusSystemEventsRows(params) {
	const limit = params.limit ?? 5;
	if (params.queuedSystemEvents.length === 0) return;
	return params.queuedSystemEvents.slice(0, limit).map((event) => ({ Event: event }));
}
function buildStatusSystemEventsTrailer(params) {
	const limit = params.limit ?? 5;
	return params.queuedSystemEvents.length > limit ? params.muted(`… +${params.queuedSystemEvents.length - limit} more`) : null;
}
//#endregion
//#region src/commands/status-overview-rows.ts
function readModelPricingHealth(params) {
	if (params.health?.modelPricing) return params.health.modelPricing;
	const probeHealth = params.surface.gatewayProbe?.health;
	if (!probeHealth || typeof probeHealth !== "object") return;
	const modelPricing = probeHealth.modelPricing;
	if (!modelPricing || typeof modelPricing !== "object") return;
	const state = modelPricing.state;
	if (state !== "ok" && state !== "degraded" && state !== "disabled") return;
	return modelPricing;
}
function buildModelPricingOverviewValue(params) {
	const health = params.health;
	if (!health) return null;
	if (health.state !== "degraded") return null;
	const detail = health.detail ? ` · ${health.detail}` : "";
	return params.warn(`warning · optional pricing refresh degraded${detail}`);
}
function buildStatusCommandOverviewRows(params) {
	const agentsValue = buildStatusAgentsValue({
		agentStatus: params.agentStatus,
		formatTimeAgo: params.formatTimeAgo
	});
	const eventsValue = buildStatusEventsValue({ queuedSystemEvents: params.summary.queuedSystemEvents });
	const tasksValue = buildStatusTasksValue({
		summary: params.summary,
		warn: params.warn,
		muted: params.muted
	});
	const probesValue = buildStatusProbesValue({
		health: params.health,
		ok: params.ok,
		muted: params.muted
	});
	const heartbeatValue = buildStatusHeartbeatValue({ summary: params.summary });
	const lastHeartbeatValue = buildStatusLastHeartbeatValue({
		deep: params.opts.deep,
		gatewayReachable: params.surface.gatewayReachable,
		lastHeartbeat: params.lastHeartbeat,
		warn: params.warn,
		muted: params.muted,
		formatTimeAgo: params.formatTimeAgo
	});
	const memoryValue = buildStatusMemoryValue({
		memory: params.memory,
		memoryPlugin: params.memoryPlugin,
		ok: params.ok,
		warn: params.warn,
		muted: params.muted,
		resolveMemoryVectorState: params.resolveMemoryVectorState,
		resolveMemoryFtsState: params.resolveMemoryFtsState,
		resolveMemoryCacheSummary: params.resolveMemoryCacheSummary,
		memoryUnavailableLabel: "not checked"
	});
	const pluginCompatibilityValue = buildStatusPluginCompatibilityValue({
		notices: params.pluginCompatibility,
		ok: params.ok,
		warn: params.warn
	});
	const modelPricingValue = buildModelPricingOverviewValue({
		health: readModelPricingHealth({
			health: params.health,
			surface: params.surface
		}),
		ok: params.ok,
		warn: params.warn,
		muted: params.muted
	});
	return buildStatusOverviewRowsFromSurface({
		surface: params.surface,
		decorateOk: params.ok,
		decorateWarn: params.warn,
		decorateTailscaleOff: params.muted,
		decorateTailscaleWarn: params.warn,
		prefixRows: [{
			Item: "OS",
			Value: `${params.osLabel} · node ${process.versions.node}`
		}],
		updateValue: params.updateValue,
		agentsValue,
		suffixRows: [
			...modelPricingValue ? [{
				Item: "Model pricing",
				Value: modelPricingValue
			}] : [],
			...params.updateRestartValue ? [{
				Item: "Update restart",
				Value: params.updateRestartValue
			}] : [],
			{
				Item: "Memory",
				Value: memoryValue
			},
			{
				Item: "Plugin compatibility",
				Value: pluginCompatibilityValue
			},
			{
				Item: "Probes",
				Value: probesValue
			},
			{
				Item: "Events",
				Value: eventsValue
			},
			{
				Item: "Tasks",
				Value: tasksValue
			},
			{
				Item: "Heartbeat",
				Value: heartbeatValue
			},
			...lastHeartbeatValue ? [{
				Item: "Last heartbeat",
				Value: lastHeartbeatValue
			}] : [],
			{
				Item: "Sessions",
				Value: buildStatusSessionsOverviewValue({
					sessions: params.summary.sessions,
					formatKTokens: params.formatKTokens
				})
			}
		],
		gatewayAuthWarningValue: params.surface.gatewayProbeAuthWarning ? params.warn(params.surface.gatewayProbeAuthWarning) : null
	});
}
function buildStatusAllOverviewRows(params) {
	return buildStatusOverviewRowsFromSurface({
		surface: params.surface,
		tailscaleBackendState: params.tailscaleBackendState,
		includeBackendStateWhenOff: true,
		includeBackendStateWhenOn: true,
		includeDnsNameWhenOff: true,
		prefixRows: [
			{
				Item: "Version",
				Value: VERSION
			},
			{
				Item: "OS",
				Value: params.osLabel
			},
			{
				Item: "Node",
				Value: process.versions.node
			},
			{
				Item: "Config",
				Value: params.configPath
			}
		],
		middleRows: [...params.updateRestartValue ? [{
			Item: "Update restart",
			Value: params.updateRestartValue
		}] : [], {
			Item: "Security",
			Value: `Run: ${formatCliCommand("openclaw security audit --deep")}`
		}],
		agentsValue: buildStatusAllAgentsValue({ agentStatus: params.agentStatus }),
		suffixRows: [{
			Item: "Secrets",
			Value: buildStatusSecretsValue(params.secretDiagnosticsCount)
		}],
		gatewaySelfFallbackValue: "unknown"
	});
}
//#endregion
//#region src/commands/status-update-restart.ts
function readReason(payload) {
	const reason = payload.stats?.reason;
	return typeof reason === "string" && reason.trim().length > 0 ? reason : null;
}
function readAfterVersion(payload) {
	const version = payload.stats?.after?.version;
	return typeof version === "string" && version.trim().length > 0 ? version : null;
}
function formatUpdateRestartStatusValue(payload, opts = {}) {
	if (!payload || payload.kind !== "update") return null;
	const age = opts.formatTimeAgo && Number.isFinite(payload.ts) ? ` · ${opts.formatTimeAgo(Math.max(0, (opts.nowMs ?? Date.now()) - payload.ts))}` : "";
	const reason = readReason(payload);
	const warn = opts.warn ?? ((value) => value);
	const ok = opts.ok ?? ((value) => value);
	const muted = opts.muted ?? ((value) => value);
	if (payload.status === "error") return warn(`failed · ${reason ?? "restart failed"} · run openclaw gateway status --deep${age}`);
	if (payload.status === "skipped") {
		if (reason === "managed-service-handoff-started") return warn(`handoff running · gateway restart pending · run openclaw update status${age}`);
		if (reason === "restart-health-pending") return warn(`restart pending health verification · run openclaw gateway status --deep${age}`);
		return muted(`skipped · ${reason ?? "restart skipped"}${age}`);
	}
	const version = readAfterVersion(payload);
	return ok(`verified${version ? ` · gateway ${version}` : ""}${age}`);
}
function formatUpdateRestartActionLines(payload) {
	if (!payload || payload.kind !== "update") return [];
	if (payload.status === "error") return ["Update restart failed; run openclaw gateway status --deep.", "If the service is down, run openclaw gateway restart or openclaw gateway install --force."];
	const reason = readReason(payload);
	if (payload.status === "skipped" && (reason === "managed-service-handoff-started" || reason === "restart-health-pending")) return ["Update restart is still pending; run openclaw update status --json for handoff state.", "If it stays pending, run openclaw gateway status --deep."];
	return [];
}
//#endregion
//#region src/commands/status-all/report-tables.ts
const statusOverviewTableColumns = [{
	key: "Item",
	header: "Item",
	minWidth: 10
}, {
	key: "Value",
	header: "Value",
	flex: true,
	minWidth: 24
}];
const statusAgentsTableColumns = [
	{
		key: "Agent",
		header: "Agent",
		minWidth: 12
	},
	{
		key: "BootstrapFile",
		header: "Bootstrap file",
		minWidth: 14
	},
	{
		key: "Sessions",
		header: "Sessions",
		align: "right",
		minWidth: 8
	},
	{
		key: "Active",
		header: "Active",
		minWidth: 10
	},
	{
		key: "Store",
		header: "Store",
		flex: true,
		minWidth: 34
	}
];
function buildStatusAgentTableRows(params) {
	return params.agentStatus.agents.map((agent) => ({
		Agent: agent.name?.trim() ? `${agent.id} (${agent.name.trim()})` : agent.id,
		BootstrapFile: agent.bootstrapPending === true ? params.warn("PRESENT") : agent.bootstrapPending === false ? params.ok("ABSENT") : "unknown",
		Sessions: String(agent.sessionsCount),
		Active: agent.lastActiveAgeMs != null ? formatTimeAgo(agent.lastActiveAgeMs) : "unknown",
		Store: agent.sessionsPath
	}));
}
function buildStatusChannelDetailSections(params) {
	return params.details.map((detail) => ({
		kind: "table",
		title: detail.title,
		width: params.width,
		renderTable: params.renderTable,
		columns: detail.columns.map((column) => ({
			key: column,
			header: column,
			flex: column === "Notes",
			minWidth: column === "Notes" ? 28 : 10
		})),
		rows: detail.rows.map((row) => ({
			...row,
			...row.Status === "OK" ? { Status: params.ok("OK") } : row.Status === "WARN" ? { Status: params.warn("WARN") } : {}
		}))
	}));
}
//#endregion
//#region src/commands/status-all/report-sections.ts
function buildStatusOverviewSection(params) {
	return {
		kind: "table",
		title: "Overview",
		width: params.width,
		renderTable: params.renderTable,
		columns: [...statusOverviewTableColumns],
		rows: params.rows
	};
}
function buildStatusChannelsSection(params) {
	return {
		kind: "table",
		title: "Channels",
		width: params.width,
		renderTable: params.renderTable,
		columns: statusChannelsTableColumns.map((column) => column.key === "Detail" ? Object.assign({}, column, { minWidth: 28 }) : column),
		rows: buildStatusChannelsTableRows({
			rows: params.rows,
			channelIssues: params.channelIssues,
			ok: params.ok,
			warn: params.warn,
			muted: params.muted,
			accentDim: params.accentDim,
			formatIssueMessage: params.formatIssueMessage
		})
	};
}
function buildStatusChannelsTableSection(params) {
	return {
		kind: "table",
		title: "Channels",
		width: params.width,
		renderTable: params.renderTable,
		columns: [...params.columns],
		rows: params.rows
	};
}
function buildStatusChannelDetailsSections(params) {
	return buildStatusChannelDetailSections({
		details: params.details,
		width: params.width,
		renderTable: params.renderTable,
		ok: params.ok,
		warn: params.warn
	});
}
function buildStatusAgentsSection(params) {
	return {
		kind: "table",
		title: "Agents",
		width: params.width,
		renderTable: params.renderTable,
		columns: [...statusAgentsTableColumns],
		rows: buildStatusAgentTableRows({
			agentStatus: params.agentStatus,
			ok: params.ok,
			warn: params.warn
		})
	};
}
function buildStatusSessionsSection(params) {
	return {
		kind: "table",
		title: "Sessions",
		width: params.width,
		renderTable: params.renderTable,
		columns: [...params.columns],
		rows: params.rows
	};
}
function buildStatusSystemEventsSection(params) {
	return {
		kind: "table",
		title: "System events",
		width: params.width,
		renderTable: params.renderTable,
		columns: [{
			key: "Event",
			header: "Event",
			flex: true,
			minWidth: 24
		}],
		rows: params.rows ?? [],
		trailer: params.trailer,
		skipIfEmpty: true
	};
}
function buildStatusHealthSection(params) {
	return {
		kind: "table",
		title: "Health",
		width: params.width,
		renderTable: params.renderTable,
		columns: [...params.columns ?? []],
		rows: params.rows ?? [],
		skipIfEmpty: true
	};
}
function buildStatusUsageSection(params) {
	return {
		kind: "lines",
		title: "Usage",
		body: params.usageLines ?? [],
		skipIfEmpty: true
	};
}
//#endregion
//#region src/commands/status-all/text-report.ts
function appendStatusSectionHeading(params) {
	if (params.lines.length > 0) params.lines.push("");
	params.lines.push(params.heading(params.title));
}
function appendStatusLinesSection(params) {
	appendStatusSectionHeading(params);
	params.lines.push(...params.body);
}
function appendStatusTableSection(params) {
	appendStatusSectionHeading(params);
	params.lines.push(params.renderTable({
		width: params.width,
		columns: [...params.columns],
		rows: params.rows
	}).trimEnd());
}
function appendStatusReportSections(params) {
	for (const section of params.sections) {
		if (section.kind === "raw") {
			if (section.skipIfEmpty && section.body.length === 0) continue;
			params.lines.push(...section.body);
			continue;
		}
		if (section.kind === "lines") {
			if (section.skipIfEmpty && section.body.length === 0) continue;
			appendStatusLinesSection({
				lines: params.lines,
				heading: params.heading,
				title: section.title,
				body: section.body
			});
			continue;
		}
		if (section.skipIfEmpty && section.rows.length === 0) continue;
		appendStatusTableSection({
			lines: params.lines,
			heading: params.heading,
			title: section.title,
			width: section.width,
			renderTable: section.renderTable,
			columns: section.columns,
			rows: section.rows
		});
		if (section.trailer) params.lines.push(section.trailer);
	}
}
//#endregion
export { buildStatusSystemEventsRows as C, buildStatusSessionsRows as S, statusHealthColumns as T, buildStatusHealthRows as _, buildStatusChannelsSection as a, buildStatusPluginCompatibilityLines as b, buildStatusOverviewSection as c, buildStatusUsageSection as d, formatUpdateRestartActionLines as f, buildStatusFooterLines as g, buildStatusCommandOverviewRows as h, buildStatusChannelDetailsSections as i, buildStatusSessionsSection as l, buildStatusAllOverviewRows as m, appendStatusSectionHeading as n, buildStatusChannelsTableSection as o, formatUpdateRestartStatusValue as p, buildStatusAgentsSection as r, buildStatusHealthSection as s, appendStatusReportSections as t, buildStatusSystemEventsSection as u, buildStatusModelSelectionLines as v, buildStatusSystemEventsTrailer as w, buildStatusSecurityAuditLines as x, buildStatusPairingRecoveryLines as y };
