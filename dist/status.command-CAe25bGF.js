import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
import { t as sanitizeTerminalText } from "./safe-text-J_0sTthZ.js";
import { c as normalizePairingConnectRequestId, d as readConnectPairingRequiredMessage, f as readPairingConnectErrorDetails } from "./connect-error-details-BNpp20bs.js";
import { o as readRestartSentinel } from "./restart-sentinel-BDtpdKoy.js";
import { r as withProgress } from "./progress-CE2g1zbv.js";
import { t as logGatewayConnectionDetails } from "./status.gateway-connection-CyT_TFa4.js";
import { a as resolveStatusRuntimeSnapshot, c as resolveStatusUsageSummary, f as buildStatusOverviewSurfaceFromScan, o as resolveStatusSecurityAudit, r as resolveStatusGatewayHealth, t as loadStatusProviderUsageModule } from "./status-runtime-shared-CC7Iwhf3.js";
import { C as buildStatusSystemEventsRows, S as buildStatusSessionsRows, T as statusHealthColumns, _ as buildStatusHealthRows, b as buildStatusPluginCompatibilityLines, c as buildStatusOverviewSection, d as buildStatusUsageSection, g as buildStatusFooterLines, h as buildStatusCommandOverviewRows, l as buildStatusSessionsSection, o as buildStatusChannelsTableSection, p as formatUpdateRestartStatusValue, s as buildStatusHealthSection, t as appendStatusReportSections, u as buildStatusSystemEventsSection, v as buildStatusModelSelectionLines, w as buildStatusSystemEventsTrailer, x as buildStatusSecurityAuditLines, y as buildStatusPairingRecoveryLines } from "./text-report-DSavWMY0.js";
import { n as statusChannelsTableColumns, t as buildStatusChannelsTableRows } from "./channels-table-CgZQAI5Q.js";
import { t as runStatusJsonCommand } from "./status-json-command-Sn2cxAVm.js";
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
		updateValue: params.updateValue,
		updateRestartValue: params.updateRestartValue
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
		modelSelectionLines: buildStatusModelSelectionLines({
			recent: params.summary.sessions.recent,
			shortenText: params.shortenText,
			warn: params.theme.warn,
			muted: params.theme.muted
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
				title: "Model selection",
				body: params.modelSelectionLines,
				skipIfEmpty: true
			},
			{
				kind: "lines",
				title: "Security audit",
				body: params.securityAuditLines
			},
			params.channelsRows.length === 0 ? {
				kind: "lines",
				title: "Channels",
				body: [params.muted("No channels configured")]
			} : { ...buildStatusChannelsTableSection({
				width: params.width,
				renderTable: params.renderTable,
				columns: params.channelsColumns,
				rows: params.channelsRows
			}) },
			params.sessionsRows.length === 0 ? {
				kind: "lines",
				title: "Sessions",
				body: [params.muted("No sessions")]
			} : { ...buildStatusSessionsSection({
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
const statusScanModuleLoader = createLazyImportLoader(() => import("./status.scan-CLQ12ZcQ.js"));
const statusScanFastJsonModuleLoader = createLazyImportLoader(() => import("./status.scan.fast-json-ieT3RrAt.js"));
const statusAllModuleLoader = createLazyImportLoader(() => import("./status-all-CmMswlTL.js"));
const statusCommandTextRuntimeLoader = createLazyImportLoader(() => import("./status.command.text-runtime-Ckz7ew5p.js"));
const statusGatewayConnectionRuntimeLoader = createLazyImportLoader(() => import("./status.gateway-connection.runtime.js"));
const statusNodeModeModuleLoader = createLazyImportLoader(() => import("./status.node-mode-Dh36Mnqd.js"));
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
	const overviewSurface = buildStatusOverviewSurfaceFromScan({
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
	});
	const updateRestartValue = formatUpdateRestartStatusValue((await readRestartSentinel().catch(() => null))?.payload, {
		ok,
		warn,
		muted,
		formatTimeAgo
	});
	const lines = await buildStatusCommandReportLines(await buildStatusCommandReportData({
		opts,
		surface: overviewSurface,
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
		updateValue: updateSurface.updateAvailable ? warn(`available · ${updateSurface.updateLine}`) : updateSurface.updateLine,
		updateRestartValue
	}));
	for (const line of lines) runtime.log(line);
}
//#endregion
export { statusCommand as n, resolvePairingRecoveryContext as t };
