import { a as resolveCanvasHostConfig, n as isCanvasHostEnabled } from "./config-8ESl39g-.js";
import { n as CANVAS_HOST_PATH } from "./a2ui-shared-ChIGfmtH.js";
import { t as handleA2uiHttpRequest } from "./a2ui-DNWaCF9M.js";
import { t as createCanvasHostHandler } from "./server--nbMQnZ4.js";
//#region extensions/canvas/src/http-route.ts
function createCanvasHttpRouteHandler(params) {
	let hostHandlerPromise = null;
	const loadHostHandler = async () => {
		if (!isCanvasHostEnabled(params.config)) return null;
		hostHandlerPromise ??= (async () => {
			const hostConfig = resolveCanvasHostConfig({
				config: params.config,
				pluginConfig: params.pluginConfig
			});
			const handler = await createCanvasHostHandler({
				runtime: params.runtime,
				rootDir: hostConfig.root,
				basePath: CANVAS_HOST_PATH,
				allowInTests: params.allowInTests,
				liveReload: hostConfig.liveReload
			});
			return handler.rootDir ? handler : null;
		})();
		return hostHandlerPromise;
	};
	return {
		async handleHttpRequest(req, res) {
			const handler = await loadHostHandler();
			if (!handler) return false;
			const url = new URL(req.url ?? "/", "http://localhost");
			if (url.pathname === "/__openclaw__/a2ui" || url.pathname.startsWith(`/__openclaw__/a2ui/`)) return handleA2uiHttpRequest(req, res);
			return handler.handleHttpRequest(req, res);
		},
		async handleUpgrade(req, socket, head) {
			const handler = await loadHostHandler();
			if (!handler) return false;
			if (new URL(req.url ?? "/", "http://localhost").pathname !== "/__openclaw__/ws") return false;
			return handler.handleUpgrade(req, socket, head);
		},
		async close() {
			await (hostHandlerPromise ? await hostHandlerPromise : null)?.close();
			hostHandlerPromise = null;
		}
	};
}
//#endregion
export { createCanvasHttpRouteHandler };
