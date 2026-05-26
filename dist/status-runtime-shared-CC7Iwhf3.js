import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
import "./agent-scope-CtLXGcWm.js";
import { s as resolveDefaultAgentDir } from "./agent-scope-config-CMp71_27.js";
import { i as resolveGatewayService, r as readGatewayServiceState } from "./service-CTzdMGsq.js";
import { r as resolveReadOnlyChannelPluginsForConfig } from "./read-only-CHBMrkWp.js";
import { t as resolveNodeService } from "./node-service-DvVyyG8s.js";
import { t as summarizeGatewayServiceLayout } from "./service-layout-B6U4GQmd.js";
import { a as buildStatusOverviewSurfaceRows, t as buildGatewayStatusJsonPayload } from "./format-qvQo2sAg.js";
import { t as formatDaemonRuntimeShort } from "./status.format-DMoa2-sH.js";
//#region src/commands/status-overview-surface.ts
function buildStatusOverviewSurfaceFromScan(params) {
	return {
		cfg: params.scan.cfg,
		update: params.scan.update,
		tailscaleMode: params.scan.tailscaleMode,
		tailscaleDns: params.scan.tailscaleDns,
		tailscaleHttpsUrl: params.scan.tailscaleHttpsUrl,
		gatewayMode: params.scan.gatewayMode,
		remoteUrlMissing: params.scan.remoteUrlMissing,
		gatewayConnection: params.scan.gatewayConnection,
		gatewayReachable: params.scan.gatewayReachable,
		gatewayProbe: params.scan.gatewayProbe,
		gatewayProbeAuth: params.scan.gatewayProbeAuth,
		gatewayProbeAuthWarning: params.scan.gatewayProbeAuthWarning,
		gatewaySelf: params.scan.gatewaySelf,
		gatewayService: params.gatewayService,
		nodeService: params.nodeService,
		nodeOnlyGateway: params.nodeOnlyGateway
	};
}
function buildStatusOverviewSurfaceFromOverview(params) {
	return {
		cfg: params.overview.cfg,
		update: params.overview.update,
		tailscaleMode: params.overview.tailscaleMode,
		tailscaleDns: params.overview.tailscaleDns,
		tailscaleHttpsUrl: params.overview.tailscaleHttpsUrl,
		gatewayMode: params.overview.gatewaySnapshot.gatewayMode,
		remoteUrlMissing: params.overview.gatewaySnapshot.remoteUrlMissing,
		gatewayConnection: params.overview.gatewaySnapshot.gatewayConnection,
		gatewayReachable: params.overview.gatewaySnapshot.gatewayReachable,
		gatewayProbe: params.overview.gatewaySnapshot.gatewayProbe,
		gatewayProbeAuth: params.overview.gatewaySnapshot.gatewayProbeAuth,
		gatewayProbeAuthWarning: params.overview.gatewaySnapshot.gatewayProbeAuthWarning,
		gatewaySelf: params.overview.gatewaySnapshot.gatewaySelf,
		gatewayService: params.gatewayService,
		nodeService: params.nodeService,
		nodeOnlyGateway: params.nodeOnlyGateway
	};
}
function buildStatusOverviewRowsFromSurface(params) {
	return buildStatusOverviewSurfaceRows({
		cfg: params.surface.cfg,
		update: params.surface.update,
		tailscaleMode: params.surface.tailscaleMode,
		tailscaleDns: params.surface.tailscaleDns,
		tailscaleHttpsUrl: params.surface.tailscaleHttpsUrl,
		tailscaleBackendState: params.tailscaleBackendState,
		includeBackendStateWhenOff: params.includeBackendStateWhenOff,
		includeBackendStateWhenOn: params.includeBackendStateWhenOn,
		includeDnsNameWhenOff: params.includeDnsNameWhenOff,
		decorateTailscaleOff: params.decorateTailscaleOff,
		decorateTailscaleWarn: params.decorateTailscaleWarn,
		gatewayMode: params.surface.gatewayMode,
		remoteUrlMissing: params.surface.remoteUrlMissing,
		gatewayConnection: params.surface.gatewayConnection,
		gatewayReachable: params.surface.gatewayReachable,
		gatewayProbe: params.surface.gatewayProbe,
		gatewayProbeAuth: params.surface.gatewayProbeAuth,
		gatewayProbeAuthWarning: params.surface.gatewayProbeAuthWarning,
		gatewaySelf: params.surface.gatewaySelf,
		gatewayService: params.surface.gatewayService,
		nodeService: params.surface.nodeService,
		nodeOnlyGateway: params.surface.nodeOnlyGateway,
		decorateOk: params.decorateOk,
		decorateWarn: params.decorateWarn,
		prefixRows: params.prefixRows,
		middleRows: params.middleRows,
		suffixRows: params.suffixRows,
		agentsValue: params.agentsValue,
		updateValue: params.updateValue,
		gatewayAuthWarningValue: params.gatewayAuthWarningValue,
		gatewaySelfFallbackValue: params.gatewaySelfFallbackValue
	});
}
function buildStatusGatewayJsonPayloadFromSurface(params) {
	return buildGatewayStatusJsonPayload({
		gatewayMode: params.surface.gatewayMode,
		gatewayConnection: params.surface.gatewayConnection,
		remoteUrlMissing: params.surface.remoteUrlMissing,
		gatewayReachable: params.surface.gatewayReachable,
		gatewayProbe: params.surface.gatewayProbe,
		gatewaySelf: params.surface.gatewaySelf,
		gatewayProbeAuthWarning: params.surface.gatewayProbeAuthWarning
	});
}
//#endregion
//#region src/commands/status.service-summary.ts
async function readServiceStatusSummary(service, fallbackLabel) {
	try {
		const state = await readGatewayServiceState(service, { env: process.env });
		const layout = await summarizeGatewayServiceLayout(state.command);
		const managedByOpenClaw = state.installed;
		const externallyManaged = !managedByOpenClaw && state.running;
		const installed = managedByOpenClaw || externallyManaged;
		const loadedText = externallyManaged ? "running (externally managed)" : state.loaded ? service.loadedText : service.notLoadedText;
		return {
			label: service.label,
			installed,
			loaded: state.loaded,
			managedByOpenClaw,
			externallyManaged,
			loadedText,
			runtime: state.runtime,
			...layout ? { layout } : {}
		};
	} catch {
		return {
			label: fallbackLabel,
			installed: null,
			loaded: false,
			managedByOpenClaw: false,
			externallyManaged: false,
			loadedText: "unknown",
			runtime: void 0
		};
	}
}
//#endregion
//#region src/commands/status.daemon.ts
async function buildDaemonStatusSummary(serviceLabel) {
	const summary = await readServiceStatusSummary(serviceLabel === "gateway" ? resolveGatewayService() : resolveNodeService(), serviceLabel === "gateway" ? "Daemon" : "Node");
	return {
		label: summary.label,
		installed: summary.installed,
		loaded: summary.loaded,
		managedByOpenClaw: summary.managedByOpenClaw,
		externallyManaged: summary.externallyManaged,
		loadedText: summary.loadedText,
		runtime: summary.runtime,
		runtimeShort: formatDaemonRuntimeShort(summary.runtime),
		layout: summary.layout
	};
}
async function getDaemonStatusSummary() {
	return await buildDaemonStatusSummary("gateway");
}
async function getNodeDaemonStatusSummary() {
	return await buildDaemonStatusSummary("node");
}
//#endregion
//#region src/commands/status-runtime-shared.ts
const providerUsageLoader = createLazyImportLoader(() => import("./provider-usage-CSXU6PJM.js"));
const securityAuditModuleLoader = createLazyImportLoader(() => import("./audit.runtime.js"));
const gatewayCallModuleLoader = createLazyImportLoader(() => import("./call-C8FPOqHS.js"));
function loadProviderUsage() {
	return providerUsageLoader.load();
}
function loadSecurityAuditModule() {
	return securityAuditModuleLoader.load();
}
function loadGatewayCallModule() {
	return gatewayCallModuleLoader.load();
}
async function resolveStatusSecurityAudit(params) {
	const { runSecurityAudit } = await loadSecurityAuditModule();
	const readOnlyPlugins = resolveReadOnlyChannelPluginsForConfig(params.config, {
		activationSourceConfig: params.sourceConfig,
		includeSetupFallbackPlugins: false
	});
	return await runSecurityAudit({
		config: params.config,
		sourceConfig: params.sourceConfig,
		deep: false,
		includeFilesystem: true,
		includeChannelSecurity: true,
		loadPluginSecurityCollectors: false,
		...readOnlyPlugins.missingConfiguredChannelIds.length === 0 ? { plugins: readOnlyPlugins.plugins } : {}
	});
}
async function resolveStatusUsageSummary(params) {
	const { loadProviderUsageSummary } = await loadProviderUsage();
	return await loadProviderUsageSummary({
		timeoutMs: params.timeoutMs,
		config: params.config,
		agentDir: params.agentDir ?? resolveDefaultAgentDir(params.config)
	});
}
async function loadStatusProviderUsageModule() {
	return await loadProviderUsage();
}
async function resolveStatusGatewayHealth(params) {
	const { callGateway } = await loadGatewayCallModule();
	return await callGateway({
		method: "health",
		params: { probe: true },
		timeoutMs: params.timeoutMs,
		config: params.config
	});
}
async function resolveStatusGatewayHealthSafe(params) {
	if (!params.gatewayReachable) return { error: params.gatewayProbeError ?? "gateway unreachable" };
	const { callGateway } = await loadGatewayCallModule();
	return await callGateway({
		method: "health",
		params: { probe: true },
		timeoutMs: params.timeoutMs,
		config: params.config,
		...params.callOverrides
	}).catch((err) => ({ error: String(err) }));
}
async function resolveStatusGatewayDiagnosticsSafe(params) {
	if (!params.gatewayReachable) return null;
	const { callGateway } = await loadGatewayCallModule();
	return await callGateway({
		method: "diagnostics.stability",
		params: { limit: 1e3 },
		timeoutMs: params.timeoutMs,
		config: params.config,
		...params.callOverrides
	}).catch(() => null);
}
async function resolveStatusLastHeartbeat(params) {
	if (!params.gatewayReachable) return null;
	const { callGateway } = await loadGatewayCallModule();
	return await callGateway({
		method: "last-heartbeat",
		params: {},
		timeoutMs: params.timeoutMs,
		config: params.config
	}).catch(() => null);
}
async function resolveStatusServiceSummaries() {
	return await Promise.all([getDaemonStatusSummary(), getNodeDaemonStatusSummary()]);
}
async function resolveStatusRuntimeDetails(params) {
	const resolveUsageSummary = params.resolveUsage ?? resolveStatusUsageSummary;
	const resolveGatewayHealthSummary = params.resolveHealth ?? resolveStatusGatewayHealth;
	const usage = params.usage ? await resolveUsageSummary({
		timeoutMs: params.timeoutMs,
		config: params.config
	}) : void 0;
	const health = params.deep ? params.suppressHealthErrors ? await resolveGatewayHealthSummary({
		config: params.config,
		timeoutMs: params.timeoutMs
	}).catch(() => void 0) : await resolveGatewayHealthSummary({
		config: params.config,
		timeoutMs: params.timeoutMs
	}) : void 0;
	const lastHeartbeat = params.deep ? await resolveStatusLastHeartbeat({
		config: params.config,
		timeoutMs: params.timeoutMs,
		gatewayReachable: params.gatewayReachable
	}) : null;
	const [gatewayService, nodeService] = await resolveStatusServiceSummaries();
	return {
		usage,
		health,
		lastHeartbeat,
		gatewayService,
		nodeService
	};
}
async function resolveStatusRuntimeSnapshot(params) {
	return {
		securityAudit: params.includeSecurityAudit ? await (params.resolveSecurityAudit ?? resolveStatusSecurityAudit)({
			config: params.config,
			sourceConfig: params.sourceConfig
		}) : void 0,
		...await resolveStatusRuntimeDetails({
			config: params.config,
			timeoutMs: params.timeoutMs,
			usage: params.usage,
			deep: params.deep,
			gatewayReachable: params.gatewayReachable,
			suppressHealthErrors: params.suppressHealthErrors,
			resolveUsage: params.resolveUsage,
			resolveHealth: params.resolveHealth
		})
	};
}
//#endregion
export { resolveStatusRuntimeSnapshot as a, resolveStatusUsageSummary as c, buildStatusOverviewSurfaceFromOverview as d, buildStatusOverviewSurfaceFromScan as f, resolveStatusGatewayHealthSafe as i, buildStatusGatewayJsonPayloadFromSurface as l, resolveStatusGatewayDiagnosticsSafe as n, resolveStatusSecurityAudit as o, resolveStatusGatewayHealth as r, resolveStatusServiceSummaries as s, loadStatusProviderUsageModule as t, buildStatusOverviewRowsFromSurface as u };
