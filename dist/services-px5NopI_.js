import { r as STATE_DIR } from "./paths-Cnwfh6dH.js";
import { i as emitTrustedDiagnosticEvent, s as onInternalDiagnosticEvent } from "./diagnostic-events-BkhOFI0h.js";
import { t as createSubsystemLogger } from "./subsystem-DLRoKDlF.js";
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
	for (const entry of params.registry.services) {
		const service = entry.service;
		const serviceContext = createServiceContext({
			config: params.config,
			workspaceDir: params.workspaceDir,
			service: entry
		});
		try {
			await service.start(serviceContext);
			running.push({
				id: service.id,
				stop: service.stop ? () => service.stop?.(serviceContext) : void 0
			});
		} catch (err) {
			const error = err;
			log.error(`plugin service failed (${service.id}, plugin=${entry.pluginId}, root=${entry.rootDir ?? "unknown"}): ${error?.message ?? String(err)}`);
		}
	}
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
