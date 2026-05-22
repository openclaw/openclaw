import { r as createBrowserRouteDispatcher, t as startBrowserControlServiceFromConfig } from "./control-service-ttQB7tD9.js";
import { n as createBrowserControlContext } from "./plugin-enabled-1HlG2z0o.js";
//#region extensions/browser/src/browser/local-dispatch.runtime.ts
async function dispatchBrowserControlRequest(req) {
	if (!await startBrowserControlServiceFromConfig()) throw new Error("browser control disabled");
	return await createBrowserRouteDispatcher(createBrowserControlContext()).dispatch(req);
}
//#endregion
export { dispatchBrowserControlRequest };
