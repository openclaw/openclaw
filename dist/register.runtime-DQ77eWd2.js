import { a as unregisterAcpRuntimeBackend, n as getAcpRuntimeBackend, r as registerAcpRuntimeBackend } from "./registry-xA2gDhdp.js";
import "./acp-runtime-backend-LC5BzNoV.js";
//#region extensions/acpx/register.runtime.ts
const ACPX_BACKEND_ID = "acpx";
const ENABLE_STARTUP_PROBE_ENV = "OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE";
const SKIP_RUNTIME_PROBE_ENV = "OPENCLAW_SKIP_ACPX_RUNTIME_PROBE";
let serviceModulePromise = null;
function loadServiceModule() {
	serviceModulePromise ??= import("./service-D51K1vSC.js");
	return serviceModulePromise;
}
function shouldRunStartupProbe(env = process.env) {
	return env[ENABLE_STARTUP_PROBE_ENV] !== "0" && env[SKIP_RUNTIME_PROBE_ENV] !== "1";
}
async function startRealService(state) {
	if (state.realRuntime) return state.realRuntime;
	if (!state.ctx) throw new Error("ACPX runtime service is not started");
	state.startPromise ??= (async () => {
		const { createAcpxRuntimeService } = await loadServiceModule();
		const service = createAcpxRuntimeService(state.params);
		state.realService = service;
		await service.start(state.ctx);
		const backend = getAcpRuntimeBackend(ACPX_BACKEND_ID);
		if (!backend?.runtime) throw new Error("ACPX runtime service did not register an ACP backend");
		state.realRuntime = backend.runtime;
		return state.realRuntime;
	})();
	return await state.startPromise;
}
function createDeferredRuntime(state) {
	return {
		async ensureSession(input) {
			return await (await startRealService(state)).ensureSession(input);
		},
		async *runTurn(input) {
			yield* (await startRealService(state)).runTurn(input);
		},
		async getCapabilities(input) {
			return await (await startRealService(state)).getCapabilities?.(input) ?? { controls: [] };
		},
		async getStatus(input) {
			return await (await startRealService(state)).getStatus?.(input) ?? {};
		},
		async setMode(input) {
			await (await startRealService(state)).setMode?.(input);
		},
		async setConfigOption(input) {
			await (await startRealService(state)).setConfigOption?.(input);
		},
		async doctor() {
			return await (await startRealService(state)).doctor?.() ?? {
				ok: true,
				message: "ok"
			};
		},
		async prepareFreshSession(input) {
			await (await startRealService(state)).prepareFreshSession?.(input);
		},
		async cancel(input) {
			await (await startRealService(state)).cancel(input);
		},
		async close(input) {
			await (await startRealService(state)).close(input);
		},
		async probeAvailability() {
			await (await startRealService(state)).probeAvailability();
		},
		isHealthy() {
			return state.realRuntime?.isHealthy() ?? false;
		}
	};
}
function createAcpxRuntimeService(params = {}) {
	const state = {
		ctx: null,
		params,
		realRuntime: null,
		realService: null,
		startPromise: null
	};
	return {
		id: "acpx-runtime",
		async start(ctx) {
			if (process.env.OPENCLAW_SKIP_ACPX_RUNTIME === "1") {
				ctx.logger.info("skipping embedded acpx runtime backend (OPENCLAW_SKIP_ACPX_RUNTIME=1)");
				return;
			}
			state.ctx = ctx;
			if (shouldRunStartupProbe()) {
				await startRealService(state);
				return;
			}
			registerAcpRuntimeBackend({
				id: ACPX_BACKEND_ID,
				runtime: createDeferredRuntime(state)
			});
			ctx.logger.info("embedded acpx runtime backend registered lazily");
		},
		async stop(ctx) {
			if (state.realService) await state.realService.stop?.(ctx);
			else unregisterAcpRuntimeBackend(ACPX_BACKEND_ID);
			state.ctx = null;
			state.realRuntime = null;
			state.realService = null;
			state.startPromise = null;
		}
	};
}
//#endregion
export { createAcpxRuntimeService as t };
