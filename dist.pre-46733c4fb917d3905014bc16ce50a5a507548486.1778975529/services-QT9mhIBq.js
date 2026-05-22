import { r as STATE_DIR } from "./paths-Cnwfh6dH.js";
import { i as emitTrustedDiagnosticEvent, s as onInternalDiagnosticEvent } from "./diagnostic-events-QP40Y1ku.js";
import { t as createSubsystemLogger } from "./subsystem-B8WCz3Ew.js";
import { t as encodeStartupTraceSegment } from "./startup-trace-segment-BjEe_473.js";
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
		...grantsInternalDiagnostics ? { internalDiagnostics: {
			emit: emitTrustedDiagnosticEvent,
			onEvent: onInternalDiagnosticEvent
		} } : {}
	};
}
async function startPluginServices(params) {
	const running = [];
	let failedCount = 0;
	for (const entry of params.registry.services) {
		const service = entry.service;
		const serviceContext = createServiceContext({
			config: params.config,
			workspaceDir: params.workspaceDir,
			service: entry
		});
		try {
			const startService = () => service.start(serviceContext);
			const traceName = `sidecars.plugin-services.${encodeStartupTraceSegment(entry.pluginId)}.${encodeStartupTraceSegment(service.id)}`;
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
				await entry.stop();
			} catch (err) {
				log.warn(`plugin service stop failed (${entry.id}): ${String(err)}`);
			}
		}
	} };
}
//#endregion
export { startPluginServices };
