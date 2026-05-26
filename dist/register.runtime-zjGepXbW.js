import { a as unregisterAcpRuntimeBackend, t as getAcpRuntimeBackend } from "./registry-KuKuvijT.js";
import "./acp-runtime-backend-BPQA8n2I.js";
//#region extensions/acpx/register.runtime.ts
const ACPX_BACKEND_ID = "acpx";
let serviceModulePromise = null;
function loadServiceModule() {
	serviceModulePromise ??= import("./service-DPmdIkJ0.js");
	return serviceModulePromise;
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
			await startRealService(state);
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
