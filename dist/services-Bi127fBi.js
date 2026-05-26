import { r as STATE_DIR } from "./paths-Cw7f9XhU.js";
import { c as onInternalDiagnosticEvent, i as emitTrustedDiagnosticEvent } from "./diagnostic-events-BLgzARSp.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { t as encodeStartupTraceSegment } from "./startup-trace-segment-Cd4cVDJE.js";
import { n as withPluginHttpRouteRegistry } from "./http-registry-Dt8GAiji.js";
//#region src/plugins/services.ts
const log = createSubsystemLogger("plugins");
function createPluginLogger() {
	return {
		info: (msg) => log.info(msg),
		warn: (msg) => log.warn(msg),
		error: (msg) => log.error(msg),
		debug: (msg) => log.debug(msg)
	};
}
function createServiceContext(params) {
	const grantsInternalDiagnostics = params.service?.pluginId === params.service?.service.id && (params.service?.service.id === "diagnostics-otel" || params.service?.service.id === "diagnostics-prometheus") && (params.service?.origin === "bundled" || params.service?.trustedOfficialInstall === true);
	return {
		config: params.config,
		workspaceDir: params.workspaceDir,
		stateDir: STATE_DIR,
		logger: createPluginLogger(),
		...params.startupTrace ? { startupTrace: createScopedPluginServiceStartupTrace(params.startupTrace, createPluginServiceTraceName(params.service)) } : {},
		...grantsInternalDiagnostics ? { internalDiagnostics: {
			emit: emitTrustedDiagnosticEvent,
			onEvent: onInternalDiagnosticEvent
		} } : {}
	};
}
function createPluginServiceTraceName(entry) {
	return `sidecars.plugin-services.${encodeStartupTraceSegment(entry.pluginId)}.${encodeStartupTraceSegment(entry.service.id)}`;
}
function createScopedPluginServiceStartupTrace(startupTrace, prefix) {
	const scopeName = (name) => `${prefix}.${name.split(".").map((segment) => encodeStartupTraceSegment(segment)).join(".")}`;
	return {
		measure: (name, run) => startupTrace.measure(scopeName(name), run),
		...startupTrace.detail ? { detail: (name, metrics) => startupTrace.detail?.(scopeName(name), metrics) } : {}
	};
}
async function startPluginServices(params) {
	const running = [];
	let failedCount = 0;
	for (const entry of params.registry.services) {
		const service = entry.service;
		const traceName = createPluginServiceTraceName(entry);
		const serviceContext = createServiceContext({
			config: params.config,
			startupTrace: params.startupTrace,
			workspaceDir: params.workspaceDir,
			service: entry
		});
		try {
			const startService = () => withPluginHttpRouteRegistry(params.registry, () => service.start(serviceContext));
			if (params.startupTrace) await params.startupTrace.measure(traceName, startService);
			else await startService();
			running.push({
				id: service.id,
				stop: service.stop ? () => service.stop?.(serviceContext) : void 0
			});
		} catch (err) {
			failedCount += 1;
			const error = err;
			log.error(`plugin service failed (${service.id}, plugin=${entry.pluginId}, root=${entry.rootDir ?? "unknown"}): ${error?.message ?? String(err)}`);
		}
	}
	params.startupTrace?.detail?.("sidecars.plugin-services.summary", [
		["serviceCount", params.registry.services.length],
		["startedCount", running.length],
		["failedCount", failedCount]
	]);
	return { stop: async () => {
		for (const entry of running.toReversed()) {
			if (!entry.stop) continue;
			try {
				await withPluginHttpRouteRegistry(params.registry, () => entry.stop?.());
			} catch (err) {
				log.warn(`plugin service stop failed (${entry.id}): ${String(err)}`);
			}
		}
	} };
}
//#endregion
export { startPluginServices };
