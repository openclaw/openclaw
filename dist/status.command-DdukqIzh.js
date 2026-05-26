import { t as createLazyImportLoader } from "./lazy-promise-SFT4i6yI.js";
import { t as sanitizeTerminalText } from "./safe-text-CdNixupx.js";
import { c as normalizePairingConnectRequestId, d as readConnectPairingRequiredMessage, f as readPairingConnectErrorDetails } from "./connect-error-details-Coy_cvEz.js";
import { r as withProgress } from "./progress-Cw6xZlhJ.js";
import { t as logGatewayConnectionDetails } from "./status.gateway-connection-CqFnqW8R.js";
import { a as resolveStatusSecurityAudit, d as buildStatusOverviewSurfaceFromScan, i as resolveStatusRuntimeSnapshot, n as resolveStatusGatewayHealth, s as resolveStatusUsageSummary, t as loadStatusProviderUsageModule } from "./status-runtime-shared-b3OzK0mt.js";
import { t as runStatusJsonCommand } from "./status-json-command-BTReMX-D.js";
import { n as statusChannelsTableColumns, t as buildStatusChannelsTableRows } from "./channels-table-CcxqkBC0.js";
import { S as statusHealthColumns, _ as buildStatusPluginCompatibilityLines, b as buildStatusSystemEventsRows, c as buildStatusOverviewSection, d as buildStatusUsageSection, g as buildStatusPairingRecoveryLines, h as buildStatusHealthRows, l as buildStatusSessionsSection, m as buildStatusFooterLines, o as buildStatusChannelsTableSection, p as buildStatusCommandOverviewRows, s as buildStatusHealthSection, t as appendStatusReportSections, u as buildStatusSystemEventsSection, v as buildStatusSecurityAuditLines, x as buildStatusSystemEventsTrailer, y as buildStatusSessionsRows } from "./text-report-DHmEsnsT.js";
//#region src/commands/status.command-report-data.ts
async function buildStatusCommandReportData(params) {
	const overviewRows = buildStatusCommandOverviewRows({
		opts: params.opts,
		surface: params.surface,
		osLabel: params.osSummary.label,
		summary: params.summary,
		health: params.health,
		lastHeartbeat: params.lastHeartbeat,
		agentStatus: params.agentStatus,
		memory: params.memory,
		memoryPlugin: params.memoryPlugin,
		pluginCompatibility: params.pluginCompatibility,
		ok: params.ok,
		warn: params.warn,
		muted: params.muted,
		formatTimeAgo: params.formatTimeAgo,
		formatKTokens: params.formatKTokens,
		resolveMemoryVectorState: params.resolveMemoryVectorState,
		resolveMemoryFtsState: params.resolveMemoryFtsState,
		resolveMemoryCacheSummary: params.resolveMemoryCacheSummary,
		updateValue: params.updateValue
	});
	const sessionsColumns = [
		{
			key: "Key",
			header: "Key",
			minWidth: 20,
			flex: true
		},
		{
			key: "Kind",
			header: "Kind",
			minWidth: 6
		},
		{
			key: "Age",
			header: "Age",
			minWidth: 9
		},
		{
			key: "Model",
			header: "Model",
			minWidth: 14
		},
		{
			key: "Runtime",
			header: "Runtime",
			minWidth: 14
		},
		{
			key: "Tokens",
			header: "Tokens",
			minWidth: 16
		},
		...params.opts.verbose ? [{
			key: "Cache",
			header: "Cache",
			minWidth: 16,
			flex: true
		}] : []
	];
	const securityAuditLines = params.securityAudit ? buildStatusSecurityAuditLines({
		securityAudit: params.securityAudit,
		theme: params.theme,
		shortenText: params.shortenText,
		formatCliCommand: params.formatCliCommand
	}) : [params.theme.muted(`Skipped in fast status. Full report: ${params.formatCliCommand("openclaw security audit")}`), params.theme.muted(`Deep probe: ${params.formatCliCommand("openclaw status --deep")}`)];
	return {
		heading: params.theme.heading,
		muted: params.theme.muted,
		renderTable: params.renderTable,
		width: params.tableWidth,
		overviewRows,
		showTaskMaintenanceHint: params.summary.taskAudit.errors > 0,
		taskMaintenanceHint: `Task maintenance: ${params.formatCliCommand("openclaw tasks maintenance --apply")}`,
		pluginCompatibilityLines: buildStatusPluginCompatibilityLines({
			notices: params.pluginCompatibility,
			formatNotice: params.formatPluginCompatibilityNotice,
			warn: params.theme.warn,
			muted: params.theme.muted
		}),
		pairingRecoveryLines: buildStatusPairingRecoveryLines({
			pairingRecovery: params.pairingRecovery,
			warn: params.theme.warn,
			muted: params.theme.muted,
			formatCliCommand: params.formatCliCommand
		}),
		securityAuditLines,
		channelsColumns: statusChannelsTableColumns,
		channelsRows: buildStatusChannelsTableRows({
			rows: params.channels.rows,
			channelIssues: params.channelIssues,
			ok: params.ok,
			warn: params.warn,
			muted: params.muted,
			accentDim: params.accentDim,
			formatIssueMessage: (message) => params.shortenText(message, 84)
		}),
		sessionsColumns,
		sessionsRows: buildStatusSessionsRows({
			recent: params.summary.sessions.recent,
			verbose: params.opts.verbose,
			shortenText: params.shortenText,
			formatTimeAgo: params.formatTimeAgo,
			formatTokensCompact: params.formatTokensCompact,
			formatPromptCacheCompact: params.formatPromptCacheCompact,
			muted: params.muted
		}),
		systemEventsRows: buildStatusSystemEventsRows({ queuedSystemEvents: params.summary.queuedSystemEvents }),
		systemEventsTrailer: buildStatusSystemEventsTrailer({
			queuedSystemEvents: params.summary.queuedSystemEvents,
			muted: params.muted
		}),
		healthColumns: params.health ? statusHealthColumns : void 0,
		healthRows: params.health ? buildStatusHealthRows({
			health: params.health,
			formatHealthChannelLines: params.formatHealthChannelLines,
			ok: params.ok,
			warn: params.warn,
			muted: params.muted
		}) : void 0,
		usageLines: params.usageLines,
		footerLines: buildStatusFooterLines({
			updateHint: params.formatUpdateAvailableHint(params.surface.update),
			warn: params.theme.warn,
			formatCliCommand: params.formatCliCommand,
			nodeOnlyGateway: params.surface.nodeOnlyGateway,
			gatewayReachable: params.surface.gatewayReachable
		})
	};
}
//#endregion
//#region src/commands/status.command-report.ts
async function buildStatusCommandReportLines(params) {
	const lines = [];
	lines.push(params.heading("OpenClaw status"));
	appendStatusReportSections({
		lines,
		heading: params.heading,
		sections: [
			{ ...buildStatusOverviewSection({
				width: params.width,
				renderTable: params.renderTable,
				rows: params.overviewRows
			}) },
			{
				kind: "raw",
				body: params.showTaskMaintenanceHint ? ["", params.muted(params.taskMaintenanceHint)] : [],
				skipIfEmpty: true
			},
			{
				kind: "lines",
				title: "Plugin compatibility",
				body: params.pluginCompatibilityLines,
				skipIfEmpty: true
			},
			{
				kind: "raw",
				body: params.pairingRecoveryLines.length > 0 ? ["", ...params.pairingRecoveryLines] : [],
				skipIfEmpty: true
			},
			{
				kind: "lines",
				title: "Security audit",
				body: params.securityAuditLines
			},
			{ ...buildStatusChannelsTableSection({
				width: params.width,
				renderTable: params.renderTable,
				columns: params.channelsColumns,
				rows: params.channelsRows
			}) },
			{ ...buildStatusSessionsSection({
				width: params.width,
				renderTable: params.renderTable,
				columns: params.sessionsColumns,
				rows: params.sessionsRows
			}) },
			{ ...buildStatusSystemEventsSection({
				width: params.width,
				renderTable: params.renderTable,
				rows: params.systemEventsRows,
				trailer: params.systemEventsTrailer
			}) },
			{ ...buildStatusHealthSection({
				width: params.width,
				renderTable: params.renderTable,
				columns: params.healthColumns,
				rows: params.healthRows
			}) },
			{ ...buildStatusUsageSection({ usageLines: params.usageLines }) },
			{
				kind: "raw",
				body: ["", ...params.footerLines]
			}
		]
	});
	return lines;
}
//#endregion
//#region src/commands/status.command.ts
const statusScanModuleLoader = createLazyImportLoader(() => import("./status.scan-CDtHLgTr.js"));
const statusScanFastJsonModuleLoader = createLazyImportLoader(() => import("./status.scan.fast-json-uXbTDDND.js"));
const statusAllModuleLoader = createLazyImportLoader(() => import("./status-all-B8FCreWR.js"));
const statusCommandTextRuntimeLoader = createLazyImportLoader(() => import("./status.command.text-runtime-CPj1guHA.js"));
const statusGatewayConnectionRuntimeLoader = createLazyImportLoader(() => import("./status.gateway-connection.runtime.js"));
const statusNodeModeModuleLoader = createLazyImportLoader(() => import("./status.node-mode-BU6oqhu8.js"));
function loadStatusScanModule() {
	return statusScanModuleLoader.load();
}
function loadStatusScanFastJsonModule() {
	return statusScanFastJsonModuleLoader.load();
}
function loadStatusAllModule() {
	return statusAllModuleLoader.load();
}
function loadStatusCommandTextRuntime() {
	return statusCommandTextRuntimeLoader.load();
}
function loadStatusGatewayConnectionRuntime() {
	return statusGatewayConnectionRuntimeLoader.load();
}
function loadStatusNodeModeModule() {
	return statusNodeModeModuleLoader.load();
}
function resolvePairingRecoveryContext(params) {
	const structured = readPairingConnectErrorDetails(params.details);
	if (structured) return {
		requestId: normalizePairingConnectRequestId(structured.requestId) ?? null,
		reason: structured.reason ?? null,
		remediationHint: structured.remediationHint ? sanitizeTerminalText(structured.remediationHint) : null
	};
	const pairing = readConnectPairingRequiredMessage([params.error, params.closeReason].filter((part) => typeof part === "string" && part.trim().length > 0).join(" "));
	if (!pairing) return null;
	return {
		requestId: normalizePairingConnectRequestId(pairing.requestId) ?? null,
		reason: pairing.reason ?? null,
		remediationHint: null
	};
}
async function statusCommand(opts, runtime) {
	if (opts.all && !opts.json) {
		await loadStatusAllModule().then(({ statusAllCommand }) => statusAllCommand(runtime, { timeoutMs: opts.timeoutMs }));
		return;
	}
	if (opts.json) {
		await runStatusJsonCommand({
			opts,
			runtime,
			includeSecurityAudit: opts.all === true,
			includePluginCompatibility: true,
			suppressHealthErrors: true,
			scanStatusJsonFast: async (scanOpts, runtimeForScan) => await loadStatusScanFastJsonModule().then(({ scanStatusJsonFast }) => scanStatusJsonFast(scanOpts, runtimeForScan))
		});
		return;
	}
	const scan = await loadStatusScanModule().then(({ scanStatus }) => scanStatus({
		json: false,
		timeoutMs: opts.timeoutMs,
		all: opts.all,
		deep: opts.deep
	}, runtime));
	const { cfg, osSummary, tailscaleMode, tailscaleDns, tailscaleHttpsUrl, update, gatewayConnection, remoteUrlMissing, gatewayMode, gatewayProbeAuth, gatewayProbeAuthWarning, gatewayProbe, gatewayReachable, gatewaySelf, channelIssues, agentStatus, channels, summary, secretDiagnostics, memory, memoryPlugin, pluginCompatibility } = scan;
	const { securityAudit, usage, health, lastHeartbeat, gatewayService: daemon, nodeService: nodeDaemon } = await resolveStatusRuntimeSnapshot({
		config: scan.cfg,
		sourceConfig: scan.sourceConfig,
		timeoutMs: opts.timeoutMs,
		usage: opts.usage,
		deep: opts.deep,
		gatewayReachable,
		includeSecurityAudit: opts.all === true || opts.deep === true,
		resolveSecurityAudit: async (input) => await withProgress({
			label: "Running security audit…",
			indeterminate: true,
			enabled: true
		}, async () => await resolveStatusSecurityAudit(input)),
		resolveUsage: async (input) => await withProgress({
			label: "Fetching usage snapshot…",
			indeterminate: true,
			enabled: opts.json !== true
		}, async () => await resolveStatusUsageSummary(input)),
		resolveHealth: async (input) => await withProgress({
			label: "Checking gateway health…",
			indeterminate: true,
			enabled: opts.json !== true
		}, async () => await resolveStatusGatewayHealth(input))
	});
	const { buildStatusUpdateSurface, formatCliCommand, formatHealthChannelLines, formatKTokens, formatPromptCacheCompact, formatPluginCompatibilityNotice, formatTimeAgo, formatTokensCompact, formatUpdateAvailableHint, getTerminalTableWidth, info, renderTable, resolveMemoryCacheSummary, resolveMemoryFtsState, resolveMemoryVectorState, shortenText, theme } = await loadStatusCommandTextRuntime();
	const muted = (value) => theme.muted(value);
	const ok = (value) => theme.success(value);
	const warn = (value) => theme.warn(value);
	const updateSurface = buildStatusUpdateSurface({
		updateConfigChannel: cfg.update?.channel,
		update
	});
	if (opts.verbose) {
		const { buildGatewayConnectionDetails } = await loadStatusGatewayConnectionRuntime();
		logGatewayConnectionDetails({
			runtime,
			info,
			message: buildGatewayConnectionDetails({ config: scan.cfg }).message,
			trailingBlankLine: true
		});
	}
	const tableWidth = getTerminalTableWidth();
	if (secretDiagnostics.length > 0) {
		runtime.log(theme.warn("Secret diagnostics:"));
		for (const entry of secretDiagnostics) runtime.log(`- ${entry}`);
		runtime.log("");
	}
	const nodeOnlyGateway = await loadStatusNodeModeModule().then(({ resolveNodeOnlyGatewayInfo }) => resolveNodeOnlyGatewayInfo({
		daemon,
		node: nodeDaemon
	}));
	const pairingRecovery = resolvePairingRecoveryContext({
		error: gatewayProbe?.error ?? null,
		closeReason: gatewayProbe?.close?.reason ?? null,
		details: gatewayProbe?.connectErrorDetails
	});
	const usageLines = usage ? await loadStatusProviderUsageModule().then(({ formatUsageReportLines }) => formatUsageReportLines(usage)) : void 0;
	const lines = await buildStatusCommandReportLines(await buildStatusCommandReportData({
		opts,
		surface: buildStatusOverviewSurfaceFromScan({
			scan: {
				cfg,
				update,
				tailscaleMode,
				tailscaleDns,
				tailscaleHttpsUrl,
				gatewayMode,
				remoteUrlMissing,
				gatewayConnection,
				gatewayReachable,
				gatewayProbe,
				gatewayProbeAuth,
				gatewayProbeAuthWarning,
				gatewaySelf
			},
			gatewayService: daemon,
			nodeService: nodeDaemon,
			nodeOnlyGateway
		}),
		osSummary,
		summary,
		securityAudit,
		health,
		usageLines,
		lastHeartbeat,
		agentStatus,
		channels,
		channelIssues,
		memory,
		memoryPlugin,
		pluginCompatibility,
		pairingRecovery,
		tableWidth,
		ok,
		warn,
		muted,
		shortenText,
		formatCliCommand,
		formatTimeAgo,
		formatKTokens,
		formatTokensCompact,
		formatPromptCacheCompact,
		formatHealthChannelLines,
		formatPluginCompatibilityNotice,
		formatUpdateAvailableHint,
		resolveMemoryVectorState,
		resolveMemoryFtsState,
		resolveMemoryCacheSummary,
		accentDim: theme.accentDim,
		theme,
		renderTable,
		updateValue: updateSurface.updateAvailable ? warn(`available · ${updateSurface.updateLine}`) : updateSurface.updateLine
	}));
	for (const line of lines) runtime.log(line);
}
//#endregion
export { statusCommand as n, resolvePairingRecoveryContext as t };
